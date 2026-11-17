/**
 * Pure platform sitemap population. Kept outside app/sitemap.ts so the market
 * cutover can prove canonical population without importing Next's request-only
 * headers module into the deterministic API test project.
 */
import { NEW_BUSINESS_TYPE_SLUGS, businessTypePath } from './business-types'

export const PLATFORM_SITEMAP_ENTRIES = [
  // `/` is the Mexico shop builder since root-shop-builder-home: the most important page, and
  // it changes weekly like the landing it replaced. `/mx/vende` is a 308 now, so it is not
  // listed — a sitemap that names a redirect source asks crawlers to index a hop.
  { path: '/', changeFrequency: 'weekly', priority: 1 },
  { path: '/mx', changeFrequency: 'daily', priority: 1 },
  { path: '/mx/l', changeFrequency: 'daily', priority: 0.9 },
  { path: '/us', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/us/l', changeFrequency: 'daily', priority: 0.9 },
  { path: '/acerca', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/en', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/mx/vende/creadores', changeFrequency: 'weekly', priority: 0.8 },
  { path: '/mx/vende/mundial', changeFrequency: 'weekly', priority: 0.8 },
  { path: '/mx/vende/negocios', changeFrequency: 'weekly', priority: 0.8 },
  { path: '/mx/vende/servicios', changeFrequency: 'weekly', priority: 0.8 },
  { path: '/mx/vende/autos', changeFrequency: 'weekly', priority: 0.8 },
  // own-shop-positioning S3.1 — the eight business-type pages a promoter sends (`autos`/`servicios` are above).
  ...NEW_BUSINESS_TYPE_SLUGS.map((slug) => ({ path: businessTypePath(slug), changeFrequency: 'weekly', priority: 0.8 }) as const),
  { path: '/mx/vende/migracion', changeFrequency: 'weekly', priority: 0.8 },
  { path: '/mx/precios', changeFrequency: 'weekly', priority: 0.8 },
  { path: '/mx/vende/migracion/shopify', changeFrequency: 'weekly', priority: 0.7 },
  { path: '/mx/vende/migracion/tiendanube', changeFrequency: 'weekly', priority: 0.7 },
  { path: '/mx/vende/migracion/woocommerce', changeFrequency: 'weekly', priority: 0.7 },
  { path: '/mx/vende/migracion/bigcartel', changeFrequency: 'weekly', priority: 0.7 },
  // `/us/sell`, not `/sell`. `/sell` is the publish wizard behind auth and its
  // signed-out branch is now a 308 to the market landing — listing a redirect
  // spends crawl budget rediscovering the page the sitemap could have named.
  { path: '/us/sell', changeFrequency: 'weekly', priority: 0.9 },
] as const

export function platformSitemapUrls(origin = 'https://miyagisanchez.com'): string[] {
  const base = origin.replace(/\/+$/, '')
  return PLATFORM_SITEMAP_ENTRIES.map(({ path }) => `${base}${path}`)
}

/**
 * The marketplace catalog half of the platform sitemap (Daniel 2026-11-16: "add shops and
 * listings to the sitemap"). Until then the platform sitemap named only entry points and
 * crawlers had to discover every product and shop through `/mx/l` pagination.
 *
 * Each URL is the one its page declares canonical, so the sitemap never names a mirror:
 *   - a listing → `/<market>/l/<id>` (ListingRenderer's market branch);
 *   - a shop    → `/<market>/s/<slug>` (ShopRenderer's market branch) — one per shop that has
 *     at least one visible listing in that market. A shop with nothing on sale is a thin page,
 *     and the listing feed is the only population that is already market-scoped and
 *     visibility-filtered by the backend.
 * `hidden` is the set of shop slugs whose pages 404 (unapproved private previews): neither
 * the shop nor its listings may be listed, or the sitemap asks crawlers to index a 404.
 */
export type CatalogSitemapListing = {
  id: string
  shop?: { slug?: string | null } | null
}

export type CatalogSitemapEntry = {
  path: string
  changeFrequency: 'daily' | 'weekly'
  priority: number
}

export function catalogSitemapEntries(
  markets: ReadonlyArray<{ market: string; listings: ReadonlyArray<CatalogSitemapListing> }>,
  hidden: ReadonlySet<string> = new Set(),
): CatalogSitemapEntry[] {
  const out: CatalogSitemapEntry[] = []
  const seen = new Set<string>()
  const push = (entry: CatalogSitemapEntry) => {
    if (seen.has(entry.path)) return
    seen.add(entry.path)
    out.push(entry)
  }
  for (const { market, listings } of markets) {
    const shops: string[] = []
    for (const listing of listings) {
      const slug = listing.shop?.slug ?? null
      if (slug && hidden.has(slug)) continue
      push({ path: `/${market}/l/${encodeURIComponent(listing.id)}`, changeFrequency: 'weekly', priority: 0.7 })
      if (slug && !shops.includes(slug)) shops.push(slug)
    }
    for (const slug of shops) {
      push({ path: `/${market}/s/${encodeURIComponent(slug)}`, changeFrequency: 'daily', priority: 0.8 })
    }
  }
  return out
}
