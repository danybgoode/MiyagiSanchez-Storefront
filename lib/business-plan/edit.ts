/**
 * A merchant's own numbers → `told` inputs (business-infrastructure D7). Pure: the route parses, this decides.
 *
 * Every number the merchant types arrives in PESOS (or hours/minutes/units) and is stored in cents with source `told`.
 * A told value is never overwritten by an estimate later (`mergeValue`), so what they type stands.
 *
 * Clearing a value (null) removes the merchant's override and leaves the gap named — it never stores 0 for "unknown".
 * An explicit 0 is stored as 0: a service with no material cost is a real 0, not a missing one.
 */

import { INPUT_LIMITS, type BusinessInputs, type OfferInput, type Valued } from './model'

export type OfferField = 'price' | 'cost' | 'minutes' | 'units'

export interface PlanEdit {
  /** The `updated_at` the page read — the write's precondition. */
  updated_at: string
  offers?: Array<{ key: string; field: OfferField; value: number | null }>
  capacity?: { resource: string; hours_per_month: number | null } | null
  fixed_costs?: Array<{ label: string; monthly: number }>
  /** Pesos a month the owner wants to take home; null clears it. */
  goal?: number | null
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const FIELDS: readonly OfferField[] = ['price', 'cost', 'minutes', 'units']
const MAX_PESOS = INPUT_LIMITS.maxCents / 100

const finite = (v: unknown, max: number): number | null | undefined =>
  v === null ? null : typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined
const label = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()
  return t && t.length <= max ? t : null
}

const FIELD_MAX: Record<OfferField, number> = {
  price: MAX_PESOS,
  cost: MAX_PESOS,
  minutes: INPUT_LIMITS.maxMinutesPerUnit,
  units: INPUT_LIMITS.maxUnitsPerMonth,
}

/** Parse the body; anything malformed is a null (a 400), never a partial save. */
export function parsePlanEdit(body: unknown): PlanEdit | null {
  if (!isObj(body) || typeof body.updated_at !== 'string' || !body.updated_at) return null
  const out: PlanEdit = { updated_at: body.updated_at }
  if (body.offers !== undefined) {
    if (!Array.isArray(body.offers) || body.offers.length > INPUT_LIMITS.maxOffers * FIELDS.length) return null
    out.offers = []
    for (const o of body.offers) {
      if (!isObj(o) || typeof o.key !== 'string' || !FIELDS.includes(o.field as OfferField)) return null
      const value = finite(o.value, FIELD_MAX[o.field as OfferField])
      if (value === undefined) return null
      out.offers.push({ key: o.key, field: o.field as OfferField, value })
    }
  }
  if (body.capacity !== undefined) {
    if (body.capacity === null) out.capacity = null
    else {
      if (!isObj(body.capacity)) return null
      const resource = label(body.capacity.resource, INPUT_LIMITS.maxLabel)
      const hours = finite(body.capacity.hours_per_month, INPUT_LIMITS.maxHoursPerMonth)
      if (!resource || hours === undefined) return null
      out.capacity = { resource, hours_per_month: hours }
    }
  }
  if (body.fixed_costs !== undefined) {
    if (!Array.isArray(body.fixed_costs) || body.fixed_costs.length > INPUT_LIMITS.maxFixedCosts) return null
    out.fixed_costs = []
    for (const f of body.fixed_costs) {
      if (!isObj(f)) return null
      const l = label(f.label, INPUT_LIMITS.maxLabel)
      const monthly = finite(f.monthly, MAX_PESOS)
      if (!l || monthly === undefined || monthly === null) return null
      out.fixed_costs.push({ label: l, monthly })
    }
  }
  if (body.goal !== undefined) {
    const goal = finite(body.goal, MAX_PESOS)
    if (goal === undefined) return null
    out.goal = goal
  }
  const touches = out.offers?.length || out.capacity !== undefined || out.fixed_costs !== undefined || out.goal !== undefined
  return touches ? out : null
}

const toCents = (pesos: number) => Math.round(pesos * 100)

function setField(o: OfferInput, field: OfferField, value: number | null, at: string): OfferInput | null {
  const told = (v: number): Valued<number> => ({ value: v, source: 'told', at })
  const key = ({ price: 'price_cents', cost: 'unit_cost_cents', minutes: 'minutes_per_unit', units: 'units_per_month' } as const)[field]
  const stored = value === null ? undefined : told(field === 'price' || field === 'cost' ? toCents(value) : value)
  // A zero price is not a price (division by it is the break-even): refuse it rather than store it.
  if (field === 'price' && stored && stored.value === 0) return null
  if (field === 'minutes' && stored && stored.value === 0) return null
  const next = { ...o }
  if (stored) next[key] = stored
  else delete next[key]
  return next
}

/** Apply an edit, or null when it names an offer the model does not have (stale page) or a refused value. */
export function applyPlanEdit(inputs: BusinessInputs, edit: PlanEdit, at: string): BusinessInputs | null {
  let offers = inputs.offers
  for (const change of edit.offers ?? []) {
    const i = offers.findIndex((o) => o.key === change.key)
    if (i === -1) return null
    const updated = setField(offers[i], change.field, change.value, at)
    if (!updated) return null
    offers = offers.map((o, j) => (j === i ? updated : o))
  }
  const next: BusinessInputs = { ...inputs, offers }
  // A section is sent whole, but only what the merchant CHANGED becomes theirs: an untouched estimate keeps its
  // «estimado» label (PR #467 review — re-sending a list must not launder the AI's numbers into the merchant's own).
  if (edit.capacity !== undefined) {
    if (edit.capacity === null) delete next.capacity
    else {
      const prev = inputs.capacity
      const hours = edit.capacity.hours_per_month
      next.capacity = {
        resource: prev && prev.resource.value === edit.capacity.resource ? prev.resource : { value: edit.capacity.resource, source: 'told', at },
        ...(hours === null
          ? {}
          : { hours_per_month: prev?.hours_per_month && prev.hours_per_month.value === hours ? prev.hours_per_month : { value: hours, source: 'told' as const, at } }),
      }
    }
  }
  if (edit.fixed_costs !== undefined) {
    next.fixed_costs = edit.fixed_costs.map((f) => {
      const cents = toCents(f.monthly)
      const same = inputs.fixed_costs.find((p) => p.label === f.label && p.monthly_cents.value === cents)
      return same ?? { label: f.label, monthly_cents: { value: cents, source: 'told' as const, at } }
    })
  }
  if (edit.goal !== undefined) {
    if (edit.goal === null) delete next.goal_cents
    else next.goal_cents = { value: toCents(edit.goal), source: 'told', at }
  }
  return next
}
