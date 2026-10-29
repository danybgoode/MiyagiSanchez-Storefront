/**
 * The shop's Meta catalog feed (share-kit S3.1, D18) — the CSV a merchant pastes into Commerce Manager so their
 * Instagram Shopping and WhatsApp Business catalogs fill and stay current.
 *
 * Built from the S1 catalog model, so the feed carries exactly what the catalog page shows. Columns are Meta's required
 * set, re-confirmed when S3 started (2026-10-28): id, title, description, availability, condition, price, link,
 * image_link, brand. `id` is the Medusa product id, stable across edits, so Meta updates an item instead of adding a
 * second one. A product without a photo or a price would be rejected by Meta, so it is left out here and counted by
 * reason, and the merchant sees how many are missing and why.
 *
 * Pure: relative imports only, so the `api` Playwright project unit-tests it.
 */

import type { CatalogItem, CatalogModel } from './catalog'
import { isShopSlug } from '../share-link'

export const META_FEED_COLUMNS = [
  'id',
  'title',
  'description',
  'availability',
  'condition',
  'price',
  'link',
  'image_link',
  'brand',
] as const

export interface MetaFeed {
  csv: string
  included: number
  excluded: { no_photo: number; no_price: number }
}

/** «199.00 MXN» — Meta's price format: the amount with two decimals, a space, the ISO currency. */
export function metaPrice(priceCents: number, currency: string): string {
  return `${(priceCents / 100).toFixed(2)} ${currency.toUpperCase()}`
}

/**
 * RFC 4180: a field with a comma, a quote or a line break is quoted, and its quotes doubled.
 * Spreadsheet formula-neutralising (a leading `'`) is deliberately NOT applied: Meta ingests the text literally and
 * would publish the apostrophe on Instagram and WhatsApp, and the text is the shop's own, already public on its
 * product pages (codex security lens + verifier, PR 449).
 */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function exclusionReason(item: CatalogItem): keyof MetaFeed['excluded'] | null {
  if (!item.imageUrl) return 'no_photo'
  if (item.priceCents == null || item.priceCents <= 0) return 'no_price'
  return null
}

export function buildMetaFeed(model: CatalogModel): MetaFeed {
  const excluded = { no_photo: 0, no_price: 0 }
  const rows: string[][] = []
  for (const item of model.items) {
    const reason = exclusionReason(item)
    if (reason) {
      excluded[reason] += 1
      continue
    }
    rows.push([
      item.id,
      item.title,
      // Meta requires a description; the title stands in rather than dropping the product.
      item.description?.trim() || item.title,
      item.availability,
      item.condition,
      metaPrice(item.priceCents as number, item.currency),
      item.url,
      item.imageUrl as string,
      model.shop.name,
    ])
  }
  const lines = [META_FEED_COLUMNS.join(','), ...rows.map((row) => row.map(csvField).join(','))]
  return { csv: `${lines.join('\r\n')}\r\n`, included: rows.length, excluded }
}

/** How many products the feed leaves out — the number the Comparte tile states. */
export function metaFeedExcludedCount(feed: MetaFeed): number {
  return feed.excluded.no_photo + feed.excluded.no_price
}

/** The route segment `<slug>.csv` → the slug, or null for anything else (no other extension, no bare slug). */
export function feedSlugFromSegment(segment: string): string | null {
  if (!segment.endsWith('.csv')) return null
  const slug = segment.slice(0, -'.csv'.length)
  return isShopSlug(slug) ? slug : null
}

export type MetaFeedResponse = { status: 404 } | { status: 503 } | { status: 200; csv: string }

/**
 * What the feed route answers for a loaded model (D18): no model or an unclaimed shop is a 404; a partial read is a
 * 503, never a short feed, because a scheduled Meta replace-feed deletes every missing row (verifier, PR 449).
 */
export function metaFeedResponse(model: CatalogModel | null): MetaFeedResponse {
  if (!model || !model.shop.claimed) return { status: 404 }
  if (!model.complete) return { status: 503 }
  return { status: 200, csv: buildMetaFeed(model).csv }
}
