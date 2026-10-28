import { expect, test } from '@playwright/test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { coerceBlocks } from '../lib/prompt-to-shop/access'
import { fallbackCatalog, fallbackIdentity, fallbackWords } from '../lib/prompt-to-shop/blocks'
import { CHECKLIST_LABELS, PHOTO_COPY } from '../lib/prompt-to-shop/copy'
import { publishState } from '../lib/prompt-to-shop/photo'
import { draftView, ownProductCards } from '../lib/prompt-to-shop/view'
import { getSetupSteps, type ShopRow } from '../lib/setup-guide'
import { GUIDE_SHOP_COLUMNS, guideProductCount, guideProgress, guideStepsFor } from '../lib/setup-guide-source'

// Prompt-to-shop S4.1 / S4.3 — the kept-shop checklist is Resumen's guide (D17), «Publicar» says why it is off, and
// examples stay out of every public surface.

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const RESUMEN = 'app/(shell)/shop/manage/page.tsx'
const ARMAR = 'app/(shell)/sell/armar/page.tsx'

const bare: ShopRow = { name: 'Velas Luz', description: null, metadata: null, mp_enabled: true, custom_domain: null, ucp_webhook_url: null }
const ROWS: ShopRow[] = [
  bare,
  { ...bare, description: 'Velas de soya hechas a mano.' },
  { ...bare, description: 'x', metadata: { settings: { mercadopago: { connected: true }, shipping: { local_pickup: true } } } },
  { ...bare, description: 'x', metadata: { settings: { checkout: { bank_transfer: { clabe: '002180700000000000' } }, guide: { share_done: true } } } },
  { ...bare, metadata: { settings: { stripe: { charges_enabled: true }, guide: { share_done: 'yes' } } } },
]

/** Resumen's numbers exactly as Resumen has always derived them: its page's inputs and SetupGuideCard's arithmetic. */
function resumenNumbers(row: ShopRow, productCount: number) {
  const guide = (row.metadata as { settings?: { guide?: { share_done?: boolean } } } | null)?.settings?.guide
  const steps = getSetupSteps({ shop: row, productCount, shareDone: !!guide?.share_done })
  const doneCount = steps.filter((s) => s.done).length
  return { doneCount, total: steps.length, width: (doneCount / steps.length) * 100 }
}

test('checklist parity: the canvas shows Resumen\'s % for the same shop row and product count', () => {
  let compared = 0
  for (const row of ROWS) {
    for (const productCount of [0, 1, 7]) {
      const resumen = resumenNumbers(row, productCount)
      const canvas = guideProgress(guideStepsFor(row, productCount))
      expect(canvas.done, `${JSON.stringify(row.metadata)} × ${productCount}`).toBe(resumen.doneCount)
      expect(canvas.total).toBe(resumen.total)
      expect(canvas.percent).toBe(Math.round(resumen.width))
      compared++
    }
  }
  expect(compared).toBe(ROWS.length * 3)
  // Not vacuous: the fixtures span the range.
  const percents = new Set(ROWS.map((r) => guideProgress(guideStepsFor(r, 1)).percent))
  expect(percents.size).toBeGreaterThan(2)
})

test('both surfaces load the guide through the SAME calls — the row read, the step builder and the product count', () => {
  for (const file of [RESUMEN, ARMAR]) {
    const src = read(file)
    expect(src, file).toMatch(/fetchGuideShop\(/)
    expect(src, file).toMatch(/guideStepsFor\(/)
    expect(src, file).toMatch(/guideProductCount\(/)
    expect(src, file).toMatch(/fetchDeletedListingIds\(/)
    // Neither builds its own copy of the guide input any more.
    expect(src, file).not.toMatch(/getSetupSteps\(/)
    expect(src, file).not.toMatch(/name, description, metadata, mp_enabled/)
  }
  expect(read('lib/setup-guide-server.ts')).toContain('GUIDE_SHOP_COLUMNS')
  expect(GUIDE_SHOP_COLUMNS).toBe('name, description, metadata, mp_enabled, custom_domain, ucp_webhook_url')
  // Resumen's card still draws its bar the way resumenNumbers() above mirrors.
  expect(read('app/(shell)/shop/manage/SetupGuideCard.tsx')).toContain('(doneCount / steps.length) * 100')
})

test('the product count is the seller\'s products minus the mirror-deleted ones', () => {
  expect(guideProductCount([{ id: 'a' }, { id: 'b' }, { id: 'c' }], new Set(['b']))).toBe(2)
  expect(guideProductCount([], new Set())).toBe(0)
})

test('the checklist is getSetupSteps unchanged: five ids, canvas labels Fotos · Cobros · Entregas, no «publicar» step', () => {
  const ids = getSetupSteps({ shop: bare, productCount: 0, shareDone: false }).map((s) => s.id)
  expect(ids).toEqual(['perfil', 'catalogo', 'pagos', 'envios', 'comparte'])
  expect(Object.keys(CHECKLIST_LABELS).sort()).toEqual([...ids].sort())
  expect(CHECKLIST_LABELS).toMatchObject({ catalogo: 'Fotos', pagos: 'Cobros', envios: 'Entregas' })
  expect(ids).not.toContain('publicar' as never)
  expect(guideStepsFor(null, 3)).toEqual([])
  expect(guideProgress([])).toEqual({ done: 0, total: 0, percent: 0 })
})

test('«Publicar» is disabled with its reason until one real product exists, and an unread count is not zero', () => {
  expect(publishState(0)).toEqual({ enabled: false, reason: 'Agrega al menos un producto tuyo' })
  expect(PHOTO_COPY.publishNeedsProduct).toBe('Agrega al menos un producto tuyo')
  expect(publishState(null)).toEqual({ enabled: false, reason: PHOTO_COPY.publishUnknown })
  expect(publishState(1)).toEqual({ enabled: true, href: '/shop/manage/catalogo' })
  // Examples never count: the page feeds publishState the Medusa product list, not the draft's catalog.
  expect(read(ARMAR)).toMatch(/publishState\(own \? own\.length : null\)/)
})

test('a kept draft whose examples were all replaced shows no examples — not a catalog still shaping', () => {
  const identity = fallbackIdentity('Velas de soya en Guadalajara')
  const blocks = coerceBlocks({ identity, words: fallbackWords(identity), catalog: [], block_status: { identity: 'ok', words: 'ok', catalog: 'ok', photo_confirms: {} } })
  expect(blocks.catalog).toEqual([])
  const view = draftView('d', blocks)
  expect(view.pending.catalog).toBe(false)
  expect(view.cards).toEqual([])
  // The ledger key does not leak into the block statuses.
  expect(Object.keys(blocks.block_status).sort()).toEqual(['catalog', 'identity', 'words'])
  // A never-generated catalog is still pending.
  expect(draftView('d', coerceBlocks({ identity, words: null, catalog: null, block_status: {} })).pending.catalog).toBe(true)
  // Each example card carries its position, which «Cambiar por mi foto» sends with its title.
  expect(draftView('d', coerceBlocks({ identity, words: null, catalog: fallbackCatalog(), block_status: {} })).cards?.map((c) => c.index)).toEqual([0, 1, 2, 3])
})

test('own product cards read Medusa\'s projection: `active` is published, anything else is not', () => {
  const cards = ownProductCards([
    { id: 'p1', title: 'Vela', price_cents: 18000, currency: 'MXN', status: 'draft', images: [{ url: 'https://x/a.jpg' }] },
    { id: 'p2', title: 'Jabón', price_cents: null, currency: null, status: 'active' },
  ])
  expect(cards[0]).toMatchObject({ published: false, imageUrl: 'https://x/a.jpg' })
  expect(cards[0].priceLabel).toMatch(/180/)
  expect(cards[1]).toMatchObject({ published: true, imageUrl: null, priceLabel: null })
})

// ── Examples never reach a public surface (S4.3) ─────────────────────────────────────────────────────────────────

function filesBelow(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`
    if (name === 'node_modules' || name.startsWith('.')) return []
    return statSync(join(ROOT, rel)).isDirectory() ? filesBelow(rel) : /\.(ts|tsx|mjs|js)$/.test(name) ? [rel] : []
  })
}

const PUBLIC_SURFACE = /sitemap|robots|search|marketplace|(^|\/)catalog|ucp|feed|merchant-center|llms|\/mx\/l\/|\/l\/\[|explorar|browse/i
/** The only modules that may read `shop_drafts`: the prompt-to-shop rail itself. */
const DRAFT_READERS = new Set([
  'lib/prompt-to-shop/read.ts',
  'lib/prompt-to-shop/server.ts',
  'lib/prompt-to-shop/claim-server.ts',
  'lib/prompt-to-shop/photo-server.ts',
  // S5.4: the nudge cron reads kept drafts and records which reminders went (`block_status.nudges`).
  'lib/prompt-to-shop/nudges-server.ts',
])

test('no marketplace, search or sitemap module reads shop_drafts — and only the prompt-to-shop rail does at all', () => {
  const files = ['app', 'lib', 'components'].flatMap(filesBelow)
  const publicFiles = files.filter((f) => PUBLIC_SURFACE.test(f))
  // Not vacuous: the sweep really saw the public surfaces it guards.
  expect(files.length).toBeGreaterThan(500)
  expect(publicFiles).toContain('app/sitemap.ts')
  expect(publicFiles.some((f) => f.startsWith('app/api/ucp/'))).toBe(true)
  expect(publicFiles.some((f) => /search/i.test(f))).toBe(true)
  expect(publicFiles.length).toBeGreaterThan(20)

  // A READ is a query on the table (a comment that names it is not); the RPCs that touch it live in server.ts.
  const readers = files.filter((f) => /\.from\(\s*['"`]shop_drafts['"`]/.test(read(f)))
  expect(readers.filter((f) => PUBLIC_SURFACE.test(f))).toEqual([])
  expect(readers.filter((f) => !DRAFT_READERS.has(f))).toEqual([])
  // …and the allow-list is real, not stale.
  expect(readers.sort()).toEqual([...DRAFT_READERS].sort())
})
