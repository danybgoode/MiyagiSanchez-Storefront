import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { buildCatalogModel, catalogOrderEvent } from '../lib/share-kit/catalog'
import { buildMetaFeed, csvField, feedSlugFromSegment, META_FEED_COLUMNS, metaFeedExcludedCount, metaFeedResponse, metaPrice } from '../lib/share-kit/meta-feed'
import { MCP_SELLER_TOOLS } from '../lib/ucp/capabilities'
import { PARTNER_READ_TOOLS } from '../lib/partner-tools'
import { SELLER_MCP_TOOLS } from '../lib/setup-spec'
import type { Listing } from '../lib/types'

/**
 * Share kit S3 — the Meta feed, its route, the order-tap events and `get_share_kit` (share-kit D18, D19).
 *
 * Observed red, one mutation at a time: `metaPrice` without `toFixed(2)` («199 MXN»); `csvField` not doubling a
 * quote; dropping the no-photo exclusion (a photo-less product reached the feed); `metaFeedResponse` serving an
 * unclaimed shop or a partial read; availability hard-coded to `in stock`; and `get_share_kit` reading
 * `args.shop_slug` instead of the resolved shop.
 */

function listing(id: string, over: Partial<Listing> = {}): Listing {
  return {
    id, shop_id: 'sel_a', medusa_product_id: id, title: `Producto ${id}`, description: 'Hecho a mano', price_cents: 19900,
    currency: 'MXN', condition: 'new', listing_type: 'product', category: null, collections: [], state: null,
    municipio: null, location: null, metadata: {}, images: [{ url: `https://pub-x.r2.dev/${id}.webp` }], tags: [],
    status: 'active', source_platform: null, source_url: null, views: 0, created_at: '2026-10-01T00:00:00Z',
    shop: { slug: 'tienda-a' } as Listing['shop'],
    ...over,
  }
}

function modelOf(listings: Listing[], { owner = 'user_1', complete = true }: { owner?: string | null; complete?: boolean } = {}) {
  return buildCatalogModel({ shop: { slug: 'tienda-a', name: 'Tienda A', clerk_user_id: owner, metadata: {} }, listings, complete })
}

function feedOf(listings: Listing[]) {
  return buildMetaFeed(modelOf(listings))
}

/** Minimal RFC 4180 reader — enough to prove the writer round-trips. */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') { field += '"'; i++ } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\r' && csv[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++ }
    else field += c
  }
  return rows
}

test.describe('share kit · the Meta feed (D18)', () => {
  test("Meta's required columns, in order, with «199.00 MXN» prices and the product's stable id", () => {
    const rows = parseCsv(feedOf([listing('prod_1')]).csv)
    expect(rows[0]).toEqual([...META_FEED_COLUMNS])
    expect(rows[0]).toEqual(['id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link', 'brand'])
    expect(rows[1]).toEqual([
      'prod_1', 'Producto prod_1', 'Hecho a mano', 'in stock', 'new', '199.00 MXN',
      'https://miyagisanchez.com/mx/l/prod_1', 'https://pub-x.r2.dev/prod_1.webp', 'Tienda A',
    ])
    expect(metaPrice(5, 'mxn')).toBe('0.05 MXN')
    expect(metaPrice(100000, 'MXN')).toBe('1000.00 MXN')
  })

  test('no photo or no price is left out and counted by reason', () => {
    const feed = feedOf([
      listing('ok'),
      listing('nophoto', { images: [] }),
      listing('noprice', { price_cents: null }),
      listing('zero', { price_cents: 0 }),
    ])
    expect(feed.included).toBe(1)
    expect(feed.excluded).toEqual({ no_photo: 1, no_price: 2 })
    expect(metaFeedExcludedCount(feed)).toBe(3)
    expect(parseCsv(feed.csv).map((r) => r[0])).toEqual(['id', 'ok'])
  })

  test('commas, quotes and line breaks survive the round trip; an empty description falls back to the title', () => {
    const title = 'Taza "La Grande", 350 ml'
    const description = 'Línea 1\nLínea 2, con coma'
    const rows = parseCsv(feedOf([listing('p', { title, description }), listing('q', { description: '  ' })]).csv)
    expect(rows[1][1]).toBe(title)
    expect(rows[1][2]).toBe(description)
    expect(rows[2][2]).toBe('Producto q')
    expect(csvField('a"b')).toBe('"a""b"')
    expect(csvField('plain')).toBe('plain')
  })

  test('a used grade is `used`; new or unset is `new`', () => {
    const rows = parseCsv(feedOf([listing('a', { condition: 'like_new' }), listing('b', { condition: null }), listing('c', { condition: 'parts' })]).csv)
    expect(rows.slice(1).map((r) => r[4])).toEqual(['used', 'new', 'used'])
  })

  test('availability follows stock: sold out is `out of stock`, sold out but taking orders is `available for order`', () => {
    const rows = parseCsv(feedOf([
      listing('a', { in_stock: true }),
      listing('b', { in_stock: false, allow_backorder: false }),
      listing('c', { in_stock: false, allow_backorder: true }),
      listing('d'),
    ]).csv)
    expect(rows.slice(1).map((r) => r[3])).toEqual(['in stock', 'out of stock', 'available for order', 'in stock'])
  })

  test('the route answers 404 for no shop or an unclaimed one, 503 for a partial read, and the CSV otherwise', () => {
    expect(metaFeedResponse(null)).toEqual({ status: 404 })
    expect(metaFeedResponse(modelOf([listing('a')], { owner: null }))).toEqual({ status: 404 })
    expect(metaFeedResponse(modelOf([listing('a')], { owner: 'pending:x' }))).toEqual({ status: 404 })
    expect(metaFeedResponse(modelOf([listing('a')], { complete: false }))).toEqual({ status: 503 })
    expect(metaFeedResponse(modelOf([], { complete: false }))).toEqual({ status: 503 })
    const ok = metaFeedResponse(modelOf([listing('a')]))
    expect(ok.status).toBe(200)
    expect(ok.status === 200 && parseCsv(ok.csv).length).toBe(2)
  })

  test('the route segment must be <slug>.csv', () => {
    expect(feedSlugFromSegment('tienda-a.csv')).toBe('tienda-a')
    for (const bad of ['tienda-a', 'tienda-a.json', '.csv', '..%2Fadmin.csv', 'Tienda.csv', 'a/b.csv']) {
      expect(feedSlugFromSegment(bad), bad).toBeNull()
    }
  })
})

test.describe('share kit · order-tap events (D19)', () => {
  test('a WhatsApp tap and a buy tap fire their own event; anything else fires none', () => {
    expect(catalogOrderEvent('whatsapp')).toBe('catalog_order_whatsapp')
    expect(catalogOrderEvent('buy')).toBe('catalog_order_buy')
    expect(catalogOrderEvent(null)).toBeNull()
    expect(catalogOrderEvent('other')).toBeNull()
  })
})

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8')

test.describe('share kit · get_share_kit is the seller\'s own shop only (D19)', () => {
  test('registered for sellers, viewer-safe for partners, named in the setup prompt', () => {
    expect(MCP_SELLER_TOOLS).toContain('get_share_kit')
    expect(PARTNER_READ_TOOLS.has('get_share_kit')).toBe(true)
    expect(SELLER_MCP_TOOLS.map((t) => t.name)).toContain('get_share_kit')
  })

  test('the shop comes from the credential, never from an argument', () => {
    const source = read('app/api/ucp/mcp/route.ts')
    const start = source.indexOf('async function handleGetShareKit(')
    const body = source.slice(start, source.indexOf('\nasync function ', start + 1))
    expect(body).toContain("resolveToolShop(authHeader, args, 'get_share_kit')")
    expect(body).toContain('const slug = agentAuth.shop.slug')
    expect(body).not.toMatch(/args\.(shop_slug|slug)|args\[/)
  })

  test('the feed route answers through metaFeedResponse, and the tile also needs a claimed shop', () => {
    expect(read('app/api/feeds/meta/[slug]/route.ts')).toContain('const plan = metaFeedResponse(')
    expect(read('app/(shell)/shop/manage/comparte/page.tsx')).toContain('const metaFeed = model?.shop.claimed')
  })
})

test.describe('share kit · the feed route and the tool, live', () => {
  test('an unknown shop, a wrong extension and a traversal attempt are 404s', async ({ request }) => {
    for (const p of ['/api/feeds/meta/no-existe-esta-tienda-zz9.csv', '/api/feeds/meta/no-existe-esta-tienda-zz9.json', '/api/feeds/meta/..%2Fadmin.csv']) {
      expect((await request.get(p)).status(), p).toBe(404)
    }
  })

  test('get_share_kit without a credential is refused', async ({ request }) => {
    const res = await request.post('/api/ucp/mcp', {
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_share_kit', arguments: { shop_slug: 'el-manchon' } } },
    })
    expect(res.status()).toBeLessThan(500)
    const body = await res.json()
    expect(body.result?.isError).toBe(true)
    expect(body.result.content[0].text).toContain('Unauthorized')
  })
})
