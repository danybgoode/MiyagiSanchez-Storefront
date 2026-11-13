import { expect, test } from '@playwright/test'
import {
  handleFileIntake, handleLinkIntake, handlePhotoIntake, INTAKE_COPY, type IntakeDeps,
} from '../lib/prompt-to-shop/intake-handler'
import {
  bigCartelRows, describeFromRows, fileKindOf, nextHop, planLink, readPageMeta, sanitizeSeedRows, screenTextFor, SEED_ROWS_MAX,
} from '../lib/prompt-to-shop/intake'
import { browserMarketHint, currencyFor } from '../lib/prompt-to-shop/locale'

// one-front-door-both-markets S1.3–S1.5 — start a shop from a photo, a catalog file or a store link (D6–D9).
// Every fake writes to ONE trace; refusals assert the trace, so a refusal that came after a model call fails here
// even when its status code is right.

const DEVICE = '0b9e8c1e-3c2a-4d8e-9a51-6f1f2b3c4d5e'
const PNG = { bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png' }
const CARD = { business: 'Vendo velas aromáticas de soya hechas a mano', title: 'Vela de soya con lavanda', description: 'Vela en frasco de vidrio ámbar.', category: 'otros', price: 180 }

function world(over: Partial<IntakeDeps> & { device?: number | null; day?: number | null; model?: string | null } = {}) {
  const trace: string[] = []
  const deps = {
    verifyTurnstile: async () => { trace.push('turnstile'); return { ok: true as const } },
    burstAllowed: async () => { trace.push('burst'); return true },
    spendDevice: async () => { trace.push('spend:device'); return over.device === undefined ? 1 : over.device },
    spendDay: async () => { trace.push('spend:day'); return over.day === undefined ? 1 : over.day },
    refundDevice: async () => { trace.push('refund:device') },
    modelConfigured: true,
    callModel: async () => { trace.push('model'); return over.model === undefined ? JSON.stringify(CARD) : over.model },
    storePhoto: async () => { trace.push('store'); return 'https://img.example.r2.dev/p2s/x.png' },
    xlsxToCsv: () => { trace.push('xlsx'); return 'title,price,category\nVela de soya lavanda,180,otros\nJabón de avena natural,90,otros\n' },
    fetchJson: async () => { trace.push('fetchJson'); return null as unknown },
    fetchHtml: async () => { trace.push('fetchHtml'); return '<html><head><title>Tacos El Güero</title><meta name="description" content="Tacos al pastor en Tijuana desde 1998"></head></html>' },
    base64: () => 'AAAA',
    categories: ['otros'],
    extractionPrompt: 'EXTRAE',
    ...over,
  }
  return { deps, trace }
}

const common = { locale: 'es', marketHint: 'mx', turnstileToken: 't', deviceId: DEVICE }

// ── Photo ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('photo: validate → Turnstile → burst → device → day → model → store; returns a business sentence and ONE row', async () => {
  const w = world()
  const out = await handlePhotoIntake({ ...common, file: PNG }, w.deps)
  expect(w.trace).toEqual(['turnstile', 'burst', 'spend:device', 'spend:day', 'model', 'store'])
  expect(out).toMatchObject({ status: 200, body: { ok: true, input: 'photo', description: CARD.business } })
  if (out.status !== 200) throw new Error('unreachable')
  expect(out.body.seed_rows).toEqual([expect.objectContaining({ title: CARD.title, price: 180, currency: 'MXN', images: ['https://img.example.r2.dev/p2s/x.png'] })])
})

test('photo: a SECOND signed-out photo on this device is refused with "create your account", before any model call', async () => {
  const w = world({ device: null })
  const out = await handlePhotoIntake({ ...common, file: PNG }, w.deps)
  expect(out).toMatchObject({ status: 429, body: { code: 'used', error: INTAKE_COPY.es.used } })
  expect(w.trace).toEqual(['turnstile', 'burst', 'spend:device'])
})

test('photo: a spent-out DAY refuses and gives the device its one photo back', async () => {
  const w = world({ day: null })
  const out = await handlePhotoIntake({ ...common, file: PNG }, w.deps)
  expect(out).toMatchObject({ status: 503, body: { code: 'budget' } })
  expect(w.trace).toEqual(['turnstile', 'burst', 'spend:device', 'spend:day', 'refund:device'])
})

test('photo: an allowance the database could not answer fails CLOSED (no model)', async () => {
  const w = world({ spendDevice: async () => { throw new Error('rpc down') } })
  const out = await handlePhotoIntake({ ...common, file: PNG }, w.deps)
  expect(out.status).toBe(503)
  expect(w.trace).not.toContain('model')
})

test('photo: a failed Turnstile or a non-image refuses before anything is spent', async () => {
  const bad = world({ verifyTurnstile: async () => ({ ok: false as const, reason: 'rejected' }) })
  expect((await handlePhotoIntake({ ...common, file: PNG }, bad.deps)).status).toBe(403)
  expect(bad.trace).toEqual([])
  const pdf = world()
  expect((await handlePhotoIntake({ ...common, file: { bytes: PNG.bytes, mime: 'application/pdf' } }, pdf.deps)).status).toBe(400)
  expect(pdf.trace).toEqual([])
})

test('photo: in English for a US visitor, prices in dollars', async () => {
  const w = world({ model: JSON.stringify({ ...CARD, business: 'I sell hand-poured soy candles', price: 24 }) })
  const out = await handlePhotoIntake({ ...common, locale: 'en', marketHint: 'us', file: PNG }, w.deps)
  if (out.status !== 200) throw new Error(`expected 200, got ${out.status}`)
  expect(out.body.seed_rows[0]).toMatchObject({ currency: 'USD', price: 24 })
})

test('photo: a model that returned no business sentence gives the visitor their one try back', async () => {
  const w = world({ model: 'not json' })
  const out = await handlePhotoIntake({ ...common, file: PNG }, w.deps)
  expect(out).toMatchObject({ status: 502, body: { code: 'unavailable' } })
  expect(w.trace).toEqual(['turnstile', 'burst', 'spend:device', 'spend:day', 'model', 'refund:device'])
})

test('pdf: a model call that failed gives the try back; one that read nothing usable keeps it (the read happened)', async () => {
  const f = world({ model: null })
  expect((await handleFileIntake({ ...common, file: { bytes: new Uint8Array([1]), mime: 'application/pdf', name: 'm.pdf' } }, f.deps)).status).toBe(502)
  expect(f.trace).toContain('refund:device')
  const e = world({ model: '[]' })
  expect((await handleFileIntake({ ...common, file: { bytes: new Uint8Array([1]), mime: 'application/pdf', name: 'm.pdf' } }, e.deps)).status).toBe(422)
  expect(e.trace).not.toContain('refund:device')
})

// ── File ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('file: a CSV is parsed in CODE — no spend, no model — and becomes rows plus a written description', async () => {
  const w = world()
  const csv = new TextEncoder().encode('title,price,category\nVela de soya lavanda,180,otros\nJabón de avena natural,90,otros\n')
  const out = await handleFileIntake({ ...common, file: { bytes: csv, mime: 'text/csv', name: 'mis_productos.csv' } }, w.deps)
  expect(w.trace).toEqual(['turnstile', 'burst'])
  if (out.status !== 200) throw new Error(`expected 200, got ${out.status}`)
  expect(out.body.seed_rows.map((r) => r.title)).toEqual(['Vela de soya lavanda', 'Jabón de avena natural'])
  expect(out.body.description).toContain('2 productos')
  expect(out.body.source_name).toBe('mis productos')
})

test('file: an XLSX goes through the sheet reader; a PDF spends an intake FIRST, then the model reads it', async () => {
  const x = world()
  const xo = await handleFileIntake({ ...common, file: { bytes: new Uint8Array([1]), mime: 'application/octet-stream', name: 'catalogo.xlsx' } }, x.deps)
  expect(x.trace).toEqual(['turnstile', 'burst', 'xlsx'])
  expect(xo.status).toBe(200)
  const p = world({ model: JSON.stringify([{ title: 'Pastel de tres leches', price: 450, category: 'otros' }]) })
  const po = await handleFileIntake({ ...common, file: { bytes: new Uint8Array([1]), mime: 'application/pdf', name: 'menu.pdf' } }, p.deps)
  expect(p.trace).toEqual(['turnstile', 'burst', 'spend:device', 'spend:day', 'model'])
  expect(po.status).toBe(200)
})

test('file: a file with no usable rows is "empty"; an unknown type is refused before Turnstile', async () => {
  const e = world()
  const empty = await handleFileIntake({ ...common, file: { bytes: new TextEncoder().encode('nada,aqui\n'), mime: 'text/csv', name: 'x.csv' } }, e.deps)
  expect(empty).toMatchObject({ status: 422, body: { code: 'empty' } })
  const u = world()
  expect((await handleFileIntake({ ...common, file: { bytes: new Uint8Array([1]), mime: 'image/png', name: 'x.png' } }, u.deps)).status).toBe(400)
  expect(u.trace).toEqual([])
})

// ── Link ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('link: a Shopify shop (any domain) becomes its own products, with the shop name in the description', async () => {
  const w = world({
    fetchJson: async () => { w.trace.push('fetchJson'); return { products: [{ title: 'Vela de soya grande', body_html: '<p>Grande</p>', variants: [{ price: '320.00' }], images: [{ src: 'https://cdn.shopify.com/v.jpg' }] }] } },
    fetchHtml: async () => { w.trace.push('fetchHtml'); return '<title>&ndash; Velas Luz</title>' },
  })
  const out = await handleLinkIntake({ ...common, url: 'velasluz.com' }, w.deps)
  expect(w.trace).toEqual(['turnstile', 'burst', 'fetchJson', 'fetchHtml'])
  if (out.status !== 200) throw new Error('expected 200')
  expect(out.body.description).toMatch(/^Velas Luz: una tienda con 1 producto/)
  expect(out.body.seed_rows[0]).toMatchObject({ title: 'Vela de soya grande', price: 320, description: 'Grande', images: ['https://cdn.shopify.com/v.jpg'] })
})

test('link: any other site gives its title and description, and no rows', async () => {
  const w = world()
  const out = await handleLinkIntake({ ...common, url: 'https://tacoselguero.mx' }, w.deps)
  expect(out).toMatchObject({ status: 200, body: { description: 'Tacos El Güero — Tacos al pastor en Tijuana desde 1998', seed_rows: [] } })
})

test('link: a private, internal or non-web address is refused before Turnstile — nothing is fetched', async () => {
  for (const url of ['http://169.254.169.254/latest/meta-data', 'http://localhost:3000', 'file:///etc/passwd', 'http://10.0.0.5', 'https://user:pw@shop.com', 'https://shop.com:8443', 'javascript:alert(1)']) {
    const w = world()
    const out = await handleLinkIntake({ ...common, url }, w.deps)
    expect(out.status, url).toBe(400)
    expect(w.trace, url).toEqual([])
  }
})

test('link: a page that says nothing about itself asks for a sentence instead', async () => {
  const w = world({ fetchHtml: async () => '<html><body>hola</body></html>' })
  expect(await handleLinkIntake({ ...common, url: 'https://example.com' }, w.deps)).toMatchObject({ status: 422, body: { code: 'silentPage' } })
})

// ── Pure helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

test('seed rows are re-validated: invalid rows dropped, at most 60, https images only, the market sets the currency', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ title: `Producto número ${i + 1}`, price: 10, category: 'otros', currency: 'MXN', images: ['javascript:x', 'https://ok.example/a.jpg'] }))
  const rows = sanitizeSeedRows([{ title: 'x', category: 'otros' }, ...many], 'USD')
  expect(rows).toHaveLength(SEED_ROWS_MAX)
  expect(rows[0]).toMatchObject({ title: 'Producto número 1', currency: 'USD', images: ['https://ok.example/a.jpg'] })
  expect(sanitizeSeedRows('nope', 'MXN')).toEqual([])
})

test('the screen sees the rows titles too, so a file of prohibited products cannot hide behind a written description', () => {
  expect(screenTextFor('una tienda con 2 productos', [{ title: 'Réplica AAA Rolex', category: 'otros' }])).toContain('Réplica AAA Rolex')
})

test('describeFromRows stays within the box limit, in the visitor language', () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ title: `Long product title number ${i} `.repeat(4).trim(), category: 'otros' as const }))
  const en = describeFromRows(rows, 'en', 'Candle Co')
  expect(en.startsWith('Candle Co: a shop with 9 products, such as')).toBe(true)
  expect(en.length).toBeLessThanOrEqual(500)
})

test('planLink recognises Shopify and Big Cartel by host; everything public is a page', () => {
  expect(planLink('https://velasluz.myshopify.com/products/x')).toEqual({ kind: 'shopify', domain: 'velasluz.myshopify.com' })
  expect(planLink('lunaprints.bigcartel.com')).toEqual({ kind: 'bigcartel', origin: 'https://lunaprints.bigcartel.com' })
  expect(planLink('articulo.mercadolibre.com.mx/MLM-1')).toMatchObject({ kind: 'page' })
  expect(planLink('')).toBeNull()
})

test('a redirect is followed only to another public web address', () => {
  expect(nextHop('https://a.com/x', '/y')).toBe('https://a.com/y')
  expect(nextHop('https://a.com/x', 'http://127.0.0.1/admin')).toBeNull()
  expect(nextHop('https://a.com/x', 'ftp://a.com/f')).toBeNull()
  expect(nextHop('https://a.com/x', null)).toBeNull()
})

test('page meta: OpenGraph first, entities decoded, attribute order does not matter', () => {
  expect(readPageMeta('<meta content="Velas &amp; jabones" property="og:title"><title>ignored</title>')).toEqual({ title: 'Velas & jabones', description: null })
})

test('file kinds by extension first (browsers send octet-stream), then by MIME', () => {
  expect(fileKindOf('Catálogo.XLSX', 'application/octet-stream')).toBe('xlsx')
  expect(fileKindOf('menu', 'application/pdf')).toBe('pdf')
  expect(fileKindOf('photo.png', 'image/png')).toBeNull()
})

test('Big Cartel products.json → rows', () => {
  expect(bigCartelRows([{ name: 'Print A4 luna', price: 15, images: [{ url: 'https://x/a.jpg' }] }])[0]).toMatchObject({ title: 'Print A4 luna', price: 15, images: ['https://x/a.jpg'] })
  expect(bigCartelRows({})).toEqual([])
})

test('the browser hint: timezone first (an en-US phone in Monterrey is in Mexico), then a language region, else none', () => {
  expect(browserMarketHint({ timeZone: 'America/Monterrey', languages: ['en-US'] })).toBe('mx')
  expect(browserMarketHint({ timeZone: 'America/Los_Angeles', languages: ['es-MX'] })).toBe('us')
  expect(browserMarketHint({ timeZone: 'Europe/Madrid', languages: ['es-ES'] })).toBeNull()
  expect(browserMarketHint({ timeZone: 'Europe/Madrid', languages: ['en-US'] })).toBe('us')
  expect(currencyFor(null)).toBe('MXN')
})

// ── D9: the merchant's own rows on the canvas and into the shop ───────────────────────────────────────────────────

import { pendingSeedRows, seedCards, seedImportRows } from '../lib/prompt-to-shop/view'
import { coerceBlocks } from '../lib/prompt-to-shop/access'

test('seed rows show as the merchant\'s own cards (never EJEMPLO), priced in their currency', () => {
  const cards = seedCards([{ title: 'Vela de soya', price: 24, currency: 'USD', images: ['https://cdn.example/v.jpg'] }, { title: 'Jabón' }])
  expect(cards).toEqual([
    { id: 'seed-0', title: 'Vela de soya', priceLabel: expect.stringContaining('24'), imageUrl: 'https://cdn.example/v.jpg', published: false },
    { id: 'seed-1', title: 'Jabón', priceLabel: null, imageUrl: null, published: false },
  ])
  expect(cards[0].priceLabel).toContain('US')
})

test('the import payload carries a stable external id per row, so a second upload updates instead of duplicating', () => {
  const a = seedImportRows('7f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607', [{ title: 'Vela' }, { title: 'Jabón', category: 'hogar' }], 'MXN')
  const b = seedImportRows('7f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607', [{ title: 'Vela' }, { title: 'Jabón', category: 'hogar' }], 'MXN')
  expect(a.map((r) => r.external_id)).toEqual(['p2s-7f2a1b3c-1', 'p2s-7f2a1b3c-2'])
  expect(a).toEqual(b)
  expect(a[1]).toMatchObject({ category: 'hogar', listing_type: 'product', quantity: 1 })
})

test('the upload is offered until every seed title is a product; an unreadable product list still offers it', () => {
  const rows = [{ title: 'Vela de soya' }, { title: 'Jabón' }]
  expect(pendingSeedRows(rows, [{ title: 'vela de soya ' }])).toHaveLength(2)
  expect(pendingSeedRows(rows, [{ title: 'Vela de soya' }, { title: 'jabón' }])).toEqual([])
  expect(pendingSeedRows(rows, null)).toHaveLength(2)
  expect(pendingSeedRows(null, [])).toEqual([])
})

test('a draft row\'s seed_rows survive the read; anything that is not a titled row is dropped', () => {
  const blocks = coerceBlocks({ identity: null, words: null, catalog: null, block_status: {}, seed_rows: [{ title: 'Vela' }, { nope: 1 }, 'x'] })
  expect(blocks.seedRows).toEqual([{ title: 'Vela' }])
  expect(coerceBlocks({ identity: null, words: null, catalog: null, block_status: {} }).seedRows).toBeNull()
})

// The DB is the contract (LEARNINGS): `ai_allowance_kind_check` refuses any other kind, and on 2026-11-12 a new
// kind made every signed-out photo fail CLOSED live. Read the newest constraint from the migrations, not from memory.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ANON_INTAKE } from '../lib/prompt-to-shop/intake'

test('the intake spends only allowance kinds the database accepts, on subjects of its own', () => {
  const dir = join(process.cwd(), 'supabase', 'migrations')
  const latest = readdirSync(dir).sort().map((f) => readFileSync(join(dir, f), 'utf8'))
    .filter((sql) => sql.includes('add constraint ai_allowance_kind_check')).pop()!
  const allowed = [...latest.slice(latest.lastIndexOf('add constraint ai_allowance_kind_check')).split(';')[0].matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1])
  expect(allowed.length).toBeGreaterThan(2)
  expect(allowed).toContain(ANON_INTAKE.kind)
  expect(allowed).toContain(ANON_INTAKE.budgetKind)
  // Not the generation budget's subject, and not a signed-in merchant's photo subject.
  expect(ANON_INTAKE.budgetSubject).not.toBe('global')
  expect(ANON_INTAKE.deviceSubject('x')).not.toMatch(/^(device|user):/)
})

// ── Security lens, PR #498 ───────────────────────────────────────────────────────────────────────────────────────

test('a redirect cannot reach another port or carry credentials (the same door as the first URL)', () => {
  expect(nextHop('https://shop.com/', 'http://shop.com:9000/admin')).toBeNull()
  expect(nextHop('https://shop.com/', 'https://shop.com:6379/')).toBeNull()
  expect(nextHop('https://shop.com/', 'https://u:p@shop.com/')).toBeNull()
  expect(nextHop('https://shop.com/', 'https://shop.com:443/ok')).toBe('https://shop.com/ok')
})

test('the screen sees EVERY row title, so a list cannot hide prohibited items past the first few', () => {
  const rows = [...Array.from({ length: 40 }, (_, i) => ({ title: `Vela aromática ${i + 1}`, category: 'otros' as const })), { title: 'Réplica AAA Rolex', category: 'otros' as const }]
  expect(screenTextFor('una tienda', rows)).toContain('Réplica AAA Rolex')
})

test('an out-of-range numeric entity on a stranger\'s page does not crash the read', () => {
  expect(() => readPageMeta('<title>a &#99999999; b &#x110000; c &#xD800;</title>')).not.toThrow()
  expect(readPageMeta('<title>Velas &#241; &#x1F56F;</title>').title).toBe('Velas ñ 🕯')
})

// ── Fresh review, PR #498 ────────────────────────────────────────────────────────────────────────────────────────

import { readCappedBody } from '../lib/prompt-to-shop/intake'

test('a price in another currency than the SHOP\'s is dropped at import, never relabelled (US$95 must not become MX$95)', () => {
  const rows = seedImportRows('7f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607', [{ title: 'Wool runner', price: 95, currency: 'USD' }, { title: 'Vela', price: 180, currency: 'MXN' }], 'MXN')
  expect(rows[0].currency).toBe('MXN')
  expect(rows[0].price).toBeUndefined()
  expect(JSON.parse(JSON.stringify(rows[0]))).not.toHaveProperty('price')
  expect(rows[1]).toMatchObject({ currency: 'MXN', price: 180 })
})

test('photo: a prohibited description is refused BEFORE the photo is stored on our bucket', async () => {
  const w = world({ model: JSON.stringify({ ...CARD, business: 'Vendo pistolas sin papeles', title: 'Pistola 9mm' }) })
  ;(w.deps as IntakeDeps).screen = async () => { w.trace.push('screen'); return { verdict: 'refuse', kind: 'prohibited' } }
  const out = await handlePhotoIntake({ ...common, file: PNG }, w.deps)
  expect(out).toMatchObject({ status: 422, body: { code: 'prohibited' } })
  expect(w.trace).toEqual(['turnstile', 'burst', 'spend:device', 'spend:day', 'model', 'screen'])
})

function streamOf(chunks: number[]): ReadableStream<Uint8Array> {
  let i = 0
  let cancelled = false
  const s = new ReadableStream<Uint8Array>({
    pull(c) { if (i < chunks.length) c.enqueue(new Uint8Array(chunks[i++])); else c.close() },
    cancel() { cancelled = true },
  })
  ;(s as unknown as { wasCancelled: () => boolean }).wasCancelled = () => cancelled
  return s
}

test('a page body is capped AS IT IS READ: a declared length over the cap reads nothing; a growing body is cancelled', async () => {
  expect(await readCappedBody(streamOf([10]), String(5_000_000), 1000)).toBeNull()
  const growing = streamOf([600, 600, 600])
  expect(await readCappedBody(growing, null, 1000)).toBeNull()
  expect((growing as unknown as { wasCancelled: () => boolean }).wasCancelled()).toBe(true)
  expect((await readCappedBody(streamOf([300, 300]), null, 1000))?.byteLength).toBe(600)
})

import * as XLSX from 'xlsx'
import { zipDeclaredUncompressedSize, XLSX_MAX_UNCOMPRESSED } from '../lib/prompt-to-shop/intake'

test('a spreadsheet\'s declared expansion is read from the zip directory before any parse (zip-bomb guard)', () => {
  const ws = XLSX.utils.aoa_to_sheet([['title', 'price'], ['Vela de soya lavanda', 180]])
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'A')
  const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
  const size = zipDeclaredUncompressedSize(bytes)
  expect(size).toBeGreaterThan(100)
  expect(size!).toBeLessThan(XLSX_MAX_UNCOMPRESSED)
  // Patch the first central-directory entry to declare 2 GB: the guard must see it without inflating anything.
  const bomb = bytes.slice()
  const v = new DataView(bomb.buffer)
  for (let i = 0; i < bomb.length - 4; i++) if (v.getUint32(i, true) === 0x02014b50) { v.setUint32(i + 24, 0x7fffffff, true); break }
  expect(zipDeclaredUncompressedSize(bomb)!).toBeGreaterThan(XLSX_MAX_UNCOMPRESSED)
  expect(zipDeclaredUncompressedSize(new TextEncoder().encode('not a zip at all, just text'))).toBeNull()
})

// ── S4.1 / D20 — «Crear con IA» from the dashboard: a signed-in merchant ─────────────────────────────────────────

test('signed in: no Turnstile, the merchant\'s own monthly allowance (not the device\'s one try)', async () => {
  const seen: unknown[] = []
  const w = world({ spendDevice: async (who) => { seen.push(who); w.trace.push('spend:who'); return 3 } })
  const out = await handlePhotoIntake({ ...common, turnstileToken: null, userId: 'user_9', file: PNG }, w.deps)
  expect(out.status).toBe(200)
  expect(w.trace[0]).toBe('burst')
  expect(seen).toEqual([{ kind: 'user', id: 'user_9' }])
})

test('signed in: a month that is used up says so (not "create your account")', async () => {
  const w = world({ device: null })
  const out = await handlePhotoIntake({ ...common, userId: 'user_9', file: PNG }, w.deps)
  expect(out).toMatchObject({ status: 429, body: { code: 'usedMonth' } })
})

test('signed in: rows from a file or a link are screened HERE — they go straight to the importer', async () => {
  const csv = new TextEncoder().encode('title,price,category\nRéplica AAA Rolex,900,otros\nVela de soya lavanda,180,otros\n')
  const w = world()
  ;(w.deps as IntakeDeps).screen = async (text) => { w.trace.push('screen'); return text.includes('Réplica') ? { verdict: 'refuse', kind: 'prohibited' } : { verdict: 'allow' } }
  const out = await handleFileIntake({ ...common, userId: 'user_9', file: { bytes: csv, mime: 'text/csv', name: 'x.csv' } }, w.deps)
  expect(out).toMatchObject({ status: 422, body: { code: 'prohibited' } })
  // Signed out, the same file is returned — its screen runs in the drafts request that follows.
  const anon = world()
  ;(anon.deps as IntakeDeps).screen = async () => { anon.trace.push('screen'); return { verdict: 'refuse', kind: 'prohibited' } }
  expect((await handleFileIntake({ ...common, file: { bytes: csv, mime: 'text/csv', name: 'x.csv' } }, anon.deps)).status).toBe(200)
  expect(anon.trace).not.toContain('screen')
})

test('signed out still needs Turnstile even when a userId-shaped value is absent', async () => {
  const w = world({ verifyTurnstile: async () => ({ ok: false as const, reason: 'rejected' }) })
  expect((await handleLinkIntake({ ...common, userId: null, url: 'https://shop.com' }, w.deps)).status).toBe(403)
})

// Fresh review, PR #501 ─────────────────────────────────────────────────────────────────────────────────────────

test('signed in: a model failure gives the MERCHANT their read back (not a device)', async () => {
  const refunded: unknown[] = []
  const w = world({ model: 'not json', refundDevice: async (who) => { refunded.push(who) } })
  await handlePhotoIntake({ ...common, userId: 'user_9', file: PNG }, w.deps)
  expect(refunded).toEqual([{ kind: 'user', id: 'user_9' }])
})

test('signed in: a link\'s rows are screened too', async () => {
  const w = world({ fetchJson: async () => ({ products: [{ title: 'Pistola 9mm sin papeles', variants: [{ price: '500' }] }] }) })
  ;(w.deps as IntakeDeps).screen = async () => ({ verdict: 'refuse', kind: 'prohibited' })
  expect(await handleLinkIntake({ ...common, userId: 'user_9', url: 'https://shop.example' }, w.deps)).toMatchObject({ status: 422, body: { code: 'prohibited' } })
})

test('the signed-in mode is a SHOP OWNER\'s: every intake route asks for one, from the session', () => {
  const route = readFileSync(join(process.cwd(), 'lib/prompt-to-shop/intake-route.ts'), 'utf8')
  // The seller is Medusa's (AGENTS rule 1), never the Supabase mirror.
  expect(route).toContain('await getMySeller()')
  expect(route).not.toContain("from('marketplace_shops')")
  for (const kind of ['photo', 'file', 'link']) {
    const src = readFileSync(join(process.cwd(), `app/api/p2s/intake/${kind}/route.ts`), 'utf8')
    expect(src, kind).toContain('userId: await intakeShopOwner()')
  }
  // …and a merchant's AI read is a PLAN photo: the canvas's subject, kind and cap — one pool, not two.
  const server = readFileSync(join(process.cwd(), 'lib/prompt-to-shop/intake-server.ts'), 'utf8')
  expect(server).toContain("spendAllowance(userSubject(who.id), 'photo', month, await ownerPhotoCap(who.id))")
})

test('seed prices keep their cents (149.50 stays 149.50)', () => {
  expect(sanitizeSeedRows([{ title: 'Vela de soya lavanda', price: 149.5, category: 'otros' }], 'MXN')[0].price).toBe(149.5)
})

import { screenChunksFor } from '../lib/prompt-to-shop/intake'
test('signed in: a benign title over a prohibited DESCRIPTION is refused; every row is screened in chunks', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ title: `Accesorio número ${i + 1}`, description: i === 33 ? 'Cartuchos calibre 9mm sin papeles' : 'Accesorio de cuero', category: 'otros' as const }))
  const chunks = screenChunksFor('una tienda', rows)
  expect(chunks).toHaveLength(3)
  expect(chunks.some((c) => c.includes('Cartuchos calibre 9mm'))).toBe(true)
  for (const c of chunks) expect(c.length).toBeLessThan(7000)
  const w = world({ fetchJson: async () => ({ products: rows.map((r) => ({ title: r.title, body_html: r.description, variants: [{ price: '100' }] })) }) })
  ;(w.deps as IntakeDeps).screen = async (text) => (text.includes('Cartuchos') ? { verdict: 'refuse', kind: 'prohibited' } : { verdict: 'allow' })
  expect(await handleLinkIntake({ ...common, userId: 'user_9', url: 'https://shop.example' }, w.deps)).toMatchObject({ status: 422 })
})

test('a screen that throws is unavailable on the direct-import path, never an escaped error (Codex, PR #501)', async () => {
  const w = world({ fetchJson: async () => ({ products: [{ title: 'Vela de soya grande', variants: [{ price: '300' }] }] }) })
  ;(w.deps as IntakeDeps).screen = async () => { throw new Error('jev down') }
  expect((await handleLinkIntake({ ...common, userId: 'user_9', url: 'https://shop.example' }, w.deps)).status).toBe(200)
})

test('the bulk importer itself refuses prohibited goods — the one door every import walks through', () => {
  const src = readFileSync(join(process.cwd(), 'app/api/sell/import/route.ts'), 'utf8')
  const screened = src.indexOf('screenChunksFor(')
  expect(screened).toBeGreaterThan(src.indexOf('validateRows(body.rows)'))
  // After the seller lookup (a caller with no shop never spends a screen), before any product write.
  expect(screened).toBeGreaterThan(src.indexOf('listRes.status === 404'))
  expect(screened).toBeLessThan(src.indexOf('for (const s of staged)') > 0 ? src.indexOf('for (const s of staged)') : src.length)
  expect(src).toContain("verdict.kind === 'prohibited'")
})

test('a signed-in refund gives back the month it was spent in (one month per request)', () => {
  const src = readFileSync(join(process.cwd(), 'lib/prompt-to-shop/intake-server.ts'), 'utf8')
  expect(src.match(/monthPeriod\(new Date\(\)\)/g)?.length).toBe(1)
  expect(src).toContain("spendAllowance(userSubject(who.id), 'photo', month,")
})
