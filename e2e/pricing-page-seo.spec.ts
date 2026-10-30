import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { SUBDOMAIN_PRICE_YEARLY_MXN, SUBDOMAIN_PRICE_MONTHLY_MXN } from '../lib/subdomain-pricing'
import { CUSTOM_DOMAIN_PRICE_MXN } from '../lib/domain-pricing'
import { ML_SYNC_PRICE_YEARLY_MXN, ML_SYNC_PRICE_MONTHLY_MXN } from '../lib/ml-sync-pricing'
import { PLATFORM_SITEMAP_ENTRIES } from '../lib/market-sitemap'

/**
 * pricing-page S1.2 — `/mx/precios` in the RAW server HTML (no JS): the four sections, the real
 * prices from the price modules, metadata/OG, JSON-LD offers and the sitemap entry.
 */

const BASE_URL = 'https://miyagisanchez.com'
const es = JSON.parse(readFileSync(new URL('../locales/es.json', import.meta.url), 'utf8'))
const ui = es.precios

/** React escapes text; undo the entities a price or title can contain. */
function decode(html: string): string {
  return html.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/<!-- -->/g, '')
}

test.describe('/mx/precios · server HTML', () => {
  test('renders the four sections with real prices', async ({ request }) => {
    const res = await request.get('/mx/precios')
    expect(res.ok()).toBeTruthy()
    const html = decode(await res.text())

    for (const title of [ui.free.title, ui.extras.title, ui.processors.title, ui.compare.title]) {
      expect(html, title).toContain(title)
    }
    expect(html).toContain(`$${SUBDOMAIN_PRICE_YEARLY_MXN} MXN/año`)
    expect(html).toContain(`$${SUBDOMAIN_PRICE_MONTHLY_MXN} MXN/mes`)
    expect(html).toContain(`$${CUSTOM_DOMAIN_PRICE_MXN} MXN/año`)
    expect(html).toContain(`$${ML_SYNC_PRICE_YEARLY_MXN} MXN/año`)
    expect(html).toContain(`$${ML_SYNC_PRICE_MONTHLY_MXN} MXN/mes`)
    // Admin-set extras: a price or «Precio a cotizar» — never a bare $0.
    for (const sku of ['print_ad', 'migration']) {
      const card = html.match(new RegExp(`data-testid="precios-extra-${sku}-price"[^>]*>([^<]+)<`))
      expect(card, sku).not.toBeNull()
      expect(card![1]).toMatch(/Precio a cotizar|\$[1-9]/)
    }
    // Processors: named, with IVA, and never implying cards are free.
    expect(html).toContain('Stripe')
    expect(html).toContain('Mercado Pago')
    expect(html).toContain('SPEI')
    expect(html).toContain('más IVA')
    expect(html).toContain('href="/comparador?platform=t1&tier=basico"')
    // The signup CTA goes to the shop builder, which is the root since root-shop-builder-home.
    expect(html).toContain('data-testid="precios-primary-cta"')
    expect(html).not.toContain('href="/mx/vende"')
    // No unfilled token reached the page.
    expect(html).not.toMatch(/\{(subdomain|customDomain|mlSync|printAd|migration)\w*\}/)
  })

  test('exposes metadata, OG, canonical and JSON-LD offers for fixed prices only', async ({ request }) => {
    const html = decode(await (await request.get('/mx/precios')).text())
    expect(html).toContain(ui.metadata.title)
    expect(html).toContain(`<link rel="canonical" href="${BASE_URL}/mx/precios"`)
    expect(html).toMatch(/property="og:image"/)
    const ld = [...html.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)]
      .map((m) => JSON.parse(m[1]))
      .find((j) => j.mainEntity?.['@type'] === 'OfferCatalog')
    expect(ld).toBeTruthy()
    const offers = ld.mainEntity.itemListElement as Array<{ name: string; price: string; priceCurrency: string }>
    expect(offers.map((o) => o.price).sort()).toEqual(
      [SUBDOMAIN_PRICE_YEARLY_MXN, SUBDOMAIN_PRICE_MONTHLY_MXN, CUSTOM_DOMAIN_PRICE_MXN, ML_SYNC_PRICE_YEARLY_MXN, ML_SYNC_PRICE_MONTHLY_MXN]
        .map(String)
        .sort(),
    )
    expect(offers.every((o) => o.priceCurrency === 'MXN')).toBe(true)
    expect(offers.some((o) => /impreso|Migraci/.test(o.name))).toBe(false)
  })

  test('is in the sitemap', async ({ request }) => {
    expect(PLATFORM_SITEMAP_ENTRIES.some((e) => e.path === '/mx/precios')).toBe(true)
    const xml = await (await request.get('/sitemap.xml')).text()
    expect(xml).toContain('/mx/precios</loc>')
  })

  test('the about surfaces carry the catalog prices and the page link', async ({ request }) => {
    const llms = await (await request.get('/llms.txt')).text()
    expect(llms).not.toMatch(/TBD/)
    expect(llms).toContain('/mx/precios')
    expect(llms).toContain(`$${ML_SYNC_PRICE_YEARLY_MXN} MXN/year`)
    const acerca = decode(await (await request.get('/acerca')).text())
    expect(acerca).toContain('href="/mx/precios"')
    expect(acerca).toContain(`$${CUSTOM_DOMAIN_PRICE_MXN} MXN/año`)
    expect(acerca).not.toMatch(/\{(subdomain|customDomain|mlSync|printAd|migration)\w*\}/)
  })
})
