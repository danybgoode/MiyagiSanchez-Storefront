/**
 * What a live shop already knows about itself, for the business model (business-infrastructure D11).
 *
 * Two pure readers, fed by the two seller-scoped reads the profit page already makes:
 *   - `productsFrom` — `GET /store/sellers/me/products` → price and cost per product. Cost is the seller-private
 *     `unit_cost_cents` on the FIRST variant, the same single-variant scope COGS has everywhere (profit-analyzer).
 *   - `salesFrom` — `GET /store/sellers/me/profit` (the ledger) → units and revenue per product over a window.
 *
 * The plan is in pesos: only MXN sales are counted. A US shop's USD sales are not converted into a Mexican plan;
 * they are simply not read here (the plan says so through its gaps, not through a wrong number).
 *
 * Pure: no I/O.
 */

import type { ProfitEvent, ProfitOrderInfo } from '../profit'
import type { ProductSales, ShopProduct } from './model'

/** 90 days: long enough to smooth a slow week, short enough that last season's prices do not set this month's plan. */
export const SALES_WINDOW_DAYS = 90

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const cents = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)

/**
 * The products read's `listings` (shape) joined with its `products` (raw rows, for the private variant metadata).
 * `null` = the body is not a products read at all — "could not read", never "no products" (an empty list here would
 * retire every real offer in the model).
 */
export function productsFrom(body: unknown): ShopProduct[] | null {
  if (!isObj(body) || !Array.isArray(body.listings)) return null
  const raw = new Map<string, Record<string, unknown>>()
  for (const p of Array.isArray(body.products) ? body.products : []) if (isObj(p) && typeof p.id === 'string') raw.set(p.id, p)
  const out: ShopProduct[] = []
  for (const l of body.listings) {
    if (!isObj(l) || typeof l.id !== 'string' || typeof l.title !== 'string') continue
    if (typeof l.currency === 'string' && l.currency.toLowerCase() !== 'mxn') continue
    const rawRow = raw.get(l.id)
    const variants = rawRow?.variants
    const rawMeta = rawRow && isObj(rawRow.metadata) ? rawRow.metadata : isObj(l.metadata) ? l.metadata : null
    const meta = Array.isArray(variants) && isObj(variants[0]) && isObj(variants[0].metadata) ? variants[0].metadata : null
    out.push({
      id: l.id,
      title: l.title,
      status: typeof l.status === 'string' ? l.status : null,
      price_cents: cents(l.price_cents),
      unit_cost_cents: meta ? cents(meta.unit_cost_cents) : null,
      replaces_example: rawMeta && typeof rawMeta.p2s_example === 'string' ? rawMeta.p2s_example : null,
    })
  }
  return out
}

/** Units and revenue per product, from the ledger's revenue events inside the window. */
export function salesFrom(events: ProfitEvent[], orders: ProfitOrderInfo[], now: Date, windowDays = SALES_WINDOW_DAYS): ProductSales[] {
  const since = now.getTime() - windowDays * 24 * 60 * 60 * 1000
  const lineToItem = new Map<string, { product_id: string; quantity: number }>()
  for (const o of orders) {
    for (const it of o.items) {
      if (it.product_id && typeof it.quantity === 'number' && it.quantity > 0) lineToItem.set(it.id, { product_id: it.product_id, quantity: it.quantity })
    }
  }
  const byProduct = new Map<string, ProductSales>()
  const countedLines = new Set<string>()
  for (const e of events) {
    if (e.event_type !== 'revenue' || !e.order_line_id) continue
    if ((e.currency_code ?? '').toLowerCase() !== 'mxn') continue
    const t = Date.parse(e.captured_at)
    if (!Number.isFinite(t) || t < since || t > now.getTime()) continue
    const item = lineToItem.get(e.order_line_id)
    if (!item) continue
    const row = byProduct.get(item.product_id) ?? { product_id: item.product_id, units: 0, revenue_cents: 0 }
    row.revenue_cents += e.amount_cents
    // A line can carry more than one revenue event (an adjustment); its units count once.
    if (!countedLines.has(e.order_line_id)) {
      row.units += item.quantity
      countedLines.add(e.order_line_id)
    }
    byProduct.set(item.product_id, row)
  }
  return [...byProduct.values()]
}

/** The window in months, for "units per month" (90 days ≈ 3 months; never below one). */
export function windowMonths(windowDays = SALES_WINDOW_DAYS): number {
  return Math.max(1, Math.round((windowDays / 30) * 10) / 10)
}
