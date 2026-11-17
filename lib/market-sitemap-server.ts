import 'server-only'
import { unstable_cache } from 'next/cache'
import { searchListings } from './listings'
import { MARKET_CODES } from './markets'
import { isShopPreviewPrivateBySlug } from './preview-access'
import { catalogSitemapEntries, type CatalogSitemapEntry } from './market-sitemap'
import type { Listing } from './types'

// 24 per page (searchListings' fixed page size) × 200 = 4,800 listings per market. The
// live catalog is ~125; the cap only stops a runaway loop, it is far below the 50,000-URL
// sitemap limit. Hitting it is logged, not silent.
const MAX_PAGES = 200

async function readMarketListings(market: (typeof MARKET_CODES)[number]): Promise<Listing[]> {
  const listings: Listing[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await searchListings({ page: String(page) }, market)
    // A closed/unavailable market contributes nothing — never a guessed list.
    if (result.market_unavailable) break
    listings.push(...result.listings)
    if (result.listings.length === 0 || listings.length >= result.total) return listings
    if (page === MAX_PAGES) console.error(`[sitemap] ${market} catalog truncated at ${listings.length} of ${result.total}`)
  }
  return listings
}

/**
 * Every market's listings + shops for the platform sitemap. Cached for an hour: the sitemap
 * route is dynamic (it reads the host header), and a crawler fetch must not page the whole
 * catalog each time.
 */
export const catalogSitemap = unstable_cache(
  async (): Promise<CatalogSitemapEntry[]> => {
    // A backend failure THROWS out of here on purpose: unstable_cache stores only a
    // returned value, so a blip is never cached as an empty catalog for an hour. The
    // sitemap route catches it and serves the entry points alone for that request.
    const markets = await Promise.all(
      MARKET_CODES.map(async (market) => ({ market, listings: await readMarketListings(market) })),
    )
    const shops = new Map<string, string | null>()
    for (const { listings } of markets) {
      for (const l of listings) if (l.shop?.slug) shops.set(l.shop.slug, l.shop.clerk_user_id ?? null)
    }
    const hidden = new Set<string>()
    await Promise.all(
      [...shops].map(async ([slug, clerkUserId]) => {
        // Fails closed like the pages do: an unreadable anchor counts as private.
        if (await isShopPreviewPrivateBySlug(slug, clerkUserId).catch(() => true)) hidden.add(slug)
      }),
    )
    return catalogSitemapEntries(markets, hidden)
  },
  ['platform-catalog-sitemap'],
  { revalidate: 3600, tags: ['listings'] },
)
