/**
 * lib/plan-subscription-bridge.ts
 *
 * The ONE server-side bridge to a paid plan's monthly subscription in Medusa Commerce (plans-gratis-negocio S1.2;
 * made plan-neutral by plan-tienda-three-free-months S2.2, README D3). Medusa Commerce is the SOURCE OF TRUTH for
 * "does this shop have a live monthly subscription to this plan?" (AGENTS rule #1). Plan Negocio and Plan Tienda have
 * the same two internal routes on the Backend (`/internal/negocio-subscription`, `/internal/tienda-subscription`,
 * Backend #228), so both plans go through this one file and cannot drift apart: `lib/negocio-subscription.ts` and
 * `lib/tienda-subscription.ts` only name their route.
 *
 * Three states, never two: a read that FAILED is reported as `unavailable: true`, so the plan seam can say "could
 * not look" instead of a confident "none". Gating still fails closed (an unavailable read never grants).
 *
 * The answer's interpretation is a pure function (`readPlanSubscriptionAnswer`) so the three states are tested
 * without a backend.
 *
 * server-only (holds MEDUSA_INTERNAL_SECRET).
 */
import 'server-only'
import { readPlanSubscriptionAnswer, UNAVAILABLE_PLAN_SUBSCRIPTION, type PlanSubscription } from './plan-subscription-answer'

export type { PlanSubscription } from './plan-subscription-answer'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const INTERNAL_SECRET = process.env.MEDUSA_INTERNAL_SECRET ?? ''

/** The Backend route of each plan's subscription: `/internal/<route>`. */
export type PlanSubscriptionRoute = 'negocio-subscription' | 'tienda-subscription'

/**
 * A plan is per SHOP: the marketplace shop id is required and only that shop's subscription counts, so one monthly
 * payment never opens the plan on every shop the same person owns.
 */
export async function getPlanSubscription(route: PlanSubscriptionRoute, sellerClerkId: string, shopId: string): Promise<PlanSubscription> {
  if (!INTERNAL_SECRET || !shopId) return UNAVAILABLE_PLAN_SUBSCRIPTION
  try {
    const res = await fetch(
      `${MEDUSA_BASE}/internal/${route}?seller_clerk_id=${encodeURIComponent(sellerClerkId)}` +
        `&shop_id=${encodeURIComponent(shopId)}`,
      { headers: { 'x-internal-secret': INTERNAL_SECRET }, cache: 'no-store', signal: AbortSignal.timeout(4000) },
    )
    if (!res.ok) return UNAVAILABLE_PLAN_SUBSCRIPTION
    return readPlanSubscriptionAnswer(await res.json())
  } catch {
    return UNAVAILABLE_PLAN_SUBSCRIPTION
  }
}

/**
 * Send a plan subscription's status, by its Stripe id, to the Backend's lapse path. `status` is STRIPE'S status as it
 * is (`active`, `unpaid`, `incomplete_expired`, …): the Backend decides what is live and what is final (Backend
 * #228). Returns `{ updated }` = rows written or already cancelled; 0 means nothing matched, which the caller must
 * treat as a failure on a money path.
 */
export async function setPlanSubscriptionStatus(route: PlanSubscriptionRoute, stripeSubscriptionId: string, status: string): Promise<number> {
  const res = await fetch(`${MEDUSA_BASE}/internal/${route}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
    body: JSON.stringify({ stripe_subscription_id: stripeSubscriptionId, status }),
  })
  if (!res.ok) throw new Error(`${route} PATCH ${res.status}`)
  const body = (await res.json()) as { updated?: number }
  return typeof body.updated === 'number' ? body.updated : 0
}
