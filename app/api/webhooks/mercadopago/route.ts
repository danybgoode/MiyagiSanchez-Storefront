/**
 * MercadoPago IPN webhook — handles payment.created / payment.updated notifications.
 *
 * MP sends two notification formats:
 *   v2: POST body  { type: "payment", data: { id: "123" }, action: "payment.created" }
 *   v1: GET/POST   ?topic=payment&id=123   (also supported as fallback)
 *
 * We always return 200 quickly, then do async work — MP retries on non-200.
 * Idempotency is enforced by the UNIQUE INDEX on marketplace_orders.mp_payment_id.
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/supabase'
import { getMpPayment, getMpPreapproval } from '@/lib/mercadopago'
import {
  sendSaleCompletedToSeller,
  sendOrderConfirmedToBuyer,
  sendCoordinatedOrderToBuyer,
  sendCoordinatedOrderToSeller,
  sendPickupOrderToBuyer,
  sendPickupOrderToSeller,
  getSellerEmail,
} from '@/lib/email'
import { formatOfferAmount } from '@/lib/offers'
import { personalizationFromOrderItems, type PersonalizationBlock } from '@/lib/personalization'
import { markListingPurchased } from '@/lib/offer-state'
import { deliverOrderWebhook } from '@/lib/ucp/webhooks'
import { tg } from '@/lib/telegram'
import { upsertOrderMirror } from '@/lib/order-mirror'
import { shouldEmailBuyer, shouldNotifySellerOfSale, telegramBuyerLabel } from '@/lib/in-person/notify-policy'
import { dispatchToBuyer } from '@/lib/notifications/dispatch'
import { buildBuyerMessage } from '@/lib/notifications/buyer-messages'
import { isEnabled } from '@/lib/flags'
import { resolveBuyerClerkId } from '@/lib/order-buyer'
import { isVerifiedCustomDomain } from '@/lib/custom-domain'
import { handlePrintAdPaid } from '@/lib/print-server'
import { maybeRewardReferralOnOrder } from '@/lib/referrals'
import { awardSweepstakesPurchaseBonusForOrder } from '@/lib/sweepstakes'
import { issuePaidTicketsForOrder } from '@/lib/paid-event-tickets'
import type { RentalBookingLike } from '@/lib/rental-booking'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const MEDUSA_PUB_KEY = process.env.MEDUSA_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''
const MEDUSA_INTERNAL_SECRET = process.env.MEDUSA_INTERNAL_SECRET ?? ''

/**
 * Patch the MP payment session with the real payment ID, then complete the Medusa
 * cart. Returns the order ID.
 *
 * `fields=%2Bcustomer.metadata` ADDS the customer relation's metadata to Medusa's
 * default field set instead of replacing it (`+` prefix; percent-encoded because a
 * literal `+` in a query string decodes as a space) — buyer notifications money-path
 * Sprint 2: threads `customer.metadata.clerk_user_id` through for pref-gated dispatch.
 */
async function completeMedusaCartWithMp(cartId: string, mpPaymentId: string): Promise<{ orderId: string | null; metadata: Record<string, unknown>; personalization: PersonalizationBlock[]; buyerClerkId: string | null } | null> {
  try {
    // Step 1: authorize the session with the real MP payment ID
    const authRes = await fetch(`${MEDUSA_BASE}/store/carts/${cartId}/mp-authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-publishable-api-key': MEDUSA_PUB_KEY,
      },
      body: JSON.stringify({ mp_payment_id: mpPaymentId }),
    })
    if (!authRes.ok) {
      const body = await authRes.json().catch(() => ({}))
      console.error('[mp webhook] mp-authorize failed:', cartId, body)
      return null
    }

    // Step 2: complete the cart (authorizePayment will see status: approved now)
    const completeRes = await fetch(`${MEDUSA_BASE}/store/carts/${cartId}/complete?fields=%2Bcustomer.metadata`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-publishable-api-key': MEDUSA_PUB_KEY,
      },
    })
    if (!completeRes.ok) {
      const body = await completeRes.json().catch(() => ({}))
      console.error('[mp webhook] cart complete failed:', cartId, body)
      return null
    }
    const data = await completeRes.json().catch(() => ({}))
    const orderId = data?.order?.id ?? null
    const metadata = (data?.order?.metadata ?? {}) as Record<string, unknown>
    const personalization = personalizationFromOrderItems(data?.order?.items)
    const buyerClerkId = (data?.order?.customer?.metadata?.clerk_user_id as string | undefined) ?? null
    console.log('[mp webhook] Medusa cart completed:', cartId, '→ order:', orderId)
    return { orderId, metadata, personalization, buyerClerkId }
  } catch (e) {
    console.error('[mp webhook] completeMedusaCartWithMp error:', cartId, e)
    return null
  }
}

/**
 * Complete a Medusa cart (session already authorized by the backend mp-ipn).
 * Same `+customer.metadata` field-append as `completeMedusaCartWithMp` above.
 */
async function completeMedusaCart(cartId: string): Promise<{ orderId: string | null; buyerClerkId: string | null } | null> {
  try {
    const res = await fetch(`${MEDUSA_BASE}/store/carts/${cartId}/complete?fields=%2Bcustomer.metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-publishable-api-key': MEDUSA_PUB_KEY },
    })
    if (!res.ok) {
      console.error('[mp webhook] complete failed:', cartId, await res.json().catch(() => ({})))
      return null
    }
    const data = await res.json().catch(() => ({}))
    const orderId = data?.order?.id ?? null
    const buyerClerkId = (data?.order?.customer?.metadata?.clerk_user_id as string | undefined) ?? null
    return { orderId, buyerClerkId }
  } catch (e) {
    console.error('[mp webhook] complete error:', cartId, e)
    return null
  }
}

/**
 * Marketplace MP payment (funds in the seller's account). The backend verifies
 * with the seller's token + patches the session; we then complete + mirror.
 */
async function handleMarketplaceMpPayment(sellerId: string, paymentId: string) {
  let ipn: {
    status: string
    cart_id?: string | null
    amount_cents?: number
    currency?: string
    buyer_email?: string | null
    buyer_name?: string | null
    metadata?: Record<string, unknown>
  } | null = null

  try {
    const res = await fetch(`${MEDUSA_BASE}/store/payments/mp-ipn`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-publishable-api-key': MEDUSA_PUB_KEY,
        'x-internal-secret': MEDUSA_INTERNAL_SECRET,
      },
      body: JSON.stringify({ seller_id: sellerId, payment_id: paymentId }),
    })
    if (!res.ok) {
      console.error('[mp webhook] mp-ipn failed:', await res.json().catch(() => ({})))
      return
    }
    ipn = await res.json()
  } catch (e) {
    console.error('[mp webhook] mp-ipn error:', e)
    return
  }

  if (!ipn || ipn.status !== 'approved' || !ipn.cart_id) return

  const cartId = ipn.cart_id
  const meta = ipn.metadata ?? {}
  const metaText = (key: string): string | null =>
    typeof meta[key] === 'string' ? meta[key] : null
  const productId = metaText('product_id') ?? ''
  const currency = (ipn.currency ?? 'MXN').toUpperCase()
  const amountCents = ipn.amount_cents ?? 0
  const buyerEmail = ipn.buyer_email ?? null
  const buyerName = ipn.buyer_name ?? null
  const offerId = metaText('offer_id')
  const shippingAmountCents = Number(meta.shipping_amount_cents ?? 0) || 0

  const completed = await completeMedusaCart(cartId)
  const medusaOrderId = completed?.orderId ?? null
  if (!medusaOrderId) return
  // Buyer notifications money-path (epic 05, S2) — flag-gated, null-safe; flag off
  // ⇒ null, reproducing today's mirror row exactly.
  const buyerMoneypathEnabled = await isEnabled('notifications.buyer_moneypath_enabled')
  const buyerClerkId = resolveBuyerClerkId(completed?.buyerClerkId ?? null, buyerMoneypathEnabled)
  const eventTickets = await issuePaidTicketsForOrder(medusaOrderId)

  // Print-ad placement? Mark paid, send print emails, skip the generic order flow.
  const isPrintAd = await handlePrintAdPaid({
    cartId, medusaOrderId, amountCents, currency, buyerEmail, buyerName,
  })
  if (isPrintAd) {
    const amtFmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(amountCents / 100)
    tg.salePaid(amtFmt, 'Anuncio impreso', buyerEmail ?? 'anunciante', 'mercadopago')
    return
  }

  const { created } = await upsertOrderMirror({
    medusaOrderId,
    cartId,
    sellerId: metaText('seller_id') ?? sellerId,
    productId,
    paymentMethod: 'mercadopago',
    amountCents,
    currency,
    buyerEmail,
    buyerName,
    buyerClerkId,
    fulfillmentMethod: metaText('fulfillment_method'),
    pickupSpotId: metaText('pickup_spot_id'),
    shippingAmountCents,
    mpPaymentId: paymentId,
    offerId,
    eventTickets,
    shippingQuote: metaText('shipping_rate_id') ? {
      rate_id: metaText('shipping_rate_id')!,
      carrier: metaText('shipping_carrier'),
      service: metaText('shipping_service'),
      amount_cents: shippingAmountCents,
      currency: metaText('shipping_currency') ?? currency,
      delivery_estimate: meta.shipping_delivery_estimate ? Number(meta.shipping_delivery_estimate) : null,
      delivery_label: metaText('shipping_delivery_label'),
    } : null,
  })

  if (!created) return // late webhook racing the cron / a retry — side effects already done

  deliverOrderWebhook(medusaOrderId, 'order.created').catch(e => console.error('[ucp-webhook] mp marketplace:', e))
  if (productId) {
    markListingPurchased({ listingId: productId, offerId: offerId ?? undefined })
      .catch(e => console.error('[mp webhook] markListingPurchased:', e))
  }

  // ── Referral reward on the buyer's first purchase (non-fatal) ──────────────
  maybeRewardReferralOnOrder({ buyerEmail }).catch(e => console.error('[referrals] mp:', e))
  awardSweepstakesPurchaseBonusForOrder({
    sellerId: (meta.seller_id as string) ?? sellerId,
    orderId: medusaOrderId,
    buyerEmail,
    paidAt: new Date().toISOString(),
  }).catch(e => console.error('[sweepstakes] mp marketplace:', e))

  const amtFmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(amountCents / 100)
  tg.salePaid(amtFmt, productId || 'Producto', buyerEmail ?? 'comprador', 'mercadopago')

  if (productId && buyerEmail) {
    const be: string = buyerEmail
    const listingInfo = await getMedusaListing(productId)
    if (listingInfo) {
      const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com'
      const listingUrl = `${SITE_URL}/mx/l/${productId}`
      const amountFormatted = formatOfferAmount(amountCents, currency)
      sendOrderConfirmedToBuyer({
        buyerEmail: be, buyerName,
        listingTitle: listingInfo.title, listingUrl, amountPaid: amountFormatted,
        shopName: listingInfo.seller_name, isDigital: false,
        eventTickets,
      }).catch(e => console.error('[mp email] marketplace buyer:', e))

      // ── Compras (Push/Telegram) — additive only; the email above is untouched ──
      const buyerMsg = buildBuyerMessage('order_confirmed', {
        listingTitle: listingInfo.title,
        url: listingUrl,
        amountPaid: amountFormatted,
      })
      void dispatchToBuyer(
        { clerkUserId: buyerClerkId, email: be },
        { group: 'buyer.compras', push: buyerMsg.push, telegram: buyerMsg.telegram },
      )

      if (listingInfo.seller_clerk_id) {
        getSellerEmail(listingInfo.seller_clerk_id).then(sellerEmail => {
          if (sellerEmail) return sendSaleCompletedToSeller({
            sellerEmail, listingTitle: listingInfo.title, listingUrl,
            amountPaid: amountFormatted, buyerName, buyerEmail: be, isDigital: false,
          })
        }).catch(e => console.error('[mp email] marketplace seller:', e))
      }
    }
  }
}

/** Fetch listing info from Medusa for email context */
type ListingInfo = {
  title: string
  seller_name: string
  seller_clerk_id?: string
  seller_phone?: string | null
  seller_whatsapp?: string | null
  pickup_spots?: Array<{ name?: string; address?: string; instructions?: string }>
}

async function getMedusaListing(productId: string): Promise<ListingInfo | null> {
  try {
    const res = await fetch(`${MEDUSA_BASE}/store/listings/${productId}`, {
      headers: { 'x-publishable-api-key': MEDUSA_PUB_KEY },
    })
    if (!res.ok) return null
    const { listing } = await res.json()
    const shopMeta = (listing?.shop?.metadata ?? listing?.seller?.metadata ?? {}) as Record<string, unknown>
    const settings = (shopMeta.settings ?? {}) as Record<string, unknown>
    const checkout = (settings.checkout ?? {}) as Record<string, unknown>
    const theme    = (settings.theme    ?? {}) as Record<string, unknown>
    const social   = (theme.social      ?? {}) as Record<string, unknown>
    const shipping = (settings.shipping ?? {}) as Record<string, unknown>
    return {
      title: listing?.title ?? listing?.name ?? 'Producto',
      seller_name: listing?.seller?.name ?? listing?.shop?.name ?? '',
      seller_clerk_id: listing?.seller?.clerk_user_id ?? listing?.shop?.clerk_user_id ?? undefined,
      seller_phone: checkout.show_phone && checkout.phone ? String(checkout.phone) : null,
      seller_whatsapp: typeof social.whatsapp === 'string'
        ? social.whatsapp
        : typeof checkout.phone === 'string' ? checkout.phone : null,
      pickup_spots: (shipping.pickup_spots ?? []) as ListingInfo['pickup_spots'],
    }
  } catch {
    return null
  }
}

export async function POST(req: NextRequest) {
  // ── Parse notification ────────────────────────────────────────────────────
  let body: Record<string, unknown> = {}
  try {
    body = await req.json() as Record<string, unknown>
  } catch { /* MP sometimes sends form-encoded; fall through */ }

  // Support both v2 body and v1 query-param formats
  const { searchParams } = new URL(req.url)
  const topic = (body.type ?? body.topic ?? searchParams.get('topic')) as string | undefined
  const dataId = (body.data as Record<string, unknown> | undefined)?.id
  const resourceId = String(dataId ?? body.id ?? searchParams.get('id') ?? '')

  // ── Route preapproval (subscription) notifications ────────────────────────
  if (topic === 'preapproval' && resourceId && resourceId !== 'undefined') {
    await handleMpPreapproval(resourceId).catch(e =>
      console.error('[mp webhook] preapproval handler error:', e),
    )
    return NextResponse.json({ received: true })
  }

  const paymentId = resourceId

  // Acknowledge non-payment topics immediately (merchant_order, etc.)
  if (topic !== 'payment' || !paymentId || paymentId === 'undefined') {
    return NextResponse.json({ received: true })
  }

  // ── Marketplace flow: seller_id carried on the preference notification_url ──
  // These payments live in the SELLER's MP account, so we can't fetch them with
  // the platform token. Delegate verification to the backend (which holds the
  // seller token), then complete + mirror.
  const sellerIdParam = searchParams.get('seller_id')
  if (sellerIdParam) {
    await handleMarketplaceMpPayment(sellerIdParam, paymentId).catch(e =>
      console.error('[mp webhook] marketplace handler error:', e),
    )
    return NextResponse.json({ received: true })
  }

  // ── Fetch & verify payment from MP (legacy / platform-collected) ──────────
  let payment
  try {
    payment = await getMpPayment(paymentId)
  } catch (err) {
    console.error('[mp webhook] failed to fetch payment:', paymentId, err)
    // Return 200 so MP doesn't endlessly retry a bad ID
    return NextResponse.json({ received: true })
  }

  // Only process approved payments
  if (payment.status !== 'approved') {
    return NextResponse.json({ received: true })
  }

  const amountCents = Math.round((payment.transaction_amount ?? 0) * 100)
  const currency    = (payment.currency_id ?? 'MXN').toUpperCase()
  const buyerEmail  = payment.payer?.email ?? null
  const buyerName   = [payment.payer?.first_name, payment.payer?.last_name]
    .filter(Boolean).join(' ').trim() || null

  // ── New Medusa-backed flow (cart_id in payment.metadata) ─────────────────
  const mpMeta = (payment.metadata ?? {}) as Record<string, string>
  if (mpMeta.cart_id) {
    await handleMedusaMpPayment({
      paymentId,
      cartId: mpMeta.cart_id,
      productId: mpMeta.product_id ?? '',
      sellerId: mpMeta.seller_id ?? '',
      offerId: mpMeta.offer_id,
      fulfillmentMethod: mpMeta.fulfillment_method,
      pickupSpotId: mpMeta.pickup_spot_id,
      shippingRateId: mpMeta.shipping_rate_id,
      shippingCarrier: mpMeta.shipping_carrier,
      shippingService: mpMeta.shipping_service,
      shippingAmountCents: Number(mpMeta.shipping_amount_cents ?? 0) || 0,
      shippingCurrency: mpMeta.shipping_currency,
      shippingDeliveryEstimate: mpMeta.shipping_delivery_estimate,
      shippingDeliveryLabel: mpMeta.shipping_delivery_label,
      source: mpMeta.source,
      amountCents,
      currency,
      buyerEmail,
      buyerName,
    })
    return NextResponse.json({ received: true })
  }

  // ── Legacy Supabase flow (external_reference has JSON) ───────────────────
  let ref: Record<string, string> = {}
  try {
    ref = JSON.parse(payment.external_reference ?? '{}') as Record<string, string>
  } catch { /* ignore */ }

  const { listing_id, shop_id, listing_type, offer_id } = ref
  if (!listing_id || !shop_id) {
    console.warn('[mp webhook] missing listing/shop in external_reference for payment:', paymentId)
    return NextResponse.json({ received: true })
  }

  // ── Idempotency — skip if already recorded ────────────────────────────────
  const { data: existing } = await db
    .from('marketplace_orders')
    .select('id')
    .eq('mp_payment_id', paymentId)
    .maybeSingle()

  if (existing) return NextResponse.json({ received: true })

  // ── Record order ──────────────────────────────────────────────────────────
  const { data: order } = await db
    .from('marketplace_orders')
    .insert({
      listing_id,
      shop_id,
      mp_preference_id: (payment as unknown as Record<string, unknown>).preference_id as string ?? null,
      mp_payment_id:    paymentId,
      mp_status:        payment.status,
      buyer_email:      buyerEmail,
      buyer_name:       buyerName,
      amount_cents:     amountCents,
      currency,
      status:           'paid',
      metadata:         offer_id ? { offer_id } : {},
    })
    .select('id')
    .single()

  if (!order) {
    console.error('[mp webhook] order insert failed for payment:', paymentId)
    return NextResponse.json({ received: true })
  }

  // ── Fire UCP webhook (non-fatal) ─────────────────────────────────────────
  deliverOrderWebhook(order.id, 'order.created').catch(e => console.error('[ucp-webhook] mp:', e))

  // ── Mark winning offer paid, decline competing offers, close mirror listing
  await markListingPurchased({ listingId: listing_id, offerId: offer_id })

  // ── Fetch listing + shop context for emails ───────────────────────────────
  const { data: listing } = await db
    .from('marketplace_listings')
    .select('id, title, currency, marketplace_shops!inner(name, clerk_user_id)')
    .eq('id', listing_id)
    .single()

  if (listing) {
    // ── Telegram admin alert ────────────────────────────────────────────────
    const amtFmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(amountCents / 100)
    tg.salePaid(amtFmt, listing.title, buyerEmail ?? 'comprador', 'mercadopago')

    const shop = listing.marketplace_shops as unknown as { name: string; clerk_user_id: string | null }
    const listingUrl    = `https://miyagisanchez.com/mx/l/${listing_id}`
    const amountFormatted = formatOfferAmount(amountCents, currency)
    const isDigital     = listing_type === 'digital'

    if (buyerEmail) {
      sendOrderConfirmedToBuyer({
        buyerEmail, buyerName,
        listingTitle: listing.title, listingUrl,
        amountPaid: amountFormatted, shopName: shop.name, isDigital,
      }).catch(e => console.error('[mp email] buyer:', e))
    }

    if (shop.clerk_user_id) {
      getSellerEmail(shop.clerk_user_id)
        .then(sellerEmail => {
          if (sellerEmail) {
            return sendSaleCompletedToSeller({
              sellerEmail, listingTitle: listing.title, listingUrl,
              amountPaid: amountFormatted, buyerName, buyerEmail, isDigital,
            })
          }
        })
        .catch(e => console.error('[mp email] seller:', e))
    }
  }

  return NextResponse.json({ received: true })
}

// ── New Medusa flow MP payment handler ────────────────────────────────────────

async function handleMedusaMpPayment({
  paymentId,
  cartId,
  productId,
  sellerId,
  offerId,
  fulfillmentMethod,
  pickupSpotId,
  shippingRateId,
  shippingCarrier,
  shippingService,
  shippingAmountCents,
  shippingCurrency,
  shippingDeliveryEstimate,
  shippingDeliveryLabel,
  source,
  amountCents,
  currency,
  buyerEmail,
  buyerName,
}: {
  paymentId: string
  cartId: string
  productId: string
  sellerId: string
  offerId?: string
  fulfillmentMethod?: string
  pickupSpotId?: string
  shippingRateId?: string
  shippingCarrier?: string
  shippingService?: string
  shippingAmountCents?: number
  shippingCurrency?: string
  shippingDeliveryEstimate?: string
  shippingDeliveryLabel?: string
  /** Provider metadata `source` stamped by start-checkout on a server-built cart (e.g. in_person). */
  source?: string
  amountCents: number
  currency: string
  buyerEmail: string | null
  buyerName: string | null
}) {
  // 1. Complete the Medusa cart (mp-authorize + complete)
  const completed = await completeMedusaCartWithMp(cartId, paymentId)
  const medusaOrderId = completed?.orderId ?? null
  const orderMeta = completed?.metadata ?? {}
  // Buyer notifications money-path (epic 05, S2) — flag-gated, null-safe; flag off
  // ⇒ null, reproducing today's mirror row exactly.
  const buyerMoneypathEnabled = await isEnabled('notifications.buyer_moneypath_enabled')
  const buyerClerkId = resolveBuyerClerkId(completed?.buyerClerkId ?? null, buyerMoneypathEnabled)
  const supportMeta = (orderMeta.support ?? null) as Record<string, unknown> | null
  const isSupportPayment = supportMeta?.kind === 'support'
  let eventTickets: Awaited<ReturnType<typeof issuePaidTicketsForOrder>> = []

  // 2. Record in Supabase so the existing order UIs can find it (idempotent)
  if (medusaOrderId) {
    eventTickets = await issuePaidTicketsForOrder(medusaOrderId)
    await upsertOrderMirror({
      medusaOrderId,
      cartId,
      sellerId: sellerId ?? '',
      productId: productId ?? '',
      paymentMethod: 'mercadopago',
      amountCents: isSupportPayment ? Number(supportMeta?.amount_cents ?? amountCents) : amountCents,
      currency,
      buyerEmail,
      buyerName,
      buyerClerkId,
      fulfillmentMethod: fulfillmentMethod ?? null,
      pickupSpotId: pickupSpotId ?? null,
      shippingAmountCents: shippingAmountCents ?? 0,
      mpPaymentId: paymentId,
      offerId: offerId ?? null,
      channel: (orderMeta.channel as string | undefined) ?? null,
      eventTickets,
      shippingQuote: shippingRateId ? {
        rate_id: shippingRateId,
        carrier: shippingCarrier ?? null,
        service: shippingService ?? null,
        amount_cents: shippingAmountCents ?? 0,
        currency: shippingCurrency ?? currency,
        delivery_estimate: shippingDeliveryEstimate ? Number(shippingDeliveryEstimate) : null,
        delivery_label: shippingDeliveryLabel || null,
      } : null,
    })
  }

  // 3. Fire UCP webhook
  deliverOrderWebhook(medusaOrderId ?? cartId, 'order.created').catch(e => console.error('[ucp-webhook] medusa mp:', e))

  if (isSupportPayment) {
    const amtFmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(Number(supportMeta?.amount_cents ?? amountCents) / 100)
    tg.salePaid(amtFmt, 'Apoyo / contribución', buyerEmail ?? 'comprador', 'mercadopago')
    return
  }

  // 3. Mark winning offer paid, decline competing offers, close mirror listing
  await markListingPurchased({ listingId: productId, offerId })

  // 4. Telegram admin alert
  const amtFmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(amountCents / 100)
  tg.salePaid(amtFmt, productId || 'Producto', telegramBuyerLabel({ source }, buyerEmail), 'mercadopago')

  // 5. Emails (best-effort via Medusa listing fetch)
  // In-person (D7): no seller sale email for a sale the merchant rang up, and a counter order only
  // emails a buyer address that is real.
  const sourceMeta = { source }
  if (productId && shouldEmailBuyer(sourceMeta, buyerEmail)) {
    const listingInfo = await getMedusaListing(productId)
    if (listingInfo) {
      // Own-channel: when the order came from a VERIFIED custom domain, brand the
      // buyer email + product link to that domain (auth-gated order links stay on
      // the platform). isVerifiedCustomDomain guards against forged metadata.
      const originDomain = typeof orderMeta.origin_domain === 'string' ? orderMeta.origin_domain : null
      const storeDomain = orderMeta.channel === 'custom_domain' && originDomain && (await isVerifiedCustomDomain(originDomain))
        ? originDomain
        : null
      const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com'
      const listingUrl = storeDomain
        ? `https://${storeDomain}/l/${productId}`
        : `${SITE_URL}/mx/l/${productId}`
      const amountFormatted = formatOfferAmount(amountCents, currency)
      const personalization = completed?.personalization ?? []

      const SITE_URL2 = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com'
      const isPickup2 = fulfillmentMethod === 'local_pickup'
      const isCoord2  = !fulfillmentMethod || fulfillmentMethod === 'none' || fulfillmentMethod === 'coord' || fulfillmentMethod === 'rental'
      const orderUrl2 = `${SITE_URL2}/account/orders/${medusaOrderId ?? cartId}`

      // ── Buyer email ───────────────────────────────────────────────────────
      if (isPickup2) {
        const spot = listingInfo.pickup_spots?.[0]
        sendPickupOrderToBuyer({
          buyerEmail,
          buyerName,
          listingTitle: listingInfo.title,
          listingUrl,
          amountPaid: amountFormatted,
          shopName: listingInfo.seller_name,
          pickupAddress: spot?.address ?? null,
          pickupInstructions: spot?.instructions ?? null,
          sellerPhone: listingInfo.seller_phone ?? null,
          sellerWhatsapp: listingInfo.seller_whatsapp ?? null,
          orderUrl: orderUrl2,
          personalization,
          eventTickets,
          storeDomain,
        }).catch(e => console.error('[mp email] pickup buyer:', e))
      } else if (isCoord2) {
        sendCoordinatedOrderToBuyer({
          buyerEmail,
          buyerName,
          listingTitle: listingInfo.title,
          listingUrl,
          amountPaid: amountFormatted,
          shopName: listingInfo.seller_name,
          sellerPhone: listingInfo.seller_phone ?? null,
          sellerWhatsapp: listingInfo.seller_whatsapp ?? null,
          orderUrl: orderUrl2,
          personalization,
          eventTickets,
          storeDomain,
          rentalBooking: (orderMeta.rental_booking as RentalBookingLike | undefined) ?? null,
          currency,
        }).catch(e => console.error('[mp email] coord buyer:', e))
      } else {
        sendOrderConfirmedToBuyer({
          buyerEmail,
          buyerName,
          listingTitle: listingInfo.title,
          listingUrl,
          amountPaid: amountFormatted,
          shopName: listingInfo.seller_name,
          isDigital: false,
          personalization,
          eventTickets,
          storeDomain,
        }).catch(e => console.error('[mp email] medusa buyer:', e))
      }

      // ── Compras (Push/Telegram) — additive only; the email above is untouched ──
      const buyerMsg = buildBuyerMessage('order_confirmed', {
        listingTitle: listingInfo.title,
        url: orderUrl2,
        amountPaid: amountFormatted,
      })
      void dispatchToBuyer(
        { clerkUserId: buyerClerkId, email: buyerEmail },
        { group: 'buyer.compras', push: buyerMsg.push, telegram: buyerMsg.telegram },
      )

      // ── Seller email ──────────────────────────────────────────────────────
      if (listingInfo.seller_clerk_id && shouldNotifySellerOfSale(sourceMeta)) {
        const sellerOrderUrl2 = `${SITE_URL2}/shop/manage/orders/${medusaOrderId ?? cartId}`
        getSellerEmail(listingInfo.seller_clerk_id)
          .then(sellerEmail => {
            if (!sellerEmail) return
            if (isPickup2) {
              return sendPickupOrderToSeller({
                sellerEmail,
                listingTitle: listingInfo.title,
                listingUrl,
                amountPaid: amountFormatted,
                buyerName,
                buyerEmail,
                shopName: listingInfo.seller_name,
                orderUrl: sellerOrderUrl2,
                personalization,
              })
            }
            if (isCoord2) {
              return sendCoordinatedOrderToSeller({
                sellerEmail,
                listingTitle: listingInfo.title,
                listingUrl,
                amountPaid: amountFormatted,
                buyerName,
                buyerEmail,
                shopName: listingInfo.seller_name,
                orderId: medusaOrderId ?? cartId,
                orderUrl: sellerOrderUrl2,
                personalization,
                rentalBooking: (orderMeta.rental_booking as RentalBookingLike | undefined) ?? null,
                currency,
              })
            }
            return sendSaleCompletedToSeller({
              sellerEmail,
              listingTitle: listingInfo.title,
              listingUrl,
              amountPaid: amountFormatted,
              buyerName,
              buyerEmail,
              isDigital: false,
            })
          })
          .catch(e => console.error('[mp email] medusa seller:', e))
      }
    }
  }
}

// ── Preapproval (subscription) handler ───────────────────────────────────────

async function handleMpPreapproval(preapprovalId: string) {
  const pa = await getMpPreapproval(preapprovalId)
  if (!pa) return

  // Map MP status → our status
  const statusMap: Record<string, string> = {
    authorized: 'active',
    paused:     'past_due',
    cancelled:  'canceled',
    pending:    'pending_authorization',
  }
  const newStatus = statusMap[pa.status ?? ''] ?? pa.status ?? 'unknown'

  // Upsert by mp_preapproval_id
  const { data: existing } = await db
    .from('marketplace_subscriptions')
    .select('id, status')
    .eq('mp_preapproval_id', preapprovalId)
    .maybeSingle()

  if (existing) {
    await db.from('marketplace_subscriptions')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', existing.id)

    // Alert on first activation
    if (existing.status !== 'active' && newStatus === 'active') {
      tg.alert(`✅ MP Suscripción activada\nPreapproval: ${preapprovalId}`)
    }
    if (newStatus === 'canceled') {
      tg.alert(`❌ MP Suscripción cancelada\nPreapproval: ${preapprovalId}`)
    }
  }
}

// MP sometimes sends IPN as GET with query params — acknowledge those too
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const topic     = searchParams.get('topic')
  const paymentId = searchParams.get('id')

  if (topic === 'payment' && paymentId) {
    // Re-route to POST handler logic via internal fetch (simpler: just return 200
    // and let the actual POST notification do the work — MP sends both)
    console.log('[mp webhook] GET IPN received for payment:', paymentId)
  }

  return NextResponse.json({ received: true })
}
