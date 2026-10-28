/**
 * Pure platform sitemap population. Kept outside app/sitemap.ts so the market
 * cutover can prove canonical population without importing Next's request-only
 * headers module into the deterministic API test project.
 */
export const PLATFORM_SITEMAP_ENTRIES = [
  { path: '/', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/mx', changeFrequency: 'daily', priority: 1 },
  { path: '/mx/l', changeFrequency: 'daily', priority: 0.9 },
  { path: '/us', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/us/l', changeFrequency: 'daily', priority: 0.9 },
  { path: '/acerca', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/en', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/mx/vende', changeFrequency: 'weekly', priority: 0.9 },
  { path: '/mx/vende/creadores', changeFrequency: 'weekly', priority: 0.8 },
  { path: '/mx/vende/mundial', changeFrequency: 'weekly', priority: 0.8 },
  { path: '/mx/vende/negocios', changeFrequency: 'weekly', priority: 0.8 },
  { path: '/mx/vende/servicios', changeFrequency: 'weekly', priority: 0.8 },
  { path: '/mx/vende/autos', changeFrequency: 'weekly', priority: 0.8 },
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
