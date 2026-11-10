/**
 * lib/plan-payment.ts — writing a paid one-time plan payment onto the shop (plans-gratis-negocio S1.3; made
 * plan-neutral by plan-tienda-three-free-months S2.1, README D3/D6).
 *
 * The loop every dated grant goes through — Negocio's yearly payment, a promoter package, Plan Tienda's yearly payment:
 *
 *   read the shop's metadata → decide (pure: `decideNegocioPayment` / `decideTiendaPayment`) → write through ONE
 *   guarded statement (`merge_shop_metadata_guards`, built by `grantWriteRpcArgs`) → if a guard fired, re-read and
 *   decide again.
 *
 * Why a loop and not one write: the decision depends on three keys (both grants and the trial, `PLAN_PAYMENT_READS`
 * in lib/plan.ts). If any of them changes between the read and the write, the write matches no row, and the right
 * answer is to decide again from the truth — never to write the stale decision. Three attempts is far more than two
 * real payments for one shop landing in the same instant can need; past that something is wrong and a person must
 * look (the caller alerts).
 *
 * Why the replay rule lives in the decision, not here: the grant remembers the payment ids it counted, so a replayed
 * webhook decides `replay` and this loop writes nothing — it never needs to know about Stripe.
 *
 * The I/O is injected (`PlanPaymentDeps`), so the loop's behaviour — replay, retry after a lost race, giving up — is
 * tested without a database. `lib/negocio-webhook.ts` wires it to Supabase.
 */
import {
  NEGOCIO_GRANT_KEY,
  TIENDA_GRANT_KEY,
  decideNegocioPayment,
  decideTiendaPayment,
  grantWriteRpcArgs,
  type GrantWriteRpcArgs,
  type PlanGrantKey,
  type PlanGrantWrite,
} from './plan'
import type { PaidPlan } from './plan-kind'

export type PlanPaymentInput = {
  shopId: string
  /** A stable id for the payment (the Stripe Checkout Session id, `transfer:<id>`): the replay key. */
  paymentId: string
  months: number
  note: string
  now?: Date
}

/** `comp` only for Negocio: a permanent Negocio has nothing to extend (Plan Tienda has no comp, README D3). */
export type PlanPaymentOutcome = 'written' | 'replay' | 'comp'

export type PlanPaymentDeps = {
  /** The shop row's metadata, or `null` when no row has that id. Throws when the read itself failed. */
  readMetadata: (shopId: string) => Promise<{ metadata: unknown } | null>
  /** Runs `merge_shop_metadata_guards` with these exact arguments; true when the row was written, false when a guard
   *  fired (nothing written). Throws when the call itself failed. */
  writeGrant: (args: GrantWriteRpcArgs) => Promise<boolean>
}

export const PLAN_PAYMENT_ATTEMPTS = 3

/** The metadata key each paid plan's dated grant lives under. */
export const PLAN_GRANT_KEYS: Readonly<Record<PaidPlan, PlanGrantKey>> = Object.freeze({
  negocio: NEGOCIO_GRANT_KEY,
  tienda: TIENDA_GRANT_KEY,
})

type Decided = { action: 'replay' } | { action: 'comp' } | PlanGrantWrite

/** The pure decision for `plan` — each plan's own rules, never restated here. */
export function decidePlanPayment(plan: PaidPlan, metadata: unknown, input: PlanPaymentInput): Decided {
  const payment = { paymentId: input.paymentId, months: input.months, note: input.note, now: input.now }
  return plan === 'negocio' ? decideNegocioPayment(metadata, payment) : decideTiendaPayment(metadata, payment)
}

/** Write the paid months onto the shop's `plan` grant: compare-and-swap, re-read and retried on a concurrent change. */
export async function applyPlanPayment(plan: PaidPlan, input: PlanPaymentInput, deps: PlanPaymentDeps): Promise<PlanPaymentOutcome> {
  const key = PLAN_GRANT_KEYS[plan]
  for (let attempt = 0; attempt < PLAN_PAYMENT_ATTEMPTS; attempt += 1) {
    const shop = await deps.readMetadata(input.shopId)
    if (!shop) throw new Error(`no shop row for id ${input.shopId}`)
    const decision = decidePlanPayment(plan, shop.metadata, input)
    if (decision.action !== 'write') return decision.action
    // ONE statement: the paid grant and, for a Negocio payment over a live Tienda grant, that grant moved forward
    // (README D4) land together or not at all — and only if every key the decision read is still exactly as read.
    if (await deps.writeGrant(grantWriteRpcArgs(input.shopId, key, decision))) return 'written'
    // A guard fired: one of the three keys changed between the read and the write. Re-read and decide again.
  }
  throw new Error('grant write lost three compare-and-swap races')
}
