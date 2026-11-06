/**
 * lib/promoter-panel.ts — the promoter panel's pure rules (epic 08 · promoter-panel). Next-free and dependency-free,
 * so the Playwright `api` runner tests them directly.
 *
 * - Where the merchant sells today (D6), stored in `merchant_relationships.current_channels`, and the path it gives
 *   step 2 «Sus productos» (D9).
 * - The import cap (D4, Daniel 2026-11-05): up to 150 products are part of opening the shop, in every package; a bigger
 *   catalog is the paid «Migración con consultor», and the merchant can always import the rest for free from their own
 *   panel after the claim. 150 is `MIGRATION_FLAT_LISTING_CAP` — the same number the paid migration's flat price covers.
 */
import { MIGRATION_FLAT_LISTING_CAP } from './migration-estimate'

/** Where a merchant sells today. A closed list: the panel shows it as a dropdown, never free text (Daniel). */
export const SELLS_TODAY = ['none', 'social', 'mercadolibre', 'shopify', 'tiendanube', 'woocommerce', 'bigcartel', 'other'] as const
export type SellsToday = (typeof SELLS_TODAY)[number]

export function isSellsToday(value: unknown): value is SellsToday {
  return typeof value === 'string' && (SELLS_TODAY as readonly string[]).includes(value)
}

/** Step 2's path: a Shopify import, an export file, the Mercado Libre note, or typed cards. Cards are always below. */
export type StepTwoPath = 'shopify' | 'file' | 'mercadolibre' | 'cards'

export function stepTwoPath(sellsToday: unknown): StepTwoPath {
  if (sellsToday === 'shopify') return 'shopify'
  // Big Cartel publishes no product export (only orders — its help center, read 2026-11-05), so it types its products.
  if (sellsToday === 'tiendanube' || sellsToday === 'woocommerce') return 'file'
  if (sellsToday === 'mercadolibre') return 'mercadolibre'
  return 'cards'
}

/** How many products an import in the panel brings (D4). */
export const PROMOTER_IMPORT_CAP = MIGRATION_FLAT_LISTING_CAP

export function importCapPlan(total: number): { take: number; overCap: number } {
  const safe = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0
  const take = Math.min(safe, PROMOTER_IMPORT_CAP)
  return { take, overCap: safe - take }
}
