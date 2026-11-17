import { test, expect } from '@playwright/test'
import { catalogSitemapEntries } from '../lib/market-sitemap'

// The platform sitemap names every listing and the shop behind it, at the URL each page
// declares canonical (`/<market>/l/<id>`, `/<market>/s/<slug>`), and never a page that 404s.
test.describe('platform sitemap — catalog', () => {
  test('listings and their shops are listed per market at canonical URLs', () => {
    const paths = catalogSitemapEntries([
      {
        market: 'mx',
        listings: [
          { id: 'prod_a', shop: { slug: 'tacos' } },
          { id: 'prod_b', shop: { slug: 'tacos' } },
          { id: 'prod_c', shop: null },
        ],
      },
      { market: 'us', listings: [{ id: 'prod_d', shop: { slug: 'boots' } }] },
    ]).map((e) => e.path)

    expect(paths).toEqual([
      '/mx/l/prod_a',
      '/mx/l/prod_b',
      '/mx/l/prod_c',
      '/mx/s/tacos',
      '/us/l/prod_d',
      '/us/s/boots',
    ])
  })

  test('a hidden (private-preview) shop contributes neither itself nor its listings', () => {
    const paths = catalogSitemapEntries(
      [{ market: 'mx', listings: [{ id: 'prod_a', shop: { slug: 'secret' } }, { id: 'prod_b', shop: { slug: 'open' } }] }],
      new Set(['secret']),
    ).map((e) => e.path)
    expect(paths).toEqual(['/mx/l/prod_b', '/mx/s/open'])
  })

  test('the served platform sitemap includes catalog URLs', async ({ request }) => {
    const res = await request.get('/sitemap.xml')
    expect(res.status()).toBe(200)
    const xml = await res.text()
    // The entry points are still there…
    expect(xml).toContain('<loc>https://miyagisanchez.com/mx</loc>')
    // …and so is the catalog, in both families.
    expect(xml).toMatch(/<loc>https:\/\/miyagisanchez\.com\/(mx|us)\/l\/[^<]+<\/loc>/)
    expect(xml).toMatch(/<loc>https:\/\/miyagisanchez\.com\/(mx|us)\/s\/[^<]+<\/loc>/)
    // Never an unprefixed (redirecting) family.
    expect(xml).not.toMatch(/<loc>https:\/\/miyagisanchez\.com\/(l|s)\//)
  })
})
