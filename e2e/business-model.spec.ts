import { expect, test } from '@playwright/test'
import {
  MEASURED_MIN_UNITS,
  gapsOf,
  mergeShop,
  mergeValue,
  readInputs,
  seedFromDraft,
  type BusinessInputs,
  type Valued,
} from '../lib/business-plan/model'
import { productsFrom, salesFrom, windowMonths } from '../lib/business-plan/sales'
import { applyPlanEdit, parsePlanEdit } from '../lib/business-plan/edit'
import type { ProfitEvent, ProfitOrderInfo } from '../lib/profit'

// business-infrastructure S2.1 + S2.3 — one business model per shop, every input with its source (epic D6, D7, D11).

const AT = '2026-11-04T00:00:00.000Z'
const v = (value: number, source: Valued<number>['source']): Valued<number> => ({ value, source, at: AT })

test('provenance: told beats estimated; measured needs enough sales; absent never erases', () => {
  // told always wins over an estimate, and an estimate never replaces a told value
  expect(mergeValue(v(100, 'estimated'), v(80, 'told'))?.value).toBe(80)
  expect(mergeValue(v(80, 'told'), v(100, 'estimated'))?.value).toBe(80)
  // a measurement replaces a told value only when the merchant confirms it
  expect(mergeValue(v(80, 'told'), v(90, 'measured'), { backedBy: 50 })?.value).toBe(80)
  expect(mergeValue(v(80, 'told'), v(90, 'measured'), { backedBy: 50, confirmed: true })?.value).toBe(90)
  // a measurement replaces an estimate only past the threshold
  expect(mergeValue(v(100, 'estimated'), v(90, 'measured'), { backedBy: MEASURED_MIN_UNITS - 1 })?.source).toBe('estimated')
  expect(mergeValue(v(100, 'estimated'), v(90, 'measured'), { backedBy: MEASURED_MIN_UNITS })?.source).toBe('measured')
  // and an estimate never replaces a measurement
  expect(mergeValue(v(90, 'measured'), v(100, 'estimated'))?.source).toBe('measured')
  // absent incoming keeps what is there; a thin measurement with nothing there is NOT taken
  expect(mergeValue(v(5, 'told'), undefined)?.value).toBe(5)
  expect(mergeValue(undefined, v(1, 'measured'), { backedBy: 1 })).toBeUndefined()
})

test('a stored model is read defensively: malformed values are dropped (a named gap), never coerced to zero', () => {
  const read = readInputs({
    offers: [
      { key: 'p:1', title: 'Tamal', price_cents: { value: 3500, source: 'measured', at: AT }, unit_cost_cents: { value: -5, source: 'told', at: AT } },
      { key: 'p:2', title: '' },
      'nonsense',
    ],
    fixed_costs: [{ label: 'Gas', monthly_cents: { value: 90000, source: 'estimated', at: AT } }, { label: 'Renta', monthly_cents: { value: 'mucho', source: 'told', at: AT } }],
    goal_cents: { value: 1500000, source: 'bogus', at: AT },
  })
  expect(read.offers).toHaveLength(1)
  expect(read.offers[0].price_cents?.value).toBe(3500)
  expect(read.offers[0].unit_cost_cents).toBeUndefined()
  expect(read.fixed_costs.map((f) => f.label)).toEqual(['Gas'])
  expect(read.goal_cents).toBeUndefined()
  expect(readInputs(null)).toEqual({ offers: [], fixed_costs: [] })
  // what is missing is named
  const gaps = gapsOf(read)
  expect(gaps).toContainEqual({ kind: 'goal' })
  expect(gaps).toContainEqual({ kind: 'cost', offer: 'p:1', title: 'Tamal' })
  expect(gaps).toContainEqual({ kind: 'capacity' })
})

test('a kept draft seeds the model: examples become offers, every value estimated, matched by TITLE', () => {
  const seeded = seedFromDraft(
    [{ title: 'Tamal verde', price: 35 }, { title: 'Atole', price: 25 }],
    {
      // the order differs from the catalog on purpose: numbers are keyed by title, not position
      offers: [{ title: 'Atole', unit_cost: 6, minutes_per_unit: 4 }, { title: 'Tamal verde', unit_cost: 12, minutes_per_unit: 10 }],
      capacity: { resource: 'la vaporera', hours_per_month: 80 },
      fixed_costs: [{ label: 'Gas', monthly: 900 }],
    },
    AT,
  )
  expect(seeded.offers.map((o) => [o.key, o.title, o.price_cents?.value, o.unit_cost_cents?.value, o.minutes_per_unit?.value])).toEqual([
    ['ex:0', 'Tamal verde', 3500, 1200, 10],
    ['ex:1', 'Atole', 2500, 600, 4],
  ])
  expect(seeded.offers.every((o) => o.price_cents?.source === 'estimated')).toBe(true)
  expect(seeded.capacity?.hours_per_month?.value).toBe(80)
  expect(seeded.fixed_costs[0].monthly_cents).toEqual({ value: 90000, source: 'estimated', at: AT })
  // No numbers block: offers and prices still seed; costs are gaps, not zeros.
  const bare = seedFromDraft([{ title: 'Tamal', price: 30 }], null, AT)
  expect(bare.offers[0].unit_cost_cents).toBeUndefined()
})

const draftModel = (): BusinessInputs => seedFromDraft(
  [{ title: 'Tamal verde', price: 35 }, { title: 'Atole', price: 25 }, { title: 'Champurrado', price: 30 }],
  { offers: [{ title: 'Tamal verde', unit_cost: 12, minutes_per_unit: 10 }, { title: 'Atole', unit_cost: 6, minutes_per_unit: 4 }, { title: 'Champurrado', unit_cost: 7, minutes_per_unit: 5 }], capacity: null, fixed_costs: [] },
  AT,
)

test('a live shop merges in: catalog price/cost measured; a photo product inherits its example\'s estimate', () => {
  const merged = mergeShop(
    draftModel(),
    [
      // made from a photo that replaced «Tamal verde»: no cost on the product yet
      { id: 'prod_1', title: 'Tamal verde de pollo', price_cents: 3800, unit_cost_cents: null, replaces_example: 'Tamal verde' },
      // a product the merchant created by hand, with their cost
      { id: 'prod_2', title: 'Tamal de rajas', price_cents: 3600, unit_cost_cents: 1300 },
      { id: 'prod_3', title: 'Borrado', price_cents: 100, unit_cost_cents: 1, status: 'deleted' },
    ],
    [{ product_id: 'prod_2', units: 30, revenue_cents: 108000 }],
    { months: windowMonths(), at: AT },
  )
  const byKey = Object.fromEntries(merged.offers.map((o) => [o.key, o]))
  expect(byKey['p:prod_1'].price_cents).toMatchObject({ value: 3800, source: 'measured' })
  // the estimate rides along, STILL labelled estimated — never written to Medusa as a fake measured cost
  expect(byKey['p:prod_1'].unit_cost_cents).toMatchObject({ value: 1200, source: 'estimated' })
  expect(byKey['p:prod_1'].minutes_per_unit?.value).toBe(10)
  expect(byKey['p:prod_2'].unit_cost_cents).toMatchObject({ value: 1300, source: 'measured' })
  expect(byKey['p:prod_2'].units_per_month).toMatchObject({ value: 10, source: 'measured' })
  expect(byKey['p:prod_3']).toBeUndefined()
  // «Tamal verde» was replaced; one more real product (prod_2) displaces one more example; one example stays ACTIVE —
  // the others are retired, never deleted
  const active = merged.offers.filter((o) => o.key.startsWith('ex:') && !o.retired).map((o) => o.title)
  expect(active).toEqual(['Atole'])
  expect(merged.offers.filter((o) => o.key.startsWith('ex:')).map((o) => o.title)).toEqual(['Tamal verde', 'Atole', 'Champurrado'])
  // the deleted product is not active
  expect(merged.offers.find((o) => o.key === 'p:prod_3')).toBeUndefined()
})

test('measured monthly units need the threshold; a merchant\'s own number is never overwritten by sales', () => {
  const stored: BusinessInputs = { offers: [{ key: 'p:a', title: 'A', units_per_month: v(20, 'told') }, { key: 'p:b', title: 'B' }], fixed_costs: [] }
  const merged = mergeShop(stored, [
    { id: 'a', title: 'A', price_cents: 1000, unit_cost_cents: null },
    { id: 'b', title: 'B', price_cents: 1000, unit_cost_cents: null },
  ], [{ product_id: 'a', units: 90, revenue_cents: 90000 }, { product_id: 'b', units: 1, revenue_cents: 1000 }], { months: 3, at: AT })
  expect(merged.offers.find((o) => o.key === 'p:a')?.units_per_month).toMatchObject({ value: 20, source: 'told' })
  expect(merged.offers.find((o) => o.key === 'p:b')?.units_per_month).toBeUndefined()
})

test('the products read: price from the listing, cost from the FIRST variant\'s private metadata, MXN only', () => {
  const products = productsFrom({
    listings: [
      { id: 'p1', title: 'Tamal', price_cents: 3500, currency: 'MXN', status: 'published' },
      { id: 'p2', title: 'Hat', price_cents: 2000, currency: 'USD', status: 'published' },
      { id: 'p3', title: 'Sin costo', price_cents: 1000, currency: 'mxn', status: 'draft' },
    ],
    products: [
      { id: 'p1', metadata: { p2s_example: 'Tamal verde' }, variants: [{ metadata: { unit_cost_cents: 1200 } }, { metadata: { unit_cost_cents: 9 } }] },
      { id: 'p3', variants: [{ metadata: {} }] },
    ],
  })
  expect(products).toEqual([
    { id: 'p1', title: 'Tamal', status: 'published', price_cents: 3500, unit_cost_cents: 1200, replaces_example: 'Tamal verde' },
    { id: 'p3', title: 'Sin costo', status: 'draft', price_cents: 1000, unit_cost_cents: null, replaces_example: null },
  ])
  // not a products read at all = could not read (null), never "no products"
  expect(productsFrom(null)).toBeNull()
  expect(productsFrom({ listings: 'x' })).toBeNull()
  expect(productsFrom({ listings: [] })).toEqual([])
})

test('the ledger read: revenue events in the window, MXN only, a line\'s units counted once', () => {
  const now = new Date('2026-11-04T00:00:00Z')
  const orders: ProfitOrderInfo[] = [
    { id: 'o1', display_id: 1, created_at: null, currency_code: 'mxn', source: 'native', items: [{ id: 'l1', product_id: 'p1', variant_id: null, title: 'Tamal', quantity: 4 }] },
    { id: 'o2', display_id: 2, created_at: null, currency_code: 'mxn', source: 'native', items: [{ id: 'l2', product_id: 'p1', variant_id: null, title: 'Tamal', quantity: 2 }] },
    { id: 'o3', display_id: 3, created_at: null, currency_code: 'usd', source: 'native', items: [{ id: 'l3', product_id: 'p1', variant_id: null, title: 'Tamal', quantity: 9 }] },
  ]
  const ev = (id: string, line: string, amount: number, at: string, cur = 'mxn', type: ProfitEvent['event_type'] = 'revenue'): ProfitEvent =>
    ({ id, order_id: 'x', order_line_id: line, source: 'native', event_type: type, amount_cents: amount, currency_code: cur, captured_at: at })
  const sales = salesFrom([
    ev('e1', 'l1', 14000, '2026-10-20T00:00:00Z'),
    ev('e1b', 'l1', -500, '2026-10-21T00:00:00Z'), // an adjustment on the same line: units count once
    ev('e2', 'l2', 7000, '2026-06-01T00:00:00Z'), // outside the 90-day window
    ev('e3', 'l3', 9000, '2026-10-20T00:00:00Z', 'usd'),
    ev('e4', 'l1', 1200, '2026-10-20T00:00:00Z', 'mxn', 'cogs_snapshot'),
  ], orders, now)
  expect(sales).toEqual([{ product_id: 'p1', units: 4, revenue_cents: 13500 }])
})

test('a merchant\'s edit: pesos in, told cents stored; cleared = gap again; malformed = refused whole', () => {
  const inputs = draftModel()
  const edit = parsePlanEdit({
    updated_at: 'u1',
    offers: [{ key: 'ex:0', field: 'cost', value: 14.5 }, { key: 'ex:1', field: 'minutes', value: null }],
    goal: 15000,
    capacity: { resource: 'mi tiempo', hours_per_month: 160 },
    fixed_costs: [{ label: 'Renta', monthly: 3000 }],
  })
  expect(edit).not.toBeNull()
  const next = applyPlanEdit(inputs, edit!, AT)!
  expect(next.offers[0].unit_cost_cents).toEqual({ value: 1450, source: 'told', at: AT })
  expect(next.offers[1].minutes_per_unit).toBeUndefined()
  expect(next.goal_cents).toEqual({ value: 1500000, source: 'told', at: AT })
  expect(next.capacity?.resource).toEqual({ value: 'mi tiempo', source: 'told', at: AT })
  expect(next.fixed_costs).toEqual([{ label: 'Renta', monthly_cents: { value: 300000, source: 'told', at: AT } }])
  // a stale page naming an offer the model no longer has, a zero price, a negative cost: refused, nothing half-saved
  expect(applyPlanEdit(inputs, { updated_at: 'u', offers: [{ key: 'p:gone', field: 'cost', value: 1 }] }, AT)).toBeNull()
  expect(applyPlanEdit(inputs, { updated_at: 'u', offers: [{ key: 'ex:0', field: 'price', value: 0 }] }, AT)).toBeNull()
  expect(parsePlanEdit({ updated_at: 'u', offers: [{ key: 'ex:0', field: 'cost', value: -1 }] })).toBeNull()
  expect(parsePlanEdit({ updated_at: 'u', offers: [{ key: 'ex:0', field: 'margin', value: 1 }] })).toBeNull()
  expect(parsePlanEdit({ offers: [] })).toBeNull()
  expect(parsePlanEdit({ updated_at: 'u' })).toBeNull()
  // an explicit 0 cost is real (a service with no materials), not a gap
  expect(applyPlanEdit(inputs, { updated_at: 'u', offers: [{ key: 'ex:0', field: 'cost', value: 0 }] }, AT)!.offers[0].unit_cost_cents?.value).toBe(0)
})

test('merging the same shop twice changes nothing — no write, no re-stamped dates', () => {
  const products = [{ id: 'a', title: 'A', price_cents: 1000, unit_cost_cents: 400 }]
  const sales = [{ product_id: 'a', units: 30, revenue_cents: 30000 }]
  const first = mergeShop({ offers: [], fixed_costs: [] }, products, sales, { months: 3, at: '2026-11-01T00:00:00.000Z' })
  const second = mergeShop(readInputs(JSON.parse(JSON.stringify(first))), products, sales, { months: 3, at: '2026-11-02T00:00:00.000Z' })
  expect(JSON.stringify(second)).toBe(JSON.stringify(readInputs(JSON.parse(JSON.stringify(first)))))
  expect(second.offers[0].price_cents?.at).toBe('2026-11-01T00:00:00.000Z')
  // a CHANGED price is a change
  const third = mergeShop(second, [{ ...products[0], price_cents: 1200 }], sales, { months: 3, at: '2026-11-03T00:00:00.000Z' })
  expect(third.offers[0].price_cents).toMatchObject({ value: 1200, at: '2026-11-03T00:00:00.000Z' })
})

test('merging is IDEMPOTENT: three visits leave the same model, and a typed example is the last to retire', () => {
  const stored = draftModel()
  // the merchant typed a cost on the LAST example
  stored.offers[2] = { ...stored.offers[2], unit_cost_cents: v(900, 'told') }
  const products = [{ id: 'hand', title: 'Tamal de rajas', price_cents: 3600, unit_cost_cents: 1300 }]
  const w = { months: 3, at: AT }
  const once = mergeShop(stored, products, [], w)
  const twice = mergeShop(readInputs(JSON.parse(JSON.stringify(once))), products, [], w)
  const thrice = mergeShop(readInputs(JSON.parse(JSON.stringify(twice))), products, [], w)
  expect(JSON.stringify(thrice)).toBe(JSON.stringify(readInputs(JSON.parse(JSON.stringify(once)))))
  // 3 examples, 1 other real product → 2 stay active, the typed one among them; nothing deleted
  const exs = thrice.offers.filter((o) => o.key.startsWith('ex:'))
  expect(exs).toHaveLength(3)
  expect(exs.filter((o) => !o.retired).map((o) => o.title)).toContain('Champurrado')
  expect(exs.find((o) => o.title === 'Champurrado')?.unit_cost_cents).toEqual(v(900, 'told'))
})

test('a product the read does not return is retired with its typed numbers, and comes back when it returns', () => {
  const stored: BusinessInputs = { offers: [{ key: 'p:x', title: 'X', unit_cost_cents: v(500, 'told') }], fixed_costs: [] }
  const away = mergeShop(stored, [], [], { months: 3, at: AT })
  expect(away.offers).toEqual([{ ...stored.offers[0], retired: true }])
  const back = mergeShop(away, [{ id: 'x', title: 'X', price_cents: 1000, unit_cost_cents: null }], [], { months: 3, at: AT })
  expect(back.offers[0].retired).toBeUndefined()
  expect(back.offers[0].unit_cost_cents).toEqual(v(500, 'told'))
})

test('keep → photo → FIRST visit: the replaced example is gone from the catalog, its estimate still reaches the product', () => {
  // the draft catalog no longer has «Tamal verde» (the photo confirm removed it), but the numbers block does
  const seeded = seedFromDraft(
    [{ title: 'Atole', price: 25 }],
    { offers: [{ title: 'Tamal verde', unit_cost: 12, minutes_per_unit: 10 }, { title: 'Atole', unit_cost: 6, minutes_per_unit: 4 }], capacity: null, fixed_costs: [] },
    AT,
  )
  expect(seeded.offers.find((o) => o.title === 'Tamal verde')).toMatchObject({ retired: true })
  const merged = mergeShop(seeded, [{ id: 'p1', title: 'Tamal verde de pollo', price_cents: 3800, unit_cost_cents: null, replaces_example: 'Tamal verde' }], [], { months: 3, at: AT })
  expect(merged.offers.find((o) => o.key === 'p:p1')?.unit_cost_cents).toEqual({ value: 1200, source: 'estimated', at: AT })
})

test('sales: an unreadable ledger keeps what is stored; a read with no sales is a measured zero over an older read', () => {
  const stored: BusinessInputs = { offers: [{ key: 'p:a', title: 'A', units_per_month: v(12, 'measured') }], fixed_costs: [] }
  const product = [{ id: 'a', title: 'A', price_cents: 1000, unit_cost_cents: null }]
  expect(mergeShop(stored, product, null, { months: 3, at: AT }).offers[0].units_per_month?.value).toBe(12)
  expect(mergeShop(stored, product, [], { months: 3, at: AT }).offers[0].units_per_month?.value).toBe(0)
  // over an estimate, zero sales is not enough to replace it
  const est: BusinessInputs = { offers: [{ key: 'p:a', title: 'A', units_per_month: v(30, 'estimated') }], fixed_costs: [] }
  expect(mergeShop(est, product, [], { months: 3, at: AT }).offers[0].units_per_month?.source).toBe('estimated')
})

test('re-sending a section does not launder estimates: only what changed becomes the merchant\'s', () => {
  const inputs: BusinessInputs = {
    offers: [],
    fixed_costs: [{ label: 'Gas', monthly_cents: v(90000, 'estimated') }, { label: 'Luz', monthly_cents: v(40000, 'estimated') }],
    capacity: { resource: { value: 'la vaporera', source: 'estimated', at: AT }, hours_per_month: v(80, 'estimated') },
  }
  const next = applyPlanEdit(inputs, {
    updated_at: 'u',
    fixed_costs: [{ label: 'Gas', monthly: 900 }, { label: 'Luz', monthly: 450 }],
    capacity: { resource: 'la vaporera', hours_per_month: 100 },
  }, '2026-11-05T00:00:00.000Z')!
  expect(next.fixed_costs[0].monthly_cents.source).toBe('estimated')
  expect(next.fixed_costs[1].monthly_cents).toMatchObject({ value: 45000, source: 'told' })
  expect(next.capacity?.resource.source).toBe('estimated')
  expect(next.capacity?.hours_per_month).toMatchObject({ value: 100, source: 'told' })
})
