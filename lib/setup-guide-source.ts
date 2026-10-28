/**
 * The setup guide's INPUTS, shared by every surface that shows it (prompt-to-shop S4.1, D17).
 *
 * Resumen (`/shop/manage`) and the owner canvas (`/sell/armar`) both show "how far along is my shop". If each built
 * `getSetupSteps`' input on its own, the two would drift the first time one of them changed a column or a flag —
 * and the merchant would see two different percentages for the same shop. So both read the same row
 * (`GUIDE_SHOP_COLUMNS`, from `marketplace_shops`), turn it into steps here, and count progress here.
 *
 * Pure: no I/O. The read lives in `setup-guide-server.ts`.
 */

import { filterOutDeleted } from './listing-lifecycle'
import { getSetupSteps, type SetupStep, type ShopRow } from './setup-guide'

/** The exact `marketplace_shops` columns `ShopRow` needs. Resumen and the canvas select this string, nothing else. */
export const GUIDE_SHOP_COLUMNS = 'name, description, metadata, mp_enabled, custom_domain, ucp_webhook_url'

export type GuideShopRow = ShopRow

/** `metadata.settings.guide.share_done` — the comparte step's only signal. Truthy, as Resumen always read it. */
export function shareDoneOf(row: Pick<ShopRow, 'metadata'>): boolean {
  const settings = (row.metadata as { settings?: { guide?: { share_done?: unknown } } } | null)?.settings
  return !!settings?.guide?.share_done
}

/**
 * The five steps for a shop row and its product count. A missing row is `[]` — "the guide did not load", which a
 * caller must not read as "every step is done" (SetupGuideCard's own rule).
 */
export function guideStepsFor(row: GuideShopRow | null | undefined, productCount: number): SetupStep[] {
  if (!row) return []
  return getSetupSteps({ shop: row, productCount, shareDone: shareDoneOf(row) })
}

export interface GuideProgress {
  done: number
  total: number
  /** Whole percent, 0–100. 0 when the guide did not load. */
  percent: number
}

/** "3 de 5" and its percentage — the numbers Resumen's card shows, computed once for both surfaces. */
export function guideProgress(steps: SetupStep[]): GuideProgress {
  const total = steps.length
  const done = steps.filter((s) => s.done).length
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 }
}

/** The product count both surfaces feed `getSetupSteps`: the seller's Medusa products minus mirror-deleted ones. */
export function guideProductCount<T extends { id: string }>(listings: T[], deletedIds: Set<string>): number {
  return filterOutDeleted(listings, deletedIds).length
}
