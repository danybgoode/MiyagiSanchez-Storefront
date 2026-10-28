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
 * Degrades, never dies: a failed or stalled read (2 s budget) leaves that price `null`
 * («Precio a cotizar»), which is the honest state — never a fabricated number and never a `$0`.
 */
import 'server-only'
import { unstable_cache } from 'next/cache'
import { db } from '@/lib/supabase'
import { getPromoterSkuPrices } from '@/lib/promoter'
import { getComparatorDataset } from '@/lib/cost-comparator-data'
import { processorRatesFromDataset } from '@/lib/cost-comparator-dataset'
import { buildPricingCatalog, type PricingCatalog } from '@/lib/pricing-catalog'
import type { PrintTier } from '@/lib/print'

/** Bounded read budget (ms) and cache window (s) — the same shape as `lib/copy-overrides.ts`.
 * This runs on every about surface (/acerca, /agent, /llms.txt, the UCP manifest, MCP), so a
 * stalled query must cost at most this budget, and repeated reads must not hit the database. */
const PRICE_FETCH_TIMEOUT_MS = 2_000
const PRICE_CACHE_REVALIDATE_SECONDS = 300

function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timeout`)), PRICE_FETCH_TIMEOUT_MS),
  )
  return Promise.race([work, timeout])
}

async function fetchAdminPrices(): Promise<{ migration: number | null; printTiers: number[] | null }> {
  const [migration, printTiers] = await Promise.all([
    bounded(getPromoterSkuPrices(), 'promoter sku prices')
      .then((prices) => prices.migration ?? null)
      .catch(() => null),
    bounded(
      Promise.resolve(db.from('print_editions').select('tiers').eq('status', 'open')),
      'print_editions',
    )
      .then(({ data, error }) => {
        if (error || !data) return null
        const cents = (data as Array<{ tiers: PrintTier[] | null }>)
          .flatMap((e) => e.tiers ?? [])
          .map((t) => t.price_cents)
          .filter((c): c is number => typeof c === 'number' && Number.isFinite(c) && c > 0)
        return cents.length > 0 ? cents : null
      })
      .catch(() => null),
  ])
  return { migration, printTiers }
}

const getCachedAdminPrices = unstable_cache(fetchAdminPrices, ['pricing-catalog-admin-prices'], {
  revalidate: PRICE_CACHE_REVALIDATE_SECONDS,
  tags: ['pricing-catalog'],
})

export async function getPricingCatalog(): Promise<PricingCatalog> {
  const [admin, dataset] = await Promise.all([
    getCachedAdminPrices().catch(() => ({ migration: null, printTiers: null })),
    getComparatorDataset('es'),
  ])
  return buildPricingCatalog({
    migrationPriceMxn: admin.migration,
    printAdTiersCents: admin.printTiers,
    processors: processorRatesFromDataset(dataset),
  })
}
