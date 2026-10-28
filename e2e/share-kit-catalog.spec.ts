import { expect, test } from '@playwright/test'
import { buildCatalogModel, catalogShortUrl, catalogUrl, orderMessage } from '../lib/share-kit/catalog'
import { shopWhatsAppNumber, whatsappDigits } from '../lib/share-kit/whatsapp'
import { readAllSellerProducts, SELLER_PRODUCTS_PAGE_SIZE } from '../lib/seller-product-pages'
import { parseShopQrTarget, shopQrPlan } from '../lib/share-link'
import type { Listing } from '../lib/types'

/**
 * Share kit S1 — the catalog model, its scoping and the catalog page (Roadmap/03-selling-and-shops/share-kit, D1–D10).
 *
 * Observed red, one mutation at a time: removing the two-shop filter in `buildCatalogModel` (the stray listing of
 * shop B appeared); dropping the `whatsapp_cta` check in `shopWhatsAppNumber` (an unconsented number became a
 * button); reading only the first page in `readAllSellerProducts` (73 products became 50); and mapping every
 * `target` to `catalogo` in `parseShopQrTarget`.
 */

const CLAIMED = 'user_2abc'

function shop(slug: string, settings: Record<string, unknown> = {}, owner: string | null = CLAIMED) {
  return { id: `sel_${slug}`, slug, name: `Tienda ${slug}`, clerk_user_id: owner, metadata: { settings } }
}

function listing(id: string, shopSlug: string, over: Partial<Listing> = {}): Listing {
  return {
    id,
    shop_id: `sel_${shopSlug}`,
    medusa_product_id: id,
    title: `Producto ${id}`,
    description: null,
    price_cents: 19900,
    currency: 'MXN',
    condition: 'new',
    listing_type: 'product',
    category: null,
    collections: [],
    state: null,
    municipio: null,
    location: null,
    metadata: {},
    images: [{ url: `https://pub-x.r2.dev/${id}.webp` }],
    tags: [],
    status: 'active',
    source_platform: null,
    source_url: null,
    views: 0,
    created_at: '2026-10-01T00:00:00Z',
    shop: { slug: shopSlug } as Listing['shop'],
    ...over,
  }
}

const WHATSAPP_ON = { checkout: { whatsapp_cta: true, phone: '55 1234 5678' } }

test.describe('share kit · the catalog model (D6, D7)', () => {
  test("shop A's catalog never carries shop B's products", () => {
    const model = buildCatalogModel({
      shop: shop('tienda-a'),
      listings: [listing('prod_a1', 'tienda-a'), listing('prod_b1', 'tienda-b'), listing('prod_a2', 'tienda-a')],
    })
    expect(model.items.map((i) => i.id)).toEqual(['prod_a1', 'prod_a2'])
  })

  test('a product that two cached pages both returned appears once', () => {
    const model = buildCatalogModel({
      shop: shop('tienda-a'),
      listings: [listing('prod_a1', 'tienda-a'), listing('prod_a1', 'tienda-a'), listing('prod_a2', 'tienda-a')],
    })
    expect(model.items.map((i) => i.id)).toEqual(['prod_a1', 'prod_a2'])
  })

  test('a claimed shop with WhatsApp on gets «Pedir por WhatsApp» naming the product and its link', () => {
    const model = buildCatalogModel({ shop: shop('tienda-a', WHATSAPP_ON), listings: [listing('prod_a1', 'tienda-a')] })
    const item = model.items[0]
    expect(model.shop.whatsapp).toBe('525512345678')
    expect(item.order.kind).toBe('whatsapp')
    const url = new URL(item.order.href)
    expect(url.origin + url.pathname).toBe('https://wa.me/525512345678')
    const text = url.searchParams.get('text') ?? ''
    expect(text).toContain('"Producto prod_a1"')
    expect(text).toContain('https://mschz.org/l/prod_a1')
    expect(text).toBe(orderMessage(item))
  })

  test('no number, no consent, or no owner ⇒ «Comprar» to the product page', () => {
    for (const s of [
      shop('tienda-a'),
      shop('tienda-a', { checkout: { whatsapp_cta: false, phone: '5512345678' } }),
      shop('tienda-a', WHATSAPP_ON, null),
      shop('tienda-a', WHATSAPP_ON, 'pending:abc'),
    ]) {
      const [item] = buildCatalogModel({ shop: s, listings: [listing('prod_a1', 'tienda-a')] }).items
      expect(item.order).toEqual({ kind: 'buy', href: 'https://miyagisanchez.com/mx/l/prod_a1' })
    }
  })

  test('a product with no price says «Precio a consultar»; links are absolute and short', () => {
    const model = buildCatalogModel({
      shop: shop('tienda-a'),
      listings: [listing('prod_a1', 'tienda-a', { price_cents: null, images: [] })],
    })
    expect(model.items[0].priceLabel).toBe('Precio a consultar')
    expect(model.items[0].imageUrl).toBeNull()
    expect(model.links.catalog).toBe('https://miyagisanchez.com/mx/s/tienda-a/catalogo')
    expect(model.links.catalogShort).toBe('https://mschz.org/s/tienda-a/catalogo')
    expect(catalogUrl('x')).toBe('https://miyagisanchez.com/mx/s/x/catalogo')
    expect(catalogShortUrl('x')).toBe('https://mschz.org/s/x/catalogo')
  })
})

test.describe('share kit · the WhatsApp number (D3)', () => {
  test('a number is only a button when the merchant turned the button on', () => {
    expect(shopWhatsAppNumber({ checkout: { phone: '5512345678' } })).toBeNull()
    expect(shopWhatsAppNumber({ checkout: { whatsapp_cta: true, phone: '5512345678' } })).toBe('5512345678')
    expect(shopWhatsAppNumber({ checkout: { whatsapp_cta: true, phone: '1' }, theme: { social: { whatsapp: '5599' } } })).toBe('5599')
    expect(shopWhatsAppNumber(null)).toBeNull()
  })

  test('digits keep an existing 52 and add it otherwise', () => {
    expect(whatsappDigits('+52 (55) 1234-5678')).toBe('525512345678')
    expect(whatsappDigits('55 1234 5678')).toBe('525512345678')
    expect(whatsappDigits('no digits')).toBeNull()
  })
})

test.describe('share kit · every page of a shop (D2)', () => {
  test('pages through to count instead of stopping at the first page', async () => {
    const all = Array.from({ length: 73 }, (_, i) => ({ id: `p${i}` }))
    const calls: Array<[number, number]> = []
    const read = await readAllSellerProducts(async (limit, offset) => {
      calls.push([limit, offset])
      return { seller: { slug: 's' }, products: all.slice(offset, offset + limit), count: all.length }
    })
    expect(read.ok && read.products.length).toBe(73)
    expect(read.ok && read.complete).toBe(true)
    expect(calls).toEqual([[SELLER_PRODUCTS_PAGE_SIZE, 0], [SELLER_PRODUCTS_PAGE_SIZE, 50]])
  })

  test('a failed later page keeps what was read and says it is partial; a failed first page fails', async () => {
    const partial = await readAllSellerProducts(async (limit, offset) =>
      offset === 0 ? { products: Array.from({ length: 50 }, (_, i) => ({ id: i })), count: 80 } : null)
    expect(partial).toMatchObject({ ok: true, complete: false })
    expect(partial.ok && partial.products.length).toBe(50)
    expect(await readAllSellerProducts(async () => null)).toEqual({ ok: false })
  })
})

test.describe('share kit · the catalog QR (D10)', () => {
  test('only `catalogo` targets the catalog; the shop stays the default', () => {
    expect(parseShopQrTarget('catalogo')).toBe('catalogo')
    for (const other of [null, '', 'shop', 'CATALOGO', 'https://evil.example']) expect(parseShopQrTarget(other)).toBe('shop')
    expect(shopQrPlan('tienda-a', 'catalogo')).toEqual({ url: 'https://mschz.org/s/tienda-a/catalogo', filename: 'tienda-a-catalogo-qr.png' })
    expect(shopQrPlan('tienda-a')).toEqual({ url: 'https://mschz.org/tienda-a', filename: 'tienda-a-qr.png' })
    expect(shopQrPlan('../x', 'catalogo')).toBeNull()
  })
})

/**
 * A live Mexico shop, discovered from the public catalog (never a pinned fixture — those rot). `/api/ucp/catalog`
 * answers `{ items: [{ shop: { slug } }], market_code }` and defaults to the Mexico market; a first version of this
 * read `products[].seller.slug`, a shape the route does not have, so it skipped every run (verifier, PR 447).
 */
async function anyPublicShopSlug(request: import('@playwright/test').APIRequestContext): Promise<string | null> {
  const res = await request.get('/api/ucp/catalog?limit=20')
  if (!res.ok()) return null
  const data = await res.json() as { market_code?: string; items?: Array<{ shop?: { slug?: string } | null }> }
  if (data.market_code && data.market_code !== 'mx') return null
  return data.items?.find((item) => item.shop?.slug)?.shop?.slug ?? null
}

test.describe('share kit · the catalog page server HTML (D8, D9)', () => {
  test('a live shop renders one scroll of its own products, each with one order action, with no JS needed', async ({ request }) => {
    const slug = await anyPublicShopSlug(request)
    test.skip(!slug, 'FIXTURE UNAVAILABLE: the public catalog named no shop slug')
    const res = await request.get(`/mx/s/${slug}/catalogo`)
    expect(res.status()).toBe(200)
    const html = await res.text()
    expect(html).toContain('data-testid="catalogo"')
    const items = html.match(/data-testid="catalogo-item"/g) ?? []
    const orders = html.match(/data-testid="catalogo-order"/g) ?? []
    expect(items.length).toBeGreaterThan(0)
    expect(orders.length).toBe(items.length)
    expect(html).toMatch(/Pedir por WhatsApp|Comprar/)
    expect(html).toContain(`/mx/s/${slug}/catalogo`)
  })

  test('an unknown shop is a 404, not an empty catalog', async ({ request }) => {
    const res = await request.get('/mx/s/no-existe-esta-tienda-zz9/catalogo')
    expect(res.status()).toBe(404)
  })
})
