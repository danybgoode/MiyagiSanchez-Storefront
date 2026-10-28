import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fallbackCatalog, fallbackIdentity, fallbackWords, markExample, type ExampleRow, type IdentityBlock, type WordsBlock } from '../lib/prompt-to-shop/blocks'
import { draftView, EXAMPLE_TAG, formatSuggestedPrice, type DraftBlocks } from '../lib/prompt-to-shop/view'
import { resolveTheme } from '../lib/shop-presentation/theme'
import { readableTextOn } from '../lib/platform-theme'

// Prompt-to-shop S2.1 — the draft → view adapter (epic D14). The preview is the real shop, so the adapter must
// feed the REAL theme resolver and the REAL readable-text rule, and must never invent content for a block that
// has not landed.

const DRAFT = '7f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607'

const identity: IdentityBlock = {
  name: 'Tamales La Abuela', tagline: 'Tamales de masa madre', description: 'Hechos a mano.', city: 'Puebla', state: 'Puebla',
  accent_color: '#8a3b12', accent_alternates: ['#1f6f5c', '#2f4b8a', '#6b2f6b'], theme_preset: 'terracota',
}
const words: WordsBlock = { announcement: 'Pedidos con un día de anticipación.', headline: 'Como los de casa', about: 'Somos una familia poblana.' }
const catalog: ExampleRow[] = [
  markExample({ title: 'Tamal de rajas', description: 'Con queso.', price: 1850, category: 'moda' }),
  markExample({ title: 'Docena surtida', price: 30.5, category: 'no-existe' as never }),
]
const full: DraftBlocks = { identity, words, catalog, block_status: { identity: 'ok', words: 'ok', catalog: 'ok' } }

test('the theme is the real resolveTheme fed the live shop settings shape', () => {
  const view = draftView(DRAFT, full)
  expect(view.theme).toEqual(resolveTheme({ theme_preset: 'terracota', theme: { accent_color: '#8a3b12' } }))
  expect(view.theme.preset).toBe('terracota')
  expect(view.accent).toBe('#8a3b12')
  expect(view.accentTextColor).toBe(readableTextOn('#8a3b12'))
})

test('a pale accent gets dark text, a dark accent gets light text (readableTextOn, not a local rule)', () => {
  const pale = draftView(DRAFT, { ...full, identity: { ...identity, accent_color: '#f5e6a8' } })
  const dark = draftView(DRAFT, full)
  expect(pale.accentTextColor).toBe(readableTextOn('#f5e6a8'))
  expect(pale.accentTextColor).not.toBe(dark.accentTextColor)
})

test('words and identity map to the shell props', () => {
  const view = draftView(DRAFT, full)
  expect(view).toMatchObject({
    name: 'Tamales La Abuela', tagline: 'Tamales de masa madre', headline: 'Como los de casa',
    about: 'Somos una familia poblana.', announcement: 'Pedidos con un día de anticipación.',
  })
  expect(view.shop).toMatchObject({ id: DRAFT, name: 'Tamales La Abuela', location: 'Puebla, Puebla', logo_url: null, metadata: null })
  expect(view.accentAlternates).toEqual(['#8a3b12', '#1f6f5c', '#2f4b8a', '#6b2f6b'])
})

test('example cards carry EJEMPLO, an illustration, and an es-MX suggested price', () => {
  const cards = draftView(DRAFT, full).cards!
  expect(cards).toHaveLength(2)
  expect(EXAMPLE_TAG).toBe('EJEMPLO')
  for (const c of cards) expect(c.tag).toBe('EJEMPLO')
  expect(cards[0]).toMatchObject({ title: 'Tamal de rajas', priceLabel: formatSuggestedPrice(1850, undefined), illustration: 'moda' })
  expect(cards[0].priceLabel).toBe('$1,850')
  // An unknown category falls back to the generic illustration instead of a missing one.
  expect(cards[1].illustration).toBe('otros')
  // Whole pesos: a suggestion with cents would read as a quote.
  expect(cards[1].priceLabel).toBe('$31')
  expect(new Set(cards.map((c) => c.key)).size).toBe(2)
})

test('a block that has not landed is a placeholder, never invented content', () => {
  const empty = draftView(DRAFT, { identity: null, words: null, catalog: null, block_status: {} })
  expect(empty.pending).toEqual({ identity: true, words: true, catalog: true })
  expect(empty).toMatchObject({ name: null, headline: null, announcement: null, cards: null })
  expect(empty.shop.name).toBe('')
  expect(empty.theme).toEqual(resolveTheme({}))
  expect(empty.accent).toBe('var(--color-accent)')

  const half = draftView(DRAFT, { identity, words: null, catalog: null, block_status: { identity: 'ok' } })
  expect(half.pending).toEqual({ identity: false, words: true, catalog: true })
  expect(half.name).toBe('Tamales La Abuela')
  expect(half.headline).toBeNull()
})

test('a fallback block is flagged so the canvas can say so; a placeholder is not a fallback', () => {
  const fb = draftView(DRAFT, {
    identity: fallbackIdentity('Vendo velas'), words: fallbackWords({ name: 'Velas' }), catalog: fallbackCatalog(),
    block_status: { identity: 'fallback', words: 'ok', catalog: 'fallback' },
  })
  expect(fb.fallback).toEqual({ identity: true, words: false, catalog: true })
  const none = draftView(DRAFT, { identity: null, words: null, catalog: null, block_status: { identity: 'fallback' } })
  expect(none.fallback.identity).toBe(false)
})

test('the adapter stays pure: no server-only, next/* or Medusa in its module graph', () => {
  const src = readFileSync(join(process.cwd(), 'lib', 'prompt-to-shop', 'view.ts'), 'utf8')
  const imports = src.split('\n').filter((l) => /^import /.test(l)).join('\n')
  expect(imports).toContain("from '../shop-presentation/theme'")
  expect(imports).not.toMatch(/server-only|'next|lib\/medusa|@medusajs/)
})

test('ShopIndexBody renders its grid through the extracted presentational ShopIndexGrid (D14)', () => {
  const body = readFileSync(join(process.cwd(), 'app', '(shell)', '_shop-sections', 'ShopIndexBody.tsx'), 'utf8')
  const grid = readFileSync(join(process.cwd(), 'app', '(shell)', '_shop-sections', 'ShopIndexGrid.tsx'), 'utf8')
  expect(body).toContain('<ShopIndexGrid')
  expect(body).not.toContain('<ClosetListingCard')
  // The grid fetches nothing: listings arrive as props.
  expect(grid).not.toMatch(/getShopListings|getDictionary|fetch\(/)
  expect(grid).toContain('<ClosetListingCard')
})
