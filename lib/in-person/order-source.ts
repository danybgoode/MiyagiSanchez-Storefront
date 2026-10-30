/**
 * Where a sale came from — labels, the inbox filter and the Ganancias split (in-person-sales
 * S2.3, D17). Pure and next-free. The set mirrors the backend ledger's `LedgerSource`
 * (`native | mercadolibre | in_person | payment_link`); the inbox row calls the native one
 * `miyagi`. Anything unrecognised reads as the native source rather than inventing a channel.
 */

export type OrderSource = 'miyagi' | 'mercadolibre' | 'in_person' | 'payment_link'

export function normalizeOrderSource(source: string | null | undefined): OrderSource {
  return source === 'mercadolibre' || source === 'in_person' || source === 'payment_link' ? source : 'miyagi'
}

const LABEL: Record<OrderSource, string> = {
  miyagi: 'Tienda en línea',
  mercadolibre: 'Mercado Libre',
  in_person: 'En persona',
  payment_link: 'Cobro con link',
}

export function orderSourceLabel(source: string | null | undefined): string {
  return LABEL[normalizeOrderSource(source)]
}

/** A badge only for the sources that are not the plain online shop (Mercado Libre keeps its own badge). */
export function inPersonBadgeLabel(source: string | null | undefined): string | null {
  const s = normalizeOrderSource(source)
  return s === 'in_person' || s === 'payment_link' ? LABEL[s] : null
}

const ORDER: OrderSource[] = ['miyagi', 'in_person', 'payment_link', 'mercadolibre']

/** The sources actually present, in a stable order — a filter with one option is not shown. */
export function presentSources(orders: Array<{ source?: string | null }>): OrderSource[] {
  const seen = new Set(orders.map((o) => normalizeOrderSource(o.source)))
  return ORDER.filter((s) => seen.has(s))
}

export function filterBySource<T extends { source?: string | null }>(orders: T[], source: OrderSource | null): T[] {
  return source === null ? orders : orders.filter((o) => normalizeOrderSource(o.source) === source)
}

export interface SourceSummary {
  source: OrderSource
  label: string
  currency_code: string
  orders: number
  revenue_cents: number
  margin_cents: number
}

/** Ganancias split: per source AND currency (cents of two currencies are never added). */
export function summarizeBySource(
  rows: Array<{ source?: string | null; currency_code: string; revenue_cents: number; margin_cents: number | null }>,
): SourceSummary[] {
  const buckets = new Map<string, SourceSummary>()
  for (const row of rows) {
    const source = normalizeOrderSource(row.source)
    const key = `${source}::${row.currency_code}`
    const b = buckets.get(key) ?? { source, label: LABEL[source], currency_code: row.currency_code, orders: 0, revenue_cents: 0, margin_cents: 0 }
    b.orders += 1
    b.revenue_cents += row.revenue_cents
    b.margin_cents += row.margin_cents ?? 0
    buckets.set(key, b)
  }
  return [...buckets.values()].sort((a, b) => ORDER.indexOf(a.source) - ORDER.indexOf(b.source) || a.currency_code.localeCompare(b.currency_code))
}
