import { expect, test } from '@playwright/test'
import { PLAN_TARGET_MARGIN_PCT, computePlan, offerEconomics } from '../lib/business-plan/engine'
import { allowedNumbers, explainTemplate, guardExplanation, inputsHash, numbersIn } from '../lib/business-plan/explain'
import type { BusinessInputs, Valued } from '../lib/business-plan/model'
import { solveForPrice } from '../lib/profit'

// business-infrastructure S3.1–S3.3 — the plan engine (D8, D9) and the words over it (D10).

const AT = '2026-11-04T00:00:00.000Z'
const told = (value: number): Valued<number> => ({ value, source: 'told', at: AT })

/** The cook from the pitch: plates at $95 costing $38, 20 minutes of stove each; tamales at $24 costing $14. */
function cook(over: Partial<BusinessInputs> = {}): BusinessInputs {
  return {
    offers: [
      { key: 'p:plato', title: 'Comida corrida', price_cents: told(9500), unit_cost_cents: told(3800), minutes_per_unit: told(20), units_per_month: told(40) },
      { key: 'p:tamal', title: 'Tamal', price_cents: told(2400), unit_cost_cents: told(1400), minutes_per_unit: told(5), units_per_month: told(20) },
    ],
    capacity: { resource: { value: 'la estufa', source: 'told', at: AT }, hours_per_month: told(200) },
    fixed_costs: [{ label: 'Renta', monthly_cents: told(300000) }, { label: 'Gas', monthly_cents: told(90000) }],
    goal_cents: told(1500000),
    ...over,
  }
}

test('per offer: contribution, margin and contribution per hour of the limiting resource', () => {
  const [plato, tamal] = offerEconomics(cook())
  expect(plato).toMatchObject({ contribution_cents: 5700, minutes: 20, contribution_per_hour_cents: 17100 })
  expect(plato.margin_pct).toBeCloseTo(0.6, 5)
  expect(tamal).toMatchObject({ contribution_cents: 1000, contribution_per_hour_cents: 12000 })
  // retired offers are kept in the model, never counted
  const withRetired = cook({ offers: [...cook().offers, { key: 'ex:0', title: 'Ejemplo', price_cents: told(100), unit_cost_cents: told(90), retired: true }] })
  expect(offerEconomics(withRetired).map((o) => o.key)).toEqual(['p:plato', 'p:tamal'])
})

test('volume, break-even and the DEMAND constraint (the stove could make enough, buyers buy too few)', () => {
  const plan = computePlan(cook())
  // mix by units sold: 40 plates, 20 tamales → avg contribution = (40·5700 + 20·1000)/60 = 4133.33
  expect(plan.avg_contribution_cents).toBe(4133)
  expect(plan.fixed_cents).toBe(390000)
  expect(plan.breakeven_units).toBe(Math.ceil(390000 / 4133))
  expect(plan.needed_units).toBe(Math.ceil((390000 + 1500000) / 4133))
  // avg minutes = (40·20 + 20·5)/60 = 15 → 200 h = 12000 min → 800 units (≥ the 458 needed: the stove is not the limit)
  expect(plan.capacity_units).toBe(800)
  expect(plan.current_units).toBe(60)
  expect(plan.constraint).toEqual({ kind: 'demand', needed_units: plan.needed_units, current_units: 60 })
  expect(plan.current_profit_cents).toBe(40 * 5700 + 20 * 1000 - 390000)
  // demand binds → get buyers first, then push the best earner per sale
  expect(plan.moves.map((m) => m.kind)).toEqual(['grow_demand', 'push'])
  expect(plan.moves[0]).toMatchObject({ kind: 'grow_demand', extra_units: (plan.needed_units as number) - 60, href: '/shop/manage/comparte' })
  expect(plan.moves[1]).toMatchObject({ kind: 'push', offer: 'p:plato' })
})

test('the CAPACITY constraint: push what earns most per HOUR, reprice thin margins, say how many hours are missing', () => {
  const plan = computePlan(cook({
    capacity: { resource: { value: 'la estufa', source: 'told', at: AT }, hours_per_month: told(10) },
    offers: [
      { key: 'p:plato', title: 'Comida corrida', price_cents: told(9500), unit_cost_cents: told(3800), minutes_per_unit: told(20), units_per_month: told(30) },
      // 30% margin: thin when you cannot sell more
      { key: 'p:tamal', title: 'Tamal', price_cents: told(2000), unit_cost_cents: told(1400), minutes_per_unit: told(5), units_per_month: told(30) },
    ],
  }))
  expect(plan.constraint.kind).toBe('capacity')
  const kinds = plan.moves.map((m) => m.kind)
  expect(kinds).toContain('reprice')
  expect(kinds).toContain('push')
  const reprice = plan.moves.find((m) => m.kind === 'reprice')!
  // the price comes from the Profit Analyzer's own solver, never a second formula
  const solved = solveForPrice({ cogsCents: 1400, shippingCents: 0, fixedFeeCents: 0, feePct: 0, targetMarginPct: PLAN_TARGET_MARGIN_PCT })
  expect(reprice).toMatchObject({ offer: 'p:tamal', from_cents: 2000, to_cents: solved.achievable ? solved.priceCents : -1, href: '/shop/manage/profit' })
  // the push is the best earner PER HOUR (plates: $171/h vs tamal at $72/h)
  expect(plan.moves.find((m) => m.kind === 'push')).toMatchObject({ offer: 'p:plato' })
  expect(plan.moves.length).toBeLessThanOrEqual(3)
})

test('a loss-maker is paused; an average sale that loses money is "losing", not a volume problem', () => {
  const plan = computePlan(cook({
    offers: [
      { key: 'p:malo', title: 'Pastel', price_cents: told(20000), unit_cost_cents: told(26000), minutes_per_unit: told(60), units_per_month: told(10) },
    ],
  }))
  expect(plan.constraint).toEqual({ kind: 'losing', avg_contribution_cents: -6000 })
  expect(plan.moves[0]).toMatchObject({ kind: 'pause', offer: 'p:malo', loss_per_unit_cents: 6000, href: '/sell/edit/malo' })
  expect(plan.needed_units).toBeNull()
})

test('missing inputs are NAMED, never guessed: no costs, no goal, no sales', () => {
  const noCosts = computePlan({ offers: [{ key: 'p:a', title: 'A', price_cents: told(1000) }], fixed_costs: [] })
  expect(noCosts.constraint).toEqual({ kind: 'inputs', gap: { kind: 'cost', offer: 'p:a', title: 'A' } })
  expect(noCosts.needed_units).toBeNull()
  expect(noCosts.moves[0]).toMatchObject({ kind: 'fill_input' })

  const noGoal = computePlan(cook({ goal_cents: undefined }))
  expect(noGoal.constraint).toEqual({ kind: 'inputs', gap: { kind: 'goal' } })
  expect(noGoal.breakeven_units).not.toBeNull()

  const noSales = computePlan(cook({ offers: cook().offers.map(({ units_per_month: _u, ...o }) => o) }))
  expect(noSales.current_units).toBeNull()
  expect(noSales.constraint).toMatchObject({ kind: 'inputs', gap: { kind: 'units' } })

  const nothing = computePlan({ offers: [], fixed_costs: [] })
  expect(nothing.constraint).toEqual({ kind: 'inputs', gap: { kind: 'offers' } })
})

test('on track: current sales already reach the goal', () => {
  const busy = cook().offers.map((o) => ({ ...o, units_per_month: told(100) }))
  // avg contribution (100·5700 + 100·1000)/200 = 3350; needed (390000 + 200000)/3350 = 177 ≤ 200 sold today
  const plan = computePlan(cook({ offers: busy, goal_cents: told(200000) }))
  expect(plan.constraint).toEqual({ kind: 'none', needed_units: 177, current_units: 200 })
  expect(plan.moves.filter((m) => m.kind === 'grow_demand')).toEqual([])
})

test('the words may only repeat the engine\'s figures — any other number sends the template', () => {
  const plan = computePlan(cook())
  const template = explainTemplate(plan)
  expect(guardExplanation(template, plan)).toBe(template)
  // numbers normalise: "$15,000" == 15000
  expect(numbersIn('Para ganar $15,000 al mes necesitas unas 458 ventas.')).toEqual(['15000', '458'])
  expect(allowedNumbers(plan).has('15000')).toBe(true)
  // an invented figure, a "rounded" break-even, a made-up percentage → rejected
  expect(guardExplanation(`${template} Con eso creces 37% al año.`, plan)).toBeNull()
  expect(guardExplanation(`Necesitas unas ${(plan.needed_units as number) + 1} ventas.`, plan)).toBeNull()
  expect(guardExplanation('', plan)).toBeNull()
  expect(guardExplanation(42, plan)).toBeNull()
})

test('the explanation is cached by its inputs: same inputs, same hash; any change, new hash', () => {
  expect(inputsHash(cook())).toBe(inputsHash(cook()))
  expect(inputsHash(cook({ goal_cents: told(1600000) }))).not.toBe(inputsHash(cook()))
})

test('under a capacity limit the push is the best earner per HOUR, not per sale (the production function)', () => {
  const plan = computePlan(cook({
    capacity: { resource: { value: 'el horno', source: 'told', at: AT }, hours_per_month: told(20) },
    offers: [
      // most per sale ($200), least per hour of oven ($20/h)
      { key: 'p:pastel', title: 'Pastel', price_cents: told(30000), unit_cost_cents: told(10000), minutes_per_unit: told(600), units_per_month: told(2) },
      // less per sale ($57), far more per hour ($171/h)
      { key: 'p:plato', title: 'Comida corrida', price_cents: told(9500), unit_cost_cents: told(3800), minutes_per_unit: told(20), units_per_month: told(10) },
    ],
  }))
  expect(plan.constraint.kind).toBe('capacity')
  expect(plan.moves.find((m) => m.kind === 'push')).toMatchObject({ offer: 'p:plato' })
})
