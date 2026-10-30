/**
 * Profit margin math — the PURE seam the profit dashboard reads
 * (profit-analyzer S1 · US-3). No React, no `server-only`, no network: the
 * `/shop/manage/profit` server page fetches the backend's raw ledger
 * (`GET /store/sellers/me/profit`) and everything from raw events → per-order
 * / per-SKU margin rows happens here, spec'd in `e2e/profit.spec.ts`.
 *
 * Honesty rules (mirror the ledger's own): a missing piece is a named PENDING
 * fact ("envío pendiente"), never an assumed $0 — margins are computed over
 * the pieces that exist, and each row says which are missing. Amounts are
 * integer centavos throughout (the ledger's own unit).
 */

export type ProfitEventType = 'revenue' | 'ml_fee' | 'shipping_cost' | 'cogs_snapshot'
// Mirrors the backend ledger's LedgerSource (in-person-sales D17): counter sales and payment links are
// native Medusa orders that carry their own source.
export type ProfitSource = 'mercadolibre' | 'native' | 'in_person' | 'payment_link'

export interface ProfitEvent {
  id: string
  order_id: string
  order_line_id: string | null
  source: ProfitSource
  event_type: ProfitEventType
  amount_cents: number
  currency_code: string
  captured_at: string
}

export interface ProfitOrderItem {
  id: string
  product_id: string | null
  variant_id: string | null
  title: string | null
  quantity: number | null
}

export interface ProfitOrderInfo {
  id: string
  display_id: number | null
  created_at: string | null
  currency_code: string | null
  source: ProfitSource
  items: ProfitOrderItem[]
}

export type PendingPiece = 'cogs' | 'shipping' | 'ml_fee'

export interface OrderMarginRow {
  /** The order's own currency (S4.3 / D16) — see `SkuMarginRow.currency_code`. */
  currency_code: string
  order_id: string
  display_id: number | null
  created_at: string | null
  source: ProfitSource
  title: string
  revenue_cents: number
  fees_cents: number
  shipping_cents: number
  cogs_cents: number
  /** revenue − fees − shipping − cogs, over the pieces that exist. */
  margin_cents: number
  /** margin / revenue; null when revenue is 0 (margin % is meaningless). */
  margin_pct: number | null
  /** The named missing pieces this row is honest about. */
  pending: PendingPiece[]
}

export interface SkuMarginRow {
  /**
   * The currency this row is denominated in (us-marketplace S4.3 / D16).
   *
   * Every aggregation key includes it. Cents are not a unit — 1000 MXN cents and
   * 1000 USD cents are different amounts of money, and adding them produces a number
   * that is not a price in any currency. Before this, a seller operating in both
   * markets would have seen one summed figure with no indication it was nonsense.
   */
  currency_code: string
  product_id: string
  /** The specific variant this row's Apply-price control targets (Sprint 2 ·
   * US-5); null when events couldn't be attributed to a single variant. */
  variant_id: string | null
  title: string
  units: number
  revenue_cents: number
  fees_cents: number
  cogs_cents: number
  /** Per-SKU margin EXCLUDES shipping (an order-level cost) — stated in the UI. */
  margin_cents: number
  margin_pct: number | null
  /** Honest missing pieces for THIS row (never 'shipping' — excluded by design here). */
  pending: PendingPiece[]
  /** Only set by `computeSkuMarginsByChannel` (catalog-management S4) — the
   * channel this row's revenue/fees belong to. `computeSkuMargins` blends
   * both channels into one row and leaves this undefined (ambiguous). */
  source?: ProfitSource
}

const sum = (events: ProfitEvent[], type: ProfitEventType) =>
  events.filter((e) => e.event_type === type).reduce((acc, e) => acc + (Number.isFinite(e.amount_cents) ? e.amount_cents : 0), 0)

/**
 * One margin row per order that has at least one ledger event. Pending
 * pieces: `cogs` when no snapshot landed (seller had no cost recorded at sale
 * time), `shipping` when no shipping-cost event exists yet (label not bought /
 * ML shipment cost unparsed — pickup orders also show it; the copy says
 * "registrado"), `ml_fee` when an ML order's fee couldn't be parsed.
 */
export function computeOrderMargins(events: ProfitEvent[], orders: ProfitOrderInfo[]): OrderMarginRow[] {
  const orderById = new Map(orders.map((o) => [o.id, o]))
  const byOrder = new Map<string, ProfitEvent[]>()
  for (const e of events) {
    const list = byOrder.get(e.order_id) ?? []
    list.push(e)
    byOrder.set(e.order_id, list)
  }

  const rows: OrderMarginRow[] = []
  for (const [orderId, orderEvents] of byOrder) {
    const info = orderById.get(orderId)
    const source: ProfitSource = info?.source ?? orderEvents[0]?.source ?? 'native'
    const revenue = sum(orderEvents, 'revenue')
    const fees = sum(orderEvents, 'ml_fee')
    const shipping = sum(orderEvents, 'shipping_cost')
    const cogs = sum(orderEvents, 'cogs_snapshot')

    const pending: PendingPiece[] = []
    if (!orderEvents.some((e) => e.event_type === 'cogs_snapshot')) pending.push('cogs')
    if (!orderEvents.some((e) => e.event_type === 'shipping_cost')) pending.push('shipping')
    if (source === 'mercadolibre' && !orderEvents.some((e) => e.event_type === 'ml_fee')) pending.push('ml_fee')

    const margin = revenue - fees - shipping - cogs
    rows.push({
      currency_code: normalizeCurrency(info?.currency_code),
      order_id: orderId,
      display_id: info?.display_id ?? null,
      created_at: info?.created_at ?? null,
      source,
      title: info?.items?.[0]?.title ?? '—',
      revenue_cents: revenue,
      fees_cents: fees,
      shipping_cents: shipping,
      cogs_cents: cogs,
      margin_cents: margin,
      margin_pct: revenue > 0 ? margin / revenue : null,
      pending,
    })
  }

  // Newest first (created_at desc, unknowns last) — the dashboard's order.
  return rows.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
}

export interface CurrencyTotals {
  currency_code: string
  revenue: number
  fees: number
  shipping: number
  cogs: number
  margin: number
  margin_pct: number | null
  orders: number
}

/**
 * Dashboard totals, ONE SET PER CURRENCY (S4.3 / D16).
 *
 * The dashboard used to `reduce` every order row into a single figure. For a
 * Mexico-only platform that was right; the moment one seller takes both MXN and USD it
 * becomes a number that is not money — pesos and dollars added as though cents were a
 * unit. And it fails silently: the total still renders, still looks plausible, and is
 * simply wrong, which is the worst shape a money bug can take.
 *
 * Sorted by revenue so the seller's principal market leads, with the currency itself as
 * the tiebreak so the order is stable across renders.
 */
export const EMPTY_TOTALS = (currency = 'mxn'): CurrencyTotals => ({
  currency_code: normalizeCurrency(currency),
  revenue: 0, fees: 0, shipping: 0, cogs: 0, margin: 0, margin_pct: null, orders: 0,
})

export function totalsByCurrency(rows: OrderMarginRow[]): CurrencyTotals[] {
  const byCurrency = new Map<string, CurrencyTotals>()
  for (const row of rows) {
    const code = normalizeCurrency(row.currency_code)
    const totals = byCurrency.get(code) ?? {
      currency_code: code, revenue: 0, fees: 0, shipping: 0, cogs: 0, margin: 0, margin_pct: null, orders: 0,
    }
    totals.revenue += row.revenue_cents
    totals.fees += row.fees_cents
    totals.shipping += row.shipping_cents
    totals.cogs += row.cogs_cents
    totals.margin += row.margin_cents
    totals.orders += 1
    byCurrency.set(code, totals)
  }
  // A seller with no sales yet still gets ONE zero group. Returning an empty array
  // would make the summary cards vanish rather than read zero — the dashboard's
  // existing empty state, deleted by accident. Found by the Codex pass on frontend
  // PR 360.
  if (byCurrency.size === 0) return [EMPTY_TOTALS()]

  return [...byCurrency.values()]
    .map((t) => ({ ...t, margin_pct: t.revenue > 0 ? t.margin / t.revenue : null }))
    .sort((a, b) => b.revenue - a.revenue || a.currency_code.localeCompare(b.currency_code))
}

/**
 * The currency an amount is denominated in, lowercased, with a documented default.
 *
 * `mxn` is the fallback because every event that predates the US market is Mexican and
 * the column was nullable then — NOT because an unknown currency is safe to treat as
 * pesos. A row whose currency truly cannot be read is a different fact from a Mexican
 * one, but it cannot arise here: the ledger writer stamps `order.currency_code` and
 * defaults it identically, so the two agree by construction rather than by luck.
 */
export function normalizeCurrency(currency: string | null | undefined): string {
  const value = typeof currency === 'string' ? currency.trim().toLowerCase() : ''
  return value || 'mxn'
}

/**
 * Line-level events (revenue / ml_fee / cogs) aggregated per product.
 * Attribution: by the event's `order_line_id` → the order's item → product;
 * events without a line id (ML index-qualified lines) attribute to the
 * order's product when the order has exactly ONE distinct product — else
 * they land in the honest "sin asignar" bucket rather than a guessed SKU.
 * Shipping (order-level) is deliberately excluded — stated in the UI.
 */
export function computeSkuMargins(events: ProfitEvent[], orders: ProfitOrderInfo[]): SkuMarginRow[] {
  const orderById = new Map(orders.map((o) => [o.id, o]))
  const buckets = new Map<string, SkuMarginRow>()

  // Bucketed by variant when known (the Apply-price control's addressable
  // unit, US-5), falling back to product_id for events that predate a
  // variant_id being recorded — never collapses two distinct variants of the
  // same product into one row.
  const bucketFor = (bucketKey: string, productId: string, variantId: string | null, title: string, currency: string): SkuMarginRow => {
    const existing = buckets.get(bucketKey)
    if (existing) return existing
    const fresh: SkuMarginRow = {
      currency_code: currency, product_id: productId, variant_id: variantId, title, units: 0,
      revenue_cents: 0, fees_cents: 0, cogs_cents: 0, margin_cents: 0, margin_pct: null, pending: [],
    }
    buckets.set(bucketKey, fresh)
    return fresh
  }

  // Per-bucket "did we see this event type at all" flags, tracked alongside
  // (not inside) the public row shape — mirrors computeOrderMargins' pending
  // logic, just aggregated across every event the bucket ever saw.
  const seenCogs = new Set<string>()
  const seenMlFee = new Set<string>()
  const seenMercadolibre = new Set<string>()

  for (const e of events) {
    if (e.event_type === 'shipping_cost') continue
    const info = orderById.get(e.order_id)
    const items = info?.items ?? []

    let item: ProfitOrderItem | undefined
    if (e.order_line_id) {
      item = items.find((i) => i.id === e.order_line_id)
    } else {
      const distinctProducts = new Set(items.map((i) => i.product_id).filter(Boolean))
      if (distinctProducts.size === 1) item = items[0]
    }
    const productId = item?.product_id ?? 'unassigned'
    const variantId = item?.variant_id ?? null
    const title = item?.title ?? 'Sin asignar'
    // CURRENCY IS PART OF THE KEY (D16). Even the "unassigned" bucket splits by it —
    // an honest unattributed total in one currency beats a meaningless mixed one.
    const currency = normalizeCurrency(e.currency_code)
    const baseKey = productId === 'unassigned' ? 'unassigned' : (variantId ?? productId)
    const bucketKey = `${baseKey}::${currency}`
    const bucket = bucketFor(bucketKey, productId, variantId, title, currency)

    if (e.event_type === 'revenue') bucket.revenue_cents += e.amount_cents
    else if (e.event_type === 'ml_fee') bucket.fees_cents += e.amount_cents
    else if (e.event_type === 'cogs_snapshot') bucket.cogs_cents += e.amount_cents

    if (e.event_type === 'revenue') {
      const qty = item?.quantity
      bucket.units += typeof qty === 'number' && Number.isFinite(qty) ? qty : 0
      if (e.source === 'mercadolibre') seenMercadolibre.add(bucketKey)
    }
    if (e.event_type === 'cogs_snapshot') seenCogs.add(bucketKey)
    if (e.event_type === 'ml_fee') seenMlFee.add(bucketKey)
  }

  const rows = [...buckets.entries()].map(([bucketKey, row]) => {
    row.margin_cents = row.revenue_cents - row.fees_cents - row.cogs_cents
    row.margin_pct = row.revenue_cents > 0 ? row.margin_cents / row.revenue_cents : null
    const pending: PendingPiece[] = []
    if (!seenCogs.has(bucketKey)) pending.push('cogs')
    if (seenMercadolibre.has(bucketKey) && !seenMlFee.has(bucketKey)) pending.push('ml_fee')
    row.pending = pending
    return row
  })
  // Highest revenue first; the unassigned bucket always last.
  return rows.sort((a, b) =>
    (a.product_id === 'unassigned' ? 1 : 0) - (b.product_id === 'unassigned' ? 1 : 0)
    || b.revenue_cents - a.revenue_cents)
}

/**
 * Per-channel variant of `computeSkuMargins` (catalog-management S4 · Story
 * 4.1) — the catalog table wants Miyagi-vs-ML margin split per product,
 * which the dashboard's blended-by-variant bucketing doesn't give. SAME math
 * as `computeSkuMargins` (identical `sum()`-shaped accumulation, identical
 * pending-piece rules) — the only difference is the bucket key carries the
 * event's `source` too, so a product sold on both channels gets two rows
 * instead of one blended row. `computeSkuMargins` itself is untouched (the
 * profit dashboard keeps its existing blended behavior, zero regression
 * risk) — this is an additive sibling, not a fork of the formula.
 */
export function computeSkuMarginsByChannel(events: ProfitEvent[], orders: ProfitOrderInfo[]): SkuMarginRow[] {
  const orderById = new Map(orders.map((o) => [o.id, o]))
  const buckets = new Map<string, SkuMarginRow>()

  const bucketFor = (bucketKey: string, productId: string, variantId: string | null, title: string, source: ProfitSource, currency: string): SkuMarginRow => {
    const existing = buckets.get(bucketKey)
    if (existing) return existing
    const fresh: SkuMarginRow = {
      currency_code: currency, product_id: productId, variant_id: variantId, title, units: 0,
      revenue_cents: 0, fees_cents: 0, cogs_cents: 0, margin_cents: 0, margin_pct: null, pending: [], source,
    }
    buckets.set(bucketKey, fresh)
    return fresh
  }

  const seenCogs = new Set<string>()
  const seenMlFee = new Set<string>()
  const seenMercadolibre = new Set<string>()

  for (const e of events) {
    if (e.event_type === 'shipping_cost') continue
    const info = orderById.get(e.order_id)
    const items = info?.items ?? []

    let item: ProfitOrderItem | undefined
    if (e.order_line_id) {
      item = items.find((i) => i.id === e.order_line_id)
    } else {
      const distinctProducts = new Set(items.map((i) => i.product_id).filter(Boolean))
      if (distinctProducts.size === 1) item = items[0]
    }
    const productId = item?.product_id ?? 'unassigned'
    const variantId = item?.variant_id ?? null
    const title = item?.title ?? 'Sin asignar'
    const baseBucketKey = productId === 'unassigned' ? 'unassigned' : (variantId ?? productId)
    // The per-channel dimension: the event's own source, not the order's —
    // matches computeOrderMargins' own `source` field, so a product with
    // events from both channels never collapses into one row.
    const currency = normalizeCurrency(e.currency_code)
    // The channel is in the key for the unassigned bucket TOO. Dropping it there
    // predates this change — the original key was a bare `'unassigned'` — but it
    // corrupts exactly what this function exists to separate: two unassigned events
    // from different channels merged into one row, in the per-CHANNEL breakdown.
    // Found by the Antigravity pass on frontend PR 360.
    const bucketKey = `${baseBucketKey}::${e.source}::${currency}`
    const bucket = bucketFor(bucketKey, productId, variantId, title, e.source, currency)

    if (e.event_type === 'revenue') bucket.revenue_cents += e.amount_cents
    else if (e.event_type === 'ml_fee') bucket.fees_cents += e.amount_cents
    else if (e.event_type === 'cogs_snapshot') bucket.cogs_cents += e.amount_cents

    if (e.event_type === 'revenue') {
      const qty = item?.quantity
      bucket.units += typeof qty === 'number' && Number.isFinite(qty) ? qty : 0
      if (e.source === 'mercadolibre') seenMercadolibre.add(bucketKey)
    }
    if (e.event_type === 'cogs_snapshot') seenCogs.add(bucketKey)
    if (e.event_type === 'ml_fee') seenMlFee.add(bucketKey)
  }

  const rows = [...buckets.entries()].map(([bucketKey, row]) => {
    row.margin_cents = row.revenue_cents - row.fees_cents - row.cogs_cents
    row.margin_pct = row.revenue_cents > 0 ? row.margin_cents / row.revenue_cents : null
    const pending: PendingPiece[] = []
    if (!seenCogs.has(bucketKey)) pending.push('cogs')
    if (seenMercadolibre.has(bucketKey) && !seenMlFee.has(bucketKey)) pending.push('ml_fee')
    row.pending = pending
    return row
  })
  return rows.sort((a, b) =>
    (a.product_id === 'unassigned' ? 1 : 0) - (b.product_id === 'unassigned' ? 1 : 0)
    || b.revenue_cents - a.revenue_cents)
}

// ── Solve-for-price suggester (Sprint 2 · US-4) ──────────────────────────────
// The corrected formula from the epic README: fees are a % of the price BEING
// SOLVED FOR (not the current price), so a naive additive formula
// (cogs + shipping + fee + margin) understates the price ML would actually
// need to charge the fee against. Degenerate when fee% + margin% >= 1 — that
// price would be infinite/negative, so there is no achievable price.

export interface SolveForPriceInput {
  cogsCents: number
  shippingCents: number
  fixedFeeCents: number
  /** ML's percentage fee as a 0..1 fraction (10% ⇒ 0.10). */
  feePct: number
  /** The seller's target margin as a 0..1 fraction (25% ⇒ 0.25). */
  targetMarginPct: number
}

export type SolveForPriceResult =
  | { achievable: true; priceCents: number }
  | { achievable: false; reason: 'fee_plus_margin_exceeds_one' }

/**
 * `price = (COGS + shipping + fixed_fee) / (1 − fee% − target_margin%)`.
 * Pure, no I/O — the frontend recomputes this locally as the seller drags the
 * target-margin slider, using a fee rate fetched once (not per tick).
 */
export function solveForPrice(input: SolveForPriceInput): SolveForPriceResult {
  const denom = 1 - input.feePct - input.targetMarginPct
  if (denom <= 0) return { achievable: false, reason: 'fee_plus_margin_exceeds_one' }
  const priceCents = Math.round((input.cogsCents + input.shippingCents + input.fixedFeeCents) / denom)
  return { achievable: true, priceCents }
}

// ── Margin insights (Sprint 2 · US-6) ────────────────────────────────────────
// Pure threshold classifiers over the ledger's own SkuMarginRow[] — no new
// data shape, no live ML call (unlike the interactive suggester above, these
// read only realized history). A row with ANY pending piece is excluded from
// both buckets: missing data is a different fact from a confirmed-quiet
// margin, never conflated (mirrors the ops-routines-reporting learning).

/** Realized margin below this is a "margin killer" (includes negative/loss rows). */
export const MARGIN_KILLER_THRESHOLD_PCT = 0.05
/** Realized margin at/above this already looks healthy — the underpriced gate's floor. */
export const UNDERPRICED_MARGIN_THRESHOLD_PCT = 0.40
/**
 * The AMBITIOUS reference margin used to compute "how much higher could this
 * price go" — deliberately ABOVE `UNDERPRICED_MARGIN_THRESHOLD_PCT` (0.40),
 * since comparing against a lower/equal target could never show headroom
 * (a higher target margin always implies a higher achievable price, for the
 * same cost/fee — the achievable-price formula is monotonic in margin%).
 */
export const UNDERPRICED_TARGET_MARGIN_PCT = 0.55
/** Current price must be more than this fraction below the ambitious-target reference price. */
export const UNDERPRICED_HEADROOM_PCT = 0.10

/** A SkuMarginRow is "complete" for insight purposes when it has no pending piece. */
function isComplete(row: SkuMarginRow): boolean {
  return row.pending.length === 0
}

/**
 * SKUs whose realized margin is under the margin-killer threshold (including
 * negative/loss-making rows) — the seller's silent margin bleeders. Rows with
 * a null margin_pct (zero revenue) or a pending piece are excluded — an
 * unknown margin is not a confirmed-bad one.
 */
export function classifyMarginKillers(rows: SkuMarginRow[]): SkuMarginRow[] {
  return rows.filter((r) => isComplete(r) && r.margin_pct != null && r.margin_pct < MARGIN_KILLER_THRESHOLD_PCT)
}

/**
 * SKUs with real margin headroom: realized margin already comfortably above
 * `UNDERPRICED_MARGIN_THRESHOLD_PCT`, AND the current average unit price is
 * more than `UNDERPRICED_HEADROOM_PCT` below the price achievable at
 * `UNDERPRICED_TARGET_MARGIN_PCT` — computed from the REALIZED fee rate
 * implied by this row's own history (fees_cents / revenue_cents), so no live
 * ML call is needed (US-6 is pure-ledger, unlike the interactive US-4/5
 * suggester which fetches ML's live rate). Rows with a pending piece, zero
 * units, or zero revenue are excluded (no reliable current price / fee rate
 * to reason from).
 */
export function classifyUnderpriced(rows: SkuMarginRow[]): SkuMarginRow[] {
  return rows.filter((r) => {
    if (!isComplete(r) || r.margin_pct == null || r.units <= 0 || r.revenue_cents <= 0) return false
    if (r.margin_pct < UNDERPRICED_MARGIN_THRESHOLD_PCT) return false
    const currentUnitPriceCents = r.revenue_cents / r.units
    const impliedFeePct = r.fees_cents / r.revenue_cents
    const costPerUnitCents = Math.round(r.cogs_cents / r.units)
    const solved = solveForPrice({
      cogsCents: costPerUnitCents,
      shippingCents: 0, // per-SKU rows exclude shipping by design (order-level)
      fixedFeeCents: 0, // realized-fee-rate approximation; no live ML call in US-6
      feePct: impliedFeePct,
      targetMarginPct: UNDERPRICED_TARGET_MARGIN_PCT,
    })
    if (!solved.achievable) return false
    return currentUnitPriceCents < solved.priceCents * (1 - UNDERPRICED_HEADROOM_PCT)
  })
}

/** es-MX centavos → "$1,850.50" (matches the manage-area convention). */
/**
 * Format an amount in its OWN currency's locale (D9).
 *
 * `Intl` will happily render USD under `es-MX` — it produces `USD 12.50`, with a
 * Mexican decimal convention and a currency code where a US seller expects `$12.50`.
 * The locale follows the money, not the viewer, because this is a seller reading their
 * own takings for a market they operate in.
 */
const CURRENCY_LOCALE: Record<string, string> = { mxn: 'es-MX', usd: 'en-US' }

export function formatCents(cents: number, currency = 'MXN'): string {
  const code = normalizeCurrency(currency)
  return new Intl.NumberFormat(CURRENCY_LOCALE[code] ?? 'es-MX', {
    style: 'currency',
    currency: code.toUpperCase(),
  }).format(cents / 100)
}

/** 0.4213 → "42.1%"; null → "—". */
export function formatPct(pct: number | null): string {
  return pct == null ? '—' : `${(pct * 100).toFixed(1)}%`
}
