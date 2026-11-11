import { NextRequest, NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { createMpPreference } from '@/lib/mercadopago'
import { detectChannel } from '@/lib/channel'
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
  let body: CheckoutBody
  try {
    body = await req.json() as CheckoutBody
  } catch {
    return NextResponse.json({ error: 'Payload inválido.' }, { status: 400 })
  }

  const { listingId, offerId } = body

  if (!listingId || typeof listingId !== 'string') {
    return NextResponse.json({ error: 'Anuncio no especificado.' }, { status: 400 })
  }

  // Prefer Clerk email; fall back to body-supplied email (anonymous buyers)
  const clerkUser = await currentUser()
  const buyerEmail = clerkUser?.emailAddresses[0]?.emailAddress ?? body.buyerEmail

  // ── Fetch listing + shop ──────────────────────────────────────────────────
  const { data: listing } = await db
    .from('marketplace_listings')
    .select('id, title, price_cents, currency, listing_type, status, marketplace_shops!inner(id, mp_enabled)')
    .eq(listingLookupColumn(listingId), listingId)
    .single()

  if (!listing) {
    return NextResponse.json({ error: 'Anuncio no encontrado.' }, { status: 404 })
  }
  if (listing.status !== 'active') {
    return NextResponse.json({ error: 'Este anuncio ya no está disponible.' }, { status: 409 })
  }

  const shop = listing.marketplace_shops as unknown as { id: string; mp_enabled: boolean | null }
  if (shop.mp_enabled === false) {
    return NextResponse.json({ error: 'Este vendedor no acepta pagos con Mercado Pago.' }, { status: 422 })
  }

  if (listing.listing_type === 'digital') {
    // Digital delivery is handled by the Stripe webhook — keep those on Stripe
    return NextResponse.json({ error: 'Los productos digitales se pagan con tarjeta.' }, { status: 422 })
  }
  if (!listing.price_cents) {
    return NextResponse.json({ error: 'Este anuncio no tiene precio definido.' }, { status: 422 })
  }

  // ── If offer-based purchase, use the accepted offer amount ────────────────
  // An accepted offer sets the price ONLY for the buyer who made it, and only one checkout at a
  // time may hold it (lib/offer-reservation.ts). Anything else the caller names is ignored.
  const { userId } = await auth()
  const gate = await gateOfferPurchase({
    offerId,
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

  const origin = req.headers.get('origin') ?? 'https://miyagisanchez.com'
  const isDev = process.env.NODE_ENV === 'development'

  let preference: Awaited<ReturnType<typeof createMpPreference>>
  try {
  preference = await createMpPreference({
    title: listing.title,
    priceCents,
    currency: listing.currency,
    buyerEmail,
    listingId: listing.id,
    shopId: shop.id,
    listingType: listing.listing_type,
    offerId: gate.offerId ?? undefined,
    origin,
    channel: detectChannel(req),
    ...(gate.reservedAt ? { expiresInMs: OFFER_SESSION_TTL_MS } : {}),
  })
  } catch (e) {
    // validate -> claim -> apply: the preference never existed, so give the offer back.
    if (gate.offerId && gate.reservedAt) void releaseOfferReservation(dbOfferRelease(db), gate.offerId, gate.reservedAt)
    throw e
  }

  return NextResponse.json({
    preferenceId: preference.id,
    // In development use sandbox; in production use the live checkout
    checkoutUrl: isDev ? preference.sandboxInitPoint : preference.initPoint,
  })
}
