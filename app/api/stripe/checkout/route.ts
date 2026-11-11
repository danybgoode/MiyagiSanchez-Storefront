import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { stripe, getShopStripe } from '@/lib/stripe'
import { db } from '@/lib/supabase'
import { detectChannel } from '@/lib/channel'
import { resolveOrigin } from '@/lib/request-origin'
import { listingUrlFor } from '@/lib/market-url'
import { OFFER_SESSION_TTL_MS, dbOfferClaim, dbOfferLookup, dbOfferRelease, gateOfferPurchase, releaseOfferReservation } from '@/lib/offer-reservation'

interface CheckoutBody {
  listingId: string
  buyerEmail?: string
  offerId?: string
}

function listingLookupColumn(listingId: string) {
  return listingId.startsWith('prod_') ? 'medusa_product_id' : 'id'
}

export async function POST(req: NextRequest) {
  // Auth is optional for one-time purchases — Stripe Checkout collects buyer email.
  // Subscriptions (different route) require auth for lifecycle management.
  const { userId } = await auth()

  let body: CheckoutBody
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Datos inválidos.' }, { status: 400 }) }

  if (!body.listingId) {
    return NextResponse.json({ error: 'listingId requerido.' }, { status: 400 })
  }

  // ── Fetch listing + shop ──────────────────────────────────────────────────
  const { data: listing } = await db
    .from('marketplace_listings')
    .select('id, title, price_cents, currency, listing_type, images, shop_id, metadata, marketplace_shops!inner(id, name, metadata)')
    .eq(listingLookupColumn(body.listingId), body.listingId)
    .eq('status', 'active')
    .single()

  if (!listing) {
    return NextResponse.json({ error: 'Anuncio no encontrado.' }, { status: 404 })
  }

  if (!listing.price_cents || listing.price_cents <= 0) {
    return NextResponse.json({ error: 'Este anuncio no tiene precio definido.' }, { status: 422 })
  }

  // ── Check seller has active Stripe account ────────────────────────────────
  const shops = listing.marketplace_shops as unknown as { id: string; name: string; metadata: Record<string, unknown> | null } | { id: string; name: string; metadata: Record<string, unknown> | null }[]
  const shop = Array.isArray(shops) ? shops[0] : shops
  const stripeSettings = getShopStripe(shop?.metadata ?? null)

  if (stripeSettings.enabled === false || !stripeSettings.account_id || !stripeSettings.charges_enabled) {
    return NextResponse.json({
      error: 'Este vendedor aún no ha activado los pagos. Contacta al vendedor directamente.',
      code: 'SELLER_NOT_CONNECTED',
    }, { status: 422 })
  }

  // An accepted offer sets the price ONLY for the buyer who made it, and only one checkout at a
  // time may hold it (lib/offer-reservation.ts). Anything else the caller names is ignored.
  const gate = await gateOfferPurchase({
    offerId: body.offerId,
    listingId: listing.id,
    clerkUserId: userId ?? null,
    now: new Date(),
    lookup: dbOfferLookup(db),
    claim: dbOfferClaim(db),
  })
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error, code: gate.code }, { status: gate.status })
  }
  const priceCents = gate.priceCents ?? listing.price_cents
  const reservedAt = gate.reservedAt
  const releaseReservation = () => {
    if (gate.offerId && reservedAt) void releaseOfferReservation(dbOfferRelease(db), gate.offerId, reservedAt)
  }

  let origin: string
  try {
    origin = resolveOrigin({ siteUrl: process.env.NEXT_PUBLIC_SITE_URL, host: req.headers.get('host') })
  } catch (e) {
    releaseReservation()
    return NextResponse.json({ error: e instanceof Error ? e.message : 'No se pudo iniciar el pago.' }, { status: 500 })
  }
  const thumb = (listing.images as Array<{ url: string }> | null)?.[0]?.url

  // Physical products need a shipping address collected at checkout
  const isPhysical = listing.listing_type === 'product'

  // ── Create Stripe Checkout Session ────────────────────────────────────────
  // ── Market guard: this legacy rail is MX-only ─────────────────────────────
  //
  // Everything below hard-codes a DESTINATION charge (`transfer_data` +
  // `application_fee_amount`) in platform context, and collects a Mexican shipping
  // address. That is correct for MX and wrong for US, where the seller is merchant of
  // record and the charge must be DIRECT on their connected account.
  //
  // A US seller sold through an agent would otherwise get a destination charge
  // against an Accounts v2 merchant account, bypassing every guard in the Medusa
  // `start-checkout` rail — wrong money movement, silently.
  //
  // US checkout belongs on that Medusa rail, not here, so this refuses rather than
  // grows a second charge-strategy implementation. Refusing is also what D13 already
  // promises agents: commerce readiness suppresses US buy_now until its rail exists.
  const listingCurrency = (listing.currency ?? 'MXN').toUpperCase()
  if (listingCurrency !== 'MXN') {
    releaseReservation()
    return NextResponse.json({
      error: 'Checkout for this market is not available on this endpoint.',
      code: 'CHECKOUT_MARKET_UNSUPPORTED',
      detail: 'Non-MXN listings check out through the Medusa start-checkout rail.',
    }, { status: 422 })
  }

  // Zero commission: full amount transferred to seller, platform_fee = 0
  let session: Awaited<ReturnType<typeof stripe.checkout.sessions.create>>
  try {
  session = await stripe.checkout.sessions.create({
    mode: 'payment',
    // A reserved offer's session is short, so an abandoned checkout frees the offer on its own.
    ...(reservedAt ? { expires_at: Math.floor((Date.now() + OFFER_SESSION_TTL_MS) / 1000) } : {}),
    line_items: [{
      quantity: 1,
      price_data: {
        currency: (listing.currency ?? 'MXN').toLowerCase(),
        unit_amount: priceCents,
        product_data: {
          name: listing.title,
          ...(thumb ? { images: [thumb] } : {}),
        },
      },
    }],
    payment_intent_data: {
      // Zero-commission: full amount goes to seller
      transfer_data: { destination: stripeSettings.account_id },
      application_fee_amount: 0,
    },
    // Collect shipping address for physical products
    ...(isPhysical ? {
      shipping_address_collection: {
        allowed_countries: ['MX'],
      },
    } : {}),
    // Collect buyer email for digital delivery
    customer_email: undefined, // Stripe shows email field automatically
    success_url: `${origin}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${listingUrlFor(origin, listing.id)}?payment=cancelled`,
    metadata: {
      listing_id: listing.id,
      shop_id: listing.shop_id,
      buyer_clerk_id: userId ?? '',
      listing_type: listing.listing_type,
      offer_id: gate.offerId ?? '',
      channel: detectChannel(req),
      is_physical: isPhysical ? 'true' : 'false',
    },
    ...(body.buyerEmail ? { customer_email: body.buyerEmail } : {}),
  })
  } catch (e) {
    // validate -> claim -> apply: the session never existed, so give the offer back.
    releaseReservation()
    throw e
  }

  return NextResponse.json({ url: session.url, checkoutUrl: session.url })
}
