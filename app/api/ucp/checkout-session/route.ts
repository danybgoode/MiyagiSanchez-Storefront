/**
 * POST /api/ucp/checkout-session
 *
 * The unified checkout intelligence endpoint. Given a listing (+ optional offer),
 * returns every payment method the seller has enabled with:
 *   - Pre-generated checkout URLs for instant methods (MP, Stripe)
 *   - Privacy-safe availability/instructions for contact-first methods
 *   - A recommended_method field so an agent can present the best option first
 *   - Escrow details when applicable
 *
 * Payment methods covered:
 *   mercadopago    — cards, OXXO, digital wallet, meses sin intereses
 *   stripe         — international cards (Visa/MC/AMEX)
 *   bank_transfer  — SPEI availability (coordinates are returned only after checkout starts)
 *   cash_on_pickup — derived from shop's local_pickup setting
 *   whatsapp       — contact-first, derived from shop phone + whatsapp_cta
 *
 * Used by:
 *   - MCP tool: get_checkout_options (buyer's AI agent)
 *   - Any third-party integration or embed widget
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/supabase'
import { toUcpListing } from '@/lib/ucp/schema'
import { getListing, getPriceGrid, getShop } from '@/lib/listings'
import { isMarketUnavailable, planMarketCatalogRead } from '@/lib/market-catalog'
import type { MarketCode } from '@/lib/markets'
import { readPersonalization, validatePersonalization, getCustomFields, type PersonalizationPayload } from '@/lib/personalization'
import { isEmbedRequest } from '@/lib/embed-auth'
import { isShopClaimed } from '@/lib/claim'
import { publicShopPaymentAvailability } from '@/lib/public-shop-commerce'
import { ensureUrlProtocol } from '@/lib/url'
import { isEnabled } from '@/lib/flags'
import { clampTicketQuantity, ticketTotalLabel } from '@/lib/ticket-quantity'
import { readEventDetails } from '@/lib/event-listing'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { resolveUcpRentalQuote, rentalPricingHint, type UcpRentalQuote } from '@/lib/ucp/rental-quote'
import { normalizeShippingDestination, projectUcpFulfillment, type UcpFulfillment } from '@/lib/ucp/fulfillment'
import { fetchBackendCheckoutOptions, fetchBackendShippingRates } from '@/lib/ucp/fulfillment-server'
import type { Listing, Shop } from '@/lib/types'
import { isSeatedEvent } from '@/lib/event-seats'
import { randomUUID } from 'crypto'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS })
}

// ── Types ─────────────────────────────────────────────────────────────────────

type PaymentMethodKey = 'mercadopago' | 'stripe' | 'bank_transfer' | 'cash_on_pickup' | 'whatsapp' | 'schedule'

interface PaymentOption {
  method:        PaymentMethodKey
  label:         string
  description:   string
  available:     boolean
  instant:       boolean        // true = payment completes now; false = seller confirms later
  escrow_compatible: boolean    // can this method be combined with Compra Protegida?
  // Instant methods
  checkout_url?: string
  // Contact-first methods
  instructions?: string
  contact_url?:  string         // wa.me link or tel: link
  // Why unavailable (helps AI agent give useful feedback)
  reason_unavailable?: string
  // Scheduling (Cal.com)
  booking_url?: string
}

interface UcpCheckoutSession {
  session_id:          string
  created_at:          string
  expires_at:          string   // sessions are informational — 30 min expiry
  listing_id:          string
  market_code:         MarketCode
  offer_id:            string | null
  price: {
    amount_cents:      number
    currency:          string
    formatted:         string
    is_offer_price:    boolean
  } | null
  // Event admissions: how many units the agent requested (clamped to the
  // kill-switch + remaining seats) and the resulting line total. `quantity` is 1
  // for everything else. NOTE: agent-initiated ticket *issuance* is not yet wired
  // (the agent checkout endpoints don't open a Medusa cart) — surface parity only.
  quantity:            number
  line_total: {
    amount_cents:      number
    formatted:         string
  } | null
  // Rental line-item pricing (epic 02) — S3.1. Present (non-null) only when
  // `check_in`/`check_out` were sent for a rental listing AND resolved to a
  // valid, flag-enabled quote, computed by the SAME pure seam `/checkout`'s
  // rental mode uses — never a client-sent amount. When present, `price`/
  // `line_total` above already reflect this quote's `total_cents`.
  rental_quote:        UcpRentalQuote | null
  // Rental listings only: the per-period rate/deposit label + a nudge to send
  // dates (no dates sent), or the agent-legible reason a dated quote couldn't
  // be produced (dates sent but rejected). `null` once a quote succeeds, and
  // always `null` for a non-rental listing.
  rental_pricing_hint: string | null
  payment_options:     PaymentOption[]
  recommended_method:  PaymentMethodKey | null
  available_count:     number
  escrow: {
    available:         boolean
    required:          boolean
    mode:              'off' | 'optional' | 'required'
    description:       string
  }
  listing:             ReturnType<typeof toUcpListing>
  // Buyer personalization the agent submitted (echoed back) + whether all the
  // listing's required fields are satisfied — so the agent can self-correct
  // before placing the order.
  personalization: {
    submitted: PersonalizationPayload | null
    required_complete: boolean
    missing_field_id: string | null
  }
  // Arranged-only delivery epic, S2.1 — present ONLY when the listing is
  // coordinated-delivery (arranged product, or service/rental — see
  // isCoordinatedListing in the backend), so an agent knows to present
  // "coordina la entrega" instead of implying shipping. Omitted entirely
  // (not `false`) for ordinary shippable listings — keeps this additive and
  // matches the boundary ucp-checkout-session-shipping-boundary.spec.ts pins.
  delivery?: {
    arranged: boolean
    note: string
  }
  /** Official UCP fulfillment shape for ordinary MX physical listings. */
  fulfillment?: UcpFulfillment
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatMxn(cents: number, currency: string) {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: currency || 'MXN' }).format(cents / 100)
}

function whatsappLink(phone: string, listingTitle: string): string {
  const digits = phone.replace(/\D/g, '')
  const full   = digits.startsWith('52') ? digits : `52${digits}`
  const text   = encodeURIComponent(`Hola, me interesa tu artículo "${listingTitle}". ¿Sigue disponible?`)
  return `https://wa.me/${full}?text=${text}`
}

function listingLookupColumn(listingId: string) {
  return listingId.startsWith('prod_') ? 'medusa_product_id' : 'id'
}

// ── Main handler ───────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Widget traffic is rate-limited; agents/marketplace are not. No-op w/o Redis.
  if (isEmbedRequest(req)) {
    const rl = await checkRateLimit('embed', getClientIp(req))
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Demasiadas solicitudes.' },
        { status: 429, headers: { ...CORS, 'Retry-After': String(rl.retryAfter) } },
      )
    }
  }

  const host    = req.headers.get('host') ?? 'miyagisanchez.com'
  const proto   = host.includes('localhost') ? 'http' : 'https'
  const baseUrl = `${proto}://${host}`

  let body: {
    listing_id?: string
    market?: unknown
    offer_id?: string
    buyer_email?: string
    buyer_name?: string
    personalization?: unknown
    quantity?: number
    check_in?: string
    check_out?: string
    shipping_destination?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: CORS })
  }

  const { listing_id, offer_id, check_in, check_out } = body
  if (!listing_id) {
    return NextResponse.json({ error: 'listing_id is required' }, { status: 400, headers: CORS })
  }
  const marketDecision = planMarketCatalogRead(body.market)
  if (isMarketUnavailable(marketDecision)) {
    return NextResponse.json(
      marketDecision,
      { status: marketDecision.market_code ? 404 : 400, headers: CORS },
    )
  }

  // ── Fetch listing + shop ──────────────────────────────────────────────────
  const { data: rawListing, error: listErr } = await db
    .from('marketplace_listings')
    // Supabase is a legacy-id / offer-FK bridge only. Selecting commercial
    // columns here makes it too easy to accidentally re-authorize stale facts.
    .select('id, medusa_product_id, shop:marketplace_shops(slug)')
    .eq(listingLookupColumn(listing_id), listing_id)
    .single()

  if (listErr || !rawListing) {
    return NextResponse.json({ error: 'Listing not found' }, { status: 404, headers: CORS })
  }
  // Supabase remains the bridge for offers, whose foreign key uses the mirror
  // UUID. It is not authoritative for any catalog or commerce fact.
  const mirrorListingId = rawListing.id
  const medusaListingId = typeof rawListing.medusa_product_id === 'string'
    ? rawListing.medusa_product_id
    : listing_id
  const marketListing = await getListing(medusaListingId, marketDecision.market.code)
  if (!marketListing) {
    return NextResponse.json({ error: 'Listing not found' }, { status: 404, headers: CORS })
  }

  const joinedShop = (rawListing as {
    shop?: { slug?: string | null } | Array<{ slug?: string | null }> | null
  }).shop
  const sellerSlug = (Array.isArray(joinedShop) ? joinedShop[0]?.slug : joinedShop?.slug) ?? null
  if (!sellerSlug || marketListing.shop?.slug !== sellerSlug) {
    return NextResponse.json({ error: 'Listing not found' }, { status: 404, headers: CORS })
  }

  // `getShop` is backed by Medusa's sanitized public seller shape. Never use the
  // Supabase mirror's raw metadata here: this endpoint is unauthenticated and its
  // result is relayed verbatim by the public MCP `get_checkout_options` tool.
  const shop = await getShop(sellerSlug) as Shop | null
  if (!shop || shop.slug !== sellerSlug) {
    return NextResponse.json({ error: 'Listing not found' }, { status: 404, headers: CORS })
  }
  // The market-scoped Medusa row owns price, currency, inventory, listing type,
  // metadata/personalization, and the UCP payload. Using the mirror after merely
  // validating Medusa would reopen a stale-price and cross-channel seam.
  const listing = { ...marketListing, shop } as Listing
  const publicListingId = listing.medusa_product_id ?? listing.id
  const shopMeta = (shop?.metadata ?? {}) as Record<string, unknown>
  const settings = (shopMeta.settings ?? {}) as Record<string, unknown>
  const checkout = (settings.checkout ?? {}) as Record<string, unknown>
  const shipping = (settings.shipping ?? {}) as Record<string, unknown>

  // ── Resolve effective price (list vs accepted offer) ──────────────────────
  let priceCents = listing.price_cents
  let isOfferPrice = false

  if (offer_id) {
    const { data: offer } = await db
      .from('marketplace_offers')
      .select('offer_amount_cents, counter_amount_cents, status')
      .eq('id', offer_id)
      .eq('listing_id', mirrorListingId)
      .single()

    if (offer?.status === 'accepted') {
      priceCents   = offer.counter_amount_cents ?? offer.offer_amount_cents
      isOfferPrice = true
    }
  }

  const currency   = listing.currency ?? 'MXN'
  const isDigital  = listing.listing_type === 'digital'
  const isClaimed  = isShopClaimed(shop)

  // ── Rental quoting (S3.1) — dates in, server-recomputed total out. Reuses
  // the SAME pure seam `/checkout`'s rental mode uses (`resolveRentalCheckoutDisplay`
  // via lib/ucp/rental-quote.ts), so an agent's quote can never drift from the
  // web checkout's. Read-only: no charge happens here — a successful quote just
  // overrides `price`/`line_total` (below) to the real bookable total and points
  // the instant checkout_urls at the dated `/checkout` page (the actual S1/S2
  // charge rail). Without dates, today's per-unit-price behavior is untouched —
  // only the new `rental_pricing_hint` is added so the rate reads as per-period,
  // never the full price.
  const isRentalListing = listing.listing_type === 'rental'
  const rentalAttrs = (listing.metadata?.attrs ?? {}) as Record<string, unknown>
  let rentalQuote: UcpRentalQuote | null = null
  let rentalPricingHintText: string | null = null
  // An agent explicitly asked to book dates and got rejected (bad range, flag
  // off, etc.) — distinct from never asking at all. Cross-agent review catch:
  // without this, the instant-method options below would silently fall back to
  // the date-blind legacy endpoints, letting the agent "succeed" at a one-unit
  // charge for the exact request that was just refused. Instant methods are
  // blocked in this state (below); manual/contact-first methods stay available
  // since a human seller confirms before any money moves.
  let rentalDatesRejected = false

  if (isRentalListing) {
    if (check_in && check_out) {
      const rentalEnabled = await isEnabled('checkout.rental_pricing_enabled')
      const result = resolveUcpRentalQuote({
        enabled: rentalEnabled,
        isRentalListing: true,
        checkIn: check_in,
        checkOut: check_out,
        rateCents: priceCents ?? 0,
        attrs: rentalAttrs,
        currency,
      })
      if (result.ok) {
        rentalQuote = result.quote
        priceCents = result.quote.total_cents
      } else {
        rentalPricingHintText = result.reason
        rentalDatesRejected = true
      }
    } else {
      rentalPricingHintText = rentalPricingHint({ rateCents: priceCents ?? 0, attrs: rentalAttrs, currency })
    }
  }

  const hasPrice   = priceCents != null && priceCents > 0

  // Event admissions: an agent can request N tickets (surface parity, AGENTS #3).
  // Scoped to EVENT listings + clamped to the kill-switch + remaining seats. An
  // accepted offer — or a resolved rental quote (always exactly one date range,
  // never multi-unit, mirroring the backend's `RENTAL_CART_UNSUPPORTED` guard) —
  // is 1 unit. Issuance for the agent path is deferred (see the `quantity` note
  // on the type).
  const isEventListing = !!readEventDetails(listing)
  const quantityEnabled = (await isEnabled('events.quantity_enabled')) && isEventListing
  const quantity = isOfferPrice || rentalQuote != null
    ? 1
    : clampTicketQuantity(body.quantity ?? 1, { available: listing.available_quantity, enabled: quantityEnabled })
  const lineTotalCents = hasPrice ? priceCents! * quantity : null

  // ── Shop signals ──────────────────────────────────────────────────────────
  const paymentAvailability = publicShopPaymentAvailability(shopMeta)
  const hasMp = paymentAvailability.mercadopago
  const hasStripe = paymentAvailability.stripe
  const hasBankTransfer = paymentAvailability.bankTransfer

  const localPickup    = !!(shipping.local_pickup)
  const theme = (settings.theme ?? {}) as Record<string, unknown>
  const social = (theme.social ?? {}) as Record<string, unknown>
  const shopPhone = checkout.show_phone ? ((checkout.phone as string | null | undefined) ?? null) : null
  const whatsappPhone = ((social.whatsapp as string | null | undefined) ?? (checkout.phone as string | null | undefined) ?? null)
  const hasWhatsapp    = !!(checkout.whatsapp_cta && whatsappPhone)
  const hasPickupContact = localPickup && (!!shopPhone || !!(checkout.whatsapp_cta && whatsappPhone))

  // Scheduling links (link-drop tier — no API key required)
  const schedulingMeta = (settings.scheduling ?? {}) as { links?: Array<{ label: string; url: string }> }
  const schedulingLinks = schedulingMeta.links ?? []

  // ── Escrow ────────────────────────────────────────────────────────────────
  const escrowMode = (checkout.escrow_mode as 'off' | 'optional' | 'required' | undefined) ?? 'off'

  // ── Authoritative payment availability (Medusa checkout-options) ───────────
  // Single source of truth shared with the web checkout. Falls back to the
  // local signals above when the backend is unreachable. The seller slug
  // resolves the Medusa seller; id is a fallback.
  // Arranged-only delivery epic, S2.1 — thread the listing's own delivery_mode
  // through so checkout-options can correctly gate instant methods for a
  // flag-enabled `arranged` product (service/rental already gate unconditionally
  // server-side, S2.2, independent of this param).
  const deliveryMode: 'carrier' | 'arranged' =
    (listing.metadata as Record<string, unknown> | undefined)?.delivery_mode === 'arranged' ? 'arranged' : 'carrier'
  const checkoutOptionsSource = await fetchBackendCheckoutOptions({
    sellerRef: shop?.slug ?? shop?.id ?? '',
    listingType: listing.listing_type ?? 'product',
    isDigital,
    deliveryMode,
    isEvent: isSeatedEvent({ attrs: listing.attrs, manage_inventory: listing.manage_inventory, allow_backorder: listing.allow_backorder }),
  })
  const beMethods = checkoutOptionsSource.state === 'available' ? new Set<PaymentMethodKey>() : null
  if (checkoutOptionsSource.state === 'available') {
    for (const method of checkoutOptionsSource.paymentMethods) {
      if (method.id === 'mercadopago') beMethods!.add('mercadopago')
      else if (method.id === 'stripe') beMethods!.add('stripe')
      else if (method.id === 'manual') {
        for (const option of method.sub_options ?? []) {
          if (option.type === 'clabe') beMethods!.add('bank_transfer')
          else if (option.type === 'cash') beMethods!.add('cash_on_pickup')
        }
      }
    }
  }
  const coordinatedDelivery = checkoutOptionsSource.state === 'available'
    ? checkoutOptionsSource.onlyCoordinated
    : false
  const coordNote = checkoutOptionsSource.state === 'available'
    ? checkoutOptionsSource.coordNote
    : null
  const beHas = (k: PaymentMethodKey) => (beMethods ? beMethods.has(k) : null)
  // available = backend says so (when reachable) else local; price/claim always required.
  const mpAvailable = (beHas('mercadopago') ?? (hasMp && !isDigital)) && hasPrice && isClaimed && !rentalDatesRejected
  const stripeAvailable = (beHas('stripe') ?? hasStripe) && hasPrice && isClaimed && !rentalDatesRejected
  const bankAvailable = (beHas('bank_transfer') ?? (hasBankTransfer && !isDigital)) && hasPrice
  const cashAvailable = (beHas('cash_on_pickup') ?? (localPickup && !isDigital)) && isClaimed

  // ── Build payment options ─────────────────────────────────────────────────

  // NOTE: quantity is echoed on the session (below) but NOT appended to the
  // instant checkout URLs — those endpoints build a raw 1-unit Stripe/MP session
  // (no Medusa cart), so a quantity param there would be a misleading no-op.
  // Real agent buy-N rides the deferred issuance follow-up.

  // Rental (S3.1): the legacy /api/mp/checkout + /api/stripe/checkout endpoints
  // below have NO rental awareness — they'd charge a bare one-unit rate,
  // silently ignoring the date range and deposit. When a valid dated quote
  // exists, point the instant methods at the dated `/checkout` page instead —
  // the real S1/S2 rail that server-recomputes and charges `rentalQuote.total_cents`.
  const rentalCheckoutUrl = rentalQuote
    ? `${baseUrl}/checkout?${new URLSearchParams({
        listingId: publicListingId,
        checkIn:   rentalQuote.check_in,
        checkOut:  rentalQuote.check_out,
      }).toString()}`
    : null
  // Manual/contact-first methods: mention the reserved dates + deposit so a
  // seller confirming by hand isn't confused about what they're accepting.
  const rentalNote = rentalQuote
    ? ` Reserva ${rentalQuote.check_in} → ${rentalQuote.check_out} (${rentalQuote.nights} noches)${rentalQuote.deposit_cents > 0 ? `, incluye depósito reembolsable de ${formatMxn(rentalQuote.deposit_cents, currency)}` : ''}.`
    : ''

  // 1. MercadoPago
  let mpCheckoutUrl: string | undefined
  if (mpAvailable) {
    // Pre-generate MP preference lazily — we return the POST endpoint + params instead
    // (avoids burning an MP API call on every session request)
    mpCheckoutUrl = rentalCheckoutUrl ?? `${baseUrl}/api/mp/checkout`
  }

  const mpOption: PaymentOption = {
    method: 'mercadopago',
    label:  'Mercado Pago',
    description: 'Tarjeta de crédito/débito, OXXO, Mercado Pago wallet, meses sin intereses',
    available: mpAvailable,
    instant:   true,
    escrow_compatible: escrowMode !== 'off',
    checkout_url: mpCheckoutUrl,
    ...(!hasMp && { reason_unavailable: 'El vendedor no acepta Mercado Pago en este momento.' }),
    ...(!isClaimed && { reason_unavailable: 'Este anuncio aún no tiene vendedor registrado.' }),
    ...(isDigital && { reason_unavailable: 'Los productos digitales se pagan con tarjeta vía Stripe.' }),
    ...(!hasPrice && { reason_unavailable: 'Este anuncio no tiene precio definido.' }),
    ...(rentalDatesRejected && { reason_unavailable: 'Las fechas enviadas no son reservables (ver rental_pricing_hint) — este método no puede cobrar una renta sin una cotización válida.' }),
  }

  // 2. Stripe
  const stripeOption: PaymentOption = {
    method: 'stripe',
    label:  'Tarjeta internacional',
    description: 'Visa, Mastercard, American Express — pago directo al vendedor',
    available: stripeAvailable,
    instant:   true,
    escrow_compatible: escrowMode !== 'off',
    checkout_url: stripeAvailable ? (rentalCheckoutUrl ?? `${baseUrl}/api/stripe/checkout`) : undefined,
    ...(!hasStripe && { reason_unavailable: 'El vendedor no ha conectado Stripe.' }),
    ...(rentalDatesRejected && { reason_unavailable: 'Las fechas enviadas no son reservables (ver rental_pricing_hint) — este método no puede cobrar una renta sin una cotización válida.' }),
  }

  // 3. Bank transfer (SPEI)
  const bankOption: PaymentOption = {
    method: 'bank_transfer',
    label:  'Transferencia bancaria (SPEI)',
    description: 'Transfiere desde cualquier banco mexicano. El vendedor confirma antes de enviar.',
    available: bankAvailable,
    instant:   false,
    escrow_compatible: false,  // manual confirmation — can't hold in escrow
    ...(bankAvailable && {
      instructions: `Inicia el pago para recibir los datos de transferencia del vendedor y enviar tu comprobante.${rentalNote}`,
    }),
    ...(!bankAvailable && { reason_unavailable: 'El vendedor no ha configurado transferencia bancaria.' }),
  }

  // 4. Cash on pickup
  const cashOption: PaymentOption = {
    method: 'cash_on_pickup',
    label:  'Efectivo al recoger',
    description: 'Paga en efectivo cuando vayas a recoger el artículo. Coordina con el vendedor.',
    available: cashAvailable,
    instant:   false,
    escrow_compatible: false,
    ...(hasPickupContact && {
      instructions: `Contacta al vendedor para coordinar lugar y hora de entrega.${rentalNote}`,
      contact_url:  checkout.whatsapp_cta && whatsappPhone ? whatsappLink(whatsappPhone, listing.title) : `tel:${shopPhone}`,
    }),
    ...(localPickup && !shopPhone && {
      instructions: `Escríbele al vendedor para coordinar la entrega.${rentalNote}`,
    }),
    ...(!localPickup && { reason_unavailable: 'El vendedor no ofrece entrega en mano.' }),
    ...(isDigital && { reason_unavailable: 'Producto digital — no requiere entrega en persona.' }),
  }

  // 5. WhatsApp / direct contact
  const waOption: PaymentOption = {
    method: 'whatsapp',
    label:  'Acordar por WhatsApp',
    description: 'Contacta al vendedor directamente para acordar forma de pago y entrega.',
    available: hasWhatsapp && !isDigital && isClaimed,
    instant:   false,
    escrow_compatible: false,
    ...(hasWhatsapp && whatsappPhone && {
      instructions: 'Escríbele al vendedor por WhatsApp para acordar el pago.',
      contact_url:  whatsappLink(whatsappPhone, listing.title),
    }),
    ...(!hasWhatsapp && { reason_unavailable: 'El vendedor no tiene WhatsApp configurado.' }),
  }

  // 6. Cal.com scheduling (API-connected) + link-drop fallback
  const calcomSettings = (settings.calcom ?? {}) as { connected?: boolean; booking_url?: string; event_type_title?: string }
  const hasCalcom = !!(calcomSettings.connected && calcomSettings.booking_url)
  const hasSchedulingLinks = schedulingLinks.length > 0
  const hasSchedule = hasCalcom || hasSchedulingLinks
  // Prefer API-connected booking URL; fall back to first manual link.
  // Normalize a scheme-less seller-typed link so agents get a fully-qualified URL.
  const scheduleBookingUrl = ensureUrlProtocol(calcomSettings.booking_url || schedulingLinks[0]?.url) ?? undefined
  const scheduleLabel = listing.category === 'autos' ? '🚗 Agendar prueba de manejo'
    : listing.category === 'inmuebles' ? '🏠 Agendar visita'
    : listing.listing_type === 'service' ? '🕐 Agendar cita'
    : '📅 Agendar'
  const scheduleDescription = hasCalcom
    ? (calcomSettings.event_type_title ?? 'Reserva una cita con el vendedor')
    : hasSchedulingLinks
    ? (schedulingLinks[0]?.label ?? 'Reserva una cita con el vendedor')
    : 'Reserva una cita con el vendedor'
  const scheduleOption: PaymentOption = {
    method:            'schedule',
    label:             scheduleLabel,
    description:       scheduleDescription,
    available:         hasSchedule,
    instant:           false,
    escrow_compatible: false,
    ...(hasSchedule && {
      booking_url: scheduleBookingUrl,
      instructions: hasCalcom
        ? 'Elige tu horario. Cal.com enviará una confirmación por correo a ambas partes.'
        : 'Haz clic en el enlace para ver los horarios disponibles y reservar.',
    }),
    ...(!hasSchedule && { reason_unavailable: 'El vendedor no tiene agendamiento habilitado.' }),
  }

  const allOptions = [mpOption, stripeOption, bankOption, cashOption, waOption, scheduleOption]
  const available  = allOptions.filter(o => o.available)

  // ── Recommend best method ─────────────────────────────────────────────────
  // Priority: instant escrow-compatible > instant > contact-first
  const recommended: PaymentMethodKey | null =
    available.find(o => o.instant && o.escrow_compatible)?.method ??
    available.find(o => o.instant)?.method ??
    available.find(o => o.available)?.method ??
    null

  // ── Personalization (agent-submitted) ──────────────────────────────────────
  // Validate the submitted payload against the listing's required custom fields
  // so the agent knows whether it's safe to place the order.
  const customFields = getCustomFields((listing.metadata ?? {}) as Record<string, unknown>)
  const submittedPersonalization = readPersonalization(body.personalization)
  const submittedValues = Object.fromEntries((submittedPersonalization?.fields ?? []).map(f => [f.id, f.value]))
  const personalizationCheck = validatePersonalization(customFields, submittedValues)

  // ── Compose session ────────────────────────────────────────────────────────
  const now       = new Date()
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000)
  const shippingDestination = normalizeShippingDestination(body.shipping_destination)
  let fulfillment: UcpFulfillment | null = null
  if (!coordinatedDelivery && !isDigital && listing.listing_type === 'product') {
    if (checkoutOptionsSource.state === 'available') {
      const hasShipping = checkoutOptionsSource.deliveryMethods.some(method => method.id === 'shipping')
      const rateSource = hasShipping && shippingDestination.complete
        ? await fetchBackendShippingRates({ listingId: publicListingId, address: shippingDestination.address })
        : { state: 'not_requested' as const }
      fulfillment = projectUcpFulfillment({
        listingId: publicListingId,
        deliveryMethods: checkoutOptionsSource.deliveryMethods,
        destination: shippingDestination,
        rateSource,
      })
    } else {
      // A failed catalog read says nothing about seller availability. Surface
      // that third state instead of turning an outage into "no delivery".
      fulfillment = { methods: [], available_methods: [], shipping_quote_state: 'unavailable' }
    }
  }

  const session: UcpCheckoutSession = {
    session_id:         randomUUID(),
    created_at:         now.toISOString(),
    expires_at:         expiresAt.toISOString(),
    listing_id:         publicListingId,
    market_code:        marketDecision.market.code,
    offer_id:           offer_id ?? null,
    price: hasPrice ? {
      amount_cents:  priceCents!,
      currency,
      formatted:     formatMxn(priceCents!, currency),
      is_offer_price: isOfferPrice,
    } : null,
    quantity,
    line_total: lineTotalCents != null ? {
      amount_cents: lineTotalCents,
      formatted:    ticketTotalLabel(priceCents!, quantity, currency),
    } : null,
    rental_quote:        rentalQuote,
    rental_pricing_hint: rentalPricingHintText,
    payment_options:    allOptions,
    recommended_method: recommended,
    available_count:    available.length,
    escrow: {
      available:    escrowMode === 'optional' || escrowMode === 'required',
      required:     escrowMode === 'required',
      mode:         escrowMode,
      description:  escrowMode === 'required'
        ? 'Compra Protegida obligatoria — el pago queda retenido hasta que confirmes la recepción.'
        : escrowMode === 'optional'
        ? 'Compra Protegida disponible — puedes activarla para mayor seguridad.'
        : 'Sin Compra Protegida en esta tienda.',
    },
    listing: toUcpListing(
      listing,
      baseUrl,
      await getPriceGrid(publicListingId, marketDecision.market.code),
      await isEnabled('catalog.inventory_channels_enabled'),
      marketDecision.market.code,
    ),
    personalization: {
      submitted: submittedPersonalization,
      required_complete: customFields.length === 0 ? true : personalizationCheck.ok,
      missing_field_id: personalizationCheck.missingFieldId ?? null,
    },
    ...(coordinatedDelivery ? {
      delivery: {
        arranged: true,
        note: coordNote ?? 'Coordina la entrega directamente con el vendedor — no se ofrece envío.',
      },
    } : {}),
    ...(fulfillment ? { fulfillment } : {}),
  }

  return NextResponse.json(session, { headers: CORS })
}
