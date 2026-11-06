/**
 * lib/promoter-file-import.ts — what a platform export lacks, filled before validation (promoter-panel D3). Pure.
 *
 * - A WooCommerce file lists each variation as its own row (`Type` = variation) under its parent; those rows are
 *   dropped, so a shirt in three sizes is one product, not four.
 * - Platform categories («Ropa > Camisas») are never Miyagi Sánchez category keys, so a row whose category isn't one
 *   takes the shop's «Categoría principal» (`defaultCategory`). With no default it stays as it is and the validator
 *   rejects it — never a guessed category.
 * - Descriptions arrive as HTML (WooCommerce, Tiendanube); the tags are removed and entities decoded to plain text.
 * - Tiendanube repeats a product's row for each variant; only the first row per name is kept.
 */
import { CATALOG_CATEGORY_KEYS } from './catalog-import'

/** WooCommerce product types: a «Tipo»/«Type» column holds these, never one of our listing types. */
const WOO_TYPES = new Set(['simple', 'variable', 'variation', 'grouped', 'external', 'variación', 'variacion'])

/**
 * HTML → plain text. Tags are removed, entities decoded (`&amp;` LAST, so `&amp;lt;` stays the text "&lt;", never a
 * "<"), and any `<` or `>` left after decoding is dropped, so no markup can survive (CodeQL, #480: decoding after
 * stripping turned `&lt;script&gt;` into a literal tag, and a nested `<scr<x>ipt>` survived one pass).
 */
export function stripHtml(input: string): string {
  return input
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;|&gt;/g, '')
    .replace(/&amp;/g, '&')
    .replace(/[<>]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The key that says two rows are the SAME product: Tiendanube's «Identificador de URL», then the row's own id, then
 *  its name. Collapsing by name alone dropped distinct products that share one (Codex, #480). */
function productKey(r: Record<string, unknown>): string {
  for (const k of ['identificador_de_url', 'external_id', 'title']) {
    const v = typeof r[k] === 'string' ? (r[k] as string).trim().toLowerCase() : ''
    if (v) return `${k}:${v}`
  }
  return ''
}

export function prepareImportRecords(
  records: ReadonlyArray<Record<string, unknown>>,
  defaultCategory: string | null,
): Array<Record<string, unknown>> {
  const keys = CATALOG_CATEGORY_KEYS as readonly string[]
  // A Spanish WooCommerce export's «Tipo» lands in `listing_type` (the alias for our own «tipo»): move the WooCommerce
  // product type back to `type` so it isn't validated as a listing type and variations are recognised.
  const rows = records.map((r) => {
    const out: Record<string, unknown> = { ...r }
    const lt = typeof r.listing_type === 'string' ? r.listing_type.trim().toLowerCase() : ''
    if (WOO_TYPES.has(lt)) { out.type = lt; delete out.listing_type }
    return out
  })
  const isVariation = (r: Record<string, unknown>) => /^variaci[oó]n$|^variation$/.test(String(r.type ?? '').trim().toLowerCase())

  // A variable product's parent row has no price; its variations do. Give the parent the lowest variation price.
  const lowestByParent = new Map<string, number>()
  for (const r of rows.filter(isVariation)) {
    const parent = String(r.parent ?? r.superior ?? '').trim().replace(/^id:/i, '').toLowerCase()
    const price = Number(String(r.price ?? '').replace(/[^\d.]/g, ''))
    if (!parent || !Number.isFinite(price) || price <= 0) continue
    lowestByParent.set(parent, Math.min(price, lowestByParent.get(parent) ?? Infinity))
  }

  const seen = new Set<string>()
  return rows
    .filter((r) => !isVariation(r))
    // One product per key: Tiendanube repeats a product's row for each variant (same «Identificador de URL»).
    .filter((r) => {
      const key = productKey(r)
      if (!key) return true
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((r) => {
      const out: Record<string, unknown> = { ...r }
      const category = typeof r.category === 'string' ? r.category.trim() : ''
      if (!keys.includes(category) && defaultCategory) out.category = defaultCategory
      if (typeof r.description === 'string') out.description = stripHtml(r.description)
      const noPrice = r.price === undefined || String(r.price).trim() === ''
      if (noPrice) {
        const id = String(r.external_id ?? '').trim().toLowerCase()
        const low = id ? lowestByParent.get(id) : undefined
        if (low !== undefined) out.price = String(low)
      }
      return out
    })
}
