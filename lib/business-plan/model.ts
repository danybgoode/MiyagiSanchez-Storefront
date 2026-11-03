/**
 * The business model — one per shop, for every merchant (business-infrastructure D6, D7, D11).
 *
 * The model holds the INPUTS of a small business's unit economics: what each offer sells for, what one costs, how long
 * one takes, how many sell a month, the one resource that limits output, the fixed monthly costs, and what the owner
 * wants to earn. It never holds a computed figure: `engine.ts` computes, from this.
 *
 * Every input says where it came from, because the same model serves a shop described a minute ago (all estimates)
 * and a shop with a year of sales (mostly measured):
 *
 *   estimated — the AI proposed it from the description. Shown «estimado».
 *   told      — the merchant typed it. Never overwritten by an estimate, and by a measurement only when they confirm.
 *   measured  — read from the shop's own catalog costs and sales ledger.
 *
 * Unknown is not zero (LEARNINGS: never collapse "unknown" into "none"): a missing cost is ABSENT and named as a gap,
 * so the plan can say "falta tu costo" instead of computing a margin on $0.
 *
 * Pure: no I/O, no `next/*`, so the `api` spec runner imports it directly.
 */

export const SOURCES = ['estimated', 'told', 'measured'] as const
export type Source = (typeof SOURCES)[number]

export interface Valued<T> {
  value: T
  source: Source
  /** ISO date the value was set; a measured value is as fresh as its read. */
  at: string
}

/** One thing the business sells: a product, a service, a dish, a rental. */
export interface OfferInput {
  /** Stable key: `p:<medusa product id>` for a real product, `ex:<n>` for the nth draft example. */
  key: string
  title: string
  price_cents?: Valued<number>
  unit_cost_cents?: Valued<number>
  /** Minutes of the limiting resource one unit takes (see `CapacityInput`). */
  minutes_per_unit?: Valued<number>
  /** Units sold in a typical month. */
  units_per_month?: Valued<number>
}

/** The one resource that limits how much the business can make (the oven, the owner's hours, the van). */
export interface CapacityInput {
  resource: Valued<string>
  hours_per_month?: Valued<number>
}

export interface FixedCostInput {
  label: string
  monthly_cents: Valued<number>
}

export interface BusinessInputs {
  offers: OfferInput[]
  capacity?: CapacityInput
  fixed_costs: FixedCostInput[]
  /** What the owner wants to take home a month, after costs. */
  goal_cents?: Valued<number>
}

export const EMPTY_INPUTS: BusinessInputs = { offers: [], fixed_costs: [] }

/**
 * How many units sold, at least, before a measured figure replaces an estimate. Below it, a month of sales is noise:
 * one sale at a launch discount would otherwise overwrite a sensible estimated price. Three is the smallest count
 * that is more than one data point and still reachable by a brand-new shop in its first weeks.
 */
export const MEASURED_MIN_UNITS = 3

/** Limits a stored input must respect — the same ones every write path checks, so a bad row cannot poison the plan. */
export const INPUT_LIMITS = {
  maxOffers: 40,
  maxFixedCosts: 12,
  maxCents: 100_000_000, // $1,000,000 MXN: a micro-business plan, not a ledger
  maxMinutesPerUnit: 60 * 24 * 30,
  maxUnitsPerMonth: 1_000_000,
  maxHoursPerMonth: 24 * 31,
  maxLabel: 80,
  maxTitle: 120,
} as const

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isSource = (v: unknown): v is Source => typeof v === 'string' && (SOURCES as readonly string[]).includes(v)
const cleanText = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()
  return t && t.length <= max ? t : null
}

function readNumber(v: unknown, max: number): Valued<number> | undefined {
  if (!isObj(v) || !isSource(v.source) || typeof v.at !== 'string') return undefined
  const n = v.value
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > max) return undefined
  return { value: n, source: v.source, at: v.at }
}

/**
 * Read a stored `inputs` jsonb defensively. Anything malformed is DROPPED (absent = a named gap), never coerced to 0.
 * This is the only door from the database into the engine.
 */
export function readInputs(raw: unknown): BusinessInputs {
  if (!isObj(raw)) return { ...EMPTY_INPUTS }
  const offers: OfferInput[] = []
  for (const o of Array.isArray(raw.offers) ? raw.offers.slice(0, INPUT_LIMITS.maxOffers) : []) {
    if (!isObj(o)) continue
    const key = cleanText(o.key, 80)
    const title = cleanText(o.title, INPUT_LIMITS.maxTitle)
    if (!key || !title) continue
    offers.push({
      key,
      title,
      price_cents: readNumber(o.price_cents, INPUT_LIMITS.maxCents),
      unit_cost_cents: readNumber(o.unit_cost_cents, INPUT_LIMITS.maxCents),
      minutes_per_unit: readNumber(o.minutes_per_unit, INPUT_LIMITS.maxMinutesPerUnit),
      units_per_month: readNumber(o.units_per_month, INPUT_LIMITS.maxUnitsPerMonth),
    })
  }
  const fixed_costs: FixedCostInput[] = []
  for (const f of Array.isArray(raw.fixed_costs) ? raw.fixed_costs.slice(0, INPUT_LIMITS.maxFixedCosts) : []) {
    if (!isObj(f)) continue
    const label = cleanText(f.label, INPUT_LIMITS.maxLabel)
    const monthly = readNumber(f.monthly_cents, INPUT_LIMITS.maxCents)
    if (label && monthly) fixed_costs.push({ label, monthly_cents: monthly })
  }
  let capacity: CapacityInput | undefined
  if (isObj(raw.capacity) && isObj(raw.capacity.resource) && isSource(raw.capacity.resource.source)) {
    const name = cleanText(raw.capacity.resource.value, INPUT_LIMITS.maxLabel)
    if (name && typeof raw.capacity.resource.at === 'string') {
      capacity = {
        resource: { value: name, source: raw.capacity.resource.source, at: raw.capacity.resource.at },
        hours_per_month: readNumber(raw.capacity.hours_per_month, INPUT_LIMITS.maxHoursPerMonth),
      }
    }
  }
  return { offers, fixed_costs, capacity, goal_cents: readNumber(raw.goal_cents, INPUT_LIMITS.maxCents) }
}

/**
 * The provenance rule for ONE value (D7):
 *   - a merchant's own number (`told`) is never replaced by an estimate, nor by a measurement unless they confirm;
 *   - a measurement replaces an estimate only when enough sales back it (`backedBy` ≥ MEASURED_MIN_UNITS);
 *   - an incoming value with no current one is simply taken;
 *   - an absent incoming value never erases a current one.
 */
export function mergeValue<T>(
  current: Valued<T> | undefined,
  incoming: Valued<T> | undefined,
  opts: { backedBy?: number; confirmed?: boolean } = {},
): Valued<T> | undefined {
  if (!incoming) return current
  // Same value from the same source: keep what is stored, date included. Re-stamping it would make every visit look
  // like a change — a write per page view, and a fresh model explanation each time (PR #467).
  if (current && current.source === incoming.source && current.value === incoming.value) return current
  if (!current) return incoming.source === 'measured' && (opts.backedBy ?? Infinity) < MEASURED_MIN_UNITS ? undefined : incoming
  if (incoming.source === 'told') return incoming
  if (current.source === 'told') return incoming.source === 'measured' && opts.confirmed ? incoming : current
  if (incoming.source === 'measured') {
    return (opts.backedBy ?? Infinity) >= MEASURED_MIN_UNITS ? incoming : current
  }
  // estimated over estimated: the newer estimate wins; estimated never replaces measured.
  return current.source === 'measured' ? current : incoming
}

/** The gaps the plan names instead of guessing, in the order a merchant should fill them. */
export type Gap =
  | { kind: 'price'; offer: string; title: string }
  | { kind: 'cost'; offer: string; title: string }
  | { kind: 'minutes'; offer: string; title: string }
  | { kind: 'capacity' }
  | { kind: 'goal' }

export function gapsOf(inputs: BusinessInputs): Gap[] {
  const gaps: Gap[] = []
  if (!inputs.goal_cents) gaps.push({ kind: 'goal' })
  for (const o of inputs.offers) {
    if (!o.price_cents) gaps.push({ kind: 'price', offer: o.key, title: o.title })
    if (!o.unit_cost_cents) gaps.push({ kind: 'cost', offer: o.key, title: o.title })
  }
  if (inputs.capacity) {
    if (!inputs.capacity.hours_per_month) gaps.push({ kind: 'capacity' })
    for (const o of inputs.offers) if (!o.minutes_per_unit) gaps.push({ kind: 'minutes', offer: o.key, title: o.title })
  } else {
    gaps.push({ kind: 'capacity' })
  }
  return gaps
}

// ── Seeding ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the draft's `numbers` block holds (estimates only; see `lib/prompt-to-shop/numbers.ts`). */
export interface DraftNumbers {
  /**
   * Keyed by the example's TITLE, not its index: a photo confirm removes the example it replaces from the draft's
   * catalog, which shifts every index after it — an index key would hand one product another's cost.
   */
  offers: Array<{ title: string; unit_cost: number; minutes_per_unit: number }>
  capacity: { resource: string; hours_per_month: number } | null
  fixed_costs: Array<{ label: string; monthly: number }>
}

const pesosToCents = (pesos: number) => Math.round(pesos * 100)

/**
 * A kept draft → the first model. Every value is `estimated`, dated `at`. Offers are the draft's examples (by index);
 * their price is the example's suggested price. A model with no numbers block still gets its offers and prices.
 */
export function seedFromDraft(
  catalog: Array<{ title: string; price?: number | null }> | null,
  numbers: DraftNumbers | null,
  at: string,
): BusinessInputs {
  const est = <T>(value: T): Valued<T> => ({ value, source: 'estimated', at })
  const offers: OfferInput[] = (catalog ?? []).slice(0, INPUT_LIMITS.maxOffers).map((row, i) => {
    const n = numbers?.offers.find((o) => o.title === row.title)
    return {
      key: `ex:${i}`,
      title: row.title.slice(0, INPUT_LIMITS.maxTitle),
      ...(typeof row.price === 'number' && row.price > 0 ? { price_cents: est(pesosToCents(row.price)) } : {}),
      ...(n ? { unit_cost_cents: est(pesosToCents(n.unit_cost)), minutes_per_unit: est(n.minutes_per_unit) } : {}),
    }
  })
  return {
    offers,
    fixed_costs: (numbers?.fixed_costs ?? []).slice(0, INPUT_LIMITS.maxFixedCosts).map((f) => ({ label: f.label, monthly_cents: est(pesosToCents(f.monthly)) })),
    ...(numbers?.capacity ? { capacity: { resource: est(numbers.capacity.resource), hours_per_month: est(numbers.capacity.hours_per_month) } } : {}),
  }
}

/** A product of the shop as the seller-scoped products read returns it (first variant only, like COGS itself). */
export interface ShopProduct {
  id: string
  title: string
  status?: string | null
  price_cents: number | null
  unit_cost_cents: number | null
  /** The prompt-to-shop example this product replaced (`metadata.p2s_example`), when it was created from a photo. */
  replaces_example?: string | null
}

/** Units and revenue per product over the read window, from the profit ledger (`sales.ts` builds it). */
export interface ProductSales {
  product_id: string
  units: number
  revenue_cents: number
}

/**
 * A live shop → its measured inputs, merged into what is already stored (D11). Real products become offers keyed
 * `p:<id>`; draft examples (`ex:*`) that no real product replaced stay as they were, so a half-built shop keeps its
 * estimates. Prices and costs on the catalog are `measured` (the merchant set them on the product); monthly units and
 * the realised average price are `measured` only with MEASURED_MIN_UNITS sales behind them.
 */
export function mergeShop(
  stored: BusinessInputs,
  products: ShopProduct[],
  sales: ProductSales[],
  window: { months: number; at: string },
): BusinessInputs {
  const at = window.at
  const meas = <T>(value: T): Valued<T> => ({ value, source: 'measured', at })
  const byKey = new Map(stored.offers.map((o) => [o.key, o]))
  const live = products.filter((p) => p.status !== 'deleted').slice(0, INPUT_LIMITS.maxOffers)
  const offers: OfferInput[] = live.map((p) => {
    const key = `p:${p.id}`
    const prev = byKey.get(key)
    const s = sales.find((x) => x.product_id === p.id)
    const units = s?.units ?? 0
    const months = Math.max(1, window.months)
    // A product made from a photo inherits the ESTIMATES of the example it replaced (still `estimated`): its cost and
    // minutes until the merchant types their own or sets a cost on the product (D4, amended).
    const example = !prev && p.replaces_example ? stored.offers.find((o) => o.key.startsWith('ex:') && o.title === p.replaces_example) : undefined
    const base = prev ?? (example ? { unit_cost_cents: example.unit_cost_cents, minutes_per_unit: example.minutes_per_unit } : undefined)
    return {
      key,
      title: p.title.slice(0, INPUT_LIMITS.maxTitle),
      // The catalog price is what the merchant set: it backs itself, no sales threshold.
      price_cents: mergeValue(prev?.price_cents, p.price_cents != null ? meas(p.price_cents) : undefined, { backedBy: Infinity }),
      unit_cost_cents: mergeValue(base?.unit_cost_cents, p.unit_cost_cents != null ? meas(p.unit_cost_cents) : undefined, { backedBy: Infinity }),
      minutes_per_unit: base?.minutes_per_unit,
      units_per_month: mergeValue(prev?.units_per_month, s ? meas(Math.round((units / months) * 10) / 10) : undefined, { backedBy: units }),
    }
  })
  // Examples are the plan's stand-ins until the merchant's own products exist. One a real product replaced (by photo)
  // is gone; the rest stay only while the shop has fewer real offers than examples, so nothing is counted twice.
  const replaced = new Set(live.map((p) => p.replaces_example).filter((t): t is string => !!t))
  const remaining = stored.offers.filter((o) => o.key.startsWith('ex:') && !replaced.has(o.title))
  const otherReal = live.filter((p) => !p.replaces_example).length
  const examples = remaining.slice(0, Math.max(0, remaining.length - otherReal))
  return { ...stored, offers: [...offers, ...examples].slice(0, INPUT_LIMITS.maxOffers) }
}
