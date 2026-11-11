import { BuyerCopyText } from '@/app/components/BuyerPresentationContext'
import { notFound, permanentRedirect } from 'next/navigation'
import {
  getShop,
  readShopListings,
  getShopCollections,
  formatPrice,
} from '@/lib/listings'
import { isShopPreviewPrivateBySlug } from '@/lib/preview-access'
import { hasExcerpt } from '@/lib/excerpt'
import { isLikelyShopSlug } from '@/lib/route-shape'
import { getActiveCustomDomain } from '@/lib/custom-domain'
import { getSlugRedirect } from '@/lib/slug-redirect'
import { SetAgentContext } from '@/app/components/AgentContext'
import ClosetListingCard from './ClosetListingCard'
import AnnouncementBar from './AnnouncementBar'
import ShopHeader from '@/app/(shell)/_shop-chrome/ShopHeader'
import ShopHero from '@/app/(shell)/_shop-chrome/ShopHero'
import ShopRail from '@/app/(shell)/_shop-chrome/ShopRail'
import ShopFooter from '@/app/(shell)/_shop-chrome/ShopFooter'
import WallFeed from '@/app/(shell)/_wall/WallFeed'
import { readableTextOn } from '@/lib/platform-theme'
import { publicShopPaymentAvailability } from '@/lib/public-shop-commerce'
import type { AnnouncementSettings } from '@/lib/shop-settings/types'
import type { Metadata } from 'next'
import type { MarketCode } from '@/lib/markets'
import { marketCatalogCanonical } from '@/lib/market-seo'
import { readPublicSellerMarket } from '@/lib/owned-market'
import { getDictionary } from '@/lib/dictionary'
import { resolveMarketPresentation } from '@/lib/market-presentation'
import { readPublicWall } from '@/lib/wall/public'
import { resolvePublicWallShop } from '@/lib/wall/store'
import { normalizeSections } from '@/lib/shop-presentation/sections'
import { resolveSectionAvailability } from '@/lib/shop-presentation/availability'
import { listingHref, railOccupiesTrack, railPanels, shopListingBase, trustChips } from '@/lib/shop-presentation/chrome'
import { sectionPath } from '@/lib/shop-presentation/sections'
import { resolveTheme } from '@/lib/shop-presentation/theme'
import ShopChat from '@/components/shop-chat/ShopChat'
import { isShopClaimed } from '@/lib/claim'

interface Social { instagram?: string; facebook?: string; whatsapp?: string; tiktok?: string; twitter?: string }

export type ShopRequestContext = {
  channel?: 'marketplace' | 'subdomain' | 'custom' | 'embed'
  domain?: string | null
}

export type ShopSettingsOverlay = (
  slug: string,
  persisted: Record<string, unknown>,
) => Promise<Record<string, unknown>>

export async function generateShopMetadata({
  params,
  market,
  marketBasePath = '',
  requestContext = {},
}: {
  params: Promise<{ slug: string }>
  market?: MarketCode
  marketBasePath?: string
  requestContext?: ShopRequestContext
}): Promise<Metadata> {
  const { slug } = await params
  if (!isLikelyShopSlug(slug)) return { title: 'Tienda no encontrada' }
  const shop = await getShop(slug, market)
  if (!shop) return { title: 'Tienda no encontrada' }
  if (market && readPublicSellerMarket(shop)?.market_code !== market) {
    return { title: 'Tienda no encontrada' }
  }
  // Don't leak a preview-private shop's name/description in metadata (S1.2 guard).
  if (await isShopPreviewPrivateBySlug(shop.slug, shop.clerk_user_id)) return { title: 'Tienda no encontrada' }
  const theme = (shop.metadata as Record<string, unknown> | null)?.settings as Record<string, unknown> | undefined
  const t = (theme?.theme ?? {}) as Record<string, unknown>
  if (marketBasePath) {
    const pathname = `${marketBasePath}/s/${slug}`
    return {
      title: shop.name,
      description: (t.tagline as string | undefined) ?? shop.description ?? undefined,
      ...marketCatalogCanonical(pathname),
      openGraph: {
        url: `https://miyagisanchez.com${pathname}`,
        images: (t.banner_url as string | undefined) ? [{ url: t.banner_url as string }] : undefined,
      },
    }
  }
  // Canonical points at the shop's own domain when live, so search engines
  // consolidate ranking on the brand domain instead of the marketplace mirror.
  const domain = requestContext.domain ?? await getActiveCustomDomain(slug)
  const canonical = domain ? `https://${domain}/` : `https://miyagisanchez.com/mx/s/${slug}`
  return {
    title: shop.name,
    description: (t.tagline as string | undefined) ?? shop.description ?? undefined,
    alternates: { canonical },
    openGraph: {
      url: canonical,
      images: (t.banner_url as string | undefined) ? [{ url: t.banner_url as string }] : undefined,
    },
  }
}

// ── Shop page ─────────────────────────────────────────────────────────────────

export async function ShopPage({
  params,
  market,
  marketBasePath = '',
  requestContext = {},
  settingsOverlay,
}: {
  params: Promise<{ slug: string }>
  /** Carries the studio's owner-only preview draft (Story 5.5). Absent everywhere else. */
  searchParams?: Promise<Record<string, string | string[] | undefined>>
  market?: MarketCode
  marketBasePath?: string
  requestContext?: ShopRequestContext
  settingsOverlay?: ShopSettingsOverlay
}) {
  const { slug } = await params
  // Short-circuit junk URLs BEFORE any Medusa fetch (epic 09 · cost reduction
  // S2.2): a clearly-malformed slug can be neither a live nor a retired shop
  // (retired slugs obey the same format), so 404 it without a Store API call or a
  // redirect lookup. A well-formed-but-deleted slug passes here and 404s / 301s
  // cleanly below. On platform hosts middleware 404s these (with a cache header)
  // before the function is invoked; this guard is defense-in-depth.
  if (!isLikelyShopSlug(slug)) notFound()
  const shop = await getShop(slug, market)
  if (!shop) {
    // The shop may have been renamed — 301 a retired slug to its current one for
    // 90 days so old links/business cards keep working (US-4).
    const current = await getSlugRedirect(slug)
    if (current) permanentRedirect(`${marketBasePath}/s/${current}`)
    notFound()
  }
  if (market && readPublicSellerMarket(shop)?.market_code !== market) notFound()
  const presentationMarket = market ?? readPublicSellerMarket(shop)?.market_code ?? 'mx'
  const buyerCopy = (await getDictionary(resolveMarketPresentation(presentationMarket).language)).buyerCopy

  // Consent-safe preview leak guard (founding-merchant-consent-previews S1.2): a
  // shop with a non-activated preview anchor is private across every public
  // channel — this /s/[slug] path is also the rewrite target for the custom-domain
  // and subdomain channels, so one 404 here covers all three. Products are already
  // draft-private structurally; this additionally hides the empty shop shell +
  // merchant name until the promoter activates the approved snapshot (Sprint 2).
  if (await isShopPreviewPrivateBySlug(shop.slug, shop.clerk_user_id)) notFound()

  // SEO continuity: if this shop has a LIVE custom domain and we're being viewed
  // on the marketplace host (not already on that domain), 308-redirect legacy
  // /s/[slug] traffic to the tenant's own home so links + ranking move with them.
  const onChannel = requestContext.channel === 'custom'
  if (!onChannel && !marketBasePath) {
    const domain = await getActiveCustomDomain(shop.slug)
    if (domain) permanentRedirect(`https://${domain}/`)
  }
  // Collection nav-strip hrefs: rooted (`''`) on ANY channel (subdomain or
  // custom domain — both already serve `/c/...` at the domain root), the
  // full `/s/[slug]/c/...` prefix only on the marketplace host.
  const channelValue = requestContext.channel
  const onChannelHost = channelValue === 'custom' || channelValue === 'subdomain'
  const navBasePath = onChannelHost ? '' : `${marketBasePath}/s/${shop.slug}`
  // Where product cards point — see `ShopBases`. On the Mexico marketplace this is
  // the shop-scoped PDP, which (unlike `/mx/l`) also serves «Solo mi tienda» products.
  const productLinkBase = shopListingBase({
    onOwnedHost: onChannelHost,
    marketBasePath,
    shopSlug: shop.slug,
  })

  // The Wall's shop is the SUPABASE mirror row, not the Medusa seller `shop`
  // above — their ids live in different systems and only the slug is shared.
  // A seller with no mirror row yet simply has no Wall (known-absent).
  const [listingRead, allCollections, wallShop] = await Promise.all([
    // The shop's OWN catalog on every channel — the same read `/tienda` uses. This
    // used to be the marketplace-filtered read under `/mx`, so a «Solo mi tienda»
    // product showed on `/mx/s/<slug>/tienda` while the shop's home said «Esta
    // tienda aún no tiene anuncios» (reported live 2026-11-11, `miel-verduras`).
    // The shop page is the merchant's own shop, not marketplace discovery; the
    // marketplace grid and search keep their own channel filter.
    readShopListings(shop.slug),
    getShopCollections(shop.slug, market),
    resolvePublicWallShop(shop.slug),
  ])
  const wall = wallShop
    ? await readPublicWall({
        shopId: wallShop.id,
        shopSlug: wallShop.slug,
        basePath: navBasePath,
        listingBase: productLinkBase,
        locale: resolveMarketPresentation(presentationMarket).htmlLang,
      })
    : { entries: [], hasMore: false, total: 0 }

  // An unreadable catalog is UNAVAILABLE, not an empty shop. Rendering «no
  // listings» would cache and index a confident falsehood, and a 404 would be
  // cached too — throwing keeps the last good render (ISR serves it stale) and
  // lets the next request retry. A PARTIAL read (a later page failed) still has
  // real products, so it renders them, as every other `getShopListings` surface does.
  if (!listingRead.complete && listingRead.listings.length === 0) {
    throw new Error(`[shop] catalog read unavailable for ${shop.slug}`)
  }
  const listings = listingRead.listings
  const publishedCollectionHandles = new Set(listings.flatMap((listing) => listing.collections ?? []))
  const collections = market
    ? allCollections.filter((collection) => publishedCollectionHandles.has(collection.handle))
    : allCollections

  // Extract theme from metadata.
  //
  // The dynamic route adapter may supply the shipped, owner-authorized preview
  // overlay. Public-read routes omit it and therefore render persisted settings.
  const persistedSettings = ((shop.metadata as Record<string, unknown> | null)?.settings ?? {}) as Record<string, unknown>
  const settings = settingsOverlay
    ? await settingsOverlay(shop.slug, persistedSettings)
    : persistedSettings
  const theme = (settings.theme ?? {}) as {
    banner_url?: string | null
    accent_color?: string | null
    tagline?: string | null
    social?: Social
  }
  const checkout = (settings.checkout ?? {}) as {
    show_phone?: boolean
    phone?: string | null
    whatsapp_cta?: boolean
    show_email?: boolean
    contact_email?: string | null
  }
  const shipping = (settings.shipping ?? {}) as {
    local_pickup?: boolean
    envia_enabled?: boolean
    pickup_spots?: Array<{ name?: string; address?: string }>
  }
  const scheduling = (settings.scheduling ?? {}) as { links?: Array<{ label?: string; url?: string }> }
  const calcom = (settings.calcom ?? {}) as { connected?: boolean; booking_url?: string; event_type_title?: string }
  const returnsPolicy = settings.returns_policy as { window?: string } | null | undefined
  // Own-shop premium presentation (epic 07, Sprint 1) — absent keys render today's storefront.
  const announcement = settings.announcement as AnnouncementSettings | null | undefined
  // Theme engine v2 (Story 4.1). The resolver decides the attribute AND whether
  // the legacy preset attribute still applies — a shop that never chose a mode
  // keeps painting exactly what it painted yesterday (epic D5).
  const shopTheme = resolveTheme(settings)
  // Own-shop premium presentation (epic 07, Sprint 3) — content-page footer
  // links. Unauthored pages are simply omitted (never a dead link).
  // The controlled information architecture (Story 3.1/3.2). Config is what the
  // seller wants; availability is what the data supports. A nav link renders only
  // where the two agree, which is what makes a hidden section and an empty one
  // both produce no link rather than a dead one.
  const sectionConfig = normalizeSections(settings.sections)
  const sectionAvailability = await resolveSectionAvailability({
    shopId: wallShop?.id ?? null,
    settings,
    collectionCount: collections.length,
  })

  // ONE render-time instant, shared by every Wall card's relative date. Reading
  // the clock per card could straddle midnight mid-list and label two posts from
  // the same minute "hoy" and "ayer". Same precedent as app/(mx-site)/mx/page.tsx.
  const renderNow = new Date()

  // The rail's content — real data or absent, never invented (Story 8.4).
  const aboutBody = (settings.about as { body?: string } | null | undefined)?.body?.trim() || null
  const railCollections = collections.slice(0, 3).map((collection) => {
    const members = listings.filter((l) => (l.collections ?? []).includes(collection.handle))
    return {
      handle: collection.handle,
      name: collection.name,
      href: `${navBasePath}/c/${collection.handle}`,
      count: members.length,
      thumbUrl: members[0]?.images?.[0]?.url ?? null,
    }
  }).filter((c) => c.count > 0)
  const shopStatus = {
    dispatch: (settings.orders as { processing_time?: string } | undefined)?.processing_time?.trim() || null,
    nextEvent: null as string | null,
  }

  const paymentAvailability = publicShopPaymentAvailability(shop.metadata)
  const sellerHasStripe = paymentAvailability.stripe
  const sellerHasMp = paymentAvailability.mercadopago
  const hasBankTransfer = paymentAvailability.bankTransfer
  const hasDimo = paymentAvailability.dimo
  const hasPickup = !!shipping.local_pickup
  const hasScheduling = !!(calcom.connected && calcom.booking_url) || !!scheduling.links?.some(link => link.url)
  const returnsLabel = returnsPolicy?.window === '7d' ? buyerCopy['listing.returnWindow7']
    : returnsPolicy?.window === '14d' ? buyerCopy['listing.returnWindow14']
    : returnsPolicy?.window === '30d' ? buyerCopy['listing.returnWindow30']
    : null
  const visibleWhatsapp = checkout.whatsapp_cta ? (theme.social?.whatsapp ?? checkout.phone ?? null) : null
  const visibleWhatsappDigits = visibleWhatsapp?.replace(/\D/g, '') || null
  const visiblePhone = checkout.show_phone ? checkout.phone ?? null : null

  // The contact affordances the old identity header carried. They move into the
  // rail rather than disappearing with it — for an unclaimed shop the WhatsApp
  // link may be the only way to reach the merchant at all.
  const railContacts = [
    visibleWhatsappDigits && { href: `https://wa.me/${visibleWhatsappDigits}`, label: 'WhatsApp' },
    visiblePhone && { href: `tel:${visiblePhone}`, label: visiblePhone },
    checkout.show_email && checkout.contact_email && { href: `mailto:${checkout.contact_email}`, label: checkout.contact_email },
    theme.social?.instagram && { href: `https://instagram.com/${theme.social.instagram}`, label: `@${theme.social.instagram}` },
    theme.social?.tiktok && { href: `https://tiktok.com/@${theme.social.tiktok}`, label: `@${theme.social.tiktok}` },
    theme.social?.facebook && { href: theme.social.facebook, label: 'Facebook' },
  ].filter(Boolean) as Array<{ href: string; label: string }>

  /**
   * The commerce facts that used to sit in a loose chip row above the grid.
   *
   * They move into the rail's Perfil panel — that panel answers "can I trust
   * this shop", which is what these are. It is also what gives every shop a
   * rail: all 30 live shops have a payment method while only 2 have an About
   * body, so without these the two-column shell would collapse on nearly every
   * shop.
   *
   * Copy keys are the SAME ones the chip row used, so nothing new to translate
   * and no wording drifts.
   */
  const railSignals = [
    sellerHasMp && { key: 'mp', label: buyerCopy['s.slug.page.85cbb14f'] },
    sellerHasStripe && { key: 'stripe', label: buyerCopy['s.slug.page.15146f83'] },
    hasBankTransfer && { key: 'spei', label: buyerCopy['s.slug.page.9bc19390'] },
    hasDimo && { key: 'dimo', label: buyerCopy['s.slug.page.4df902a1'] },
    hasPickup && {
      key: 'pickup',
      label: buyerCopy['s.slug.page.ad1b2858'] + (shipping.pickup_spots?.[0]?.name ? `: ${shipping.pickup_spots[0].name}` : ''),
    },
    hasScheduling && { key: 'agenda', label: calcom.event_type_title ?? scheduling.links?.[0]?.label ?? buyerCopy['s.slug.page.a762f91d'] },
    returnsLabel && { key: 'returns', label: `${buyerCopy['s.slug.page.b4c1603f']} ${returnsLabel}` },
  ].filter(Boolean) as Array<{ key: string; label: string }>

  // ONE derivation, shared with ShopRail — see `railPanels`.
  const railPanelCount = railPanels({
    about: aboutBody,
    chipCount: [shop.verified === true, !!shipping.envia_enabled].filter(Boolean).length + railSignals.length,
    contactCount: railContacts.length,
    hasClaim: !shop.clerk_user_id,
    collectionCount: railCollections.length,
    hasStatus: !!shopStatus.dispatch,
  }).count


  const accent = theme.accent_color ?? 'var(--color-accent)'
  // Readable text over the seller's own accent — a light/pastel accent needs
  // dark ink instead of hardcoded white (reused by the announcement bar + the
  // hero promo CTA button, both painted with `accent` as their background).
  const accentTextColor = readableTextOn(theme.accent_color ?? undefined)

  const pageContent = (
    <div
      style={{ '--shop-accent': accent, ...shopTheme.variables } as React.CSSProperties}
      data-shop-surface={shopTheme.recipe.surface}
      data-shop-background={shopTheme.recipe.background}
      data-shop-identity={shopTheme.recipe.identity}
      data-shop-preset={shopTheme.presetAttribute || undefined}
    >

      {/* Push the shop name into AgentContext so the navbar AI card's copied prompt names
          this shop (S2.2). On white-label channels the AIAgentButton consumer isn't
          rendered, so the value is set but never read → harmless. */}
      <SetAgentContext shopName={shop.name} />

      {/* ── Announcement bar (own-shop premium presentation, Sprint 1) ──────── */}
      <AnnouncementBar announcement={announcement} textColor={accentTextColor} />

      {/* ── Shop chrome (Living Shop, epic 07 · Sprint 8) ────────────────────
          Identity, navigation and bag travel together and stay put, as the
          design concept has it. This REPLACES the old banner-plus-overlapping-
          logo block and the bare chip nav — the section links are the same ones
          from the same derivation, so a hidden or empty section still cannot
          produce a dead link. */}
      <ShopHeader
        shopName={shop.name}
        logoUrl={shop.logo_url ?? null}
        config={sectionConfig}
        availability={sectionAvailability}
        basePath={navBasePath}
        active="wall"
        accent={accent}
        accentTextColor={accentTextColor}
        copy={buyerCopy}
      />

      <ShopHero
        shop={shop}
        tagline={theme.tagline ?? null}
        bannerUrl={theme.banner_url ?? null}
        artUrl={listings[0]?.images?.[0]?.url ?? null}
        posterTitle={collections[0]?.name ?? listings[0]?.title ?? null}
        shopHref={sectionPath('shop', navBasePath)}
        wallHref="#wall"
        accent={accent}
        accentTextColor={accentTextColor}
        copy={buyerCopy}
      />

      {/* ── The Wall (Living Shop, epic 07 · Sprint 2) ────────────────────────
          Rendered only when the merchant has actually published something. A
          shop with a catalog and an empty Wall keeps today's storefront exactly
          as it is — an empty-feed box above a full product grid would be noise,
          and S2.5 asks that a shop with no new settings degrade to the new
          Default WITHOUT losing content. WallFeed's designed empty state belongs
          to the dedicated Wall destination, where the feed is the whole page. */}
      {/* ── The shell: Wall beside its supporting rail (Story 8.4) ────────────
          The rail is a real grid SIBLING of the Wall. Before this it did not
          exist, so the `feed-sidebar` recipe tiled the post cards into two
          columns with nothing in the second track. */}
      <div className="shop-shell" data-rail={railOccupiesTrack(railPanelCount) ? 'on' : 'off'}>
      <main className="shop-shell-main" id="wall">
      {wall.total > 0 && (
        <WallFeed
          entries={wall.entries}
          hasMore={wall.hasMore}
          shopSlug={shop.slug}
          emptyShopHref={`${navBasePath}/tienda`}
          ctx={{
            copy: buyerCopy,
            basePath: navBasePath,
            htmlLang: resolveMarketPresentation(presentationMarket).htmlLang,
            shopName: shop.name,
            shopLogoUrl: shop.logo_url ?? null,
            now: renderNow,
          }}
        />
      )}

      <div className="pt-2 pb-10">
        {listings.length === 0 ? (
          <div className="text-center py-16 text-[var(--color-muted)]">
            <div className="text-4xl mb-3"><i className="iconoir-package" aria-hidden /></div>
            <p className="font-medium"><BuyerCopyText copyKey="s.slug.page.f62ef63c" /></p>
          </div>
        ) : (
          <>
            <p className="text-xs text-[var(--color-muted)] mb-3 sm:hidden">{listings.length} <BuyerCopyText copyKey="s.slug.page.7789bbbe" /></p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {listings.map(listing => (
                <ClosetListingCard
                  key={listing.id}
                  accent={accent}
                  item={{
                    productId: listing.id,
                    variantId: null,
                    sellerId: shop.id ?? '',
                    sellerSlug: shop.slug,
                    sellerName: shop.name,
                    title: listing.title,
                    price_cents: listing.price_cents ?? 0,
                    currency: listing.currency ?? 'MXN',
                    imageUrl: listing.images?.[0]?.url ?? null,
                    listing_type: listing.listing_type ?? 'product',
                    paymentMethods: { stripe: sellerHasStripe, mp: sellerHasMp, spei: hasBankTransfer },
                    href: listingHref({ listingBase: productLinkBase }, listing.id),
                    formattedPrice: formatPrice(listing, resolveMarketPresentation(presentationMarket).htmlLang),
                    status: listing.status,
                    hasExcerpt: hasExcerpt(listing.metadata),
                  }}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* The catalog lives in the SAME column as the Wall.
          It used to sit outside the shell at a wider measure, so the page
          stepped from a 42rem feed to a 72rem grid and read as two pages
          stapled together. One column, one measure — and on the 26 of 30 live
          shops with no Wall entries yet, this is simply the shop: products
          leading, with the rail beside them. */}
      </main>

      <ShopRail
        about={aboutBody}
        chips={trustChips({
          verified: shop.verified === true,
          shipsNationwide: !!shipping.envia_enabled,
          // NOT `hasPickup`: local pickup already travels as a commerce signal
          // below, and feeding it to both put the same claim in the same panel
          // twice. The signal is the better of the two — it names the pickup
          // SPOT where the shop configured one ("Recolección local: Roma Norte"),
          // while the chip could only say that pickup exists.
          localPickup: false,
        })}
        collections={railCollections}
        status={shopStatus}
        contacts={railContacts}
        signals={railSignals}
        claimHref={shop.clerk_user_id ? null : `${marketBasePath}/s/${slug}/claim`}
        copy={buyerCopy}
      />
      </div>


      <ShopFooter
        shopName={shop.name}
        config={sectionConfig}
        availability={sectionAvailability}
        basePath={navBasePath}
        copy={buyerCopy}
      />

      {/* The shop's chat (business-infrastructure S4): claimed shops only — an unclaimed one has nobody to answer. */}
      {isShopClaimed(shop) ? <ShopChat slug={shop.slug} shopName={shop.name} siteKey={process.env.TURNSTILE_SITE_KEY || null} /> : null}

      {/* The footer content links that used to sit here are GONE (Living Shop,
          epic 07 · Story 3.5). Acerca / Preguntas / Políticas are now first-class
          nav destinations, and keeping the footer copy would have reintroduced
          exactly the problem the section nav solves — plus it ignored the
          seller's hidden-section choice, so a page they had deliberately taken
          out of the nav stayed reachable from the bottom of the page.
          `ShopContentLinks.tsx` itself is untouched and still serves the
          collection pages that render it. */}
    </div>
  )

  // On a custom domain the root layout already wraps every page in the shop's
  // white-label shell (ChannelLayout), so the page just returns its content.
  return pageContent
}

export default ShopPage
