import { getLanguagePreference } from '@/lib/site-language-server'
import { BuyerCopyText, BuyerPresentationProvider } from '@/app/components/BuyerPresentationContext'
/* eslint-disable @next/next/no-img-element -- checkout previews preserve arbitrary seller-hosted image URLs */
import { redirect, notFound } from 'next/navigation'
import { headers } from 'next/headers'
import Link from 'next/link'
import { currentUser } from '@clerk/nextjs/server'
import { getListing, getOwnedShopListing, getOwnedShopPriceGrid, getPriceGrid } from '@/lib/listings'
import { resolveOwnedPriceGridForPdp } from '@/lib/owned-market'
import { resolveCheckoutListing, shopScopedListingPath } from '@/lib/checkout-listing'
import { unitPriceCentsFor } from '@/lib/price-grid'
import { isShopClaimed } from '@/lib/claim'
import { db } from '@/lib/supabase'
import { isEnabled } from '@/lib/flags'
import { clampTicketQuantity } from '@/lib/ticket-quantity'
import { readEventDetails } from '@/lib/event-listing'
import { resolveRentalCheckoutDisplay } from '@/lib/rental-checkout-display'
import { rentalUnitsLabel, type RentalPrice } from '@/lib/rental-pricing'
import { formatPresentationCurrency, resolveMarketPresentation } from '@/lib/market-presentation'
import { browseUrlFor, listingUrlFor } from '@/lib/market-url'
import { SITE_ORIGIN } from '@/lib/market-seo'
import CheckoutExperience from './CheckoutExperience'
import { admittedOwnerShopSlug, type CheckoutProvider } from '@/lib/cart'
import { getDictionary } from '@/lib/dictionary'
import { DEFAULT_MARKET, isMarketCode } from '@/lib/markets'

type SearchParams = {
  listingId?: string
  offerId?: string
  provider?: CheckoutProvider
  /** Event admissions: how many tickets to buy (clamped to remaining seats). */
  qty?: string
  /** Specific variant for a multi-variant (print-configurator) listing. */
  variantId?: string
  /** Tenant custom domain the buyer hopped from (own-channel checkout). */
  origin?: string
  /** Rental: the buyer's chosen date range (from the PDP date picker). */
  checkIn?: string
  checkOut?: string
  market?: string
}

async function resolvePublicListingId(listingId: string) {
  if (listingId.startsWith('prod_')) return listingId

  const { data } = await db
    .from('marketplace_listings')
    .select('medusa_product_id')
    .eq('id', listingId)
    .maybeSingle()

  return data?.medusa_product_id ?? listingId
}

async function getAcceptedOfferPrice(offerId: string | undefined, listingId: string, buyerUserId: string) {
  if (!offerId) return null

  const { data: offer } = await db
    .from('marketplace_offers')
    .select(`
      id, status, offer_amount_cents, counter_amount_cents, checkout_expires_at,
      marketplace_listings!inner(id, medusa_product_id)
    `)
    .eq('id', offerId)
    .eq('buyer_clerk_user_id', buyerUserId)
    .maybeSingle()

  if (!offer || offer.status !== 'accepted') return null
  const mirror = offer.marketplace_listings as unknown as { id?: string | null; medusa_product_id?: string | null } | { id?: string | null; medusa_product_id?: string | null }[]
  const mirrorListing = Array.isArray(mirror) ? mirror[0] : mirror
  const medusaProductId = mirrorListing?.medusa_product_id
  const mirrorId = mirrorListing?.id
  if (medusaProductId !== listingId && mirrorId !== listingId) return null
  if (offer.checkout_expires_at && new Date(offer.checkout_expires_at).getTime() < Date.now()) return null

  return offer.counter_amount_cents ?? offer.offer_amount_cents
}

export default async function CheckoutPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams
  const market = isMarketCode(params.market) ? params.market : DEFAULT_MARKET
  // Next.js gives `string[]` for a repeated query key (?variantId=A&variantId=B)
  // regardless of the declared `SearchParams` type — coerce defensively into a
  // local so a malformed/duplicated URL can never reach unitPriceCentsFor() or
  // startCheckout() as anything but a plain string (cross-agent review catch,
  // 2026-07-05). Harmless in practice today (only ConfiguratorBuyBox sets it,
  // once), but costs nothing to guard. A local const rather than mutating
  // `params` itself, since the searchParams object isn't guaranteed mutable.
  let variantId = Array.isArray(params.variantId) ? (params.variantId as string[])[0] : params.variantId
  // Same array-pollution guard for offerId — getAcceptedOfferPrice()'s
  // Supabase .eq() expects a scalar, not an array (cross-agent review catch,
  // 2026-07-05).
  const offerId = Array.isArray(params.offerId) ? (params.offerId as unknown as string[])[0] : params.offerId
  // Same array-pollution guard for the rental date params — a crafted
  // ?checkIn=A&checkIn=B must never reach resolveRentalCheckoutDisplay() as
  // anything but a plain string.
  const checkIn = Array.isArray(params.checkIn) ? (params.checkIn as unknown as string[])[0] : params.checkIn
  const checkOut = Array.isArray(params.checkOut) ? (params.checkOut as unknown as string[])[0] : params.checkOut
  // Checkout itself is native on every channel, but catalog URLs differ:
  // platform PDPs live under /mx/l while a tenant must stay on /l (middleware
  // deliberately denies /mx/l there). Only middleware may set these headers;
  // the platform branch strips client-supplied copies before this page runs.
  // `params.origin` remains a checkout-return hint and is never trusted for
  // channel boundary decisions.
  const requestHeaders = await headers()
  const channel = requestHeaders.get('x-miyagi-channel')
  const channelDomain = requestHeaders.get('x-miyagi-domain')
  const onTenantChannel = channel === 'custom' || channel === 'subdomain'
  const marketOrigin = onTenantChannel && channelDomain
    ? `https://${channelDomain}`
    : SITE_ORIGIN
  const browsePath = new URL(browseUrlFor(marketOrigin)).pathname
  const rawListingId = params.listingId
  if (!rawListingId) redirect(browsePath)
  const listingId = await resolvePublicListingId(rawListingId)

  const user = await currentUser()
  if (!user) redirect(`/sign-in?redirect_url=${encodeURIComponent(`/checkout?listingId=${listingId}&market=${market}${offerId ? `&offerId=${offerId}` : ''}${params.provider ? `&provider=${params.provider}` : ''}${params.qty ? `&qty=${params.qty}` : ''}${variantId ? `&variantId=${variantId}` : ''}${params.origin ? `&origin=${encodeURIComponent(params.origin)}` : ''}${checkIn ? `&checkIn=${checkIn}` : ''}${checkOut ? `&checkOut=${checkOut}` : ''}`)}`)

  // The marketplace listing, or — for a «Solo mi tienda» product the marketplace
  // does not carry — the shop's own. Display + back link only; the cart admission
  // seam is still the money gate. See lib/checkout-listing.ts.
  const resolved = await resolveCheckoutListing(listingId, market, {
    marketplace: (id, m) => getListing(id, m),
    ownerShopSlug: admittedOwnerShopSlug,
    owned: (slug, id) => getOwnedShopListing(slug, id),
  })
  if (resolved.kind === 'absent') notFound()
  const listing = resolved.listing
  const ownedShopSlug = resolved.kind === 'owned' ? resolved.shopSlug : null
  const presentation = resolveMarketPresentation(listing.shop?.market_code ?? 'mx', await getLanguagePreference())
  const buyerCopy = (await getDictionary(presentation.language)).buyerCopy
  const formatCents = (cents: number, currency: string) =>
    formatPresentationCurrency(presentation, cents, currency, { maximumFractionDigits: 0 })
  // An owned-only product has no `/mx/l` page; on the platform its PDP is the
  // shop-scoped one. A tenant host serves it at `/l/<id>` as before.
  const listingPath = ownedShopSlug && !onTenantChannel
    ? shopScopedListingPath(ownedShopSlug, listing.id)
    : new URL(listingUrlFor(marketOrigin, listing.id)).pathname

  // Last-line money-path guard: /checkout is directly URL-reachable (the deep-link
  // target of checkoutHopHref/signInHopHref), so an unclaimed (gem) shop must be
  // redirected away even though the PDP no longer links here. Shared predicate —
  // see lib/claim.ts (same one the PDP + offers route + checkout-session use).
  const isClaimed = isShopClaimed(listing.shop)
  if (!isClaimed || listing.shop?.clerk_user_id === user.id) redirect(listingPath)

  const offerPriceCents = await getAcceptedOfferPrice(offerId, listing.id, user.id)
  if (offerId && !offerPriceCents) redirect(`${listingPath}?offer=unavailable`)
  let amountCents = offerPriceCents ?? listing.price_cents
  if (!amountCents || amountCents <= 0) redirect(listingPath)
  if (listing.status !== 'active') redirect(`${listingPath}?checkout=unavailable`)

  const isOfferCheckout = !!offerPriceCents
  // An offer is entirely orthogonal to the configurator feature — negotiation
  // predates it and was never variant-aware. A crafted URL appending
  // &variantId=<expensive-variant> to a legitimate offer-checkout link must
  // never be allowed to reach startCheckout(): the negotiated `amountCents`
  // above already only ever reflects the offer's own price, but the variant
  // actually added to the cart must ALSO stay whatever the offer's listing
  // resolves to by default, never an attacker-chosen one (cross-agent review
  // catch, 2026-07-05 — a real exploit vector, not just a display concern).
  if (isOfferCheckout) variantId = undefined

  // Block checkout for sold-out (Medusa-managed) items — backend reserves stock on
  // order placement, so this saves the buyer a failed add-to-cart at the rail.
  // Skipped for a configurator checkout (explicit variantId): `listing.in_stock`
  // is a single aggregate across ALL variants, so a mixed managed/unmanaged
  // configurator listing (one variant genuinely out of stock, another
  // unlimited) could wrongly block a buyer whose chosen variant is fine
  // (cross-agent review catch, 2026-07-05) — Medusa's own per-variant
  // reservation at order placement is the real authority for that variant.
  if (!variantId && listing.in_stock === false) redirect(`${listingPath}?checkout=unavailable`)

  // Payment + delivery availability is resolved by Medusa via the checkout-options
  // endpoint (CheckoutExperience fetches it). The page only carries listing context.
  const image = listing.images?.[0]?.url ?? null
  const isDigital = listing.listing_type === 'digital'
  // Arranged-only delivery (epic, S1.3) — the backend ignores this entirely
  // while shipping.arranged_only_enabled is off (byte-identical to today).
  const deliveryMode = ((listing.metadata as Record<string, unknown> | undefined)?.delivery_mode as 'carrier' | 'arranged' | undefined) ?? 'carrier'

  // Event admissions: buy N in one checkout (kill-switch + aforo clamped). Scoped
  // to EVENT listings only — buy-N is an admissions feature, so a crafted ?qty=N
  // on a non-event product still checks out a single unit. An accepted-offer
  // checkout is always a single unit too. Defaults to 1 everywhere else.
  const isEventListing = !!readEventDetails(listing)
  const quantityEnabled = (await isEnabled('events.quantity_enabled')) && isEventListing
  // Configurator (multi-variant, tiered-price) checkout carries its OWN qty,
  // independent of the event-admissions cap system above: `ticketQuantityCap`
  // returns 1 whenever `enabled` is false (lib/ticket-quantity.ts:39), and
  // `quantityEnabled` is only ever true for an EVENT listing — so routing a
  // configurator's `?qty=N` through `clampTicketQuantity` silently floored
  // EVERY configurator purchase to quantity 1, defeating the entire bulk-tier
  // feature (cross-agent review catch, 2026-07-05, caught while verifying an
  // unrelated finding). A configurator checkout is identified by the presence
  // of `variantId` (only ConfiguratorBuyBox sets it).
  const isConfiguratorCheckout = !!variantId && !isOfferCheckout
  // Rental: the buyer picked dates on the PDP date picker (Story 2.2's CTA is the
  // only path that sets both params). A rental books ONE unit for a date range —
  // never multi-quantity — matching the backend's `RENTAL_CART_UNSUPPORTED` guard.
  const isRentalCheckout = !isOfferCheckout && !isConfiguratorCheckout && listing.listing_type === 'rental' && !!checkIn && !!checkOut
  const quantity = isOfferCheckout || isRentalCheckout
    ? 1
    : isConfiguratorCheckout
      ? Math.max(1, Math.floor(Number(params.qty ?? 1)) || 1)
      : clampTicketQuantity(params.qty ?? 1, { available: listing.available_quantity, enabled: quantityEnabled })

  // Multi-variant (print-configurator) listing: `listing.price_cents` is the
  // MIN across all variants (a "desde $X" display price, see toListingShape),
  // not necessarily the price of the buyer's chosen combination. Resolve the
  // exact tier-correct unit price for variantId + quantity from the same
  // price-grid the PDP buy box showed, so the checkout total can never drift
  // from what the buyer saw (house rule: pay-button total = summary).
  // Unresolvable (stale variantId, removed tier, grid fetch failure) redirects
  // back to the PDP rather than silently substituting the cheaper "desde $X"
  // price — a silent fallback here would show/charge less than the buyer's
  // actual chosen combination (cross-agent review catch, 2026-07-05).
  if (isConfiguratorCheckout) {
    // Same grid the PDP showed: the shop's own grid for an owned-only product.
    const priceGrid = ownedShopSlug
      ? resolveOwnedPriceGridForPdp(await getOwnedShopPriceGrid(ownedShopSlug, listing.id), listing.shop?.market_code)
      : await getPriceGrid(listing.id)
    const resolved = priceGrid ? unitPriceCentsFor(priceGrid, variantId!, quantity) : null
    if (resolved == null) redirect(`${listingPath}?checkout=unavailable`)
    amountCents = resolved
  }

  // Rental: the total is ALWAYS server-recomputed from dates + the listing's own
  // rate/attrs — never a client-sent amount (tamper guarantee, matching the
  // backend's `resolveRentalCheckout`). Flag off, bad dates, a non-rental listing,
  // or a zero rate all redirect back to the PDP rather than falling through to a
  // single-unit charge that would silently ignore the date range and deposit.
  let rentalBreakdown: RentalPrice | null = null
  if (isRentalCheckout) {
    const rentalEnabled = await isEnabled('checkout.rental_pricing_enabled')
    const result = resolveRentalCheckoutDisplay({
      enabled: rentalEnabled,
      isRentalListing: listing.listing_type === 'rental',
      checkIn,
      checkOut,
      rateCents: listing.price_cents ?? 0,
      attrs: listing.attrs,
    })
    if (!result.ok) redirect(`${listingPath}?checkout=unavailable`)
    rentalBreakdown = result.breakdown
    amountCents = result.breakdown.totalCents
  }

  return (
    <BuyerPresentationProvider presentation={presentation} copy={buyerCopy}>
    <main className="max-w-[760px] mx-auto px-4 py-5 md:py-8">
      <div style={{ marginBottom: 18 }}>
        <Link href={listingPath} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--fg-muted)', textDecoration: 'none' }}>
          <i className="iconoir-arrow-left" style={{ fontSize: 16 }} />
          <BuyerCopyText copyKey="checkout.page.d94b0842" /></Link>
      </div>

      <div style={{ display: 'grid', gap: 16 }}>
        <section style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', overflow: 'hidden' }}>
          <div style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
            <h1 style={{ fontSize: 22, fontWeight: 800 }}><BuyerCopyText copyKey="checkout.page.93682cf2" /></h1>
            <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 4 }}><BuyerCopyText copyKey="checkout.page.403c8753" /></p>
          </div>
          <div style={{ padding: 16, display: 'flex', gap: 12 }}>
            <div style={{ width: 88, height: 88, borderRadius: 8, overflow: 'hidden', background: 'var(--bg-sunk)', flexShrink: 0 }}>
              {image ? <img src={image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /> : null}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 'var(--t-base)', fontWeight: 700, lineHeight: 1.3 }}>{listing.title}</p>
              <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 3 }}>{listing.shop?.name}</p>
              {isRentalCheckout && rentalBreakdown ? (
                <div style={{ marginTop: 8 }}>
                  <p style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)' }}><BuyerCopyText copyKey="checkout.page.fd7fe0e5" /></p>
                  <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 2 }}>
                    {checkIn} → {checkOut} · {rentalUnitsLabel(rentalBreakdown.units, rentalBreakdown.period)}
                  </p>
                  <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 4 }}>
                    {formatCents(listing.price_cents ?? 0, listing.currency)} × {rentalUnitsLabel(rentalBreakdown.units, rentalBreakdown.period)} = {formatCents(rentalBreakdown.rentCents, listing.currency)}
                  </p>
                  {rentalBreakdown.depositCents > 0 && (
                    <p style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
                      <BuyerCopyText copyKey="checkout.page.64c10dc6" />{' '}{formatCents(rentalBreakdown.depositCents, listing.currency)}
                    </p>
                  )}
                  <p style={{ fontSize: 22, fontWeight: 800, marginTop: 6 }}>{formatCents(amountCents, listing.currency)}</p>
                </div>
              ) : isOfferCheckout ? (
                <div style={{ marginTop: 8 }}>
                  <p style={{ fontSize: 12, fontWeight: 700, color: 'var(--success)' }}><BuyerCopyText copyKey="checkout.page.2bca536c" /></p>
                  <p style={{ fontSize: 22, fontWeight: 800 }}>{formatCents(amountCents, listing.currency)}</p>
                  {listing.price_cents && <p style={{ fontSize: 12, color: 'var(--fg-muted)' }}><BuyerCopyText copyKey="checkout.page.78f3647e" />{' '}<span style={{ textDecoration: 'line-through' }}>{formatCents(listing.price_cents, listing.currency)}</span></p>}
                </div>
              ) : (
                <p style={{ fontSize: 22, fontWeight: 800, marginTop: 8 }}>
                  {formatCents(amountCents, listing.currency)}
                  {quantity > 1 && <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-muted)' }}> × {quantity}</span>}
                </p>
              )}
            </div>
          </div>
        </section>

        <CheckoutExperience
          listingId={listing.id}
          variantId={variantId}
          sellerId={listing.shop!.id}
          amountCents={amountCents}
          currency={listing.currency}
          quantity={quantity}
          listingType={listing.listing_type}
          isDigital={isDigital}
          deliveryMode={deliveryMode}
          offerId={offerId}
          offerAmountCents={offerPriceCents ?? undefined}
          originDomain={params.origin}
          rental={isRentalCheckout ? { check_in: checkIn!, check_out: checkOut! } : undefined}
          market={market}
        />
      </div>
    </main>
    </BuyerPresentationProvider>
  )
}
