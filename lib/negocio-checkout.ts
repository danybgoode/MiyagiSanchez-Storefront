/**
 * lib/negocio-checkout.ts — buying a paid plan (epic 08 · plans-gratis-negocio S1.3, README D3; takes the plan as a
 * parameter since plan-tienda-three-free-months S2.1/S2.2, README D6).
 *
 * For each plan, Plan Negocio and Plan Tienda:
 *   - `month` → a Stripe subscription on the plan's monthly price. The price id is the one the Backend's plan carries
 *               (`stripe_price_id` from `GET /internal/<plan>-subscription`, seeded by scripts/seed-<plan>-plan.mjs) —
 *               never anything the client sends.
 *   - `year`  → ONE card payment of the plan's yearly price. The webhook turns it into a dated 12-month grant under
 *               the plan's key. Plan Negocio's offers card installments (meses sin intereses: Stripe allows them on
 *               one-time payments only). Plan Tienda's does NOT: at $228 a year it sits below what Mexican card
 *               installments are offered for, and installments are not part of what was decided for Plan Tienda
 *               (README D5) — one plain card payment.
 *
 * The refusal rules are pure functions (`decideNegocioCheckout`, `decideTiendaCheckout`) so they are tested without
 * Stripe; this I/O shell only reads what they need and creates the session. Every amount comes from the plan's
 * pricing module; nothing a client sends sets a price.
 *
 * server-only (Stripe + the Medusa internal secret).
 */
import 'server-only'
import { createOneTimeCheckout, createSubscriptionCheckout } from '@/lib/stripe-subscriptions'
import { getNegocioSubscription } from '@/lib/negocio-subscription'
import { getTiendaSubscription } from '@/lib/tienda-subscription'
import { resolvePlan } from '@/lib/plan-server'
import { NEGOCIO_CURRENCY, NEGOCIO_PRICE_YEARLY_CENTS, NEGOCIO_YEARLY_MONTHS } from '@/lib/negocio-pricing'
import { TIENDA_CURRENCY, TIENDA_PRICE_YEARLY_CENTS, TIENDA_YEARLY_MONTHS } from '@/lib/tienda-pricing'
import { PLAN_CHECKOUT_KINDS, type PaidPlan } from '@/lib/plan-kind'
import {
  PLAN_CHECKOUT_WINDOW_MS,
  decideNegocioCheckout,
  decideTiendaCheckout,
  monthlyFirstChargeAt,
  subscriptionFact,
  type NegocioCadence,
  type NegocioCheckoutDecision,
} from '@/lib/negocio-checkout-rules'

export { decideNegocioCheckout, decideTiendaCheckout, coerceNegocioCadence, type NegocioCadence } from '@/lib/negocio-checkout-rules'

/** A fixed canonical origin — never a (spoofable) request Host. */
function canonicalOrigin(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com'
}

export type StartPlanCheckoutResult =
  | { ok: true; url: string }
  | { ok: false; status: number; error: string }

/** What differs per plan at checkout. One row per plan: a third plan is a type error until it is written here. */
const PLAN_CHECKOUT: Readonly<Record<PaidPlan, {
  readSubscription: typeof getNegocioSubscription
  yearlyCents: number
  currency: string
  yearlyMonths: number
  productName: string
  installments: boolean
}>> = {
  negocio: {
    readSubscription: getNegocioSubscription,
    yearlyCents: NEGOCIO_PRICE_YEARLY_CENTS,
    currency: NEGOCIO_CURRENCY,
    yearlyMonths: NEGOCIO_YEARLY_MONTHS,
    productName: `Negocio — Miyagi Sánchez (${NEGOCIO_YEARLY_MONTHS} meses)`,
    installments: true,
  },
  tienda: {
    readSubscription: getTiendaSubscription,
    yearlyCents: TIENDA_PRICE_YEARLY_CENTS,
    currency: TIENDA_CURRENCY,
    yearlyMonths: TIENDA_YEARLY_MONTHS,
    productName: `Plan Tienda — Miyagi Sánchez (${TIENDA_YEARLY_MONTHS} meses)`,
    installments: false,
  },
}

export async function startPlanCheckout(plan: PaidPlan, input: {
  shopId: string
  shopMetadata: unknown
  sellerClerkId: string
  buyerEmail?: string
  cadence: NegocioCadence
}): Promise<StartPlanCheckoutResult> {
  const { shopId, sellerClerkId, cadence } = input
  const cfg = PLAN_CHECKOUT[plan]
  const state = await resolvePlan(input.shopMetadata, { sellerClerkId, shopId })

  let decision: NegocioCheckoutDecision
  // The monthly subscription of the plan being bought, read once and reused for its price id below.
  let ownSubscription: Awaited<ReturnType<typeof getNegocioSubscription>> | null = null
  if (plan === 'negocio') {
    decision = decideNegocioCheckout({ cadence, plan: state })
  } else {
    // Plan Tienda reads BOTH subscriptions itself: the derived plan can hide them behind a live trial (see
    // `decideTiendaCheckout`). Read in parallel — both are needed for every Tienda checkout.
    const [negocioSub, tiendaSub] = await Promise.all([getNegocioSubscription(sellerClerkId, shopId), getTiendaSubscription(sellerClerkId, shopId)])
    ownSubscription = tiendaSub
    decision = decideTiendaCheckout({
      cadence,
      plan: state,
      negocioSubscription: subscriptionFact(negocioSub),
      tiendaSubscription: subscriptionFact(tiendaSub),
    })
  }
  if (!decision.ok) return decision

  const origin = canonicalOrigin()
  const successUrl = `${origin}/shop/manage/negocio?negocio=activated`
  const cancelUrl = `${origin}/shop/manage/negocio?negocio=cancelled`
  // Two concurrent requests for the same shop, plan and cadence (two tabs, an agent retrying) get the SAME Stripe
  // session within a 10-minute window, so they can never become two subscriptions or two yearly payments (Codex
  // security, #473). The plan is in the key so a Tienda checkout can never be answered with a cached Negocio one.
  // Stripe keeps idempotency keys for 24 hours; the window bucket lets a deliberate retry after it start fresh.
  const idempotencyKey = `${plan}:${shopId}:${cadence}:${Math.floor(Date.now() / PLAN_CHECKOUT_WINDOW_MS)}`
  const metadata: Record<string, string> = {
    kind: PLAN_CHECKOUT_KINDS[plan],
    shop_id: shopId,
    seller_clerk_id: sellerClerkId,
    cadence,
  }

  if (cadence === 'month') {
    const sub = ownSubscription ?? (await cfg.readSubscription(sellerClerkId, shopId))
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
      // During the free trial the first charge waits for its end (the card is saved today, nothing is charged).
      trialEnd: monthlyFirstChargeAt(state),
    })
    return { ok: true, url }
  }

  const url = await createOneTimeCheckout({
    amountCents: cfg.yearlyCents,
    currency: cfg.currency,
    productName: cfg.productName,
    successUrl,
    cancelUrl,
    metadata: { ...metadata, months: String(cfg.yearlyMonths) },
    buyerEmail: input.buyerEmail,
    installments: cfg.installments,
    // Card only: the grant is written on `checkout.session.completed`, so the payment must be settled then (and
    // installments are a card feature anyway). The webhook also refuses an unpaid session.
    paymentMethodTypes: ['card'],
    idempotencyKey,
  })
  return { ok: true, url }
}

/** Buying Plan Negocio (the routes and the `start_negocio` tool). */
export function startNegocioCheckout(input: Parameters<typeof startPlanCheckout>[1]): Promise<StartPlanCheckoutResult> {
  return startPlanCheckout('negocio', input)
}

/** Buying Plan Tienda (its route and the `start_tienda` tool). */
export function startTiendaCheckout(input: Parameters<typeof startPlanCheckout>[1]): Promise<StartPlanCheckoutResult> {
  return startPlanCheckout('tienda', input)
}
