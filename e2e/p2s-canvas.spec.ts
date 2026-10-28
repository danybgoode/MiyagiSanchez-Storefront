import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CATALOG_CATEGORY_KEYS } from '../lib/catalog-import'
import { FALLBACK_NOTE } from '../lib/prompt-to-shop/copy'
import { fallbackCatalog, fallbackIdentity, fallbackWords, markExample, type ExampleRow } from '../lib/prompt-to-shop/blocks'
import { ILLUSTRATIONS } from '../lib/prompt-to-shop/illustrations'
import { draftView, type DraftBlocks } from '../lib/prompt-to-shop/view'

// Prompt-to-shop S2.4 — the preview canvas. The properties are the ones the seed's UX contract states: every
// example says EJEMPLO, shows an illustration and a suggested price, and offers nothing to buy.

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const catalog: ExampleRow[] = [
  markExample({ title: 'Tamal de rajas', description: 'Con queso.', price: 1850, category: 'moda' }),
  markExample({ title: 'Docena surtida', price: 30, category: 'otros' }),
  markExample({ title: 'Salsa verde', price: 55, category: 'hogar' }),
  markExample({ title: 'Atole', price: 25, category: 'servicios' }),
]
const full: DraftBlocks = {
  identity: fallbackIdentity('Vendo tamales en Puebla'),
  words: fallbackWords({ name: 'Tamales Puebla' }),
  catalog,
  block_status: { identity: 'ok', words: 'ok', catalog: 'ok' },
}
// Playwright compiles every .tsx it imports with its OWN JSX runtime (elements come out as `{__pw_type…}` objects),
// so a component cannot be rendered with react-dom here. The canvas properties are therefore held two ways: the
// DATA that feeds each card is exercised for real in `p2s-view.spec.ts`, and the component SOURCE is asserted below
// (comments stripped, so prose cannot satisfy or trip a check).

const code = (file: string) =>
  read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const canvas = code('app/(shell)/p2s/_components/ShopCanvas.tsx')
const illustration = code('app/(shell)/p2s/_components/ExampleIllustration.tsx')

test('every example card renders its EJEMPLO tag, an illustration, and a suggested price', () => {
  expect(canvas).toContain('{card.tag}')
  expect(canvas).toContain('<ExampleIllustration name={card.illustration} />')
  expect(canvas).toContain('{card.priceLabel}')
  expect(canvas).toContain('CANVAS_COPY.priceCaption')
  // …and the data feeding them can only ever say EJEMPLO (the type is the literal).
  const view = draftView('d', full)
  expect(view.cards).toHaveLength(4)
  for (const c of view.cards!) expect(c.tag).toBe('EJEMPLO')
})

test('there is NO buy, cart, offer, link or button anywhere in the canvas or its illustration', () => {
  for (const [name, src] of [['ShopCanvas', canvas], ['ExampleIllustration', illustration]] as const) {
    expect(src, name).not.toMatch(/<button|<a[\s>]|<Link|<form|<input|<select|onClick/)
    expect(src, name).not.toMatch(/useCart|AddToCart|BuyButton|MakeOffer|ClosetListingCard|checkout/i)
    expect(src, name).not.toMatch(/Comprar|Agregar|carrito|Ofertar|oferta|Añadir/i)
  }
})

test('the canvas wears the real ShopThemeShell and the real shop-chrome classes', () => {
  expect(canvas).toContain('<ShopThemeShell theme={view.theme} accent={view.accent}>')
  for (const cls of ['shop-header', 'shop-hero', 'shop-hero-title', 'shop-name']) expect(canvas, cls).toContain(cls)
  expect(canvas).toContain('SHOP_INDEX_GRID_CLASS')
})

test('a block that has not landed is a skeleton placeholder, not a spinner', () => {
  expect(canvas).toContain('animate-pulse')
  expect(canvas).toMatch(/view\.cards\s*\?/)
  expect(canvas).toContain('SkeletonCard')
  expect(canvas).not.toMatch(/spinner|Spinner|loading-dots|pending-dot/)
  const empty = draftView('d', { identity: null, words: null, catalog: null, block_status: {} })
  expect(empty.cards).toBeNull()
  expect(empty.pending).toEqual({ identity: true, words: true, catalog: true })
})

test('a fallback note is shown to the owner and withheld from a read-only viewer', () => {
  expect(canvas).toContain("mode === 'viewer' ? [] :")
  expect(canvas).toContain('FALLBACK_NOTE[key]')
  const fb = draftView('d', { ...full, identity: fallbackIdentity('Vendo velas'), catalog: fallbackCatalog(), block_status: { identity: 'fallback', words: 'ok', catalog: 'fallback' } })
  expect(fb.fallback).toEqual({ identity: true, words: false, catalog: true })
  expect(FALLBACK_NOTE.identity).toBe('Usamos un nombre provisional; puedes cambiarlo')
})

test('toolbar controls reach the page for the owner and are dropped for a viewer, whatever a caller passes', () => {
  expect(canvas).toContain("{mode === 'viewer' ? null : toolbar}")
})

test('one drawing per catalog category, flat line art: no photo, no embedded image, no raw colour', () => {
  expect(Object.keys(ILLUSTRATIONS).sort()).toEqual([...CATALOG_CATEGORY_KEYS].sort())
  for (const [key, shapes] of Object.entries(ILLUSTRATIONS)) {
    expect(shapes.length, key).toBeGreaterThan(0)
    for (const d of shapes) expect(d, key).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9\s.,-]+$/)
  }
  const svg = read('app/(shell)/p2s/_components/ExampleIllustration.tsx')
  expect(svg).not.toMatch(/<image|<img|href=|url\(/)
  expect(svg).toContain('stroke="var(--shop-accent')
})

test('the draft pages are dynamic, noindex, and pinned private at the header level too', () => {
  for (const file of ['app/(shell)/p2s/[id]/page.tsx', 'app/(shell)/p2s/v/[token]/page.tsx']) {
    const src = read(file)
    expect(src, file).toContain("export const dynamic = 'force-dynamic'")
    expect(src, file).toContain('robots: { index: false, follow: false }')
  }
  const cfg = read('next.config.ts')
  expect(cfg).toContain("source: '/p2s/:path*'")
  expect(cfg).toMatch(/source: '\/p2s\/:path\*',\s*headers: \[\s*\{ key: 'Cache-Control', value: 'private, no-store' \},\s*\{ key: 'X-Robots-Tag', value: 'noindex, nofollow' \}/)
  // The autosave route answers private too.
  expect(read('app/api/p2s/drafts/[id]/route.ts')).toContain("'Cache-Control': 'private, no-store'")
})

test('not found, not yours and expired all end at ONE friendly page, never a 500', () => {
  const owner = read('app/(shell)/p2s/[id]/page.tsx')
  expect(owner).toContain("if (resolved.kind === 'gone') notFound()")
  const gone = read('app/(shell)/p2s/not-found.tsx')
  expect(gone).toContain('GONE_COPY.action')
  expect(gone).toContain('href="/mx/vende"')
})
