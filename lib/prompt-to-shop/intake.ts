/**
 * Start a shop from what the merchant already has — a photo, a catalog file or their old store's link
 * (epic one-front-door-both-markets D6–D9). Pure: no I/O, no `next/*`; the routes and `intake-server.ts` do the I/O.
 *
 * Every intake ends the same way: a `description` (what the builder's generation reads) and, when the source had
 * real products, `seed_rows` — the merchant's OWN products, which ride on the draft and are imported into the shop
 * through the existing `/api/sell/import` after the claim (D9). An intake never creates a draft and never calls the
 * builder's generation: the visitor sees what came back, then the same `POST /api/p2s/drafts` runs, and THAT is
 * where the screen (D2) judges the description and the rows' titles before any generation budget is spent.
 *
 * What costs money here: the photo (Gemini vision) and a PDF (Gemini reads it). Both spend ONE signed-out AI intake
 * per device and a share of a separate daily budget FIRST (`ANON_INTAKE` below, D6). CSV, XLSX and
 * links are parsed in code and cost nothing.
 */

import { validateRows, type CatalogImportRow, type ImportCurrency } from '../catalog-import'
import { isPublicDomainShape } from '../ssrf-guard'
import type { ShopifyUcpProduct } from '../shopify-mcp-client'
import type { P2sLocale } from './locale'

/** D9: what a draft may carry. The DB check (`shop_drafts_seed_rows_check`) holds the same 60. */
export const SEED_ROWS_MAX = 60
export const INTAKE_FILE_MAX_BYTES = 5 * 1024 * 1024
export const INTAKE_PAGE_MAX_BYTES = 1024 * 1024
export const INTAKE_FETCH_TIMEOUT_MS = 5_000
export const INTAKE_MAX_REDIRECTS = 2

/**
 * D6: one signed-out AI intake (photo OR pdf) per device, ever; a platform day of them, overridable by env.
 *
 * The KINDS are existing ones on purpose: `ai_allowance_kind_check` allows only version · photo · daily_budget ·
 * chat_month (the DB is the contract — a new kind failed CLOSED against it on 2026-11-12). The SUBJECTS are this
 * intake's own, so neither count can be confused with a signed-in merchant's photos or the generation budget.
 */
export const ANON_INTAKE = {
  perDevice: 1,
  dailyBudgetDefault: 100,
  kind: 'photo',
  budgetKind: 'daily_budget',
  deviceSubject: (deviceId: string) => `intake-device:${deviceId}`,
  budgetSubject: 'global:anon_intake',
} as const

export function resolveAnonIntakeBudget(raw: string | undefined): number {
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isSafeInteger(n) && n >= 1 ? n : ANON_INTAKE.dailyBudgetDefault
}

export type IntakeKind = 'photo' | 'file' | 'url'

export interface IntakeResult {
  description: string
  seedRows: CatalogImportRow[]
  /** The source's own shop name when it had one (a Shopify or Big Cartel store, a page title). */
  sourceName: string | null
}

// ── Seed rows ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Anything → the rows a draft may carry. Re-validated server-side every time (never trust the client, the same rule
 * `validateRows` states): only VALID rows, at most 60, images only absolute https URLs, prices whole and positive or
 * absent. The currency is set by the caller's market, never by the row.
 */
export function sanitizeSeedRows(raw: unknown, currency: ImportCurrency): CatalogImportRow[] {
  if (!Array.isArray(raw)) return []
  const staged = validateRows(raw.slice(0, SEED_ROWS_MAX * 2))
  const rows: CatalogImportRow[] = []
  for (const s of staged) {
    if (!s.valid) continue
    const images = (s.row.images ?? []).filter((u) => typeof u === 'string' && /^https:\/\//i.test(u)).slice(0, 4)
    const price = typeof s.row.price === 'number' && Number.isFinite(s.row.price) && s.row.price > 0 ? Math.round(s.row.price * 100) / 100 : undefined
    rows.push({
      title: s.row.title,
      ...(s.row.description ? { description: s.row.description.slice(0, 2000) } : {}),
      ...(price !== undefined ? { price } : {}),
      currency,
      category: s.row.category,
      listing_type: s.row.listing_type ?? 'product',
      quantity: s.row.quantity ?? 1,
      ...(images.length ? { images } : {}),
    })
    if (rows.length >= SEED_ROWS_MAX) break
  }
  return rows
}

/**
 * The text the screen judges for a draft that carries rows: the description plus EVERY row's title. Every row a
 * draft can carry is a product the merchant can later upload, so screening only the first few would let a list hide
 * its prohibited items past position 15 (security lens, PR #498). 60 titles × 100 chars stays under SCREEN_MAX_CHARS.
 */
export function screenTextFor(description: string, rows: readonly CatalogImportRow[]): string {
  const titles = rows.slice(0, SEED_ROWS_MAX).map((r) => r.title).join('; ')
  return titles ? `${description}\n${titles}` : description
}

/**
 * A description written in CODE from rows, for the builder's generation to read (a file or a store has no sentence).
 * Short on purpose (≤ 500, the box's own limit): the identity block needs the gist, not the catalog.
 */
export function describeFromRows(rows: readonly CatalogImportRow[], locale: P2sLocale, sourceName: string | null): string {
  const titles = rows.slice(0, 6).map((r) => r.title)
  const n = rows.length
  const name = sourceName ? sourceName.replace(/\s+/g, ' ').trim().slice(0, 80) : null
  const lead = locale === 'en'
    ? `${name ? `${name}: ` : ''}a shop with ${n} product${n === 1 ? '' : 's'}`
    : `${name ? `${name}: ` : ''}una tienda con ${n} producto${n === 1 ? '' : 's'}`
  const list = titles.join(', ')
  return `${lead}${list ? `, ${locale === 'en' ? 'such as' : 'como'} ${list}` : ''}.`.slice(0, 500)
}

// ── Files ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type FileKind = 'csv' | 'json' | 'xlsx' | 'pdf'

/** By extension first (browsers send `application/octet-stream` for half of these), then by MIME. */
export function fileKindOf(name: string, mime: string): FileKind | null {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return 'csv'
  if (ext === 'json') return 'json'
  if (ext === 'xlsx' || ext === 'xls') return 'xlsx'
  if (ext === 'pdf') return 'pdf'
  const m = mime.toLowerCase()
  if (m === 'text/csv' || m === 'text/tab-separated-values' || m === 'text/plain') return 'csv'
  if (m === 'application/json') return 'json'
  if (m.includes('spreadsheetml') || m === 'application/vnd.ms-excel') return 'xlsx'
  if (m === 'application/pdf') return 'pdf'
  return null
}

// ── Links ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type LinkPlan =
  | { kind: 'shopify'; domain: string }
  | { kind: 'bigcartel'; origin: string }
  | { kind: 'page'; url: string }

/**
 * A pasted link → what to do with it, or null for anything that is not a public https/http web address.
 * Shopify is recognised by its `*.myshopify.com` host; any other storefront is read as a page (its title and
 * description). Mercado Libre needs OAuth, so a pasted ML link is a page too (D8).
 */
export function planLink(input: string): LinkPlan | null {
  const raw = input.trim()
  if (!raw || raw.length > 2048) return null
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password) return null
  const host = url.hostname.toLowerCase()
  if (!isPublicDomainShape(host)) return null
  if (url.port && url.port !== '443' && url.port !== '80') return null
  if (host.endsWith('.myshopify.com')) return { kind: 'shopify', domain: host }
  if (host.endsWith('.bigcartel.com')) return { kind: 'bigcartel', origin: `https://${host}` }
  return { kind: 'page', url: url.toString() }
}

const NAMED: Record<string, string> = {
  nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', middot: '·', bull: '•',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í',
  Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', uuml: 'ü', copy: '©', reg: '®', trade: '™', iexcl: '¡', iquest: '¿',
}

/** A stranger's page can carry `&#99999999;`: `String.fromCodePoint` throws on it (security lens, PR #498). */
function safeCodePoint(n: number, original: string): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : original
}

function decodeEntities(s: string): string {
  return s
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => (name in NAMED ? NAMED[name] : m))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeCodePoint(parseInt(h, 16), m))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => safeCodePoint(Number(d), m))
}

function metaContent(html: string, key: string): string | null {
  // Attribute order varies: <meta name="description" content="…"> or <meta content="…" property="og:description">.
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*>`, 'i')
  const tag = html.match(re)?.[0]
  const content = tag?.match(/content=["']([^"']*)["']/i)?.[1]
  return content ? decodeEntities(content).replace(/\s+/g, ' ').trim() || null : null
}

/** A page's own words about itself: its title and description (OpenGraph first — shops set those for sharing). */
export function readPageMeta(html: string): { title: string | null; description: string | null } {
  const head = html.slice(0, 200_000)
  const titleTag = head.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]
  const title = metaContent(head, 'og:title') ?? (titleTag ? decodeEntities(titleTag).replace(/\s+/g, ' ').trim() || null : null)
  const description = metaContent(head, 'og:description') ?? metaContent(head, 'description')
  return { title: title ? title.slice(0, 120) : null, description: description ? description.slice(0, 400) : null }
}

/** The description a page link gives the builder. Null when the page says nothing about itself. */
export function describeFromPage(meta: { title: string | null; description: string | null }): string | null {
  // A title is often «– Shop name» or «Home | Shop»: strip the separators a template leaves at either end.
  const tidy = (t: string | null) => (t ? t.replace(/^[\s–—|·:-]+|[\s–—|·:-]+$/g, '').trim() || null : null)
  const parts = [tidy(meta.title), meta.description].filter((p): p is string => !!p)
  if (!parts.length) return null
  return parts.join(' — ').slice(0, 500)
}

function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** Shopify's UCP products → rows. Price from the range minimum (major units), the first media as the cover. */
export function shopifyRows(products: readonly ShopifyUcpProduct[]): Record<string, unknown>[] {
  return products.slice(0, SEED_ROWS_MAX * 2).map((p) => {
    const desc = typeof p.description === 'string' ? p.description : p.description?.plain ?? (p.description?.html ? plainText(p.description.html) : '')
    const amount = p.price_range?.min?.amount
    const price = typeof amount === 'number' ? amount : typeof amount === 'string' ? Number(amount) : undefined
    const image = (p.media ?? []).find((m) => m?.url && (!m.type || m.type.toLowerCase().includes('image')))?.url
    return {
      title: p.title ?? '',
      description: desc,
      ...(price !== undefined && Number.isFinite(price) ? { price } : {}),
      category: 'otros',
      ...(image ? { images: [image] } : {}),
    }
  })
}

/**
 * A Shopify storefront's public `/products.json` → rows. Every Shopify shop serves it (custom domain or
 * `*.myshopify.com`) unless the owner disabled it, and it needs no app or token — measured 2026-11-12, while the
 * UCP `search_catalog` endpoint the migration connector uses answered «Missing profile uri» to an anonymous agent.
 * Null when the JSON is not Shopify's shape (a 404 page, another platform), so the caller falls back to the page.
 */
export function shopifyJsonRows(json: unknown): Record<string, unknown>[] | null {
  const products = (json as { products?: unknown } | null)?.products
  if (!Array.isArray(products)) return null
  return products.slice(0, SEED_ROWS_MAX * 2).map((p) => {
    const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>
    const variants = Array.isArray(o.variants) ? (o.variants as Array<{ price?: unknown }>) : []
    const price = Number(variants[0]?.price)
    const images = Array.isArray(o.images) ? (o.images as Array<{ src?: unknown }>).map((i) => (typeof i?.src === 'string' ? i.src : null)).filter(Boolean) : []
    return {
      title: typeof o.title === 'string' ? o.title : '',
      description: typeof o.body_html === 'string' ? plainText(o.body_html).slice(0, 2000) : '',
      ...(Number.isFinite(price) && price > 0 ? { price } : {}),
      category: 'otros',
      ...(images.length ? { images: images.slice(0, 4) } : {}),
    }
  })
}

/** Big Cartel's public `/products.json` → rows (it has no admin export; the landing page says the same). */
export function bigCartelRows(json: unknown): Record<string, unknown>[] {
  if (!Array.isArray(json)) return []
  return json.slice(0, SEED_ROWS_MAX * 2).map((p) => {
    const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>
    const images = Array.isArray(o.images) ? (o.images as Array<{ url?: unknown }>).map((i) => (typeof i?.url === 'string' ? i.url : null)).filter(Boolean) : []
    return {
      title: typeof o.name === 'string' ? o.name : '',
      description: typeof o.description === 'string' ? plainText(o.description) : '',
      ...(typeof o.price === 'number' ? { price: o.price } : typeof o.default_price === 'number' ? { price: o.default_price } : {}),
      category: 'otros',
      ...(images.length ? { images: images.slice(0, 4) } : {}),
    }
  })
}

/** Resolve a redirect's Location against the URL that sent it; null for anything that is not a plain web address. */
export function nextHop(current: string, location: string | null): string | null {
  if (!location) return null
  try {
    const next = new URL(location, current)
    if (next.protocol !== 'https:' && next.protocol !== 'http:') return null
    // The same door as `planLink`: a redirect must not reach a port or carry credentials the first URL could not
    // (security lens, PR #498 — a 443 page redirecting to :9000 or :6379 on a public host).
    if (next.username || next.password) return null
    if (next.port && next.port !== '443' && next.port !== '80') return null
    if (!isPublicDomainShape(next.hostname)) return null
    return next.toString()
  } catch {
    return null
  }
}

/** The file picker's `accept` (kept here, out of the screens, so the copy guard never reads file-type words). */
export const INTAKE_FILE_ACCEPT = '.csv,.tsv,.txt,.json,.xlsx,.xls,.pdf,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel'
export const INTAKE_PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/avif'

/**
 * Read at most `max` bytes, counting AS IT READS (fresh review, PR #498): checking the size after `arrayBuffer()`
 * would let one link make the server hold a stranger's multi-hundred-MB body. A declared length over the cap is
 * refused before reading anything; a body that grows past it is cancelled mid-stream.
 */
export async function readCappedBody(body: ReadableStream<Uint8Array> | null, contentLength: string | null, max: number): Promise<Uint8Array | null> {
  const declared = Number(contentLength ?? '')
  if (Number.isFinite(declared) && declared > max) { await body?.cancel().catch(() => {}); return null }
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) { await reader.cancel().catch(() => {}); return null }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.byteLength }
  return out
}

/** What a spreadsheet may expand to before we parse it (Codex security, PR #498): a 5 MB upload can be a zip bomb. */
export const XLSX_MAX_UNCOMPRESSED = 40 * 1024 * 1024

/**
 * The total UNCOMPRESSED size an .xlsx (a zip) declares in its central directory, or null when it is not a readable
 * zip. Read from the end-of-central-directory record; never inflates anything. A declared size can lie, so the parse
 * that follows is ALSO bounded (`sheetRows`) — this refuses the honest-but-huge and the obviously hostile cheaply.
 */
export function zipDeclaredUncompressedSize(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const minEocd = 22
  if (bytes.byteLength < minEocd) return null
  let eocd = -1
  for (let i = bytes.byteLength - minEocd; i >= Math.max(0, bytes.byteLength - minEocd - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return null
  const entries = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)
  let total = 0
  for (let n = 0; n < entries; n++) {
    if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== 0x02014b50) return null
    const size = view.getUint32(at + 24, true)
    if (size === 0xffffffff) return Number.POSITIVE_INFINITY // zip64: refuse rather than read a second format
    total += size
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
  }
  return total
}
