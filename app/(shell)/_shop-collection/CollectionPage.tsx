import { BuyerCopyText } from '@/app/components/BuyerPresentationContext'
import { notFound, permanentRedirect } from 'next/navigation'
import Link from 'next/link'
import {
  readShopListings,
  getShopCollections,
  formatPrice,
} from '@/lib/listings'
import { hasExcerpt } from '@/lib/excerpt'
import { isLikelyCollectionSlug } from '@/lib/route-shape'
import { getActiveCustomDomain } from '@/lib/custom-domain'
import { shortCollectionSlug } from '@/lib/collection-derive'
import { readableTextOn } from '@/lib/platform-theme'
import { publicShopPaymentAvailability } from '@/lib/public-shop-commerce'
import AnnouncementBar from '../s/[slug]/AnnouncementBar'
import ShopCollectionNav from '../s/[slug]/ShopCollectionNav'
import ShopSectionNav from '../_shop-sections/ShopSectionNav'
import ShopThemeShell from '../_shop-sections/ShopThemeShell'
import { resolveShopNav } from '@/lib/shop-presentation/context'
import { listingHref, shopListingBase } from '@/lib/shop-presentation/chrome'
import ClosetListingCard from '../s/[slug]/ClosetListingCard'
import type { AnnouncementSettings } from '@/lib/shop-settings/types'
import type { Shop } from '@/lib/types'
import type { MarketCode } from '@/lib/markets'
import { resolveMarketPresentation } from '@/lib/market-presentation'
import { getDictionary } from '@/lib/dictionary'

/**
 * Shared body for both collection-page routes (own-shop premium
 * presentation, Sprint 2):
 *  - `app/(shell)/s/[slug]/c/[collection]/page.tsx` — marketplace path.
 *  - `app/(shell)/c/[collection]/page.tsx` — channel path (subdomain/custom
 *    domain), shop already resolved from the unspoofable
 *    `x-miyagi-shop-slug` header.
 *
 * `isMarketplaceRoute` gates the custom-domain SEO redirect — only the
 * marketplace path needs to 308 a live-domain shop's legacy URL onward; the
 * channel path is already on the tenant's own domain by construction.
 */
export default async function CollectionPage({
  shop,
  collectionShortSlug,
  basePath,
  isMarketplaceRoute,
  market,
  marketBasePath = '',
}: {
  shop: Shop
  collectionShortSlug: string
  basePath: string
  isMarketplaceRoute: boolean
  market?: MarketCode
  marketBasePath?: string
}) {
  // Cheap shape guard before any Medusa fetch (mirrors isLikelyShopSlug/
  // isLikelyListingId's role on the sibling routes).
  if (!isLikelyCollectionSlug(collectionShortSlug)) notFound()

  const [sectionNav, navDict, allCollections, listingRead] = await Promise.all([
    resolveShopNav(shop),
    getDictionary(resolveMarketPresentation(market ?? 'mx').language),
    getShopCollections(shop.slug, market),
    // The shop's OWN catalog on every channel, as the shop home and `/tienda` read
    // it — a «Solo mi tienda» product belongs in its collection too (2026-11-11).
    readShopListings(shop.slug),
  ])
  const navCopy = navDict.buyerCopy
  // Do not collapse an unreadable catalog into a healthy empty collection: those
  // are different facts and only the latter may render. Throwing keeps the last
  // good render; a partial read still has real products and renders them.
  if (!listingRead.complete && listingRead.listings.length === 0) {
    throw new Error(`[collection] catalog read unavailable for ${shop.slug}`)
  }
  const allListings = listingRead.listings
  const publishedCollectionHandles = new Set(allListings.flatMap((listing) => listing.collections ?? []))
  const collections = market
    ? allCollections.filter((collection) => publishedCollectionHandles.has(collection.handle))
    : allCollections
  const matched = collections.find((c) => shortCollectionSlug(c.handle, shop.slug) === collectionShortSlug)
  // A foreign shop's collection handle, or a genuinely nonexistent one, is
  // simply absent from THIS shop's own collection list — this lookup IS the
  // per-shop isolation check (scoped by shop.slug, never trusts the raw id).
  if (!matched) notFound()
  // Where product cards point — the one decision in `shopListingBase` (see `ShopBases`).
  const productLinkBase = shopListingBase({
    onOwnedHost: !isMarketplaceRoute,
    marketBasePath,
    shopSlug: shop.slug,
  })

  if (isMarketplaceRoute && !marketBasePath) {
    const domain = await getActiveCustomDomain(shop.slug)
    if (domain) permanentRedirect(`https://${domain}/c/${collectionShortSlug}`)
  }

  // Compose downstream of the already print-placement-filtered listing read
  // — never re-query Medusa directly or reimplement that exclusion.
  const listings = allListings.filter((l) => l.collections?.includes(matched.handle))

  const settings = ((shop.metadata as Record<string, unknown> | null)?.settings ?? {}) as Record<string, unknown>
  const theme = (settings.theme ?? {}) as { accent_color?: string | null }
  const announcement = settings.announcement as AnnouncementSettings | null | undefined
  const themePreset = settings.theme_preset as string | null | undefined
  const accent = theme.accent_color ?? 'var(--color-accent)'
  const accentTextColor = readableTextOn(theme.accent_color ?? undefined)
  const paymentAvailability = publicShopPaymentAvailability(shop.metadata)

  return (
    <ShopThemeShell theme={sectionNav.theme} accent={sectionNav.accent}>
    <div data-shop-preset={themePreset || undefined}>
      <AnnouncementBar announcement={announcement} textColor={accentTextColor} />

      <div className="max-w-6xl mx-auto px-4 pt-6 pb-2">
        <Link href={basePath || '/'} className="text-sm text-[var(--color-muted)] no-underline hover:underline">
          ← {shop.name}
        </Link>
        <h1 className="text-xl font-bold mt-1">{matched.name}</h1>
      </div>

      {/* Story 3.2 — the shop nav sits ABOVE the collection chips here, which is
          the one place both belong: the sections are navigation, the chips are a
          filter within one of them. On the homepage the chips were competing
          with the nav, which is why they no longer render there. */}
      <ShopSectionNav
        shopName={shop.name}
        logoUrl={shop.logo_url ?? null}
        config={sectionNav.sections}
        availability={sectionNav.availability}
        basePath={basePath}
        active="collections"
        accent={sectionNav.accent}
        activeTextColor={sectionNav.accentTextColor}
        copy={navCopy}
      />

      <ShopCollectionNav
        listings={allListings}
        collections={collections}
        basePath={basePath}
        sellerSlug={shop.slug}
        accent={accent}
        activeTextColor={accentTextColor}
        activeShortSlug={collectionShortSlug}
      />

      <div className="max-w-6xl mx-auto px-4 pb-12">
        {listings.length === 0 ? (
          <div className="text-center py-16 text-[var(--color-muted)]">
            <div className="text-4xl mb-3"><i className="iconoir-package" aria-hidden /></div>
            <p className="font-medium"><BuyerCopyText copyKey="shop.collection.CollectionPage.22fbd5c9" /></p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {listings.map((listing) => (
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
                  paymentMethods: {
                    stripe: paymentAvailability.stripe,
                    mp: paymentAvailability.mercadopago,
                    spei: paymentAvailability.bankTransfer,
                  },
                  href: listingHref({ listingBase: productLinkBase }, listing.id),
                  formattedPrice: formatPrice(listing, resolveMarketPresentation(market ?? 'mx').htmlLang),
                  status: listing.status,
                  hasExcerpt: hasExcerpt(listing.metadata),
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
    </ShopThemeShell>
  )
}
