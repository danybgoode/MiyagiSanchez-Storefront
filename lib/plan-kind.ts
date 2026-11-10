/**
 * lib/plan-kind.ts — which paid plan a Stripe checkout or subscription belongs to (epic 08 ·
 * plan-tienda-three-free-months S2.1/S2.2, README D6).
 *
 * Miyagi Sánchez sells two platform plans, Plan Negocio and Plan Tienda. Every Stripe Checkout Session we create for
 * one carries `metadata.kind` = the plan's kind, and a monthly one stamps the same metadata on the SUBSCRIPTION
 * (`subscription_data.metadata`, `lib/stripe-subscriptions.ts`). That metadata is written by OUR server when it
 * creates the session; the browser only ever sends a cadence, so nothing a client sends can set it. And a plan
 * subscription lives on the PLATFORM Stripe account: the webhook retrieves it there, so a subscription a merchant
 * creates on their own connected account (where they could write any metadata) cannot be retrieved as one of ours.
 *
 * That is how a subscription is recognised as Tienda or Negocio: its retrieved metadata kind, cross-checked against
 * the price's `lookup_key` the seed scripts set (`lib/plan-subscription-sync.ts`). The price id the backend's plan
 * carries is not used for routing: knowing it needs a backend round trip per event, and a backend outage would then
 * leave a cancellation unrouted.
 *
 * Pure + next-free: the webhook, the checkout rules and their specs all read it.
 */
import { NEGOCIO_CHECKOUT_KIND } from './negocio-kind'

/** `metadata.kind` on every Plan Tienda checkout session and subscription. */
export const TIENDA_CHECKOUT_KIND = 'tienda'

export type PaidPlan = 'negocio' | 'tienda'

export const PAID_PLANS: readonly PaidPlan[] = ['negocio', 'tienda']

/** The metadata kind of each paid plan. One row per plan, so a third plan is a type error until it has a kind. */
export const PLAN_CHECKOUT_KINDS: Readonly<Record<PaidPlan, string>> = Object.freeze({
  negocio: NEGOCIO_CHECKOUT_KIND,
  tienda: TIENDA_CHECKOUT_KIND,
})

/**
 * The Stripe Price `lookup_key` each plan's monthly price is seeded with (`scripts/seed-negocio-plan.mjs`,
 * `scripts/seed-tienda-plan.mjs`). Keep in step with those scripts: they cannot import this module.
 */
export const PLAN_PRICE_LOOKUP_KEYS: Readonly<Record<PaidPlan, string>> = Object.freeze({
  negocio: 'negocio_monthly',
  tienda: 'tienda_monthly',
})

/** The paid plan a `metadata.kind` names, or null for anything else (another product's kind, missing, garbage). */
export function paidPlanOfKind(kind: unknown): PaidPlan | null {
  for (const plan of PAID_PLANS) if (kind === PLAN_CHECKOUT_KINDS[plan]) return plan
  return null
}

/** The plan a price lookup key belongs to, or null when the key is not one of the seeded plan prices. */
export function paidPlanOfLookupKey(lookupKey: unknown): PaidPlan | null {
  for (const plan of PAID_PLANS) if (lookupKey === PLAN_PRICE_LOOKUP_KEYS[plan]) return plan
  return null
}

/** The plan's name as merchants read it. */
export const PLAN_DISPLAY_NAMES: Readonly<Record<PaidPlan, string>> = Object.freeze({
  negocio: 'Plan Negocio',
  tienda: 'Plan Tienda',
})
