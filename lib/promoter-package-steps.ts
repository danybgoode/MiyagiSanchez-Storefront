/**
 * lib/promoter-package-steps.ts — the ORDER of what a promoter package paid by card does, with the I/O injected
 * (plan-tienda S4.1 review; the same discipline as lib/plan-one-time-steps.ts for the merchant's own yearly payment).
 *
 *   1. grants      — every grant of the package under the session id (`applyPackageGrants`). Each half is
 *                    replay-checked by that id in its own grant's `payments`, so a redelivery after a failure between
 *                    the Negocio and the Tienda write completes only the missing half. A throw answers `retry` and
 *                    nothing below runs.
 *   2. first time? — `written` (this delivery wrote a grant, possibly the missing half) is the first time; `replay`
 *                    (every grant already counted) is not. A package with no grant (the retired free setup) has nothing
 *                    to remember the payment, so the attribution is asked instead: already paid ⇒ not the first time.
 *                    If that read fails we cannot tell, so we answer `retry` rather than risk a second receipt.
 *   3. attribution — on every delivery that got past the grants (written, replay, none). Idempotent:
 *                    `markAttributionPaid` looks the row up by (promoter, shop, sku) and updates it to the same values;
 *                    a racing insert hits `marketplace_promoter_attributions_uniq` (23505, handled); `skipAccrual`, so
 *                    no commission row is ever written for a package (settled at source: there is no commission or
 *                    settlement record to repeat).
 *   4. one-time    — the merchant's receipt email and the ✅ alert: only on the first time, so a retry never re-sends
 *                    a message. They run even if the attribution failed: the grant DID land, and the redelivery that
 *                    records the attribution will be a replay. Without a grant they wait for the attribution, the
 *                    payment's only memory.
 * A failed attribution answers `retry`. A permanent Negocio (`comp`) writes nothing and answers `done` after one alert
 * for a refund (a retry would change nothing).
 */
import type { PlanWebhookOutcome } from './plan-subscription-sync'

export type PackageStepsDeps = {
  /** `applyPackageGrants` for this session. Throws when a grant write failed. */
  applyGrants: () => Promise<'written' | 'replay' | 'comp' | 'none'>
  /** For a package with no grant: is its attribution already paid? Throws when it could not be read. */
  alreadyPaid: () => Promise<boolean>
  /** Record the attribution (idempotent); false when it did not land. */
  attribution: () => Promise<boolean>
  /** The receipt and the ✅ alert (`first`), or the refund alert (`comp`). */
  oneTime: (kind: 'first' | 'comp') => Promise<void>
  onGrantFailed: (e: unknown) => void
}

export async function runPackageSteps(deps: PackageStepsDeps): Promise<PlanWebhookOutcome> {
  let grants: Awaited<ReturnType<PackageStepsDeps['applyGrants']>>
  try {
    grants = await deps.applyGrants()
  } catch (e) {
    deps.onGrantFailed(e)
    return 'retry'
  }
  if (grants === 'comp') {
    await deps.oneTime('comp')
    return 'done'
  }
  let first: boolean
  if (grants === 'none') {
    try {
      first = !(await deps.alreadyPaid())
    } catch {
      return 'retry'
    }
  } else {
    first = grants === 'written'
  }
  const recorded = await deps.attribution().catch(() => false)
  // With no grant, the attribution IS the only memory of this payment: say it once it is recorded, or a redelivery
  // (which would again find it unpaid) would say it a second time.
  if (first && (grants !== 'none' || recorded)) await deps.oneTime('first')
  return recorded ? 'done' : 'retry'
}
