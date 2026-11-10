/**
 * lib/plan-subscription-answer.ts — what a Backend `GET /internal/<plan>-subscription` answer means (plan-tienda
 * S2.2). Pure, so the three states are tested without a backend; `lib/plan-subscription-bridge.ts` is the I/O.
 *
 * The Backend answers (Backend #228, the same for Plan Negocio and Plan Tienda):
 *   200 `{ active, plan_id, stripe_price_id, price_cents, subscription_id }`  — a real read;
 *   200 `{ active: false, reason: 'no_plan', plan_id: null }`                 — the plan is not seeded;
 *   200 `{ active: false, reason: 'error', … }`                               — a read FAILED.
 */

export type PlanSubscription = {
  active: boolean
  /** True when the lookup failed — "could not look", not "none". */
  unavailable: boolean
  plan_id: string | null
  /** The MONTHLY recurring price (the plan's `stripe_price_id` column). */
  stripe_price_id: string | null
  price_cents: number | null
  /** The LIVE subscription's Stripe id (`sub_…`), or null. */
  subscription_id: string | null
}

export const UNAVAILABLE_PLAN_SUBSCRIPTION: PlanSubscription = Object.freeze({
  active: false, unavailable: true, plan_id: null, stripe_price_id: null, price_cents: null, subscription_id: null,
}) as PlanSubscription

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

export function readPlanSubscriptionAnswer(raw: unknown): PlanSubscription {
  if (!raw || typeof raw !== 'object') return UNAVAILABLE_PLAN_SUBSCRIPTION
  const body = raw as Record<string, unknown>
  // `reason: 'error'` is "could not look" — it keeps the resolved `plan_id`, which the activation webhook needs to
  // record a PAID subscription even when this seller's rows could not be listed.
  if (body.reason === 'error') return { ...UNAVAILABLE_PLAN_SUBSCRIPTION, plan_id: str(body.plan_id) }
  // `reason: 'no_plan'` is a KNOWN absence: with no plan seeded nobody can hold a monthly subscription, so it is "not
  // subscribed", and the yearly checkout (which needs no plan) stays open (Codex, #471). The monthly checkout still
  // refuses: it has no price to sell.
  if (body.reason === 'no_plan') return { ...UNAVAILABLE_PLAN_SUBSCRIPTION, unavailable: false }
  // Any other reason we do not know is not a confident answer either.
  if (body.reason !== undefined && body.reason !== null) return UNAVAILABLE_PLAN_SUBSCRIPTION
  if (typeof body.active !== 'boolean') return UNAVAILABLE_PLAN_SUBSCRIPTION
  return {
    active: body.active,
    unavailable: false,
    plan_id: str(body.plan_id),
    stripe_price_id: str(body.stripe_price_id),
    price_cents: typeof body.price_cents === 'number' ? body.price_cents : null,
    subscription_id: str(body.subscription_id),
  }
}
