import { expect, test } from '@playwright/test'
import { buildCatalogModel, type CatalogModel } from '../lib/share-kit/catalog'
import { catalogPdfKey, serveCatalogPdf, CATALOG_PDF_ERROR, type CatalogPdfDeps } from '../lib/share-kit/catalog-pdf'
import { chunkIntoSheets } from '../lib/share-kit/print-plan'
import type { Listing } from '../lib/types'

/**
 * Share kit S2 — the catalog PDF's cache key, the order of its gates, and the print layout (share-kit D15, D16).
 *
 * Observed red, one mutation at a time: hashing only the slug in `catalogPdfKey` (a price change kept the old key);
 * moving the rate limits ABOVE the cache read (a hit was throttled); caching a PDF with a missing image; dropping the
 * white flatten before JPEG (a transparent pixel came out black); checking the shop limit before the IP one; dropping the cache write (the second call
 * rendered again); and `chunkIntoSheets` using a fixed 5 per sheet.
 */

function listing(id: string, price = 19900): Listing {
  return {
    id, shop_id: 'sel_a', medusa_product_id: id, title: `Producto ${id}`, description: null, price_cents: price,
    currency: 'MXN', condition: 'new', listing_type: 'product', category: null, collections: [], state: null,
    municipio: null, location: null, metadata: {}, images: [{ url: `https://pub-x.r2.dev/${id}.webp` }], tags: [],
    status: 'active', source_platform: null, source_url: null, views: 0, created_at: '2026-10-01T00:00:00Z',
    shop: { slug: 'tienda-a' } as Listing['shop'],
  }
}

function model(listings: Listing[], accent: string | null = null): CatalogModel {
  return buildCatalogModel({
    shop: { slug: 'tienda-a', name: 'Tienda A', clerk_user_id: 'user_1', metadata: { settings: { theme: { accent_color: accent } } } },
    listings,
  })
}

const PDF = new TextEncoder().encode('%PDF-1.7 fake').buffer as ArrayBuffer

function fakeDeps(over: Partial<CatalogPdfDeps> & { store?: Map<string, ArrayBuffer> } = {}) {
  const store = over.store ?? new Map<string, ArrayBuffer>()
  const calls: string[] = []
  const deps: CatalogPdfDeps = {
    loadModel: async () => model([listing('p1')]),
    cacheGet: async (key) => { calls.push('cacheGet'); return store.get(key) ?? null },
    rateLimit: async (kind) => { calls.push(`rateLimit:${kind}`); return true },
    render: async () => { calls.push('render'); return { pdf: PDF, complete: true } },
    cachePut: async (key, pdf) => { calls.push('cachePut'); store.set(key, pdf) },
    ...over,
  }
  return { deps, calls, store }
}

test.describe('share kit · the PDF cache key (D16)', () => {
  test('anything a buyer sees changes the key; the same catalog keeps it', () => {
    const base = catalogPdfKey(model([listing('p1')]))
    expect(base).toMatch(/^catalog-pdf\/tienda-a\/[0-9a-f]{32}\.pdf$/)
    expect(catalogPdfKey(model([listing('p1')]))).toBe(base)
    expect(catalogPdfKey(model([listing('p1', 25000)]))).not.toBe(base)
    expect(catalogPdfKey(model([listing('p1'), listing('p2')]))).not.toBe(base)
    expect(catalogPdfKey(model([listing('p1')], '#e63946'))).not.toBe(base)
  })
})

test.describe('share kit · serving the PDF (D16)', () => {
  test('a miss renders once and stores it; the next call is a hit with no render and no rate-limit charge', async () => {
    const { deps, calls } = fakeDeps()
    const first = await serveCatalogPdf('tienda-a', '1.1.1.1', deps)
    expect(first).toMatchObject({ status: 200, cache: 'miss', filename: 'tienda-a-catalogo.pdf' })
    expect(calls).toEqual(['cacheGet', 'rateLimit:catalog_pdf_ip', 'rateLimit:catalog_pdf_shop', 'render', 'cachePut'])
    calls.length = 0
    const second = await serveCatalogPdf('tienda-a', '1.1.1.1', deps)
    expect(second).toMatchObject({ status: 200, cache: 'hit' })
    expect(calls).toEqual(['cacheGet'])
  })

  test('over either limit on a miss ⇒ 429 with the one error line, and no render', async () => {
    for (const blocked of ['catalog_pdf_shop', 'catalog_pdf_ip'] as const) {
      const { deps, calls } = fakeDeps({ rateLimit: async (kind) => kind !== blocked })
      const result = await serveCatalogPdf('tienda-a', '1.1.1.1', deps)
      expect(result).toEqual({ status: 429, error: CATALOG_PDF_ERROR })
      expect(calls).not.toContain('render')
    }
  })

  test("a client over its IP limit never spends the shop's budget", async () => {
    const { deps, calls } = fakeDeps({ rateLimit: async (kind) => { calls.push(`rateLimit:${kind}`); return kind !== 'catalog_pdf_ip' } })
    expect((await serveCatalogPdf('tienda-a', '1.1.1.1', deps)).status).toBe(429)
    expect(calls).not.toContain('rateLimit:catalog_pdf_shop')
  })

  test('a PDF with a missing image is served but never cached', async () => {
    const { deps, calls, store } = fakeDeps({ render: async () => { calls.push('render'); return { pdf: PDF, complete: false } } })
    expect(await serveCatalogPdf('tienda-a', '1.1.1.1', deps)).toMatchObject({ status: 200, cache: 'miss' })
    expect(calls).not.toContain('cachePut')
    expect(store.size).toBe(0)
  })

  test('a failed render is a 503 with the error line and caches nothing; an unknown shop is a 404', async () => {
    const failed = fakeDeps({ render: async () => null })
    expect(await serveCatalogPdf('tienda-a', 'ip', failed.deps)).toEqual({ status: 503, error: CATALOG_PDF_ERROR })
    expect(failed.calls).not.toContain('cachePut')
    const thrown = fakeDeps({ render: async () => { throw new Error('renderer down') } })
    expect((await serveCatalogPdf('tienda-a', 'ip', thrown.deps)).status).toBe(503)
    const unknown = fakeDeps({ loadModel: async () => null })
    expect((await serveCatalogPdf('nope', 'ip', unknown.deps)).status).toBe(404)
    expect(unknown.calls).toEqual([])
  })

  test('an unreadable cache renders instead of failing; a failed cache write still serves the PDF', async () => {
    const { deps } = fakeDeps({
      cacheGet: async () => { throw new Error('r2 down') },
      cachePut: async () => { throw new Error('r2 down') },
    })
    expect(await serveCatalogPdf('tienda-a', 'ip', deps)).toMatchObject({ status: 200, cache: 'miss' })
  })
})

test.describe('share kit · the print layout (D15)', () => {
  test('six products a sheet, the last sheet holds the rest, nothing is dropped', () => {
    const items = Array.from({ length: 14 }, (_, i) => i)
    const sheets = chunkIntoSheets(items)
    expect(sheets.map((s) => s.length)).toEqual([6, 6, 2])
    expect(sheets.flat()).toEqual(items)
    expect(chunkIntoSheets([])).toEqual([])
  })
})

test.describe('share kit · the print page and PDF routes, live', () => {
  test('an unknown shop has no print page and no PDF', async ({ request }) => {
    expect((await request.get('/mx/s/no-existe-esta-tienda-zz9/catalogo/imprimir')).status()).toBe(404)
    expect((await request.get('/api/catalogo/no-existe-esta-tienda-zz9/pdf')).status()).toBe(404)
    expect((await request.get('/api/catalogo/..%2Fadmin/pdf')).status()).toBe(404)
  })

  test("the seller's PDF needs a session", async ({ request }) => {
    expect((await request.get('/api/sell/catalogo/pdf')).status()).toBe(401)
  })
})

test.describe('share kit · the print page asks for JPEG (2026-10-29)', () => {
  test('photos and the logo use the pinned JPEG variant, never the screen loader', async () => {
    const { printImageUrl } = await import('../lib/image-loader')
    const { resolveImageVariant } = await import('../lib/image-variant')
    const url = printImageUrl('https://pub-x.r2.dev/a.webp', 640)
    const query = url.slice('/api/img?'.length)
    expect(resolveImageVariant(new URLSearchParams(query), query)).toMatchObject({ ok: true, variant: { fixedFormat: 'jpeg', width: 640 } })
    const page = (await import('node:fs')).readFileSync(new URL('../app/(shell)/mx/s/[slug]/catalogo/imprimir/page.tsx', import.meta.url), 'utf8')
    expect(page).not.toContain('r2ImageLoader')
    expect(page.match(/printImageUrl\(/g)?.length).toBe(2)
  })
})

test.describe('share kit · a JPEG print image is never black where the source was transparent (PR 450)', () => {
  test('a fully transparent PNG pixel encodes to white', async () => {
    const sharp = (await import('sharp')).default
    const { encodeImage } = await import('../lib/image-encode')
    const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()
    const { body, contentType } = await encodeImage(png, { width: 8, quality: 75, format: 'jpeg' })
    expect(contentType).toBe('image/jpeg')
    const { data } = await sharp(body).raw().toBuffer({ resolveWithObject: true })
    expect(Math.min(data[0], data[1], data[2])).toBeGreaterThan(245)
  })
})

test.describe('share kit · the missing-images header (PR 450)', () => {
  test('only plain digits are a count; empty, absent or garbage is unknown, never zero', async () => {
    const { parseMissingImages } = await import('../lib/print-pdf-header')
    expect(parseMissingImages('0')).toBe(0)
    expect(parseMissingImages('3')).toBe(3)
    for (const bad of [null, '', ' ', '-1', '1.5', '0x1', '1e2', ' 0']) expect(parseMissingImages(bad), String(bad)).toBeUndefined()
  })
})
