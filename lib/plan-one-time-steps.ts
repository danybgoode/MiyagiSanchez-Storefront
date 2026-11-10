/**
 * lib/plan-one-time-steps.ts — the ORDER of what a paid yearly plan checkout does, with the I/O injected (plan-tienda
 * S4.2/S4.3; fixes the gap found at the review of PR 485).
 *
 * THE GAP: the yearly path used to stop at a grant `replay`. A share or attribution write that failed AFTER the grant
 * landed escaped as a 500, Stripe delivered the event again, the grant came back `replay` — and the handler returned
 * before the shares, so they were never recorded.
 *
 * THE RULE NOW: the steps that are idempotent on their own run on EVERY delivery whose grant is counted (written now
 * or on an earlier delivery); the steps that are not run only on the delivery that wrote the grant.
 *   1. grant           — replay-checked by the payment id (`applyPlanPayment`). A failure answers `retry`.
 *   2. shares          — written or replay only (a `comp` shop paid nothing new for a share). Idempotent by
 *                        `payment_ref` (the partial unique index `marketplace_promoter_attributions_payment_ref_key`;
 *                        a duplicate re-runs only the accrual, itself exactly-once by `UNIQUE(attribution_id)`).
 *   3. attribution     — whenever the deps provide one. Idempotent: `markAttributionPaid` looks the row up by
 *                        (promoter, shop, sku) and updates it, a racing insert hits `marketplace_promoter_attributions_uniq`
 *                        (23505, handled), and its accrual is exactly-once by `UNIQUE(attribution_id)`.
 *   4. first time only — the ✅ alert, D19, the D10 hook: never on a replay, so a redelivery repeats none of them.
 *                        They run even when a share failed: the grant DID land, and the redelivery will be a replay.
 * A failed share or attribution answers `retry` (500), so Stripe delivers again and the redelivery completes only the
 * missing step — the ones that landed collide on their keys and add nothing.
 */
import type { PlanPaymentOutcome } from './plan-payment'
import type { PlanWebhookOutcome } from './plan-subscription-sync'

export type OneTimeStepsDeps = {
  /** Write the grant. Throws when it could not be written (a later delivery can fix it). */
  applyGrant: () => Promise<PlanPaymentOutcome>
  /** Record every promoter share this payment earns; false when one did not land. Must be idempotent. */
  shares: () => Promise<boolean>
  /** Record the promoter attribution this checkout carries, if any; false when it did not land. Must be idempotent. */
  attribution: () => Promise<boolean>
  /** The steps that must happen once: only after the delivery that wrote (or found `comp`). */
  firstTime: (outcome: Exclude<PlanPaymentOutcome, 'replay'>) => Promise<void>
  /** Said when the grant failed. */
  onGrantFailed: (e: unknown) => void
}

export async function runOneTimeSteps(deps: OneTimeStepsDeps): Promise<{ outcome: PlanWebhookOutcome; grant: PlanPaymentOutcome | null }> {
  let grant: PlanPaymentOutcome
  try {
    grant = await deps.applyGrant()
  } catch (e) {
    deps.onGrantFailed(e)
    // Nothing below has run: the grant is replay-checked by the payment id, so the redelivery starts clean.
    return { outcome: 'retry', grant: null }
  }
  const sharesOk = grant === 'comp' ? true : await deps.shares().catch(() => false)
  const attributionOk = await deps.attribution().catch(() => false)
  if (grant !== 'replay') await deps.firstTime(grant)
  return { outcome: sharesOk && attributionOk ? 'done' : 'retry', grant }
}
