/**
 * lib/negocio-webhook.ts — what a paid Negocio checkout does (epic 08 · plans-gratis-negocio S1.3, README D6).
 *
 * Kept out of `app/api/webhooks/stripe/route.ts` (already ~1,600 lines): the route only dispatches here by
 * `metadata.kind === 'negocio'`.
 *
 *   - Subscription complete (monthly) → record the Medusa Commerce subscription against the Negocio plan, keyed by the
 *     shop (Negocio is per shop). `/store/subscriptions` dedupes on the Stripe subscription id, so a replay is safe.
 *   - One-time complete (yearly, or a promoter package by card) → add the paid months to the shop's `negocio_grant`
 *     with a compare-and-swap through `merge_shop_metadata` (`equals` guard). The grant remembers the payment ids it
 *     counted, so a replayed webhook adds nothing (`decideNegocioPayment`).
 *   - Status changes and cancellations → flip the Medusa subscription; a lapse returns the shop to its trial or Gratis
 *     on the next read.
 *
 * The seller PAID in every one of these paths, so a write that does not land alerts on Telegram for hand repair —
 * Stripe will not retry, because the route answers 200.
 *
 * server-only.
 */
import 'server-only'
import type Stripe from 'stripe'
import { stripe } from '@/lib/stripe'
import { db } from '@/lib/supabase'
import { tg } from '@/lib/telegram'
import { getNegocioSubscription, setNegocioSubscriptionStatus } from '@/lib/negocio-subscription'
import { NEGOCIO_GRANT_KEY, decideNegocioPayment } from '@/lib/plan'
import { mapNegocioStatus, sessionMonths } from '@/lib/negocio-checkout-rules'
import { markAttributionPaid, isPromoterSku } from '@/lib/promoter'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const MEDUSA_PUB_KEY = process.env.MEDUSA_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

export async function handleNegocioSubscriptionComplete(session: Stripe.Checkout.Session): Promise<void> {
  const shopId = session.metadata?.shop_id
  const sellerClerkId = session.metadata?.seller_clerk_id
  const stripeSubscriptionId = session.subscription as string | null
  if (!shopId || !sellerClerkId || !stripeSubscriptionId) {
    console.error('[negocio sub] missing metadata/subscription:', session.id)
    tg.alert(`🚨 Negocio mensual PAGADO sin datos para activarlo — revisar.\nSession: ${session.id}`)
    return
  }
  try {
    const stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId)
    type SubWithPeriod = { current_period_start: number; current_period_end: number }
    const period = stripeSub as unknown as SubWithPeriod
    const { plan_id } = await getNegocioSubscription(sellerClerkId, shopId)
    if (!plan_id) throw new Error('negocio plan not found')
    const email = session.customer_details?.email?.toLowerCase().trim() ?? ''
    const res = await fetch(`${MEDUSA_BASE}/store/subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-publishable-api-key': MEDUSA_PUB_KEY,
        'x-internal-secret': process.env.MEDUSA_INTERNAL_SECRET ?? '',
      },
      body: JSON.stringify({
        plan_id,
        // The marketplace shop id: the Backend counts only this shop's subscription (Negocio is per shop).
        seller_id: shopId,
        clerk_user_id: sellerClerkId,
        buyer_email: email || `${sellerClerkId}@seller.miyagisanchez.com`,
        status: 'active',
        payment_method: 'stripe',
        stripe_subscription_id: stripeSubscriptionId,
        stripe_customer_id: session.customer as string | null,
        current_period_start: new Date(period.current_period_start * 1000).toISOString(),
        current_period_end: new Date(period.current_period_end * 1000).toISOString(),
        metadata: { kind: 'negocio', shop_id: shopId },
      }),
    })
    if (!res.ok) throw new Error(`subscription create ${res.status}`)
  } catch (e) {
    console.error('[negocio sub] Medusa activation failed:', e)
    tg.alert(
      `🚨 Negocio mensual PAGADO pero NO activado — reparar a mano.\nShop: ${shopId}\nSeller: ${sellerClerkId}\n` +
      `Stripe sub: ${stripeSubscriptionId}\nError: ${e instanceof Error ? e.message : String(e)}`,
    )
    return
  }
  tg.alert(`✅ Negocio mensual activado\nShop: ${shopId}`)
}

/** Write the paid months onto the shop's grant: compare-and-swap, re-read and retried on a concurrent change. */
export async function applyNegocioPayment(input: {
  shopId: string
  paymentId: string
  months: number
  note: string
  now?: Date
}): Promise<'written' | 'replay' | 'comp'> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data: shop, error: readError } = await db.from('marketplace_shops').select('metadata').eq('id', input.shopId).maybeSingle()
    if (readError) throw new Error(`shop read failed: ${readError.message}`)
    if (!shop) throw new Error(`no shop row for id ${input.shopId}`)
    const decision = decideNegocioPayment((shop as { metadata: unknown }).metadata, input)
    if (decision.action !== 'write') return decision.action
    const { data: merged, error } = await db.rpc('merge_shop_metadata', {
      p_shop_id: input.shopId,
      p_patch: { [NEGOCIO_GRANT_KEY]: decision.grant },
      p_guard_key: NEGOCIO_GRANT_KEY,
      p_guard_mode: 'equals',
      p_expected: decision.expected,
    })
    if (error) throw new Error(`grant write failed: ${error.message}`)
    if (Array.isArray(merged) && merged.length > 0) return 'written'
    // The guard fired: the grant changed between the read and the write. Re-read and decide again.
  }
  throw new Error('grant write lost three compare-and-swap races')
}

export async function handleNegocioOneTimeComplete(session: Stripe.Checkout.Session): Promise<void> {
  const shopId = session.metadata?.shop_id
  const months = sessionMonths(session.metadata?.months)
  const promoterSku = session.metadata?.promoter_sku
  if (!shopId || months === null) {
    console.error('[negocio one-time] bad metadata:', session.id)
    tg.alert(`🚨 Negocio (pago único) PAGADO con datos inválidos — revisar.\nSession: ${session.id}`)
    return
  }
  let outcome: 'written' | 'replay' | 'comp'
  try {
    outcome = await applyNegocioPayment({
      shopId,
      paymentId: session.id,
      months,
      note: promoterSku ? `promoter ${promoterSku}` : `yearly ${months}m`,
    })
  } catch (e) {
    console.error('[negocio one-time] grant write failed:', e)
    tg.alert(
      `🚨 Negocio (pago único) PAGADO pero NO activado — reparar a mano.\nShop: ${shopId}\nSession: ${session.id}\n` +
      `Error: ${e instanceof Error ? e.message : String(e)}`,
    )
    return
  }
  if (outcome === 'replay') return // already counted: no second attribution, no second alert

  const promoterId = session.metadata?.promoter_id
  if (promoterId && isPromoterSku(promoterSku)) {
    await markAttributionPaid({
      promoterId,
      sellerId: shopId,
      sku: promoterSku,
      grossAmountCents: session.amount_total ?? 0,
      cadence: 'one_time',
    })
  }
  tg.alert(
    outcome === 'comp'
      ? `ℹ️ Negocio pagado en una tienda que ya lo tenía sin costo — revisar si hay que reembolsar.\nShop: ${shopId}\nSession: ${session.id}`
      : `✅ Negocio activado (${months} meses)\nShop: ${shopId}`,
  )
}

export async function handleNegocioSubscriptionChanged(subscription: Stripe.Subscription, deleted: boolean): Promise<void> {
  const status = deleted ? 'canceled' : mapNegocioStatus(subscription.status)
  if (!status) return
  try {
    const updated = await setNegocioSubscriptionStatus(subscription.id, status)
    if (updated === 0) throw new Error('no Negocio subscription row matched')
  } catch (e) {
    console.error('[negocio sub] status sync failed:', e)
    tg.alert(
      `🚨 Negocio: no se pudo actualizar la suscripción a «${status}» — revisar.\nStripe sub: ${subscription.id}\n` +
      `Error: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

/**
 * A monthly renewal paid (or a recovery from past_due): keep the Medusa subscription active. The platform is the
 * payee — this path must NEVER reach the seller-subscription transfer below it in the webhook.
 * S4.3 hooks the promoter's year-2 renewal commission here.
 */
export async function handleNegocioInvoicePaid(invoice: Stripe.Invoice, stripeSubscriptionId: string): Promise<void> {
  await handleNegocioSubscriptionChanged({ id: stripeSubscriptionId, status: 'active' } as Stripe.Subscription, false)
  void invoice
}

/** A failed renewal: past_due is a grace state — Negocio stays while Stripe retries; only a cancel lapses it. */
export async function handleNegocioInvoiceFailed(stripeSubscriptionId: string): Promise<void> {
  await handleNegocioSubscriptionChanged({ id: stripeSubscriptionId, status: 'past_due' } as Stripe.Subscription, false)
  tg.alert(`⚠️ Pago fallido en Negocio (en gracia)\nSubscription: ${stripeSubscriptionId}`)
}
