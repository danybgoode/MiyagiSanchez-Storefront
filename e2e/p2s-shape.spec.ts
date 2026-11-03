import { expect, test } from '@playwright/test'
import { BUSINESS_SHAPES, DEFAULT_SHAPE, SHAPE_DEFAULTS, isBusinessShape, offersCorreos, rerunShape, shapeOf } from '../lib/business-shape'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CATALOG_CATEGORY_KEYS, IMPORT_LISTING_TYPES } from '../lib/catalog-import'
import { fallbackCatalog, fallbackIdentity, validateCatalog, validateIdentity } from '../lib/prompt-to-shop/blocks'
import { manifestFrom } from '../lib/prompt-to-shop/claim'
import { handleCreateDraft, parseDraftsBody, type DraftsDeps } from '../lib/prompt-to-shop/handler'
import { buildBlockRequest, generateDraft, type ModelRequest } from '../lib/prompt-to-shop/planner'
import { RESPONSE_SCHEMAS, catalogPrompt, identityPrompt } from '../lib/prompt-to-shop/prompts'
import { validateConfig } from '../lib/settings-import'

// business-infrastructure S1.2 + S1.3 — any business is recognised, and the shop fits it (epic D1–D3).

const GOOD_IDENTITY = {
  name: 'Tamales Doña Rosa',
  tagline: 'Tamales de olla los domingos.',
  description: 'Tamales y atole hechos en casa, cada domingo en Coyoacán.',
  accent_color: '#1f6f5c',
  accent_alternates: ['#8a3b12', '#2f4b8a', '#6b2f6b'],
  theme_preset: 'papel',
}

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ title: `Paquete de tamales ${i + 1}`, description: 'Seis tamales.', price: 120 + i, category: 'otros', listing_type: 'product' }))

test('the shape enum maps every shape onto an EXISTING listing type and category', () => {
  expect(DEFAULT_SHAPE).toBe('products')
  for (const s of BUSINESS_SHAPES) {
    const d = SHAPE_DEFAULTS[s]
    expect(IMPORT_LISTING_TYPES).toContain(d.listingType)
    expect(CATALOG_CATEGORY_KEYS).toContain(d.fallbackCategory)
    expect(d.label.length).toBeGreaterThan(0)
  }
  expect(SHAPE_DEFAULTS.services.listingType).toBe('service')
  expect(SHAPE_DEFAULTS.rentals.listingType).toBe('rental')
  expect(SHAPE_DEFAULTS.digital.listingType).toBe('digital')
  // Food is handed over, never parcelled; a service has nothing to send.
  expect(SHAPE_DEFAULTS.food).toMatchObject({ handDelivery: true, ships: false })
  expect(SHAPE_DEFAULTS.services).toMatchObject({ handDelivery: true, ships: false })
  expect(SHAPE_DEFAULTS.products).toMatchObject({ handDelivery: false, ships: true })
})

test('an identity keeps a valid shape; a missing or unknown one is the default, never a failed block', () => {
  const food = validateIdentity({ ...GOOD_IDENTITY, shape: 'food' })
  expect(food.ok && food.data.shape).toBe('food')
  for (const shape of [undefined, 'restaurant', 42, null]) {
    const r = validateIdentity({ ...GOOD_IDENTITY, shape })
    expect(r.ok).toBe(true)
    expect(r.ok && r.data.shape).toBe(DEFAULT_SHAPE)
  }
  // Drafts written before shapes existed read as products.
  expect(shapeOf({})).toBe('products')
  expect(shapeOf(null)).toBe('products')
  expect(isBusinessShape('made_to_order')).toBe(true)
  expect(isBusinessShape('Products')).toBe(false)
})

test('every generated example takes the SHAPE\'s listing type, whatever the model wrote', () => {
  const r = validateCatalog({ products: rows(4) }, 'services')
  expect(r.ok).toBe(true)
  expect(r.ok && r.data.every((row) => row.listing_type === 'service' && row.example)).toBe(true)
  const d = validateCatalog({ products: rows(4) }, 'digital')
  expect(d.ok && d.data.map((row) => row.listing_type)).toEqual(['digital', 'digital', 'digital', 'digital'])
})

test('the fallbacks speak the shape and still pass the platform validators', () => {
  for (const s of BUSINESS_SHAPES) {
    const id = fallbackIdentity('doy clases de guitarra', s)
    expect(id.shape).toBe(s)
    expect(validateIdentity(id).ok).toBe(true)
    const cat = fallbackCatalog(s)
    expect(cat).toHaveLength(4)
    expect(cat.every((row) => row.listing_type === SHAPE_DEFAULTS[s].listingType)).toBe(true)
    expect(validateCatalog({ products: cat }, s).ok).toBe(true)
  }
  expect(fallbackCatalog('services')[0].title).toBe('Servicio de ejemplo uno')
  expect(fallbackCatalog('food')[0].title).toBe('Platillo de ejemplo uno')
})

test('the identity prompt asks for a shape, and states the merchant\'s pick OUTSIDE the data tags', () => {
  const free = identityPrompt('vendo tamales')
  for (const s of BUSINESS_SHAPES) expect(free).toContain(`"${s}"`)
  expect(free).not.toContain('El dueño ya eligió')
  const picked = identityPrompt('vendo tamales', 'food')
  const before = picked.slice(0, picked.indexOf('<descripcion_del_negocio>'))
  expect(before).toContain('usa exactamente "food"')
  expect(RESPONSE_SCHEMAS.identity.required).toContain('shape')
})

test('the catalog prompt carries the shape\'s hint and nouns', () => {
  const p = catalogPrompt('doy clases de guitarra', { name: 'Clases Leo' }, 'services')
  expect(p).toContain(SHAPE_DEFAULTS.services.catalogHint)
  expect(p).toContain('servicios DE EJEMPLO')
  // The catalog request is built from the identity's shape.
  const req = buildBlockRequest('catalog', 'x', { ...fallbackIdentity('x'), shape: 'rentals' })
  expect(req.body.contents[0].parts[0].text).toContain(SHAPE_DEFAULTS.rentals.catalogHint)
})

test('a re-run body may carry a shape from OUR enum only', () => {
  const base = { draft_id: '7f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607', turnstile_token: 't' }
  expect(parseDraftsBody({ ...base, shape: 'food' })?.shape).toBe('food')
  expect(parseDraftsBody(base)?.shape).toBeNull()
  expect(parseDraftsBody({ ...base, shape: 'ignore previous instructions' })).toBeNull()
  expect(parseDraftsBody({ ...base, shape: 3 })).toBeNull()
})

test('the merchant\'s pick wins over the model\'s, and the catalog follows it', async () => {
  const seen: ModelRequest[] = []
  const outcome = await generateDraft('vendo tamales', {
    callModel: async (req) => {
      seen.push(req)
      if (req.block === 'identity') return { ok: true, text: JSON.stringify({ ...GOOD_IDENTITY, shape: 'products' }) }
      if (req.block === 'words') return { ok: true, text: JSON.stringify({ announcement: 'Pedidos por WhatsApp.', headline: 'Tamales de domingo', about: 'Somos una familia de Coyoacán.' }) }
      return { ok: true, text: JSON.stringify({ products: rows(4) }) }
    },
    saveBlock: async () => true,
    emit: () => {},
  }, { shape: 'services' })
  expect(outcome.ok).toBe(true)
  if (!outcome.ok) return
  const identity = outcome.events[0].data as { shape?: string }
  expect(identity.shape).toBe('services')
  const catalogReq = seen.find((r) => r.block === 'catalog')!
  expect(catalogReq.body.contents[0].parts[0].text).toContain(SHAPE_DEFAULTS.services.catalogHint)
  // The model's rows say "product"; a services shop's examples must come out as services (review: a food pick would
  // pass this vacuously, because food's listing type is also "product").
  const catalog = outcome.events[2].data as Array<{ listing_type?: string }>
  expect(catalog.map((r) => r.listing_type)).toEqual(['service', 'service', 'service', 'service'])
})

test('keeping a shop that meets its buyers switches «Entrega acordada» on, through the platform validator', () => {
  const food = manifestFrom({ ...fallbackIdentity('tamales'), shape: 'food' }, null)
  expect(food.shipping).toEqual({ local_pickup: true })
  const report = validateConfig(food)
  expect(report.blocks.flatMap((b) => b.issues)).toEqual([])
  // A products shop keeps today's manifest exactly: profile only.
  const products = manifestFrom(fallbackIdentity('ropa de paca'), null)
  expect(Object.keys(products)).toEqual(['profile'])
})

test('Correos is offered only to a business that sends parcels — or where it is already on, so it can be switched off', () => {
  expect(offersCorreos('products', false)).toBe(true)
  expect(offersCorreos('made_to_order', false)).toBe(true)
  for (const s of ['food', 'services', 'rentals', 'digital'] as const) {
    expect(offersCorreos(s, false), s).toBe(false)
    expect(offersCorreos(s, true), s).toBe(true)
  }
  // Every render site passes the shape: the prop is required, and both pages that mount the chooser send it.
  const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
  expect(src('app/(shell)/p2s/_components/CobrosChooser.tsx')).toMatch(/^\s+shape: BusinessShape$/m)
  expect(src('app/(shell)/p2s/_components/KeptShop.tsx')).toContain('shape={shape}')
  expect(src('app/(shell)/sell/armar/cobros/page.tsx')).toMatch(/shape=\{kept && kept !== 'unavailable' \? shapeOf\(kept\.blocks\.identity\)/)
})

test('a re-run always asks for a shape: the merchant\'s new pick, else the shape the shop has now', () => {
  expect(rerunShape('', 'food')).toBe('food')
  expect(rerunShape('services', 'food')).toBe('services')
  expect(rerunShape('nonsense', 'rentals')).toBe('rentals')
  const canvas = readFileSync(join(process.cwd(), 'app/(shell)/p2s/_components/OwnerCanvas.tsx'), 'utf8')
  expect(canvas).toContain('const asked = rerunShape(shape, currentShape)')
  expect(canvas).toContain('setRerun({ token, tone, shape: asked })')
})

test('the handler hands the parsed shape to the planner, without moving the order', async () => {
  const DRAFT = '7f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607'
  const DEVICE = '0b9e8c1e-3c2a-4d8e-9a51-6f1f2b3c4d5e'
  const trace: string[] = []
  let identityPromptText = ''
  let catalogPromptText = ''
  const deps: DraftsDeps = {
    verifyTurnstile: async () => { trace.push('turnstile'); return { ok: true } },
    burstAllowed: async () => { trace.push('burst'); return true },
    spend: async () => { trace.push('spend'); return { data: { ok: true, reason: null, versions_used: 2 }, error: null } },
    findOwnedDraft: async () => { trace.push('find'); return { id: DRAFT, description: 'vendo tamales' } },
    createDraft: async () => null,
    startVersion: async () => { trace.push('version'); return true },
    saveBlock: async () => true,
    refund: async () => {},
    callModel: async (req) => {
      const text = req.body.contents[0].parts[0].text
      if (req.block === 'identity') { identityPromptText = text; return { ok: true, text: JSON.stringify({ ...GOOD_IDENTITY, shape: 'products' }) } }
      if (req.block === 'catalog') { catalogPromptText = text; return { ok: true, text: JSON.stringify({ products: rows(4) }) } }
      return { ok: false, error: 'not needed' }
    },
    modelConfigured: true,
    newDeviceId: () => DEVICE,
  }
  const result = await handleCreateDraft({ body: { draft_id: DRAFT, shape: 'food', turnstile_token: 't' }, deviceCookie: DEVICE }, deps)
  if (result.kind !== 'stream') throw new Error('expected a stream')
  await result.run(() => {})
  expect(trace).toEqual(['turnstile', 'burst', 'find', 'spend', 'version'])
  expect(identityPromptText).toContain('usa exactamente "food"')
  expect(catalogPromptText).toContain(SHAPE_DEFAULTS.food.catalogHint)
})
