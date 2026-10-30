import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { stripe } from '@/lib/stripe'
import { db } from '@/lib/supabase'
import {
  sendSaleCompletedToSeller,
  sendNewOrderToSeller,
  sendOrderConfirmedToBuyer,
  sendCoordinatedOrderToBuyer,
  sendCoordinatedOrderToSeller,
  sendPickupOrderToBuyer,
  sendPickupOrderToSeller,
} from '@/lib/email'
import { dispatchToSeller, dispatchToBuyer } from '@/lib/notifications/dispatch'
import { buildBuyerMessage } from '@/lib/notifications/buyer-messages'
import { isEnabled } from '@/lib/flags'
import { resolveBuyerClerkId } from '@/lib/order-buyer'
import { formatOfferAmount } from '@/lib/offers'
import { personalizationFromOrderItems, type PersonalizationBlock } from '@/lib/personalization'
import { markListingPurchased } from '@/lib/offer-state'
import { deliverOrderWebhook } from '@/lib/ucp/webhooks'
import { tg, escapeHtml } from '@/lib/telegram'
import { transferToSeller } from '@/lib/stripe-subscriptions'
import { getR2DigitalSignedUrl, isR2DigitalConfigured } from '@/lib/r2'
import { upsertOrderMirror } from '@/lib/order-mirror'
import { shouldEmailBuyer, shouldNotifySellerOfSale, telegramBuyerLabel } from '@/lib/in-person/notify-policy'
import { isVerifiedCustomDomain } from '@/lib/custom-domain'
import { handlePrintAdPaid } from '@/lib/print-server'
import { maybeRewardReferralOnOrder } from '@/lib/referrals'
import { awardSweepstakesPurchaseBonusForOrder } from '@/lib/sweepstakes'
import { issuePaidTicketsForOrder } from '@/lib/paid-event-tickets'
import type { RentalBookingLike } from '@/lib/rental-booking'
import {
  CUSTOM_DOMAIN_CHECKOUT_KIND,
  setCustomDomainSubscriptionStatus,
} from '@/lib/domain-subscription'
import {
  SUBDOMAIN_CHECKOUT_KIND,
  setSubdomainSubscriptionStatus,
  getSubdomainSubscription,
} from '@/lib/subdomain-subscription'
import {
  ML_SYNC_CHECKOUT_KIND,
  setMlSyncSubscriptionStatus,
  getMlSyncSubscription,
} from '@/lib/ml-sync-subscription'
import { buildOneTimeGrant } from '@/lib/domain-entitlement'
import { SUBDOMAIN_GRANT_KEY } from '@/lib/subdomain-entitlement'
import { ML_SYNC_GRANT_KEY } from '@/lib/ml-sync-entitlement'
import { releaseCustomDomainForShop } from '@/lib/domain-lapse-server'
import { markAttributionPaid, isPromoterSku } from '@/lib/promoter'
import { oneTimeGrantNote } from '@/lib/promoter-close'
import { listingUrlFor } from '@/lib/market-url'
import { notifyMerchantCloseReceipt } from '@/lib/promoter-close-notify'
import { MIGRATION_CHECKOUT_KIND } from '@/lib/migration-checkout'

/** Metadata key for the `migration` SKU's inert paid/audit marker (no ongoing
 *  feature to entitle — see lib/promoter-transfer.ts). */
const MIGRATION_GRANT_KEY = 'migration_grant'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const MEDUSA_PUB_KEY = process.env.MEDUSA_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

/** Sprint 5 (US-5.5) — shared MXN formatter for the merchant close-receipt items. */
function formatMxnCents(cents: number): string {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(cents / 100)
}

/**
 * Complete a Medusa cart → creates the Medusa order. Returns the order ID.
 *
 * `fields=%2Bcustomer.metadata` ADDS the customer relation's metadata to Medusa's
 * default field set instead of replacing it (`+` prefix; percent-encoded because a
 * literal `+` in a query string decodes as a space) — every field this function
 * already reads (id/metadata/items) stays intact. Buyer notifications money-path
 * Sprint 2: threads `customer.metadata.clerk_user_id` through for pref-gated dispatch.
 */
async function completeMedusaCart(cartId: string): Promise<{ orderId: string | null; metadata: Record<string, unknown>; personalization: PersonalizationBlock[]; buyerClerkId: string | null } | null> {
  try {
    const res = await fetch(`${MEDUSA_BASE}/store/carts/${cartId}/complete?fields=%2Bcustomer.metadata`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-publishable-api-key': MEDUSA_PUB_KEY,
      },
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      console.error('[stripe webhook] completeMedusaCart failed:', cartId, body)
      return null
    }
    const data = await res.json().catch(() => ({}))
    const orderId = data?.order?.id ?? null
    const metadata = (data?.order?.metadata ?? {}) as Record<string, unknown>
    const personalization = personalizationFromOrderItems(data?.order?.items)
    const buyerClerkId = (data?.order?.customer?.metadata?.clerk_user_id as string | undefined) ?? null
    console.log('[stripe webhook] Medusa cart completed:', cartId, '→ order:', orderId)
    return { orderId, metadata, personalization, buyerClerkId }
  } catch (e) {
    console.error('[stripe webhook] completeMedusaCart error:', cartId, e)
    return null
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

// In Next.js App Router, req.text() reads the raw body before any parsing —
// no need for bodyParser: false config (that was Pages Router only)
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? ''

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const sig = req.headers.get('stripe-signature') ?? ''

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, WEBHOOK_SECRET)
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  // ── Handle events ─────────────────────────────────────────────────────────
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      if (session.mode === 'subscription') {
        if (session.metadata?.kind === CUSTOM_DOMAIN_CHECKOUT_KIND) {
          await handleCustomDomainSubscriptionComplete(session)
        } else if (session.metadata?.kind === SUBDOMAIN_CHECKOUT_KIND) {
          await handleSubdomainSubscriptionComplete(session)
        } else if (session.metadata?.kind === ML_SYNC_CHECKOUT_KIND) {
          await handleMlSyncSubscriptionComplete(session)
        } else {
          await handleSubscriptionCheckoutComplete(session)
        }
      } else if (session.metadata?.kind === CUSTOM_DOMAIN_CHECKOUT_KIND) {
        // One-time custom-domain cadence (epic 08 · promoter-program S2):
        // mode:'payment', no Stripe subscription — entitlement is a dated grant.
        await handleCustomDomainOneTimeComplete(session)
      } else if (session.metadata?.kind === SUBDOMAIN_CHECKOUT_KIND) {
        // One-time subdomain cadence (epic 07 · subdomain-pricing S2): same shape
        // as the custom-domain one-time path, writing the subdomain_grant.
        await handleSubdomainOneTimeComplete(session)
      } else if (session.metadata?.kind === ML_SYNC_CHECKOUT_KIND) {
        // One-time ML-sync cadence (epic 03 · mercadolibre-sync S6): pay a year up
        // front, writing the dated ml_sync_grant.
        await handleMlSyncOneTimeComplete(session)
      } else if (session.metadata?.kind === MIGRATION_CHECKOUT_KIND) {
        // migration SKU (epic 03 · platform-migrations S2): a one-time consulting
        // service, no subscription — writes an inert migration_grant marker.
        await handleMigrationOneTimeComplete(session)
      } else {
        await handleCheckoutComplete(session)
      }
      break
    }

    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event.data.object as Stripe.Subscription)
      break

    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object as Stripe.Subscription)
      break

    case 'invoice.payment_succeeded':
      await handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice)
      break

    case 'invoice.payment_failed':
      await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice)
      break

    case 'account.updated':
      await handleAccountUpdated(event.data.object as Stripe.Account)
      break

    default:
      // Acknowledge but don't process
      break
  }

  return NextResponse.json({ received: true })
}

// ── checkout.session.completed ────────────────────────────────────────────────

async function handleCheckoutComplete(session: Stripe.Checkout.Session) {
  const meta = session.metadata ?? {}

  // ── New Medusa-backed flow (cart_id present in metadata) ──────────────────
  if (meta.cart_id) {
    await handleMedusaCheckoutComplete(session)
    return
  }

  // ── Legacy Supabase flow ──────────────────────────────────────────────────
  const { listing_id, shop_id, listing_type, offer_id, buyer_clerk_id, is_physical } = meta
  if (!listing_id || !shop_id) return

  const amountTotal = session.amount_total ?? 0
  const currency = (session.currency ?? 'mxn').toUpperCase()
  const buyerEmail = session.customer_details?.email ?? null
  const buyerName = session.customer_details?.name ?? null
  const isPhysical = is_physical === 'true' || listing_type === 'product'

  // Extract shipping address from Stripe session (present for physical products)
  const stripeShipping = (session as unknown as Record<string, unknown>).shipping_details as
    { name?: string; address?: Record<string, string | null> } | null | undefined
  const shippingAddress: Record<string, string> | null = stripeShipping?.address
    ? {
        name:        stripeShipping.name ?? buyerName ?? '',
        line1:       stripeShipping.address.line1 ?? '',
        line2:       stripeShipping.address.line2 ?? '',
        city:        stripeShipping.address.city ?? '',
        state:       stripeShipping.address.state ?? '',
        postal_code: stripeShipping.address.postal_code ?? '',
        country:     stripeShipping.address.country ?? 'MX',
      }
    : null

  // Physical products start in 'processing' so seller can acknowledge.
  // Digital products go straight to 'paid' (webhook will fulfill them).
  const initialStatus = isPhysical ? 'processing' : 'paid'

  // ── Record the order in Supabase ─────────────────────────────────────────
  const { data: order } = await db
    .from('marketplace_orders')
    .insert({
      listing_id,
      shop_id,
      stripe_session_id: session.id,
      stripe_payment_intent_id: session.payment_intent as string | null,
      buyer_email: buyerEmail,
      buyer_name: buyerName,
      buyer_clerk_user_id: buyer_clerk_id || null,
      amount_cents: amountTotal,
      currency,
      status: initialStatus,
      shipping_address: shippingAddress ?? {},
      shipping_method: isPhysical ? 'pending' : 'none',
      metadata: offer_id ? { offer_id } : {},
    })
    .select('id')
    .single()

  if (!order) {
    console.error('Failed to create order record for session:', session.id)
    return
  }

  // ── Fire UCP webhook (non-fatal) ─────────────────────────────────────────
  deliverOrderWebhook(order.id, 'order.created').catch(e => console.error('[ucp-webhook] stripe:', e))

  // ── Referral reward on the buyer's first purchase (non-fatal) ────────────
  maybeRewardReferralOnOrder({ buyerClerkUserId: buyer_clerk_id || null, buyerEmail })
    .catch(e => console.error('[referrals] stripe:', e))
  awardSweepstakesPurchaseBonusForOrder({
    sellerId: shop_id,
    orderId: order.id,
    buyerEmail,
    paidAt: new Date().toISOString(),
  }).catch(e => console.error('[sweepstakes] stripe legacy:', e))

  // Mark winning offer paid, decline competing offers, and close the mirror listing.
  await markListingPurchased({ listingId: listing_id, offerId: offer_id })

  // ── Fetch listing + shop for email context ────────────────────────────────
  const { data: listing } = await db
    .from('marketplace_listings')
    .select('id, title, currency, metadata, marketplace_shops!inner(name, clerk_user_id)')
    .eq('id', listing_id)
    .single()

  if (!listing) return

  // ── Telegram admin alert ──────────────────────────────────────────────────
  const amountFmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(amountTotal / 100)
  tg.salePaid(amountFmt, listing.title, buyerEmail ?? 'comprador', 'stripe')

  const shop = listing.marketplace_shops as unknown as { name: string; clerk_user_id: string | null }
  const listingCurrency = listing.currency ?? currency
  const amountFormatted = formatOfferAmount(amountTotal, listingCurrency)
  const listingUrl = `https://miyagisanchez.com/mx/l/${listing_id}`
  const isDigital = listing_type === 'digital'

  // ── Digital goods: generate signed URL + update order ────────────────────
  let digitalDownloadUrl: string | null = null
  let digitalExpiresAt: string | null = null

  if (isDigital) {
    const result = await fulfillDigitalOrder({ listing, orderId: order.id })
    digitalDownloadUrl = result.downloadUrl
    digitalExpiresAt = result.expiresAt
  }

  // ── Buyer email ───────────────────────────────────────────────────────────
  if (buyerEmail) {
    sendOrderConfirmedToBuyer({
      buyerEmail,
      buyerName,
      listingTitle: listing.title,
      listingUrl,
      amountPaid: amountFormatted,
      shopName: shop.name,
      isDigital,
      digitalDownloadUrl,
      digitalExpiresAt,
    }).catch(e => console.error('[email] order confirmed buyer:', e))
  }

  // ── Seller notification (orders group: email + push, through the seam) ──────
  // Default-on → today's email still fires unless "Pedidos → Email" is off. The
  // closure preserves the existing physical-vs-digital sender choice exactly.
  if (shop.clerk_user_id) {
    void dispatchToSeller(shop.clerk_user_id, {
      group: 'orders',
      email: to =>
        isPhysical && order
          ? sendNewOrderToSeller({
              sellerEmail: to,
              listingTitle: listing.title,
              listingUrl,
              amountPaid: amountFormatted,
              buyerName,
              buyerEmail,
              shippingAddress: shippingAddress ?? null,
              orderId: order.id,
              orderUrl: `${listingUrl.replace(/\/l\/.*/, '')}/shop/manage/orders/${order.id}`,
            })
          : sendSaleCompletedToSeller({
              sellerEmail: to,
              listingTitle: listing.title,
              listingUrl,
              amountPaid: amountFormatted,
              buyerName,
              buyerEmail,
              isDigital,
            }),
      push: {
        kind: 'order',
        title: '¡Vendiste!',
        body: `${amountFormatted} · ${listing.title}`,
        url: listingUrl,
      },
      telegram:
        `🛒 <b>¡Vendiste!</b>\n${escapeHtml(listing.title)} — <b>${escapeHtml(amountFormatted)}</b>\n` +
        `Comprador: ${escapeHtml(buyerName || buyerEmail || '')}\n${escapeHtml(listingUrl)}`,
    })
  }
}

// ── New Medusa flow: checkout.session.completed ───────────────────────────────

async function handleMedusaCheckoutComplete(session: Stripe.Checkout.Session) {
  const {
    cart_id,
    product_id,
    seller_id,
    offer_id,
    fulfillment_method,
    pickup_spot_id,
    shipping_rate_id,
    shipping_carrier,
    shipping_service,
    shipping_amount_cents,
    shipping_currency,
    shipping_delivery_estimate,
    shipping_delivery_label,
  } = session.metadata ?? {}
  if (!cart_id) return

  const amountTotal = session.amount_total ?? 0
  const shippingAmountCents = Number(shipping_amount_cents ?? 0) || 0
  const currency = (session.currency ?? 'mxn').toUpperCase()
  const buyerEmail = session.customer_details?.email ?? null
  const buyerName = session.customer_details?.name ?? null

  // 1. Complete the Medusa cart → creates Medusa order
  const completed = await completeMedusaCart(cart_id)
  const medusaOrderId = completed?.orderId ?? null
  const orderMeta = completed?.metadata ?? {}
  // Buyer notifications money-path (epic 05, S2) — flag-gated, null-safe; flag off
  // ⇒ null, reproducing today's mirror row exactly.
  const buyerMoneypathEnabled = await isEnabled('notifications.buyer_moneypath_enabled')
  const buyerClerkId = resolveBuyerClerkId(completed?.buyerClerkId ?? null, buyerMoneypathEnabled)
  const supportMeta = (orderMeta.support ?? null) as Record<string, unknown> | null
  const isSupportPayment = supportMeta?.kind === 'support' || session.metadata?.checkout_kind === 'support'
  let eventTickets: Awaited<ReturnType<typeof issuePaidTicketsForOrder>> = []

  // 1b. Print-ad placement? Mark the submission paid, send print emails, and skip
  //     the generic product/coordinated flow below (placements aren't shippable orders).
  const isPrintAd = await handlePrintAdPaid({
    cartId: cart_id, medusaOrderId, amountCents: amountTotal, currency, buyerEmail, buyerName,
  })
  if (isPrintAd) {
    const amountFmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(amountTotal / 100)
    tg.salePaid(amountFmt, 'Anuncio impreso', buyerEmail ?? 'anunciante', 'stripe')
    return
  }

  // 2. Record in Supabase so existing seller/buyer order UIs can find it (idempotent)
  if (medusaOrderId) {
    eventTickets = await issuePaidTicketsForOrder(medusaOrderId)
    await upsertOrderMirror({
      medusaOrderId,
      cartId: cart_id,
      sellerId: seller_id ?? '',
      productId: product_id ?? '',
      paymentMethod: 'stripe',
      amountCents: isSupportPayment ? Number(supportMeta?.amount_cents ?? amountTotal) : amountTotal,
      currency,
      buyerEmail,
      buyerName,
      buyerClerkId,
      fulfillmentMethod: fulfillment_method ?? null,
      pickupSpotId: pickup_spot_id ?? null,
      shippingAmountCents,
      stripeSessionId: session.id,
      offerId: offer_id ?? null,
      channel: (orderMeta.channel as string | undefined) ?? null,
      eventTickets,
      shippingQuote: shipping_rate_id ? {
        rate_id: shipping_rate_id,
        carrier: shipping_carrier ?? null,
        service: shipping_service ?? null,
        amount_cents: shippingAmountCents,
        currency: shipping_currency ?? currency,
        delivery_estimate: shipping_delivery_estimate ? Number(shipping_delivery_estimate) : null,
        delivery_label: shipping_delivery_label || null,
      } : null,
    })

    if (!isSupportPayment) {
      awardSweepstakesPurchaseBonusForOrder({
        sellerId: seller_id ?? null,
        orderId: medusaOrderId,
        buyerEmail,
        paidAt: new Date().toISOString(),
      }).catch(e => console.error('[sweepstakes] medusa stripe:', e))
    }
  }

  // 3. Fire UCP webhook (non-fatal)
  deliverOrderWebhook(medusaOrderId ?? cart_id, 'order.created').catch(e => console.error('[ucp-webhook] medusa stripe:', e))

  if (isSupportPayment) {
    const amountFmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency: currency }).format(Number(supportMeta?.amount_cents ?? amountTotal) / 100)
    tg.salePaid(amountFmt, 'Apoyo / contribución', buyerEmail ?? 'comprador', 'stripe')
    return
  }

  // 3. Mark winning offer paid, decline competing offers, and close the mirror listing.
  await markListingPurchased({ listingId: product_id, offerId: offer_id })

  // 4. Telegram admin alert
  const amountFmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency: currency }).format(amountTotal / 100)
  tg.salePaid(amountFmt, product_id ?? 'Producto', telegramBuyerLabel(session.metadata, buyerEmail), 'stripe')

  // 5. Fetch Medusa listing for email context (best-effort)
  // In-person (D7): the seller is never told about a sale they rang up themselves, and a counter
  // order only emails a buyer address that is real.
  if (product_id && shouldEmailBuyer(session.metadata, buyerEmail)) {
    const listingInfo = await getMedusaListing(product_id)
    if (listingInfo) {
      // Own-channel: when the order came from a VERIFIED custom domain, brand the
      // buyer email + point the product link at that domain (auth-gated order links
      // stay on the platform). isVerifiedCustomDomain guards against forged metadata.
      const originDomain = typeof orderMeta.origin_domain === 'string' ? orderMeta.origin_domain : null
      const storeDomain = orderMeta.channel === 'custom_domain' && originDomain && (await isVerifiedCustomDomain(originDomain))
        ? originDomain
        : null
      const siteBase = storeDomain ? `https://${storeDomain}` : (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com')
      const listingUrl = listingUrlFor(siteBase, product_id)
      const amountFormatted = formatOfferAmount(amountTotal, currency)
      const personalization = completed?.personalization ?? []

      const isPickup = fulfillment_method === 'local_pickup'
      const isCoord  = !fulfillment_method || fulfillment_method === 'none' || fulfillment_method === 'coord' || fulfillment_method === 'rental'
      const isShipping = fulfillment_method === 'shipping'
      const orderUrl = `${process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com'}/account/orders/${medusaOrderId ?? cart_id}`

      // ── Buyer email ───────────────────────────────────────────────────────
      if (isPickup) {
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
          orderUrl,
          personalization,
          eventTickets,
          storeDomain,
        }).catch(e => console.error('[email] pickup buyer:', e))
      } else if (isCoord) {
        sendCoordinatedOrderToBuyer({
          buyerEmail,
          buyerName,
          listingTitle: listingInfo.title,
          listingUrl,
          amountPaid: amountFormatted,
          shopName: listingInfo.seller_name,
          sellerPhone: listingInfo.seller_phone ?? null,
          sellerWhatsapp: listingInfo.seller_whatsapp ?? null,
          orderUrl,
          personalization,
          eventTickets,
          storeDomain,
          rentalBooking: (orderMeta.rental_booking as RentalBookingLike | undefined) ?? null,
          currency,
        }).catch(e => console.error('[email] coord buyer:', e))
      } else {
        sendOrderConfirmedToBuyer({
          buyerEmail,
          buyerName,
          listingTitle: listingInfo.title,
          listingUrl,
          amountPaid: amountFormatted,
          shopName: listingInfo.seller_name,
          isDigital: false,
          digitalDownloadUrl: null,
          digitalExpiresAt: null,
          personalization,
          eventTickets,
          storeDomain,
        }).catch(e => console.error('[email] medusa order confirmed buyer:', e))
      }

      // ── Compras (Push/Telegram) — additive only; the email above is untouched ──
      const buyerMsg = buildBuyerMessage('order_confirmed', {
        listingTitle: listingInfo.title,
        url: orderUrl,
        amountPaid: amountFormatted,
      })
      void dispatchToBuyer(
        { clerkUserId: buyerClerkId, email: buyerEmail },
        { group: 'buyer.compras', push: buyerMsg.push, telegram: buyerMsg.telegram },
      )

      // ── Seller notification (orders group: email + push, through the seam) ──
      // Default-on parity: the same fulfillment-branch email still fires unless
      // "Pedidos → Email" is off. The closure preserves the exact branch choice.
      if (listingInfo.seller_clerk_id && shouldNotifySellerOfSale(session.metadata)) {
        const sellerOrderUrl = `${process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com'}/shop/manage/orders/${medusaOrderId ?? cart_id}`
        void dispatchToSeller(listingInfo.seller_clerk_id, {
          group: 'orders',
          email: to => {
            if (isPickup) {
              return sendPickupOrderToSeller({
                sellerEmail: to,
                listingTitle: listingInfo.title,
                listingUrl,
                amountPaid: amountFormatted,
                buyerName,
                buyerEmail,
                shopName: listingInfo.seller_name,
                orderUrl: sellerOrderUrl,
                personalization,
              })
            }
            if (isCoord) {
              return sendCoordinatedOrderToSeller({
                sellerEmail: to,
                listingTitle: listingInfo.title,
                listingUrl,
                amountPaid: amountFormatted,
                buyerName,
                buyerEmail,
                shopName: listingInfo.seller_name,
                orderId: medusaOrderId ?? cart_id,
                orderUrl: sellerOrderUrl,
                personalization,
                rentalBooking: (orderMeta.rental_booking as RentalBookingLike | undefined) ?? null,
                currency,
              })
            }
            if (isShipping) {
              return sendNewOrderToSeller({
                sellerEmail: to,
                listingTitle: listingInfo.title,
                listingUrl,
                amountPaid: amountFormatted,
                buyerName,
                buyerEmail,
                shippingAddress: null,
                orderId: medusaOrderId ?? cart_id,
                orderUrl: sellerOrderUrl,
                personalization,
              })
            }
            return sendSaleCompletedToSeller({
              sellerEmail: to,
              listingTitle: listingInfo.title,
              listingUrl,
              amountPaid: amountFormatted,
              buyerName,
              buyerEmail,
              isDigital: false,
            })
          },
          push: {
            kind: 'order',
            title: '¡Vendiste!',
            body: `${amountFormatted} · ${listingInfo.title}`,
            url: listingUrl,
          },
          telegram:
            `🛒 <b>¡Vendiste!</b>\n${escapeHtml(listingInfo.title)} — <b>${escapeHtml(amountFormatted)}</b>\n` +
            `Comprador: ${escapeHtml(buyerName || buyerEmail || '')}\n${escapeHtml(listingUrl)}`,
        })
      }
    }
  }
}

// ── Digital fulfillment — signs storage URL and marks order fulfilled ─────────
// Returns the download URL + expiry so the caller can include it in emails.

async function fulfillDigitalOrder({
  listing,
  orderId,
}: {
  listing: { id: string; metadata: unknown }
  orderId: string
}): Promise<{ downloadUrl: string | null; expiresAt: string | null }> {
  const meta = listing.metadata as Record<string, unknown> | null
  const digitalFile = meta?.digital_file as { path?: string; name?: string } | undefined

  if (!digitalFile?.path) {
    console.warn('No digital_file.path for listing', listing.id)
    return { downloadUrl: null, expiresAt: null }
  }

  const EXPIRY = 48 * 60 * 60 // seconds

  let signedUrl: string | null = null
  if (isR2DigitalConfigured()) {
    try {
      signedUrl = await getR2DigitalSignedUrl(digitalFile.path, EXPIRY, digitalFile.name ?? 'download')
    } catch (e) {
      console.error('[r2-digital] fulfillDigitalOrder signed URL failed:', e)
    }
  } else {
    // Supabase fallback for files uploaded before R2 migration
    const { data: signed } = await db.storage
      .from('digital-files')
      .createSignedUrl(digitalFile.path, EXPIRY, { download: digitalFile.name ?? 'download' })
    signedUrl = signed?.signedUrl ?? null
  }

  if (!signedUrl) {
    console.error('Failed to create signed URL for', digitalFile.path)
    return { downloadUrl: null, expiresAt: null }
  }

  const expiresAt = new Date(Date.now() + EXPIRY * 1000).toISOString()

  await db.from('marketplace_orders').update({
    digital_download_url: signedUrl,
    digital_download_expires_at: expiresAt,
    status: 'fulfilled',
  }).eq('id', orderId)

  return { downloadUrl: signedUrl, expiresAt }
}

// ── account.updated — sync seller Stripe status ───────────────────────────────

async function handleAccountUpdated(account: Stripe.Account) {
  if (!account.id) return

  // Sync Medusa seller metadata (new system)
  try {
    await fetch(`${MEDUSA_BASE}/store/sellers/stripe-sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-publishable-api-key': MEDUSA_PUB_KEY,
        // This route flips a seller's payment readiness, so it must not stay open
        // to anonymous callers. The backend starts REQUIRING this header in a later
        // deploy; sending it first is inert until then, which is what makes the two
        // repos safe to land in either order. The backend has no preview environment,
        // so enforcing before this shipped would have broken MX account.updated syncs.
        'x-internal-secret': process.env.MEDUSA_INTERNAL_SECRET ?? '',
      },
      body: JSON.stringify({
        stripe_account_id: account.id,
        charges_enabled: account.charges_enabled,
        details_submitted: account.details_submitted,
      }),
    })
  } catch (e) {
    console.error('[stripe webhook] Medusa seller stripe-sync failed:', e)
  }

  // Also sync legacy Supabase shops table (backwards compat during migration)
  const { data: shop } = await db
    .from('marketplace_shops')
    .select('id, metadata')
    .filter('metadata->settings->stripe->>account_id', 'eq', account.id)
    .maybeSingle()

  if (!shop) return

  const meta = (shop.metadata ?? {}) as Record<string, unknown>
  const settings = (meta.settings ?? {}) as Record<string, unknown>
  const existingStripe = (settings.stripe ?? {}) as Record<string, unknown>

  await db.from('marketplace_shops').update({
    metadata: {
      ...meta,
      settings: {
        ...settings,
        stripe: {
          ...existingStripe,
          charges_enabled: account.charges_enabled,
          details_submitted: account.details_submitted,
          onboarding_complete: account.charges_enabled && account.details_submitted,
        },
      },
    },
  }).eq('id', shop.id)
}

// ── Custom-domain subscription: checkout.session.completed ────────────────────
// (epic 07 · custom-domain-paywall S2). The PLATFORM is the payee — no transfer.
// Activates a Medusa Subscription (subscriber = seller), which flips the Sprint-1
// entitlement seam on. Recorded ONLY in Medusa (the source of truth) — no
// marketplace_subscriptions row (that table is listing-scoped).
async function handleCustomDomainSubscriptionComplete(session: Stripe.Checkout.Session) {
  const shopId = session.metadata?.shop_id
  const sellerClerkId = session.metadata?.seller_clerk_id
  const stripeSubscriptionId = session.subscription as string | null
  if (!shopId || !sellerClerkId || !stripeSubscriptionId) {
    console.error('[custom-domain sub] missing metadata/subscription:', session.id)
    return
  }

  const sellerEmail = session.customer_details?.email?.toLowerCase().trim() ?? ''

  const stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId)
  type SubWithPeriod = { current_period_start: number; current_period_end: number }
  const _sub = stripeSub as unknown as SubWithPeriod
  const periodStart = new Date(_sub.current_period_start * 1000).toISOString()
  const periodEnd   = new Date(_sub.current_period_end   * 1000).toISOString()
  const stripePriceId = stripeSub.items.data[0]?.price?.id

  // Resolve the platform plan by its Stripe price, then activate the Medusa sub.
  try {
    if (!stripePriceId) throw new Error('no price on subscription')
    const planRes = await fetch(
      `${MEDUSA_BASE}/store/sellers/subscription-plans/by-stripe-price?stripe_price_id=${encodeURIComponent(stripePriceId)}`,
      { headers: { 'x-publishable-api-key': MEDUSA_PUB_KEY } },
    )
    if (!planRes.ok) throw new Error(`plan lookup ${planRes.status}`)
    const { plan } = (await planRes.json()) as { plan?: { id: string } }
    if (!plan?.id) throw new Error('plan not found')

    const subRes = await fetch(`${MEDUSA_BASE}/store/subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-publishable-api-key': MEDUSA_PUB_KEY,
        'x-internal-secret': process.env.MEDUSA_INTERNAL_SECRET ?? '',
      },
      body: JSON.stringify({
        plan_id: plan.id,
        seller_id: shopId, // subscriber's shop (denormalized; entitlement keys off clerk id)
        clerk_user_id: sellerClerkId,
        buyer_email: sellerEmail || `${sellerClerkId}@seller.miyagisanchez.com`,
        status: 'active',
        payment_method: 'stripe',
        stripe_subscription_id: stripeSubscriptionId,
        stripe_customer_id: session.customer as string | null,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        metadata: { kind: CUSTOM_DOMAIN_CHECKOUT_KIND, shop_id: shopId },
      }),
    })
    if (!subRes.ok) throw new Error(`subscription create ${subRes.status}`)
  } catch (e) {
    // Money-path safety (S3 carryover nit): the seller PAID but isn't entitled,
    // and Stripe won't retry (this handler returns 200). Alert operationally so
    // the activation can be repaired by hand.
    console.error('[custom-domain sub] Medusa activation failed:', e)
    tg.alert(
      `🚨 Dominio propio PAGADO pero NO activado — reparar a mano.\n` +
      `Shop: ${shopId}\nSeller: ${sellerClerkId}\nStripe sub: ${stripeSubscriptionId}\nError: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  // Clear any prior lapse flag so the re-add-payment prompt disappears.
  try {
    const { data: shop } = await db
      .from('marketplace_shops')
      .select('metadata')
      .eq('id', shopId)
      .maybeSingle()
    const meta = (shop?.metadata ?? {}) as Record<string, unknown>
    if (meta.custom_domain_lapsed) {
      delete meta.custom_domain_lapsed
      await db.from('marketplace_shops').update({ metadata: meta }).eq('id', shopId)
    }
  } catch (e) {
    console.error('[custom-domain sub] clear lapse flag failed:', e)
  }

  tg.alert(`✅ Dominio propio activado\nShop: ${shopId}\nSeller: ${sellerClerkId}`)
}

// ── Custom-domain ONE-TIME: checkout.session.completed (mode=payment) ─────────
// (epic 08 · promoter-program S2). A pay-a-year-up-front purchase with NO Stripe
// subscription. Entitlement is a DATED 12-month grant on the shop metadata (the
// custom_domain_grant seam) that lapses on read — so nothing auto-charges at year
// end. When a promoter is attributed, the attribution flips to `paid` with the
// real amount collected. Mirrors handleCustomDomainSubscriptionComplete's safety:
// the seller PAID, so a failed grant write is alerted for hand-repair (Stripe
// won't retry a handler that returns 200).
async function handleCustomDomainOneTimeComplete(session: Stripe.Checkout.Session) {
  const shopId = session.metadata?.shop_id
  // The grant lands on the SHOP (by id); seller_clerk_id is informational and is
  // empty when a promoter pays for an UNCLAIMED shop (epic 08 · S4 · US-10), so
  // only shop_id is truly required.
  const sellerClerkId = session.metadata?.seller_clerk_id ?? ''
  const paidByPromoter = session.metadata?.paid_by_promoter === '1'
  if (!shopId) {
    console.error('[custom-domain one-time] missing shop_id:', session.id)
    return
  }

  // Write the dated one-time grant (+ clear any prior lapse flag) on the shop's
  // metadata JSONB — the SAME field every entitlement reader derives from. The
  // seller PAID, so a write that doesn't land MUST be caught: verify the shop
  // exists AND that the update affected a row (a `.eq` matching 0 rows returns
  // no error — the classic silent 0-row write), else alert for hand-repair.
  try {
    const { data: shop } = await db
      .from('marketplace_shops')
      .select('metadata')
      .eq('id', shopId)
      .maybeSingle()
    if (!shop) throw new Error(`no shop row for id ${shopId}`)
    const meta = ((shop.metadata ?? {}) as Record<string, unknown>)
    meta.custom_domain_grant = buildOneTimeGrant({ note: oneTimeGrantNote(paidByPromoter) })
    delete meta.custom_domain_lapsed
    const { data: updated, error } = await db
      .from('marketplace_shops')
      .update({ metadata: meta })
      .eq('id', shopId)
      .select('id')
    if (error) throw new Error(error.message)
    if (!updated || updated.length === 0) throw new Error(`grant update matched 0 rows for id ${shopId}`)
  } catch (e) {
    console.error('[custom-domain one-time] grant write failed:', e)
    tg.alert(
      `🚨 Dominio propio (pago único) PAGADO pero NO activado — reparar a mano.\n` +
      `Shop: ${shopId}\nSeller: ${sellerClerkId}\nSession: ${session.id}\nError: ${e instanceof Error ? e.message : String(e)}`,
    )
    return
  }

  // Promoter attribution → paid, with the real amount collected (post-discount).
  const promoterId = session.metadata?.promoter_id
  const promoterSku = session.metadata?.promoter_sku
  if (promoterId && isPromoterSku(promoterSku)) {
    await markAttributionPaid({
      promoterId,
      sellerId: shopId,
      sku: promoterSku,
      grossAmountCents: session.amount_total ?? 0,
      cadence: 'one_time',
    })
    // Sprint 5 (US-5.5) — the merchant receipt, one per completed close.
    notifyMerchantCloseReceipt({
      shopId,
      promoterId,
      items: [{ label: 'Dominio propio (1 año)', amountMxn: formatMxnCents(session.amount_total ?? 0) }],
    }).catch((e) => console.error('[custom-domain one-time] receipt failed:', e))
  }

  tg.alert(`✅ Dominio propio activado (pago único, 12 meses)\nShop: ${shopId}\nSeller: ${sellerClerkId}`)
}

// ── Subdomain subscription: checkout.session.completed ────────────────────────
// (epic 07 · subdomain-pricing S2). A faithful clone of the custom-domain handler
// for the cheaper subdomain SKU. The PLATFORM is the payee — no transfer. Activates
// a Medusa Subscription (subscriber = seller) against the platform subdomain plan,
// which flips the subdomain entitlement seam on (white-label instead of 301→/s/slug).
async function handleSubdomainSubscriptionComplete(session: Stripe.Checkout.Session) {
  const shopId = session.metadata?.shop_id
  const sellerClerkId = session.metadata?.seller_clerk_id
  const stripeSubscriptionId = session.subscription as string | null
  if (!shopId || !sellerClerkId || !stripeSubscriptionId) {
    console.error('[subdomain sub] missing metadata/subscription:', session.id)
    return
  }

  const sellerEmail = session.customer_details?.email?.toLowerCase().trim() ?? ''

  const stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId)
  type SubWithPeriod = { current_period_start: number; current_period_end: number }
  const _sub = stripeSub as unknown as SubWithPeriod
  const periodStart = new Date(_sub.current_period_start * 1000).toISOString()
  const periodEnd   = new Date(_sub.current_period_end   * 1000).toISOString()

  // Resolve the platform subdomain plan BY KIND (not by Stripe price): the SAME plan
  // now carries both the yearly price (its column) and the monthly price (its
  // metadata, Sprint 3), so a by-stripe-price lookup would miss a monthly-priced
  // subscription. The kind-based read returns the one plan for either cadence.
  try {
    const { plan_id } = await getSubdomainSubscription(sellerClerkId)
    if (!plan_id) throw new Error('subdomain plan not found')

    const subRes = await fetch(`${MEDUSA_BASE}/store/subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-publishable-api-key': MEDUSA_PUB_KEY,
        'x-internal-secret': process.env.MEDUSA_INTERNAL_SECRET ?? '',
      },
      body: JSON.stringify({
        plan_id,
        seller_id: shopId, // subscriber's shop (denormalized; entitlement keys off clerk id)
        clerk_user_id: sellerClerkId,
        buyer_email: sellerEmail || `${sellerClerkId}@seller.miyagisanchez.com`,
        status: 'active',
        payment_method: 'stripe',
        stripe_subscription_id: stripeSubscriptionId,
        stripe_customer_id: session.customer as string | null,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        metadata: { kind: SUBDOMAIN_CHECKOUT_KIND, shop_id: shopId },
      }),
    })
    if (!subRes.ok) throw new Error(`subscription create ${subRes.status}`)
  } catch (e) {
    // Money-path safety: the seller PAID but isn't entitled, and Stripe won't retry
    // (this handler returns 200). Alert operationally for hand-repair.
    console.error('[subdomain sub] Medusa activation failed:', e)
    tg.alert(
      `🚨 Subdominio PAGADO pero NO activado — reparar a mano.\n` +
      `Shop: ${shopId}\nSeller: ${sellerClerkId}\nStripe sub: ${stripeSubscriptionId}\nError: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  // Clear any prior lapse flag so the re-add-payment prompt disappears.
  try {
    const { data: shop } = await db
      .from('marketplace_shops')
      .select('metadata')
      .eq('id', shopId)
      .maybeSingle()
    const meta = (shop?.metadata ?? {}) as Record<string, unknown>
    if (meta.subdomain_lapsed) {
      delete meta.subdomain_lapsed
      await db.from('marketplace_shops').update({ metadata: meta }).eq('id', shopId)
    }
  } catch (e) {
    console.error('[subdomain sub] clear lapse flag failed:', e)
  }

  tg.alert(`✅ Subdominio activado\nShop: ${shopId}\nSeller: ${sellerClerkId}`)
}

// ── Subdomain ONE-TIME: checkout.session.completed (mode=payment) ─────────────
// (epic 07 · subdomain-pricing S2). A pay-a-year-up-front purchase with NO Stripe
// subscription. Entitlement is a DATED 12-month grant on the shop metadata (the
// subdomain_grant seam) that lapses on read — nothing auto-charges at year end.
// When a promoter is attributed, the attribution flips to `paid` with the real
// amount collected. Mirrors the custom-domain one-time handler's safety.
async function handleSubdomainOneTimeComplete(session: Stripe.Checkout.Session) {
  const shopId = session.metadata?.shop_id
  // The grant lands on the SHOP (by id); seller_clerk_id is informational and is
  // empty when a promoter pays for an UNCLAIMED shop, so only shop_id is required.
  const sellerClerkId = session.metadata?.seller_clerk_id ?? ''
  const paidByPromoter = session.metadata?.paid_by_promoter === '1'
  if (!shopId) {
    console.error('[subdomain one-time] missing shop_id:', session.id)
    return
  }

  // Write the dated one-time grant (+ clear any prior lapse flag) on the shop's
  // metadata JSONB — the SAME field the entitlement reader derives from. The seller
  // PAID, so a write that doesn't land MUST be caught: verify the shop exists AND
  // that the update affected a row (a `.eq` matching 0 rows returns no error — the
  // classic silent 0-row write), else alert for hand-repair.
  try {
    const { data: shop } = await db
      .from('marketplace_shops')
      .select('metadata')
      .eq('id', shopId)
      .maybeSingle()
    if (!shop) throw new Error(`no shop row for id ${shopId}`)
    const meta = ((shop.metadata ?? {}) as Record<string, unknown>)
    meta[SUBDOMAIN_GRANT_KEY] = buildOneTimeGrant({ note: oneTimeGrantNote(paidByPromoter) })
    delete meta.subdomain_lapsed
    const { data: updated, error } = await db
      .from('marketplace_shops')
      .update({ metadata: meta })
      .eq('id', shopId)
      .select('id')
    if (error) throw new Error(error.message)
    if (!updated || updated.length === 0) throw new Error(`grant update matched 0 rows for id ${shopId}`)
  } catch (e) {
    console.error('[subdomain one-time] grant write failed:', e)
    tg.alert(
      `🚨 Subdominio (pago único) PAGADO pero NO activado — reparar a mano.\n` +
      `Shop: ${shopId}\nSeller: ${sellerClerkId}\nSession: ${session.id}\nError: ${e instanceof Error ? e.message : String(e)}`,
    )
    return
  }

  // Promoter attribution → paid, with the real amount collected (post-discount).
  const promoterId = session.metadata?.promoter_id
  const promoterSku = session.metadata?.promoter_sku
  if (promoterId && isPromoterSku(promoterSku)) {
    await markAttributionPaid({
      promoterId,
      sellerId: shopId,
      sku: promoterSku,
      grossAmountCents: session.amount_total ?? 0,
      cadence: 'one_time',
    })
    // Sprint 5 (US-5.5) — the merchant receipt, one per completed close.
    notifyMerchantCloseReceipt({
      shopId,
      promoterId,
      items: [{ label: 'Subdominio propio (1 año)', amountMxn: formatMxnCents(session.amount_total ?? 0) }],
    }).catch((e) => console.error('[subdomain one-time] receipt failed:', e))
  }

  tg.alert(`✅ Subdominio activado (pago único, 12 meses)\nShop: ${shopId}\nSeller: ${sellerClerkId}`)
}

// ── ML-sync RECURRING: checkout.session.completed (mode=subscription) ─────────
// (epic 03 · mercadolibre-sync S6). Faithful clone of the subdomain subscription
// handler onto the ml_sync plan. The platform is the payee; entitlement flips on
// via the Medusa subscription (resolved by kind, covering yearly + monthly).
async function handleMlSyncSubscriptionComplete(session: Stripe.Checkout.Session) {
  const shopId = session.metadata?.shop_id
  const sellerClerkId = session.metadata?.seller_clerk_id
  const stripeSubscriptionId = session.subscription as string | null
  if (!shopId || !sellerClerkId || !stripeSubscriptionId) {
    console.error('[ml-sync sub] missing metadata/subscription:', session.id)
    return
  }

  const sellerEmail = session.customer_details?.email?.toLowerCase().trim() ?? ''

  const stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId)
  type SubWithPeriod = { current_period_start: number; current_period_end: number }
  const _sub = stripeSub as unknown as SubWithPeriod
  const periodStart = new Date(_sub.current_period_start * 1000).toISOString()
  const periodEnd   = new Date(_sub.current_period_end   * 1000).toISOString()

  // Resolve the platform ML-sync plan BY KIND (covers yearly column + monthly
  // metadata price in one read).
  try {
    const { plan_id } = await getMlSyncSubscription(sellerClerkId)
    if (!plan_id) throw new Error('ml-sync plan not found')

    const subRes = await fetch(`${MEDUSA_BASE}/store/subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-publishable-api-key': MEDUSA_PUB_KEY,
        'x-internal-secret': process.env.MEDUSA_INTERNAL_SECRET ?? '',
      },
      body: JSON.stringify({
        plan_id,
        seller_id: shopId,
        clerk_user_id: sellerClerkId,
        buyer_email: sellerEmail || `${sellerClerkId}@seller.miyagisanchez.com`,
        status: 'active',
        payment_method: 'stripe',
        stripe_subscription_id: stripeSubscriptionId,
        stripe_customer_id: session.customer as string | null,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        metadata: { kind: ML_SYNC_CHECKOUT_KIND, shop_id: shopId },
      }),
    })
    if (!subRes.ok) throw new Error(`subscription create ${subRes.status}`)
  } catch (e) {
    // Money-path safety: the seller PAID but isn't entitled, and Stripe won't retry
    // (this handler returns 200). Alert operationally for hand-repair.
    console.error('[ml-sync sub] Medusa activation failed:', e)
    tg.alert(
      `🚨 Sincronización ML PAGADA pero NO activada — reparar a mano.\n` +
      `Shop: ${shopId}\nSeller: ${sellerClerkId}\nStripe sub: ${stripeSubscriptionId}\nError: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  tg.alert(`✅ Sincronización Mercado Libre activada\nShop: ${shopId}\nSeller: ${sellerClerkId}`)
}

// ── ML-sync ONE-TIME: checkout.session.completed (mode=payment) ───────────────
// (epic 03 · mercadolibre-sync S6). A pay-a-year-up-front purchase with NO Stripe
// subscription — entitlement is a DATED 12-month grant on the shop metadata (the
// ml_sync_grant seam) that lapses on read. Mirrors the subdomain one-time handler's
// safety (verify the write landed; alert on a silent 0-row write).
async function handleMlSyncOneTimeComplete(session: Stripe.Checkout.Session) {
  const shopId = session.metadata?.shop_id
  const sellerClerkId = session.metadata?.seller_clerk_id ?? ''
  const paidByPromoter = session.metadata?.paid_by_promoter === '1'
  if (!shopId) {
    console.error('[ml-sync one-time] missing shop_id:', session.id)
    return
  }

  try {
    const { data: shop } = await db
      .from('marketplace_shops')
      .select('metadata')
      .eq('id', shopId)
      .maybeSingle()
    if (!shop) throw new Error(`no shop row for id ${shopId}`)
    const meta = (shop.metadata ?? {}) as Record<string, unknown>
    meta[ML_SYNC_GRANT_KEY] = buildOneTimeGrant({ note: oneTimeGrantNote(paidByPromoter) })
    const { data: updated, error } = await db
      .from('marketplace_shops')
      .update({ metadata: meta })
      .eq('id', shopId)
      .select('id')
    if (error) throw new Error(error.message)
    if (!updated || updated.length === 0) throw new Error(`grant update matched 0 rows for id ${shopId}`)
  } catch (e) {
    console.error('[ml-sync one-time] grant write failed:', e)
    tg.alert(
      `🚨 Sincronización ML (pago único) PAGADA pero NO activada — reparar a mano.\n` +
      `Shop: ${shopId}\nSeller: ${sellerClerkId}\nSession: ${session.id}\nError: ${e instanceof Error ? e.message : String(e)}`,
    )
    return
  }

  // Promoter attribution → paid, with the real amount collected (post-discount).
  const promoterId = session.metadata?.promoter_id
  const promoterSku = session.metadata?.promoter_sku
  if (promoterId && isPromoterSku(promoterSku)) {
    await markAttributionPaid({
      promoterId,
      sellerId: shopId,
      sku: promoterSku,
      grossAmountCents: session.amount_total ?? 0,
      cadence: 'one_time',
    })
    // Sprint 5 (US-5.5) — the merchant receipt, one per completed close.
    notifyMerchantCloseReceipt({
      shopId,
      promoterId,
      items: [{ label: 'Sincronización Mercado Libre (1 año)', amountMxn: formatMxnCents(session.amount_total ?? 0) }],
    }).catch((e) => console.error('[ml-sync one-time] receipt failed:', e))
  }

  tg.alert(`✅ Sincronización Mercado Libre activada (pago único, 12 meses)\nShop: ${shopId}\nSeller: ${sellerClerkId}`)
}

/**
 * migration SKU (epic 03 · platform-migrations, Sprint 2 · US-2.1/US-2.2) — a
 * one-time consulting service the promoter already delivered by the time this
 * fires. No ongoing feature to entitle (unlike ml-sync/domain/subdomain), so
 * `migration_grant` is an inert paid/audit marker only. The charge amount was
 * already resolved server-side at checkout creation
 * (lib/migration-checkout.ts#resolveMigrationCharge) — this handler never
 * re-derives or second-guesses it, only records what Stripe actually collected.
 */
async function handleMigrationOneTimeComplete(session: Stripe.Checkout.Session) {
  const shopId = session.metadata?.shop_id
  const sellerClerkId = session.metadata?.seller_clerk_id ?? ''
  const paidByPromoter = session.metadata?.paid_by_promoter === '1'
  if (!shopId) {
    console.error('[migration one-time] missing shop_id:', session.id)
    return
  }

  try {
    const { data: shop } = await db
      .from('marketplace_shops')
      .select('metadata')
      .eq('id', shopId)
      .maybeSingle()
    if (!shop) throw new Error(`no shop row for id ${shopId}`)
    const meta = (shop.metadata ?? {}) as Record<string, unknown>
    meta[MIGRATION_GRANT_KEY] = buildOneTimeGrant({ note: oneTimeGrantNote(paidByPromoter) })
    const { data: updated, error } = await db
      .from('marketplace_shops')
      .update({ metadata: meta })
      .eq('id', shopId)
      .select('id')
    if (error) throw new Error(error.message)
    if (!updated || updated.length === 0) throw new Error(`grant update matched 0 rows for id ${shopId}`)
  } catch (e) {
    console.error('[migration one-time] grant write failed:', e)
    tg.alert(
      `🚨 Migración de tienda PAGADA pero NO registrada — reparar a mano.\n` +
      `Shop: ${shopId}\nSeller: ${sellerClerkId}\nSession: ${session.id}\nError: ${e instanceof Error ? e.message : String(e)}`,
    )
    return
  }

  const promoterId = session.metadata?.promoter_id
  const promoterSku = session.metadata?.promoter_sku
  if (promoterId && isPromoterSku(promoterSku)) {
    await markAttributionPaid({
      promoterId,
      sellerId: shopId,
      sku: promoterSku,
      grossAmountCents: session.amount_total ?? 0,
      cadence: 'one_time',
    })
    notifyMerchantCloseReceipt({
      shopId,
      promoterId,
      items: [{ label: 'Migración de tienda', amountMxn: formatMxnCents(session.amount_total ?? 0) }],
    }).catch((e) => console.error('[migration one-time] receipt failed:', e))
  }

  tg.alert(`✅ Migración de tienda pagada\nShop: ${shopId}\nSeller: ${sellerClerkId}\nMonto: ${formatMxnCents(session.amount_total ?? 0)}`)
}

// ── Subscription: checkout.session.completed (mode=subscription) ──────────────

async function handleSubscriptionCheckoutComplete(session: Stripe.Checkout.Session) {
  const { listing_id, shop_id, buyer_clerk_id, tier_id } = session.metadata ?? {}
  if (!listing_id || !shop_id) return

  const stripeSubscriptionId = session.subscription as string | null
  const buyerEmail = session.customer_details?.email ?? null
  const buyerName  = session.customer_details?.name ?? null

  if (!stripeSubscriptionId) {
    console.error('[stripe sub] no subscription ID in session:', session.id)
    return
  }

  // Fetch subscription from Stripe to get period dates
  const stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId)
  // `current_period_*` moved off top-level in newer Stripe API versions — cast to access
  type SubWithPeriod = { current_period_start: number; current_period_end: number; cancel_at_period_end: boolean }
  const _sub = stripeSub as unknown as SubWithPeriod

  const periodStart = new Date(_sub.current_period_start * 1000).toISOString()
  const periodEnd   = new Date(_sub.current_period_end   * 1000).toISOString()

  const { data: existing } = await db
    .from('marketplace_subscriptions')
    .select('id')
    .eq('stripe_subscription_id', stripeSubscriptionId)
    .maybeSingle()

  if (existing) return // idempotent

  await db.from('marketplace_subscriptions').insert({
    listing_id,
    shop_id,
    buyer_clerk_user_id: buyer_clerk_id || null,
    buyer_email:  buyerEmail?.toLowerCase().trim() ?? '',
    buyer_name:   buyerName ?? null,
    stripe_subscription_id: stripeSubscriptionId,
    stripe_customer_id: session.customer as string | null,
    payment_method: 'stripe',
    status: 'active',
    current_period_start: periodStart,
    current_period_end:   periodEnd,
    tier_id: tier_id || null,
  })

  // ── Also record in Medusa subscriptions module (best-effort) ─────────────
  // Look up the Medusa SubscriptionPlan by stripe_price_id
  try {
    const stripePriceId = stripeSub.items.data[0]?.price?.id
    if (stripePriceId) {
      // Find matching Medusa plan via the subscription-plans listing endpoint
      const planLookupRes = await fetch(
        `${MEDUSA_BASE}/store/sellers/subscription-plans/by-stripe-price?stripe_price_id=${encodeURIComponent(stripePriceId)}`,
        { headers: { 'x-publishable-api-key': MEDUSA_PUB_KEY } }
      )
      if (planLookupRes.ok) {
        const { plan } = await planLookupRes.json() as { plan?: { id: string; seller_id: string } }
        if (plan?.id) {
          await fetch(`${MEDUSA_BASE}/store/subscriptions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-publishable-api-key': MEDUSA_PUB_KEY,
              'x-internal-secret': process.env.MEDUSA_INTERNAL_SECRET ?? '',
            },
            body: JSON.stringify({
              plan_id: plan.id,
              seller_id: plan.seller_id,
              buyer_email: buyerEmail?.toLowerCase().trim() ?? '',
              clerk_user_id: buyer_clerk_id ?? null,
              status: 'active',
              payment_method: 'stripe',
              stripe_subscription_id: stripeSubscriptionId,
              stripe_customer_id: session.customer as string | null,
              current_period_start: periodStart,
              current_period_end: periodEnd,
              metadata: { listing_id, shop_id, tier_id: tier_id ?? null },
            }),
          }).catch(e => console.error('[stripe sub] Medusa subscription record failed:', e))
        }
      }
    }
  } catch (e) {
    console.error('[stripe sub] Medusa subscription sync error:', e)
  }

  tg.newSubscription(
    `${(stripeSub.items.data[0]?.price.unit_amount ?? 0) / 100} ${stripeSub.currency.toUpperCase()}`,
    'month',
    listing_id,
    buyerEmail ?? 'comprador',
  )
}

// ── customer.subscription.updated ─────────────────────────────────────────────

async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  // Custom-domain paywall (S2.2): sync the Medusa status (the entitlement source
  // of truth). The domain is only released by customer.subscription.deleted.
  if (subscription.metadata?.kind === CUSTOM_DOMAIN_CHECKOUT_KIND) {
    const map: Record<string, 'active' | 'trialing' | 'past_due' | 'canceled'> = {
      active: 'active', trialing: 'trialing', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled',
    }
    const mapped = map[subscription.status]
    if (mapped) await setCustomDomainSubscriptionStatus(subscription.id, mapped)
    return
  }

  // Subdomain paywall (S2): same status sync against the Medusa subdomain sub.
  if (subscription.metadata?.kind === SUBDOMAIN_CHECKOUT_KIND) {
    const map: Record<string, 'active' | 'trialing' | 'past_due' | 'canceled'> = {
      active: 'active', trialing: 'trialing', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled',
    }
    const mapped = map[subscription.status]
    if (mapped) await setSubdomainSubscriptionStatus(subscription.id, mapped)
    return
  }

  // ML-sync paid SKU (S6): same status sync against the Medusa ML-sync sub.
  if (subscription.metadata?.kind === ML_SYNC_CHECKOUT_KIND) {
    const map: Record<string, 'active' | 'trialing' | 'past_due' | 'canceled'> = {
      active: 'active', trialing: 'trialing', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled',
    }
    const mapped = map[subscription.status]
    if (mapped) await setMlSyncSubscriptionStatus(subscription.id, mapped)
    return
  }

  type SubWithPeriod = { current_period_start: number; current_period_end: number }
  const _s = subscription as unknown as SubWithPeriod
  const periodStart = new Date(_s.current_period_start * 1000).toISOString()
  const periodEnd   = new Date(_s.current_period_end   * 1000).toISOString()

  await db.from('marketplace_subscriptions')
    .update({
      status: subscription.status,
      current_period_start: periodStart,
      current_period_end:   periodEnd,
      cancel_at_period_end: subscription.cancel_at_period_end,
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_subscription_id', subscription.id)
}

// ── customer.subscription.deleted ─────────────────────────────────────────────

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  // Custom-domain paywall (S2.2): a definitive cancel flips entitlement off and
  // releases the domain → the shop reverts to its free subdomain + slug.
  if (subscription.metadata?.kind === CUSTOM_DOMAIN_CHECKOUT_KIND) {
    await setCustomDomainSubscriptionStatus(subscription.id, 'canceled')
    await releaseCustomDomainForShop(subscription.metadata?.shop_id)
    return
  }

  // Subdomain paywall (S2): a definitive cancel flips entitlement off. There's
  // nothing physical to release — the subdomain IS the slug — so simply flipping
  // the Medusa sub to `canceled` makes the gate re-close (301 → free /s/slug) on
  // the next request. No grant is cleared (recurring entitles via the sub, not a
  // grant); a one-time grant would lapse on its own date.
  if (subscription.metadata?.kind === SUBDOMAIN_CHECKOUT_KIND) {
    await setSubdomainSubscriptionStatus(subscription.id, 'canceled')
    return
  }

  // ML-sync paid SKU (S6): a definitive cancel flips entitlement off — the gate
  // re-closes on the next read (sync toggle disabled). No grant to clear (recurring
  // entitles via the sub; a one-time grant lapses on its own date).
  if (subscription.metadata?.kind === ML_SYNC_CHECKOUT_KIND) {
    await setMlSyncSubscriptionStatus(subscription.id, 'canceled')
    return
  }

  await db.from('marketplace_subscriptions')
    .update({ status: 'canceled', updated_at: new Date().toISOString() })
    .eq('stripe_subscription_id', subscription.id)
}

// Lapse cleanup (custom-domain) now lives in `lib/domain-lapse-server.ts` —
// shared by this webhook (subscription canceled) and the one-time expiry sweep.

// ── invoice.payment_succeeded ─────────────────────────────────────────────────

async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice) {
  const stripeSubscriptionId = (invoice as unknown as Record<string, unknown>).subscription as string | undefined
  if (!stripeSubscriptionId) return

  // Update billing period on the subscription
  const stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId)

  // Custom-domain paywall (S2.2): a successful renewal (or recovery from past_due)
  // keeps the Medusa sub active. No seller transfer — the platform is the payee.
  if (stripeSub.metadata?.kind === CUSTOM_DOMAIN_CHECKOUT_KIND) {
    await setCustomDomainSubscriptionStatus(stripeSubscriptionId, 'active')
    return
  }

  // Subdomain paywall (S2): a successful renewal (or recovery from past_due) keeps
  // the Medusa subdomain sub active. No seller transfer — the platform is the payee.
  if (stripeSub.metadata?.kind === SUBDOMAIN_CHECKOUT_KIND) {
    await setSubdomainSubscriptionStatus(stripeSubscriptionId, 'active')
    return
  }

  // ML-sync paid SKU (S6): a successful renewal (or recovery from past_due) keeps
  // the Medusa ML-sync sub active. No seller transfer — the platform is the payee.
  if (stripeSub.metadata?.kind === ML_SYNC_CHECKOUT_KIND) {
    await setMlSyncSubscriptionStatus(stripeSubscriptionId, 'active')
    return
  }

  type SubWithPeriod = { current_period_start: number; current_period_end: number }
  const _sp = stripeSub as unknown as SubWithPeriod
  const periodStart = new Date(_sp.current_period_start * 1000).toISOString()
  const periodEnd   = new Date(_sp.current_period_end   * 1000).toISOString()

  await db.from('marketplace_subscriptions')
    .update({
      status: 'active',
      current_period_start: periodStart,
      current_period_end:   periodEnd,
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_subscription_id', stripeSubscriptionId)

  // ── Transfer 97% to seller's connected account ──────────────────────────
  const amountPaid  = invoice.amount_paid ?? 0
  const currency    = invoice.currency ?? 'mxn'
  const chargeId    = (invoice as unknown as Record<string, unknown>).charge as string | undefined

  // Get the subscription to find the shop/listing
  const { data: sub } = await db
    .from('marketplace_subscriptions')
    .select('listing_id, shop_id')
    .eq('stripe_subscription_id', stripeSubscriptionId)
    .maybeSingle()

  if (sub && chargeId) {
    // Look up seller's connected Stripe account
    const { data: shop } = await db
      .from('marketplace_shops')
      .select('metadata')
      .eq('id', sub.shop_id)
      .maybeSingle()

    const shopMeta = (shop?.metadata ?? {}) as Record<string, unknown>
    const shopSettings = (shopMeta.settings ?? {}) as Record<string, unknown>
    const stripeSettings = (shopSettings.stripe ?? {}) as Record<string, unknown>
    const connectedAccountId = stripeSettings.account_id as string | undefined

    if (connectedAccountId && amountPaid > 0) {
      await transferToSeller({
        amountCents: amountPaid,
        currency,
        connectedAccountId,
        sourceTransaction: chargeId,
        metadata: { listing_id: sub.listing_id, shop_id: sub.shop_id, stripe_subscription_id: stripeSubscriptionId },
      })
    }
  }
}

// ── invoice.payment_failed ────────────────────────────────────────────────────

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const stripeSubscriptionId = (invoice as unknown as Record<string, unknown>).subscription as string | undefined
  if (!stripeSubscriptionId) return

  // Custom-domain paywall (S2.2): a failed renewal marks the Medusa sub past_due,
  // which is a GRACE state — entitlement stays live + the domain stays connected
  // while Stripe retries. Only customer.subscription.deleted disconnects.
  try {
    const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId)
    if (sub.metadata?.kind === CUSTOM_DOMAIN_CHECKOUT_KIND) {
      await setCustomDomainSubscriptionStatus(stripeSubscriptionId, 'past_due')
      tg.alert(`⚠️ Pago fallido en dominio propio (en gracia)\nSubscription: ${stripeSubscriptionId}`)
      return
    }
    // Subdomain paywall (S2): same grace state — entitlement stays live while
    // Stripe retries; only customer.subscription.deleted collapses to /s/slug.
    if (sub.metadata?.kind === SUBDOMAIN_CHECKOUT_KIND) {
      await setSubdomainSubscriptionStatus(stripeSubscriptionId, 'past_due')
      tg.alert(`⚠️ Pago fallido en subdominio (en gracia)\nSubscription: ${stripeSubscriptionId}`)
      return
    }
    // ML-sync paid SKU (S6): same grace state — entitlement stays live while Stripe
    // retries; only customer.subscription.deleted lapses it.
    if (sub.metadata?.kind === ML_SYNC_CHECKOUT_KIND) {
      await setMlSyncSubscriptionStatus(stripeSubscriptionId, 'past_due')
      tg.alert(`⚠️ Pago fallido en sincronización ML (en gracia)\nSubscription: ${stripeSubscriptionId}`)
      return
    }
  } catch (e) {
    console.error('[custom-domain/subdomain/ml-sync lapse] payment_failed lookup error:', e)
  }

  await db.from('marketplace_subscriptions')
    .update({ status: 'past_due', updated_at: new Date().toISOString() })
    .eq('stripe_subscription_id', stripeSubscriptionId)

  tg.alert(`⚠️ Pago fallido en suscripción Stripe\nSubscription: ${stripeSubscriptionId}`)
}
