import type { MetadataRoute } from 'next'
import { headers } from 'next/headers'
import { getShop, getShopListings, getShopCollections } from '@/lib/listings'
import { shortCollectionSlug } from '@/lib/collection-derive'
import { normalizeSections, navEntries } from '@/lib/shop-presentation/sections'
import { resolveSectionAvailability } from '@/lib/shop-presentation/availability'
import { resolvePublicWallShop } from '@/lib/wall/store'
import { PLATFORM_SITEMAP_ENTRIES, type CatalogSitemapEntry } from '@/lib/market-sitemap'
import { catalogSitemap } from '@/lib/market-sitemap-server'
import { listingUrlFor, marketplaceUrl } from '@/lib/market-url'

export function platformSitemap(catalog: readonly CatalogSitemapEntry[] = []): MetadataRoute.Sitemap {
  const base = 'https://miyagisanchez.com'
  return [...PLATFORM_SITEMAP_ENTRIES, ...catalog].map(({ path, changeFrequency, priority }) => ({
    url: `${base}${path}`,
    changeFrequency,
    priority,
  }))
}

/**
 * Host-aware sitemap.
 *
 * On a tenant's custom domain (tagged by middleware with the resolved shop slug)
 * we emit THAT shop's storefront — home + every product — under the custom
 * domain, so search engines index the brand domain as an independent store and
 * avoid duplicate-content penalties against the marketplace mirror.
 *
 * On the platform host we emit the entry points plus every market's listings and
 * the shops behind them, at their canonical `/<market>/…` URLs (Daniel 2026-11-16 —
 * this reverses the earlier "entry points only" choice). If the catalog read fails,
 * the entry points still ship: a sitemap must never 500.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const h = await headers()
  const shopSlug = h.get('x-miyagi-shop-slug')
  const domain = h.get('x-miyagi-domain')

  if (shopSlug && domain) {
    const base = `https://${domain.split(':')[0]}`
    // Never 500 the sitemap on a backend hiccup — fall back to just the home URL.
    let listings: Awaited<ReturnType<typeof getShopListings>> = []
    let collections: Awaited<ReturnType<typeof getShopCollections>> = []
    let contentPaths: string[] = []
    try {
      const [l, c, shop] = await Promise.all([
        getShopListings(shopSlug),
        getShopCollections(shopSlug),
        getShop(shopSlug),
      ])
      listings = l
      collections = c
      const settings = ((shop?.metadata as Record<string, unknown> | null)?.settings ?? {}) as Record<string, unknown>
      // Living Shop (epic 07 · Story 7.2). The sitemap lists exactly the
      // destinations the NAV lists, through the same two functions — a section
      // the seller hid, or one with nothing behind it, must not be crawlable
      // when it is not reachable. Two independent derivations of "which sections
      // exist" is how a hidden page ends up indexed.
      //
      // Individual Wall ENTRIES are deliberately absent: they have no durable
      // route of their own, and the scope requires that to be justified in build
      // rather than assumed. The Wall is the homepage, which is already here.
      const wallShop = await resolvePublicWallShop(shopSlug)
      const sectionConfig = normalizeSections(settings.sections)
      const availability = await resolveSectionAvailability({
        shopId: wallShop?.id ?? null,
        settings,
        collectionCount: c.length,
      })
      contentPaths = navEntries(sectionConfig, availability, '')
        // The Wall IS `/`, already emitted below with priority 1.
        .filter((entry) => entry.key !== 'wall')
        .map((entry) => entry.path)
    } catch {
      listings = []
      collections = []
      contentPaths = []
    }
    return [
      { url: marketplaceUrl(base, '/'), changeFrequency: 'daily', priority: 1 },
      ...listings.map((l) => ({
        url: listingUrlFor(base, l.id),
        changeFrequency: 'weekly' as const,
        priority: 0.8,
      })),
      ...collections.map((c) => ({
        url: marketplaceUrl(base, `/c/${shortCollectionSlug(c.handle, shopSlug)}`),
        changeFrequency: 'weekly' as const,
        priority: 0.7,
      })),
      ...contentPaths.map((p) => ({
        url: marketplaceUrl(base, p),
        changeFrequency: 'monthly' as const,
        priority: 0.6,
      })),
    ]
  }

  let catalog: CatalogSitemapEntry[] = []
  try {
    catalog = await catalogSitemap()
  } catch (error) {
    console.error('[sitemap] catalog unavailable; serving entry points only', error)
  }
  return platformSitemap(catalog)
}
