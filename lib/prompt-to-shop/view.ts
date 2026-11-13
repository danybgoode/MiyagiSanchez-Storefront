/**
 * Prompt-to-shop — draft → view adapter (epic D14).
 *
 * The preview is the REAL shop: the canvas renders inside the real `ShopThemeShell`, with the theme the real
 * `resolveTheme` produces and the accent text colour the real `readableTextOn` picks. This module only maps a
 * draft's three blocks onto those inputs; it invents no styling of its own, so a preset that changes the live shop
 * changes the preview with it.
 *
 * Pure: no I/O, no `next/*`, no `server-only`. A block that has not landed yet (null) maps to a PLACEHOLDER state,
 * never to made-up content: the taking-shape screen is this same view with fewer blocks filled in.
 */

import type { NumbersBlock } from './numbers'
import { readableTextOn } from '../platform-theme'
import { resolveTheme } from '../shop-presentation/theme'
import type { ResolvedTheme } from '../shop-presentation/types'
import type { Shop } from '../types'
import type { BlockKey, BlockStatus, ExampleRow, IdentityBlock, IllustrationKey, WordsBlock } from './blocks'

/** The tag every example card carries (epic: an example must never be mistaken for a real product). */
export const EXAMPLE_TAG = 'EJEMPLO'
/** The same tag in English (one-front-door-both-markets D11). */
export const EXAMPLE_TAG_EN = 'EXAMPLE'

import type { P2sLocale } from './locale'

/** What the canvas needs from a draft row. Blocks are null until they land. */
export interface DraftBlocks {
  identity: IdentityBlock | null
  words: WordsBlock | null
  catalog: ExampleRow[] | null
  /**
   * «Tus números» (business-infrastructure D5). Optional: drafts written before the block existed have no column value,
   * and a draft is "landed" on identity + words + catalog — the numbers never hold back the keep.
   */
  numbers?: NumbersBlock | null
  block_status: Partial<Record<BlockKey, BlockStatus>>
  /** one-front-door-both-markets D9 — the merchant's OWN products from a photo, a file or a store link. */
  seedRows?: SeedRow[] | null
}

/** A seed row as the canvas reads it (the DB holds the validated `CatalogImportRow` shape). */
export interface SeedRow { title: string; price?: number; currency?: string; images?: string[]; description?: string; category?: string }

/**
 * The seed rows still worth offering: none once every title is already one of the shop's products (the upload
 * landed). An unreadable product list (null) offers them all — the importer's external ids make a repeat harmless.
 */
export function pendingSeedRows(rows: readonly SeedRow[] | null | undefined, products: ReadonlyArray<{ title: string }> | null): SeedRow[] {
  if (!rows?.length) return []
  if (!products) return [...rows]
  const have = new Set(products.map((p) => p.title.trim().toLowerCase()))
  return rows.every((r) => have.has(r.title.trim().toLowerCase())) ? [] : [...rows]
}

/** Must match CHUNK_MAX in app/api/sell/import/route.ts (the import page reads the same number). */
export const SEED_IMPORT_CHUNK = 25

/**
 * D9 — the rows `/api/sell/import` receives. The external id is derived from the draft and the row's position, so
 * importing twice UPDATES what the first import made (the importer's own re-upload rule) instead of duplicating it.
 */
export function seedImportRows(
  draftId: string,
  rows: readonly SeedRow[],
  shopCurrency: string,
): Array<SeedRow & { external_id: string; quantity: number; listing_type: string; category: string; currency: string }> {
  // The row's currency is the market HINT the visitor had when the draft started; the shop's is the market they
  // CHOSE. When they differ, a price in the hint's currency would be mislabelled in the shop's (US$95 → MX$95), so
  // the price is dropped and the merchant sets it — never converted, never relabelled (fresh review, PR #498).
  return rows.map((r, i) => ({
    ...r,
    currency: shopCurrency,
    ...(r.currency && r.currency !== shopCurrency ? { price: undefined } : {}),
    category: r.category ?? 'otros',
    listing_type: 'product',
    quantity: 1,
    external_id: `p2s-${draftId.slice(0, 8)}-${i + 1}`,
  }))
}

/** The merchant's own rows as cards: never «EJEMPLO», shown before the examples, «not published yet». */
export function seedCards(rows: readonly SeedRow[] | null | undefined, locale: P2sLocale = 'es'): OwnProductCardView[] {
  return (rows ?? []).map((r, i) => ({
    id: `seed-${i}`,
    title: r.title,
    priceLabel: typeof r.price === 'number' ? formatSuggestedPrice(r.price, r.currency, locale) : null,
    imageUrl: r.images?.[0] ?? null,
    published: false,
  }))
}

export interface ExampleCardView {
  key: string
  /** Position in the draft's `catalog` — with the title, what «Cambiar por mi foto» says it replaces (S4.3). */
  index: number
  title: string
  description: string
  /** Formatted es-MX, e.g. «$1,850» — a SUGGESTED price, labelled as such by the canvas. */
  priceLabel: string
  illustration: IllustrationKey
  tag: typeof EXAMPLE_TAG | typeof EXAMPLE_TAG_EN
}

export interface CanvasView {
  /** A `Shop`-shaped object for the shell. It is not a real shop: `id` is the draft id and nothing resolves it. */
  shop: Shop
  theme: ResolvedTheme
  accent: string
  accentTextColor: string
  /**
   * The swatches the picker shows: the current accent plus the three stored alternates, SORTED. Picking one swaps it
   * with the old accent in storage (PATCH), so the set never changes and a stable order keeps the picker from jumping.
   */
  accentAlternates: string[]
  name: string | null
  tagline: string | null
  description: string | null
  headline: string | null
  about: string | null
  announcement: string | null
  /** Null until the catalog block lands. */
  cards: ExampleCardView[] | null
  /** Which blocks have not landed — the canvas shows a placeholder for each. */
  pending: Record<BlockKey, boolean>
  /** Which blocks are a deterministic fallback — the canvas says so plainly. */
  fallback: Record<BlockKey, boolean>
}

const DEFAULT_ACCENT = 'var(--color-accent)'

/** «$1,850» — whole pesos for a suggestion; cents on an example price would read as a quote. */
export function formatSuggestedPrice(price: number, currency: string | undefined, locale: P2sLocale = 'es'): string {
  const code = currency === 'USD' ? 'USD' : 'MXN'
  return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'es-MX', { style: 'currency', currency: code, maximumFractionDigits: 0 }).format(price)
}

export function exampleCards(rows: ExampleRow[], locale: P2sLocale = 'es'): ExampleCardView[] {
  return rows.map((row, i) => ({
    key: `example-${i}`,
    index: i,
    title: row.title,
    description: row.description ?? '',
    priceLabel: formatSuggestedPrice(row.price ?? 0, row.currency, locale),
    illustration: row.illustration,
    tag: locale === 'en' ? EXAMPLE_TAG_EN : EXAMPLE_TAG,
  }))
}

function shopFor(draftId: string, identity: IdentityBlock | null): Shop {
  return {
    id: draftId,
    slug: 'vista-previa',
    name: identity?.name ?? '',
    description: identity?.description ?? null,
    location: [identity?.city, identity?.state].filter(Boolean).join(', ') || null,
    logo_url: null,
    clerk_user_id: null,
    verified: false,
    source: null,
    source_url: null,
    metadata: null,
    created_at: '',
    custom_domain: null,
    custom_domain_verified: false,
    custom_domain_vercel_ok: false,
  }
}

export function draftView(draftId: string, draft: DraftBlocks, locale: P2sLocale = 'es'): CanvasView {
  const { identity, words, catalog, block_status: status } = draft
  // The exact settings shape the live shop feeds `resolveTheme`: ONE preset field, and the accent beside it.
  const settings: Record<string, unknown> = identity
    ? { theme_preset: identity.theme_preset, theme: { accent_color: identity.accent_color } }
    : {}
  const accent = identity?.accent_color ?? DEFAULT_ACCENT
  return {
    shop: shopFor(draftId, identity),
    theme: resolveTheme(settings),
    accent,
    accentTextColor: readableTextOn(identity?.accent_color),
    accentAlternates: identity ? [identity.accent_color, ...identity.accent_alternates].sort() : [],
    name: identity?.name ?? null,
    tagline: identity?.tagline ?? null,
    description: identity?.description ?? null,
    headline: words?.headline ?? null,
    about: words?.about ?? null,
    announcement: words?.announcement ?? null,
    cards: catalog ? exampleCards(catalog, locale) : null,
    pending: { identity: !identity, words: !words, catalog: !catalog, numbers: !draft.numbers },
    fallback: {
      identity: !!identity && status.identity === 'fallback',
      words: !!words && status.words === 'fallback',
      catalog: !!catalog && status.catalog === 'fallback',
      numbers: !!draft.numbers && status.numbers === 'fallback',
    },
  }
}

/** One of the merchant's OWN products on the kept-shop canvas (S4.2/S4.3): a real Medusa product, never an example. */
export interface OwnProductCardView {
  id: string
  title: string
  priceLabel: string | null
  imageUrl: string | null
  published: boolean
}

export function ownProductCards(listings: Array<{ id: string; title: string; price_cents: number | null; currency: string | null; status: string; images?: Array<{ url: string }> }>, locale: P2sLocale = 'es'): OwnProductCardView[] {
  return listings.map((l) => ({
    id: l.id,
    title: l.title,
    priceLabel: typeof l.price_cents === 'number' ? formatSuggestedPrice(l.price_cents / 100, l.currency ?? undefined, locale) : null,
    imageUrl: l.images?.[0]?.url ?? null,
    // The seller listing projects Medusa `published` as `active` (backend `_utils/listing.ts`).
    published: l.status === 'active',
  }))
}
