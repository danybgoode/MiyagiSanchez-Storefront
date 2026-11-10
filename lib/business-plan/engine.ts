/**
 * The plan engine (business-infrastructure D8, D9) — the ONLY place a plan figure is computed.
 *
 * From the business model's inputs it computes, per offer: contribution (price − cost), margin, contribution per hour
 * of the limiting resource; for the business: the monthly contribution needed to cover fixed costs (break-even) and
 * the owner's goal, the volume that takes at the current mix, the volume the limiting resource allows, the volume sold
 * today, and which one BINDS:
 *
 *   capacity — the goal needs more units than the resource can make: sell what earns most per hour, or earn more per unit
 *   demand   — the resource could make enough, but buyers buy fewer than needed: get more buyers
 *   inputs   — the comparison cannot be made yet: name the ONE number to fill first (never guess it)
 *   none     — current sales already reach the goal
 *
 * Then up to three MOVES, each a typed suggestion that only LINKS to an existing page (D9): nothing applies itself.
 * Prices come from `solveForPrice` in `lib/profit.ts`, imported — never a second formula (D8).
 *
 * Pure: no I/O, no `next/*`, no model. The words that explain this are written elsewhere (`explain.ts`) and may only
 * repeat figures this function produced.
 */

import { MARGIN_KILLER_THRESHOLD_PCT, UNDERPRICED_MARGIN_THRESHOLD_PCT, solveForPrice } from '../profit'
import { activeOffers, gapsOf, type BusinessInputs, type Gap } from './model'

/**
 * The margin a reprice aims for. Between the Profit Analyzer's "margin killer" floor (5%) and its "healthy" line (40%):
 * 35% leaves a micro-business room for waste, discounts and its own time without pricing it out of its street.
 */
export const PLAN_TARGET_MARGIN_PCT = 0.35
export const MAX_MOVES = 3

export interface OfferEconomics {
  key: string
  title: string
  price_cents: number | null
  cost_cents: number | null
  contribution_cents: number | null
  /** 0..1 */
  margin_pct: number | null
  minutes: number | null
  /** Contribution per hour of the limiting resource — the production function's "what earns most per hour". */
  contribution_per_hour_cents: number | null
  units_per_month: number | null
}

export type Constraint =
  | { kind: 'capacity'; needed_units: number; capacity_units: number }
  | { kind: 'demand'; needed_units: number; current_units: number }
  | { kind: 'inputs'; gap: Gap }
  /** At the current mix the average sale loses money: more sales make it worse, so volume is not the answer. */
  | { kind: 'losing'; avg_contribution_cents: number }
  | { kind: 'none'; needed_units: number; current_units: number }

export type Move =
  | { kind: 'reprice'; offer: string; title: string; from_cents: number; to_cents: number; gain_per_unit_cents: number; href: string }
  | { kind: 'pause'; offer: string; title: string; loss_per_unit_cents: number; href: string }
  | { kind: 'push'; offer: string; title: string; contribution_cents: number; per_hour_cents: number | null; href: string }
  | { kind: 'grow_demand'; extra_units: number; href: string }
  | { kind: 'raise_capacity'; resource: string; extra_hours: number; href: string }
  | { kind: 'fill_input'; gap: Gap; href: string }

export interface Plan {
  offers: OfferEconomics[]
  fixed_cents: number
  goal_cents: number | null
  /** Weighted by the current sales mix when known, else equal across complete offers. */
  avg_contribution_cents: number | null
  avg_minutes: number | null
  breakeven_units: number | null
  needed_units: number | null
  capacity_units: number | null
  current_units: number | null
  /** Contribution today minus fixed costs: what the owner takes home now, when sales are known. */
  current_profit_cents: number | null
  constraint: Constraint
  moves: Move[]
  gaps: Gap[]
}

const productId = (key: string) => (key.startsWith('p:') ? key.slice(2) : null)
const PLAN_HREF = '/shop/manage/plan'

export function offerEconomics(inputs: BusinessInputs): OfferEconomics[] {
  // Retired offers (superseded examples, products the last read did not return) are kept in the model, never counted.
  return activeOffers(inputs).map((o) => {
    const price = o.price_cents?.value ?? null
    const cost = o.unit_cost_cents?.value ?? null
    const minutes = o.minutes_per_unit?.value ?? null
    const contribution = price != null && cost != null ? price - cost : null
    return {
      key: o.key,
      title: o.title,
      price_cents: price,
      cost_cents: cost,
      contribution_cents: contribution,
      margin_pct: contribution != null && price ? contribution / price : null,
      minutes,
      contribution_per_hour_cents: contribution != null && minutes ? Math.round((contribution * 60) / minutes) : null,
      units_per_month: o.units_per_month?.value ?? null,
    }
  })
}

/** The weights of the current mix: units sold when any are known, else equal across complete offers. */
function mixOf(complete: OfferEconomics[]): Array<{ o: OfferEconomics; w: number }> {
  const sold = complete.filter((o) => (o.units_per_month ?? 0) > 0)
  const total = sold.reduce((s, o) => s + (o.units_per_month ?? 0), 0)
  if (total > 0) return sold.map((o) => ({ o, w: (o.units_per_month ?? 0) / total }))
  return complete.map((o) => ({ o, w: 1 / complete.length }))
}

export function computePlan(inputs: BusinessInputs): Plan {
  const offers = offerEconomics(inputs)
  const gaps = gapsOf(inputs)
  const fixed_cents = inputs.fixed_costs.reduce((s, f) => s + f.monthly_cents.value, 0)
  const goal_cents = inputs.goal_cents?.value ?? null
  const complete = offers.filter((o) => o.contribution_cents != null)
  const mix = complete.length ? mixOf(complete) : []

  const avg_contribution_cents = mix.length ? Math.round(mix.reduce((s, m) => s + m.w * (m.o.contribution_cents ?? 0), 0)) : null
  const timed = mix.filter((m) => m.o.minutes != null)
  const avg_minutes = timed.length === mix.length && mix.length ? mix.reduce((s, m) => s + m.w * (m.o.minutes ?? 0), 0) : null

  const known = offers.filter((o) => o.units_per_month != null)
  const current_units = known.length ? Math.round(known.reduce((s, o) => s + (o.units_per_month ?? 0), 0)) : null
  const current_contribution = known.length && known.every((o) => o.contribution_cents != null)
    ? known.reduce((s, o) => s + (o.units_per_month ?? 0) * (o.contribution_cents ?? 0), 0)
    : null
  const current_profit_cents = current_contribution != null ? Math.round(current_contribution - fixed_cents) : null

  const positive = avg_contribution_cents != null && avg_contribution_cents > 0
  const breakeven_units = positive ? Math.ceil(fixed_cents / avg_contribution_cents) : null
  const needed_units = positive && goal_cents != null ? Math.ceil((fixed_cents + goal_cents) / avg_contribution_cents) : null
  const hours = inputs.capacity?.hours_per_month?.value ?? null
  const capacity_units = hours != null && avg_minutes ? Math.floor((hours * 60) / avg_minutes) : null

  const constraint = decideConstraint({ gaps, positive, avg_contribution_cents, needed_units, capacity_units, current_units, offers })
  const moves = decideMoves({ offers, constraint, inputs, avg_minutes })

  return {
    offers, fixed_cents, goal_cents, avg_contribution_cents, avg_minutes, breakeven_units, needed_units,
    capacity_units, current_units, current_profit_cents, constraint, moves, gaps,
  }
}

function decideConstraint(p: {
  gaps: Gap[]
  positive: boolean
  avg_contribution_cents: number | null
  needed_units: number | null
  capacity_units: number | null
  current_units: number | null
  offers: OfferEconomics[]
}): Constraint {
  const firstGap = (kinds: Gap['kind'][]) => p.gaps.find((g) => kinds.includes(g.kind))
  if (p.avg_contribution_cents == null) return { kind: 'inputs', gap: firstGap(['offers', 'price', 'cost']) ?? { kind: 'offers' } }
  if (!p.positive) return { kind: 'losing', avg_contribution_cents: p.avg_contribution_cents }
  if (p.needed_units == null) return { kind: 'inputs', gap: firstGap(['goal']) ?? { kind: 'goal' } }
  // Capacity must be COMPARED before anything is said about it: with no limit or a missing time, "your limit is
  // enough" would be a guess (D8; PR #468 review). Name the number instead.
  if (p.capacity_units == null) return { kind: 'inputs', gap: firstGap(['capacity', 'minutes']) ?? { kind: 'capacity' } }
  if (p.needed_units > p.capacity_units) {
    return { kind: 'capacity', needed_units: p.needed_units, capacity_units: p.capacity_units }
  }
  if (p.current_units == null) {
    // Without today's sales we cannot tell demand from fine. Say which number to fill; never assume zero sales.
    const unitsGap: Gap | null = p.offers[0] ? { kind: 'units', offer: p.offers[0].key, title: p.offers[0].title } : null
    return { kind: 'inputs', gap: unitsGap ?? { kind: 'capacity' } }
  }
  if (p.current_units < p.needed_units) return { kind: 'demand', needed_units: p.needed_units, current_units: p.current_units }
  return { kind: 'none', needed_units: p.needed_units, current_units: p.current_units }
}

function repriceTo(cost: number): number | null {
  const r = solveForPrice({ cogsCents: cost, shippingCents: 0, fixedFeeCents: 0, feePct: 0, targetMarginPct: PLAN_TARGET_MARGIN_PCT })
  return r.achievable ? r.priceCents : null
}

function decideMoves(p: { offers: OfferEconomics[]; constraint: Constraint; inputs: BusinessInputs; avg_minutes: number | null }): Move[] {
  const moves: Move[] = []
  const editHref = (o: OfferEconomics) => (productId(o.key) ? `/sell/edit/${productId(o.key)}` : '/sell/armar')

  // 1. Anything sold at a loss: pause it (when it is a real product) — every unit makes the goal further away.
  for (const o of p.offers) {
    if (o.contribution_cents != null && o.contribution_cents < 0 && productId(o.key)) {
      moves.push({ kind: 'pause', offer: o.key, title: o.title, loss_per_unit_cents: -o.contribution_cents, href: editHref(o) })
    }
  }

  // 2. Reprice: a margin killer always; an under-40% margin when capacity binds (you cannot sell more, so earn more).
  const repriceLine = p.constraint.kind === 'capacity' ? UNDERPRICED_MARGIN_THRESHOLD_PCT : MARGIN_KILLER_THRESHOLD_PCT
  const reprices = p.offers
    // Only real products: an example has no price to change yet (its move is to become a product).
    .filter((o) => productId(o.key) && o.margin_pct != null && o.contribution_cents != null && o.contribution_cents >= 0 && o.margin_pct < repriceLine && o.cost_cents != null && o.price_cents != null)
    .map((o) => ({ o, to: repriceTo(o.cost_cents as number) }))
    .filter((r): r is { o: OfferEconomics; to: number } => r.to != null && r.to > (r.o.price_cents as number))
    .sort((a, b) => (b.to - (b.o.price_cents as number)) * Math.max(1, b.o.units_per_month ?? 1) - (a.to - (a.o.price_cents as number)) * Math.max(1, a.o.units_per_month ?? 1))
  for (const { o, to } of reprices) {
    moves.push({
      kind: 'reprice', offer: o.key, title: o.title, from_cents: o.price_cents as number, to_cents: to,
      gain_per_unit_cents: to - (o.price_cents as number),
      // The product's own editor changes its price for any product; «Ganancias» only shows a price card for SKUs that
      // already sold (PR #468 review).
      href: editHref(o),
    })
  }

  // 3. The constraint's own move.
  const best = (by: 'per_hour' | 'per_unit') =>
    p.offers
      .filter((o) => o.contribution_cents != null && o.contribution_cents > 0 && (by === 'per_unit' || o.contribution_per_hour_cents != null))
      .sort((a, b) => (by === 'per_hour' ? (b.contribution_per_hour_cents ?? 0) - (a.contribution_per_hour_cents ?? 0) : (b.contribution_cents ?? 0) - (a.contribution_cents ?? 0)))[0]

  const c = p.constraint
  if (c.kind === 'capacity') {
    const top = best('per_hour')
    if (top) moves.push({ kind: 'push', offer: top.key, title: top.title, contribution_cents: top.contribution_cents as number, per_hour_cents: top.contribution_per_hour_cents, href: '/shop/manage/comparte' })
    const resource = p.inputs.capacity?.resource.value
    if (resource && p.avg_minutes) {
      const extra_hours = Math.ceil(((c.needed_units - c.capacity_units) * p.avg_minutes) / 60)
      moves.push({ kind: 'raise_capacity', resource, extra_hours, href: `${PLAN_HREF}#plan-capacity` })
    }
  } else if (c.kind === 'demand') {
    moves.push({ kind: 'grow_demand', extra_units: c.needed_units - c.current_units, href: '/shop/manage/comparte' })
    const top = best('per_unit')
    // Demand binds, not the resource: the push is "per sale", never "per hour of your limit".
    if (top) moves.push({ kind: 'push', offer: top.key, title: top.title, contribution_cents: top.contribution_cents as number, per_hour_cents: null, href: '/shop/manage/comparte' })
  } else if (c.kind === 'inputs') {
    moves.unshift({ kind: 'fill_input', gap: c.gap, href: PLAN_HREF })
  }

  // One move per offer: the first (most important) wins, so the list never says two things about the same product.
  const seen = new Set<string>()
  return moves.filter((m) => {
    const key = 'offer' in m ? m.offer : m.kind
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, MAX_MOVES)
}
