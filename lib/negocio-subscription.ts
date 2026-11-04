/**
 * lib/negocio-subscription.ts
 *
 * Server-side bridge to the Medusa Commerce Negocio subscription (epic 08 · plans-gratis-negocio S1.2, README D1/D3).
 * A clone of `lib/ml-sync-subscription.ts`: Medusa Commerce is the SOURCE OF TRUTH for "does this seller have a live
 * monthly Negocio subscription?" (AGENTS rule #1). Reads and writes go through the Backend's internal routes
 * (`/internal/negocio-subscription`, Backend PR #224).
 *
 * Three states, never two: a read that FAILED is reported as `unavailable: true`, so the plan seam can say "could
 * not look" instead of a confident "Gratis". Gating still fails closed (an unavailable read never grants).
 *
 * server-only (holds MEDUSA_INTERNAL_SECRET).
 */
import 'server-only'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const INTERNAL_SECRET = process.env.MEDUSA_INTERNAL_SECRET ?? ''

/** Metadata `kind` on the Stripe checkout session + subscription, so the webhook routes a Negocio purchase. */
export const NEGOCIO_CHECKOUT_KIND = 'negocio'

export type NegocioSubscription = {
  active: boolean
  /** True when the lookup failed or the plan is not seeded — "could not look", not "none". */
  unavailable: boolean
  plan_id: string | null
  /** The MONTHLY recurring price (the plan's `stripe_price_id` column). */
  stripe_price_id: string | null
  price_cents: number | null
  subscription_id: string | null
}

const UNAVAILABLE: NegocioSubscription = {
  active: false, unavailable: true, plan_id: null, stripe_price_id: null, price_cents: null, subscription_id: null,
}

/**
 * Negocio is per SHOP (README D1): the marketplace shop id is required and only that shop's subscription counts, so one
 * monthly payment never opens Negocio on every shop the same person owns.
 */
export async function getNegocioSubscription(sellerClerkId: string, shopId: string): Promise<NegocioSubscription> {
  if (!INTERNAL_SECRET || !shopId) return UNAVAILABLE
  try {
    const res = await fetch(
      `${MEDUSA_BASE}/internal/negocio-subscription?seller_clerk_id=${encodeURIComponent(sellerClerkId)}` +
        `&shop_id=${encodeURIComponent(shopId)}`,
      { headers: { 'x-internal-secret': INTERNAL_SECRET }, cache: 'no-store', signal: AbortSignal.timeout(4000) },
    )
    if (!res.ok) return UNAVAILABLE
    const body = (await res.json()) as Partial<NegocioSubscription> & { reason?: string }
    // `reason: 'error'` and `reason: 'no_plan'` are "could not look"; a clean answer has no reason.
    if (body.reason === 'error' || body.reason === 'no_plan') return { ...UNAVAILABLE, plan_id: body.plan_id ?? null }
    return {
      active: body.active === true,
      unavailable: false,
      plan_id: body.plan_id ?? null,
      stripe_price_id: body.stripe_price_id ?? null,
      price_cents: typeof body.price_cents === 'number' ? body.price_cents : null,
      subscription_id: body.subscription_id ?? null,
    }
  } catch {
    return UNAVAILABLE
  }
}

/**
 * Flip a Negocio subscription's status by its Stripe id (the webhook lapse path). Returns the number of Medusa rows
 * actually updated; 0 means nothing changed, which the caller must treat as a failure on a money path.
 */
export async function setNegocioSubscriptionStatus(stripeSubscriptionId: string, status: string): Promise<number> {
  const res = await fetch(`${MEDUSA_BASE}/internal/negocio-subscription`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
    body: JSON.stringify({ stripe_subscription_id: stripeSubscriptionId, status }),
  })
  if (!res.ok) throw new Error(`negocio-subscription PATCH ${res.status}`)
  const body = (await res.json()) as { updated?: number }
  return typeof body.updated === 'number' ? body.updated : 0
}
