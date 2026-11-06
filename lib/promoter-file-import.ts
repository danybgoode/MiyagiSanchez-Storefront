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

export function stripHtml(input: string): string {
  return input
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function prepareImportRecords(
  records: ReadonlyArray<Record<string, unknown>>,
  defaultCategory: string | null,
): Array<Record<string, unknown>> {
  const keys = CATALOG_CATEGORY_KEYS as readonly string[]
  const seen = new Set<string>()
  return records
    .filter((r) => String(r.type ?? '').trim().toLowerCase() !== 'variation')
    // One product per name: Tiendanube repeats a product's row for each variant. A row with no name is kept for the
    // validator to reject with its own message.
    .filter((r) => {
      const title = typeof r.title === 'string' ? r.title.trim().toLowerCase() : ''
      if (!title) return true
      if (seen.has(title)) return false
      seen.add(title)
      return true
    })
    .map((r) => {
      const out: Record<string, unknown> = { ...r }
      const category = typeof r.category === 'string' ? r.category.trim() : ''
      if (!keys.includes(category) && defaultCategory) out.category = defaultCategory
      if (typeof r.description === 'string') out.description = stripHtml(r.description)
      return out
    })
}
