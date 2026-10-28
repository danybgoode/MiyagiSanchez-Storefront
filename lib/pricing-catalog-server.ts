/**
 * lib/pricing-catalog-server.ts
 *
 * The I/O shell of the pricing catalog (epic 08 · pricing-page, README D2). Reads the three
 * inputs `buildPricingCatalog` cannot know on its own and hands them to the pure module:
 *
 *   - migration — `getPromoterSkuPrices().migration`, the same value `/mx/vende/migracion`
 *     already shows publicly. (That table is the PROMOTER price table; migration is the one
 *     SKU whose public price lives there. Live 2026-10-28: `migration = 999`, nothing else.)
 *   - print ad — the tier prices of every OPEN `print_editions` row. The public print-ad price
 *     is per edition and per ad size, not in the promoter table. Live 2026-10-28: both editions
 *     are `draft`, so the page shows «Precio a cotizar».
 *   - processors — the comparador dataset, with the same live overrides the comparador applies.
 *
 * Degrades, never dies: a failed read leaves that price `null` («Precio a cotizar»), which is
 * the honest state — never a fabricated number and never a `$0`.
 */
import 'server-only'
import { db } from '@/lib/supabase'
import { getPromoterSkuPrices } from '@/lib/promoter'
import { getComparatorDataset } from '@/lib/cost-comparator-data'
import { processorRatesFromDataset } from '@/lib/cost-comparator-dataset'
import { buildPricingCatalog, type PricingCatalog } from '@/lib/pricing-catalog'
import type { PrintTier } from '@/lib/print'

async function openPrintTierCents(): Promise<number[] | null> {
  try {
    const { data, error } = await db.from('print_editions').select('tiers').eq('status', 'open')
    if (error || !data) return null
    const cents = (data as Array<{ tiers: PrintTier[] | null }>)
      .flatMap((e) => e.tiers ?? [])
      .map((t) => t.price_cents)
      .filter((c): c is number => typeof c === 'number' && Number.isFinite(c) && c > 0)
    return cents.length > 0 ? cents : null
  } catch {
    return null
  }
}

async function migrationPriceMxn(): Promise<number | null> {
  try {
    const prices = await getPromoterSkuPrices()
    return prices.migration ?? null
  } catch {
    return null
  }
}

export async function getPricingCatalog(): Promise<PricingCatalog> {
  const [migration, printTiers, dataset] = await Promise.all([
    migrationPriceMxn(),
    openPrintTierCents(),
    getComparatorDataset('es'),
  ])
  return buildPricingCatalog({
    migrationPriceMxn: migration,
    printAdTiersCents: printTiers,
    processors: processorRatesFromDataset(dataset),
  })
}
