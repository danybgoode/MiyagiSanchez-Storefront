import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { NEGOCIO_PRICE_MONTHLY_MXN, NEGOCIO_PRICE_YEARLY_MXN } from '../lib/negocio-pricing'
import { TIENDA_PRICE_MONTHLY_MXN, TIENDA_PRICE_YEARLY_MXN } from '../lib/tienda-pricing'
import { yearlyAsMonthly } from '../lib/pricing-catalog'
import { PLATFORM_SITEMAP_ENTRIES } from '../lib/market-sitemap'

/**
 * pricing-page S1.2 — `/mx/precios` in the RAW server HTML (no JS): the four sections, the real
 * prices from the price modules, metadata/OG, JSON-LD offers and the sitemap entry.
 */

const BASE_URL = 'https://miyagisanchez.com'
const es = JSON.parse(readFileSync(new URL('../locales/es.json', import.meta.url), 'utf8'))
const ui = es.precios
const YEARLY = NEGOCIO_PRICE_YEARLY_MXN.toLocaleString('en-US')

/** React escapes text; undo the entities a price or title can contain. */
function decode(html: string): string {
  return html.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/<!-- -->/g, '')
}

test.describe('/mx/precios · server HTML', () => {
  test('renders the four sections with real prices', async ({ request }) => {
    const res = await request.get('/mx/precios')
    expect(res.ok()).toBeTruthy()
    const html = decode(await res.text())

    for (const title of [ui.plans.title, ui.extras.title, ui.processors.title, ui.compare.title]) {
      expect(html, title).toContain(title)
    }
    // The two PAID plans side by side (plan-tienda S2.3), priced from their modules, IVA included; no Plan Gratis.
    expect(html).toContain('data-testid="precios-plan-tienda"')
    expect(html).toContain('data-testid="precios-plan-negocio"')
    expect(html).not.toContain('data-testid="precios-plan-gratis"')
    expect(html).toContain(`Desde $${yearlyAsMonthly(TIENDA_PRICE_YEARLY_MXN)} al mes`)
    expect(html).toContain(`$${TIENDA_PRICE_YEARLY_MXN} MXN al año`)
    expect(html).toContain(`$${TIENDA_PRICE_MONTHLY_MXN} MXN al mes`)
    expect(html.match(/data-testid="precios-plan-(tienda|negocio)-iva"[^>]*>IVA incluido</g)).toHaveLength(2)
    expect(html).not.toContain('gratis para siempre')
    expect(html).toContain(`$${NEGOCIO_PRICE_MONTHLY_MXN} MXN/mes`)
    expect(html).toContain(`$${YEARLY} MXN/año`)
    // The retired extras are not sold on the page any more.
    for (const sku of ['subdomain', 'custom_domain', 'ml_sync']) expect(html).not.toContain(`precios-extra-${sku}`)
    // No printed ad is sold (Daniel, 2026-11-05).
    expect(html).not.toContain('precios-extra-print_ad')
    // Admin-set extras: a price or «Precio a cotizar» — never a bare $0.
    for (const sku of ['migration']) {
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
    expect(html).toMatch(/href="\/"[^>]*data-testid="precios-primary-cta"|data-testid="precios-primary-cta"[^>]*href="\/"/)
    expect(html).not.toContain('href="/mx/vende"')
    // No unfilled token reached the page.
    expect(html).not.toMatch(/\{(subdomain|customDomain|mlSync|printAd|migration|negocio|tienda|trial)\w*\}/)
    // The full plan names, never a bare «Negocio es opcional» (Daniel, 2026-11-05).
    expect(html).toContain('Plan Tienda')
    expect(html).toContain('Plan Negocio')
    expect(html).not.toContain('Negocio es opcional')
  })

  test('exposes metadata, OG, canonical and JSON-LD offers for the two plans\' fixed prices only', async ({ request }) => {
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
      [TIENDA_PRICE_MONTHLY_MXN, TIENDA_PRICE_YEARLY_MXN, NEGOCIO_PRICE_MONTHLY_MXN, NEGOCIO_PRICE_YEARLY_MXN].map(String).sort(),
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
    expect(llms).toContain(`$${YEARLY} MXN a year`)
    const acerca = decode(await (await request.get('/acerca')).text())
    expect(acerca).toContain('href="/mx/precios"')
    expect(acerca).toContain(`$${YEARLY} MXN al año`)
    expect(acerca).not.toMatch(/\{(subdomain|customDomain|mlSync|printAd|migration|negocio)\w*\}/)
  })
})
