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

import { readableTextOn } from '../platform-theme'
import { resolveTheme } from '../shop-presentation/theme'
import type { ResolvedTheme } from '../shop-presentation/types'
import type { Shop } from '../types'
import type { BlockKey, BlockStatus, ExampleRow, IdentityBlock, IllustrationKey, WordsBlock } from './blocks'

/** The tag every example card carries (epic: an example must never be mistaken for a real product). */
export const EXAMPLE_TAG = 'EJEMPLO'

/** What the canvas needs from a draft row. Blocks are null until they land. */
export interface DraftBlocks {
  identity: IdentityBlock | null
  words: WordsBlock | null
  catalog: ExampleRow[] | null
  block_status: Partial<Record<BlockKey, BlockStatus>>
}

export interface ExampleCardView {
  key: string
  title: string
  description: string
  /** Formatted es-MX, e.g. «$1,850» — a SUGGESTED price, labelled as such by the canvas. */
  priceLabel: string
  illustration: IllustrationKey
  tag: typeof EXAMPLE_TAG
}

export interface CanvasView {
  /** A `Shop`-shaped object for the shell. It is not a real shop: `id` is the draft id and nothing resolves it. */
  shop: Shop
  theme: ResolvedTheme
  accent: string
  accentTextColor: string
  /** The swatches the picker shows: the current accent first, then the three stored alternates (S2.4). */
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
export function formatSuggestedPrice(price: number, currency: string | undefined): string {
  const code = currency === 'USD' ? 'USD' : 'MXN'
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: code, maximumFractionDigits: 0 }).format(price)
}

export function exampleCards(rows: ExampleRow[]): ExampleCardView[] {
  return rows.map((row, i) => ({
    key: `example-${i}`,
    title: row.title,
    description: row.description ?? '',
    priceLabel: formatSuggestedPrice(row.price ?? 0, row.currency),
    illustration: row.illustration,
    tag: EXAMPLE_TAG,
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

export function draftView(draftId: string, draft: DraftBlocks): CanvasView {
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
    accentAlternates: identity ? [identity.accent_color, ...identity.accent_alternates] : [],
    name: identity?.name ?? null,
    tagline: identity?.tagline ?? null,
    description: identity?.description ?? null,
    headline: words?.headline ?? null,
    about: words?.about ?? null,
    announcement: words?.announcement ?? null,
    cards: catalog ? exampleCards(catalog) : null,
    pending: { identity: !identity, words: !words, catalog: !catalog },
    fallback: {
      identity: !!identity && status.identity === 'fallback',
      words: !!words && status.words === 'fallback',
      catalog: !!catalog && status.catalog === 'fallback',
    },
  }
}
