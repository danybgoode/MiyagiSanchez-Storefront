/**
 * lib/negocio-subscription.ts
 *
 * Server-side bridge to the Medusa Commerce Negocio subscription (epic 08 · plans-gratis-negocio S1.2, README D1/D3).
 * Medusa Commerce is the SOURCE OF TRUTH for "does this seller have a live monthly Negocio subscription?" (AGENTS
 * rule #1). Reads and writes go through the Backend's internal routes (`/internal/negocio-subscription`).
 *
 * Since plan-tienda S2.2 the body is the plan-neutral `lib/plan-subscription-bridge.ts`, shared with Plan Tienda
 * (`lib/tienda-subscription.ts`); this file only names Negocio's route.
 *
 * Three states, never two: a read that FAILED is reported as `unavailable: true`, so the plan seam can say "could
 * not look" instead of a confident "Gratis". Gating still fails closed (an unavailable read never grants).
 *
 * server-only (holds MEDUSA_INTERNAL_SECRET).
 */
import 'server-only'
import { getPlanSubscription, setPlanSubscriptionStatus, type PlanSubscription } from './plan-subscription-bridge'

/** Metadata `kind` on the Stripe checkout session + subscription, so the webhook routes a Negocio purchase. */
export { NEGOCIO_CHECKOUT_KIND } from './negocio-kind'

export type NegocioSubscription = PlanSubscription

/** Negocio is per SHOP (README D1): only that shop's subscription counts. */
export function getNegocioSubscription(sellerClerkId: string, shopId: string): Promise<NegocioSubscription> {
  return getPlanSubscription('negocio-subscription', sellerClerkId, shopId)
}

/**
 * Send a Negocio subscription's Stripe status, as Stripe reports it, to the Backend (the webhook's status sync).
 * Returns the rows written or already cancelled; 0 means nothing matched, which the caller must treat as a failure.
 */
export function setNegocioSubscriptionStatus(stripeSubscriptionId: string, status: string): Promise<number> {
  return setPlanSubscriptionStatus('negocio-subscription', stripeSubscriptionId, status)
}
