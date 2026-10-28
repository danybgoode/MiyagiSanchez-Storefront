/**
 * Prompt-to-shop — the three generated blocks, their validation and their fallbacks (epic D9, D10).
 *
 * The model's output is a SUGGESTION. These functions decide whether it is usable, and the decision always runs
 * through the platform's own validators (`validateConfig`, `validateRows`) rather than a second, local idea of what
 * a valid shop is: a parallel validator is a fork that drifts permissive.
 *
 * Pure: no I/O, no `next/*`, so the `api` spec runner imports it directly.
 */

import { CATALOG_CATEGORY_KEYS, validateRows, type CatalogImportRow } from '../catalog-import'
import { validateConfig, type StoreConfigManifest } from '../settings-import'
import { contrastRatio } from '../platform-theme'
import { THEME_PRESETS } from '../shop-settings/theme-presets'
import type { CategoryKey } from '../types'

export const BLOCK_KEYS = ['identity', 'words', 'catalog'] as const
export type BlockKey = (typeof BLOCK_KEYS)[number]
export type BlockStatus = 'ok' | 'fallback'

export const MAX_DESCRIPTION_CHARS = 500
export const EXAMPLE_ROWS_MIN = 4
export const EXAMPLE_ROWS_MAX = 6

/**
 * An accent must read as text and as a border on a white page. 3:1 is WCAG's floor for large text and UI
 * components; a pale accent the model likes is replaced, never shipped (D10).
 */
export const MIN_ACCENT_CONTRAST_ON_WHITE = 3
const PAGE_WHITE = '#ffffff'
const HEX = /^#[0-9a-fA-F]{6}$/

/** Presets a generated shop may pick. `default` is the picker's "none" option, so it is not a generation target. */
export const GENERATABLE_PRESETS = THEME_PRESETS.map((p) => p.key).filter((k) => k !== 'default')

/**
 * The illustration an example card shows: one per category, never a photo (an example that looks like a real
 * product photo is an example a buyer could mistake for stock). The key IS the category key, so the set can
 * never fall out of step with the catalog's own enum.
 */
export type IllustrationKey = CategoryKey

export interface IdentityBlock {
  name: string
  tagline: string
  description: string
  state?: string
  city?: string
  accent_color: string
  /** Three more accents the canvas offers as one-tap alternates (S2.4). */
  accent_alternates: [string, string, string]
  theme_preset: string
}

export interface WordsBlock {
  /** The announcement bar — `profile.announcement.text`, ≤ 140 characters. */
  announcement: string
  /** The canvas's hero line. Draft-only: the platform hero's promo mode needs an image URL we never invent. */
  headline: string
  about: string
}

/** A draft-only row: `CatalogImportRow` has no example field, and `MiyagiSetupFile` is not widened for it. */
export type ExampleRow = CatalogImportRow & { example: true; illustration: IllustrationKey }

export type BlockData = { identity: IdentityBlock; words: WordsBlock; catalog: ExampleRow[] }

export type BlockParse<K extends BlockKey> = { ok: true; data: BlockData[K] } | { ok: false; issues: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t && t.length <= max ? t : null
}

export function accentIsReadable(hex: unknown): hex is string {
  return typeof hex === 'string' && HEX.test(hex) && contrastRatio(hex, PAGE_WHITE) >= MIN_ACCENT_CONTRAST_ON_WHITE
}

/** The model returns JSON text; a fenced or prose-wrapped object is tolerated, anything else is a failure. */
export function parseModelJson(raw: string): unknown {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    try {
      return JSON.parse(cleaned.slice(start, end + 1))
    } catch {
      return null
    }
  }
}

export function validateIdentity(value: unknown): BlockParse<'identity'> {
  if (!isObj(value)) return { ok: false, issues: ['identity no es un objeto'] }
  const issues: string[] = []
  const name = text(value.name, 60)
  const tagline = text(value.tagline, 120)
  const description = text(value.description, 600)
  if (!name) issues.push('name vacío o > 60')
  if (!tagline) issues.push('tagline vacío o > 120')
  if (!description) issues.push('description vacío o > 600')
  if (!accentIsReadable(value.accent_color)) issues.push('accent_color no es hex legible sobre blanco')
  const alternates = Array.isArray(value.accent_alternates) ? value.accent_alternates : []
  if (alternates.length !== 3 || !alternates.every(accentIsReadable)) {
    issues.push('accent_alternates deben ser 3 hex legibles sobre blanco')
  }
  const preset = typeof value.theme_preset === 'string' ? value.theme_preset : ''
  if (!GENERATABLE_PRESETS.includes(preset)) issues.push('theme_preset desconocido')
  const state = text(value.state, 60) ?? undefined
  const city = text(value.city, 60) ?? undefined
  if (issues.length) return { ok: false, issues }

  const identity: IdentityBlock = {
    name: name!, tagline: tagline!, description: description!, state, city,
    accent_color: value.accent_color as string,
    accent_alternates: alternates as [string, string, string],
    theme_preset: preset,
  }
  // The platform's own validator has the last word on everything it knows how to check.
  const report = validateConfig({ profile: profileOf(identity) })
  const profileIssues = report.blocks.flatMap((b) => b.issues)
  return profileIssues.length ? { ok: false, issues: profileIssues } : { ok: true, data: identity }
}

export function validateWords(value: unknown): BlockParse<'words'> {
  if (!isObj(value)) return { ok: false, issues: ['words no es un objeto'] }
  const issues: string[] = []
  const announcement = text(value.announcement, 140)
  const headline = text(value.headline, 120)
  const about = text(value.about, 800)
  if (!announcement) issues.push('announcement vacío o > 140')
  if (!headline) issues.push('headline vacío o > 120')
  if (!about) issues.push('about vacío o > 800')
  if (issues.length) return { ok: false, issues }
  const report = validateConfig({ profile: { announcement: { text: announcement!, link: null } } })
  const profileIssues = report.blocks.flatMap((b) => b.issues)
  if (profileIssues.length) return { ok: false, issues: profileIssues }
  return { ok: true, data: { announcement: announcement!, headline: headline!, about: about! } }
}

/**
 * Example rows go through `validateRows` exactly as an uploaded catalog does, then get marked. `markExample`
 * drops any image the model sent: the example must show an illustration (D10), and an invented image URL is the
 * one thing `buildSetupPrompt` already forbids.
 */
export function validateCatalog(value: unknown): BlockParse<'catalog'> {
  const rows = isObj(value) && Array.isArray(value.products) ? value.products : Array.isArray(value) ? value : null
  if (!rows) return { ok: false, issues: ['catalog no trae products'] }
  if (rows.length < EXAMPLE_ROWS_MIN) return { ok: false, issues: [`menos de ${EXAMPLE_ROWS_MIN} productos`] }
  const staged = validateRows(rows.slice(0, EXAMPLE_ROWS_MAX))
  const valid = staged.filter((s) => s.valid)
  if (valid.length < EXAMPLE_ROWS_MIN) {
    return { ok: false, issues: staged.filter((s) => !s.valid).flatMap((s) => s.issues.map((i) => `fila ${s.line}: ${i.message}`)) }
  }
  const unpriced = valid.filter((s) => typeof s.row.price !== 'number' || s.row.price <= 0)
  if (unpriced.length) return { ok: false, issues: ['cada ejemplo necesita un precio sugerido'] }
  return { ok: true, data: valid.map((s) => markExample(s.row)) }
}

export function markExample(row: CatalogImportRow): ExampleRow {
  return { ...row, images: [], example: true, illustration: illustrationFor(row.category) }
}

export function illustrationFor(category: unknown): IllustrationKey {
  return (CATALOG_CATEGORY_KEYS as string[]).includes(category as string) ? (category as IllustrationKey) : 'otros'
}

export function validateBlock<K extends BlockKey>(key: K, value: unknown): BlockParse<K> {
  if (key === 'identity') return validateIdentity(value) as BlockParse<K>
  if (key === 'words') return validateWords(value) as BlockParse<K>
  return validateCatalog(value) as BlockParse<K>
}

/** The identity as the platform's `profile` — what S3.2 hands to `planSetupApply` on keep. */
export function profileOf(identity: IdentityBlock, words?: WordsBlock): NonNullable<StoreConfigManifest['profile']> {
  return {
    name: identity.name,
    tagline: identity.tagline,
    description: identity.description,
    ...(identity.state ? { state: identity.state } : {}),
    ...(identity.city ? { city: identity.city } : {}),
    accent_color: identity.accent_color,
    theme_preset: identity.theme_preset,
    ...(words ? { announcement: { text: words.announcement, link: null } } : {}),
  }
}

// ── Fallbacks — deterministic, built only from the description ───────────────────────────────────────────────────
//
// A fallback is what the merchant sees when a block failed twice. It must be valid by the same validators as a
// generated block (a spec asserts it), and it must never pretend to be generated: the stream marks it `fallback`.

const FALLBACK_ACCENTS: [string, string, string, string] = ['#1f6f5c', '#8a3b12', '#2f4b8a', '#6b2f6b']

/** A name from the description's first words, so the fallback shop is still recognisably theirs. */
export function fallbackName(description: string): string {
  const words = description
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/^(vendo|hago|tengo|ofrezco|somos|una|uno|los|las|del|por|para|con)$/i.test(w))
    .slice(0, 3)
  const base = words.length ? words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ') : 'Mi tienda'
  return base.slice(0, 60)
}

export function fallbackIdentity(description: string): IdentityBlock {
  const [accent, ...alternates] = FALLBACK_ACCENTS
  return {
    name: fallbackName(description),
    tagline: 'Hecho con cuidado, listo para ti.',
    description: description.trim().slice(0, 600) || 'Una tienda nueva en Miyagi Sánchez.',
    accent_color: accent,
    accent_alternates: alternates as [string, string, string],
    theme_preset: 'papel',
  }
}

export function fallbackWords(identity: Pick<IdentityBlock, 'name'>): WordsBlock {
  return {
    announcement: 'Pedidos por mensaje: te respondemos el mismo día.',
    headline: `Bienvenido a ${identity.name}`.slice(0, 120),
    about: `${identity.name} es una tienda nueva en Miyagi Sánchez. Escríbenos para pedidos, precios y entregas.`,
  }
}

export function fallbackCatalog(): ExampleRow[] {
  const rows: CatalogImportRow[] = [
    { title: 'Producto de ejemplo uno', description: 'Cambia este ejemplo por tu producto.', price: 150, category: 'otros' },
    { title: 'Producto de ejemplo dos', description: 'Cambia este ejemplo por tu producto.', price: 250, category: 'otros' },
    { title: 'Producto de ejemplo tres', description: 'Cambia este ejemplo por tu producto.', price: 350, category: 'otros' },
    { title: 'Producto de ejemplo cuatro', description: 'Cambia este ejemplo por tu producto.', price: 450, category: 'otros' },
  ]
  return rows.map(markExample)
}
