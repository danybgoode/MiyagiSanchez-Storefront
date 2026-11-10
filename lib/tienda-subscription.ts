/**
 * lib/tienda-subscription.ts
 *
 * Server-side bridge to the Medusa Commerce Plan Tienda subscription (epic 08 · plan-tienda-three-free-months S2.2,
 * README D3). The mirror of `lib/negocio-subscription.ts`: the monthly Plan Tienda is a Medusa Commerce plan of kind
 * `tienda_plan`, seeded by `scripts/seed-tienda-plan.mjs` through `POST /internal/setup-tienda-plan`, and read and
 * lapsed through `/internal/tienda-subscription` (Backend #228). The body is the shared
 * `lib/plan-subscription-bridge.ts`; only the route differs.
 *
 * The Backend scopes every read and write to the Tienda plan's own row, so a Tienda subscription can never answer as
 * Negocio here, nor the reverse — which is why the webhook must send a Tienda subscription's status to THIS route and
 * no other (`lib/plan-subscription-sync.ts`).
 *
 * Three states, never two: a failed read is `unavailable: true`; `reason: 'no_plan'` (not seeded yet) is a known
 * "not subscribed".
 *
 * server-only (holds MEDUSA_INTERNAL_SECRET).
 */
import 'server-only'
import { getPlanSubscription, setPlanSubscriptionStatus, type PlanSubscription } from './plan-subscription-bridge'

export { TIENDA_CHECKOUT_KIND } from './plan-kind'

export type TiendaSubscription = PlanSubscription

/** Plan Tienda is per SHOP, like Negocio: only that shop's subscription counts. */
export function getTiendaSubscription(sellerClerkId: string, shopId: string): Promise<TiendaSubscription> {
  return getPlanSubscription('tienda-subscription', sellerClerkId, shopId)
}

/** Send a Tienda subscription's Stripe status, as Stripe reports it, to the Backend. 0 = failure (see the bridge). */
export function setTiendaSubscriptionStatus(stripeSubscriptionId: string, status: string): Promise<number> {
  return setPlanSubscriptionStatus('tienda-subscription', stripeSubscriptionId, status)
}
