/**
 * lib/negocio-checkout.ts — buying Negocio (epic 08 · plans-gratis-negocio S1.3, README D3).
 *
 *   - `month` → a Stripe subscription on the Negocio plan's monthly price (seeded by scripts/seed-negocio-plan.mjs).
 *   - `year`  → ONE payment of the yearly price with card installments offered (meses sin intereses: Stripe allows
 *               them on one-time payments only). The webhook turns it into a dated 12-month `negocio_grant`.
 *
 * The refusal rules are a pure function (`decideNegocioCheckout`) so they are tested without Stripe; the I/O shell
 * (`startNegocioCheckout`) only reads the plan and creates the session. Every amount comes from
 * `lib/negocio-pricing.ts`; nothing a client sends sets a price.
 *
 * server-only (Stripe + the Medusa internal secret).
 */
import 'server-only'
import { createOneTimeCheckout, createSubscriptionCheckout } from '@/lib/stripe-subscriptions'
import { getNegocioSubscription, NEGOCIO_CHECKOUT_KIND } from '@/lib/negocio-subscription'
import { resolvePlan } from '@/lib/plan-server'
import { NEGOCIO_CURRENCY, NEGOCIO_PRICE_YEARLY_CENTS, NEGOCIO_YEARLY_MONTHS } from '@/lib/negocio-pricing'
import { decideNegocioCheckout, type NegocioCadence } from '@/lib/negocio-checkout-rules'

export { decideNegocioCheckout, coerceNegocioCadence, type NegocioCadence } from '@/lib/negocio-checkout-rules'

/** A fixed canonical origin — never a (spoofable) request Host. */
function canonicalOrigin(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com'
}

export type StartNegocioCheckoutResult =
  | { ok: true; url: string }
  | { ok: false; status: number; error: string }

export async function startNegocioCheckout(input: {
  shopId: string
  shopMetadata: unknown
  sellerClerkId: string
  buyerEmail?: string
  cadence: NegocioCadence
}): Promise<StartNegocioCheckoutResult> {
  const { shopId, sellerClerkId, cadence } = input
  const plan = await resolvePlan(input.shopMetadata, { sellerClerkId, shopId })
  const decision = decideNegocioCheckout({ cadence, plan })
  if (!decision.ok) return decision

  const origin = canonicalOrigin()
  const successUrl = `${origin}/shop/manage/negocio?negocio=activated`
  const cancelUrl = `${origin}/shop/manage/negocio?negocio=cancelled`
  // Two concurrent requests for the same shop and cadence (two tabs, an agent retrying) get the SAME Stripe session
  // within a 10-minute window, so they can never become two subscriptions or two yearly payments (Codex security,
  // #473). Stripe keeps idempotency keys for 24 hours; the window bucket lets a deliberate retry after it start fresh.
  const idempotencyKey = `negocio:${shopId}:${cadence}:${Math.floor(Date.now() / 600_000)}`
  const metadata: Record<string, string> = {
    kind: NEGOCIO_CHECKOUT_KIND,
    shop_id: shopId,
    seller_clerk_id: sellerClerkId,
    cadence,
  }

  if (cadence === 'month') {
    const sub = await getNegocioSubscription(sellerClerkId, shopId)
    if (sub.unavailable || !sub.stripe_price_id) {
      return { ok: false, status: 503, error: 'El pago mensual no está disponible en este momento. Intenta con el pago anual o más tarde.' }
    }
    const url = await createSubscriptionCheckout({
      priceId: sub.stripe_price_id,
      successUrl,
      cancelUrl,
      metadata,
      buyerEmail: input.buyerEmail,
      idempotencyKey,
    })
    return { ok: true, url }
  }

  const url = await createOneTimeCheckout({
    amountCents: NEGOCIO_PRICE_YEARLY_CENTS,
    currency: NEGOCIO_CURRENCY,
    productName: `Negocio — Miyagi Sánchez (${NEGOCIO_YEARLY_MONTHS} meses)`,
    successUrl,
    cancelUrl,
    metadata: { ...metadata, months: String(NEGOCIO_YEARLY_MONTHS) },
    buyerEmail: input.buyerEmail,
    installments: true,
    // Card only: the grant is written on `checkout.session.completed`, so the payment must be settled then (and
    // installments are a card feature anyway). The webhook also refuses an unpaid session.
    paymentMethodTypes: ['card'],
    idempotencyKey,
  })
  return { ok: true, url }
}
