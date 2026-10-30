import { test, expect } from '@playwright/test'
import {
  addItem,
  cartTotalCents,
  cartUnits,
  cashResult,
  clearCart,
  decrementLine,
  emptyCart,
  incrementLine,
  lineTotalCents,
  parsePesosToCents,
  applyPadKey,
  padTextToCents,
  centsToPadText,
  type PadKey,
  removeLine,
  toSaleLines,
  MAX_QUANTITY,
  type CounterItem,
  type CounterCart,
} from '../lib/in-person/counter-cart'
import { classifySaleResponse } from '../lib/in-person/sale-response'
import { isSellable, matchesQuery, toCounterProducts } from '../lib/in-person/counter-catalog'

/**
 * In-person sales · Sprint 1 · Story 1.1 — the counter's money math. Pure, no I/O: a
 * wrong centavo here is a wrong charge at a stall, so every branch is pinned.
 */

const taza: CounterItem = { variantId: 'var_taza', productId: 'prod_1', title: 'Taza', unitCents: 12000 }
const plato: CounterItem = { variantId: 'var_plato', productId: 'prod_2', title: 'Plato', variantTitle: 'Chico', unitCents: 4550 }

const cartOf = (...items: Array<[CounterItem, number]>): CounterCart =>
  items.reduce((cart, [item, qty]) => addItem(cart, item, qty), emptyCart())

test.describe('counter-cart · lines and totals', () => {
  test('adding the same variant merges into one line and totals in integer centavos', () => {
    const cart = addItem(addItem(emptyCart(), taza), taza)
    expect(cart.lines).toHaveLength(1)
    expect(cart.lines[0].quantity).toBe(2)
    expect(lineTotalCents(cart.lines[0])).toBe(24000)
    expect(cartTotalCents(cartOf([taza, 2], [plato, 3]))).toBe(2 * 12000 + 3 * 4550)
    expect(cartUnits(cartOf([taza, 2], [plato, 3]))).toBe(5)
  })

  test('increment adds one; decrement subtracts one and REMOVES the line at zero', () => {
    const two = cartOf([taza, 2])
    expect(incrementLine(two, 'var_taza').lines[0].quantity).toBe(3)
    expect(decrementLine(two, 'var_taza').lines[0].quantity).toBe(1)
    const gone = decrementLine(decrementLine(two, 'var_taza'), 'var_taza')
    expect(gone.lines).toHaveLength(0)
    expect(cartTotalCents(gone)).toBe(0)
  })

  test('remove drops the whole line, clear empties, unknown variants are a no-op', () => {
    const cart = cartOf([taza, 4], [plato, 1])
    expect(removeLine(cart, 'var_taza').lines.map((l) => l.variantId)).toEqual(['var_plato'])
    expect(clearCart().lines).toHaveLength(0)
    expect(removeLine(cart, 'nope')).toBe(cart)
    expect(incrementLine(cart, 'nope')).toBe(cart)
    expect(decrementLine(cart, 'nope')).toBe(cart)
  })

  test('quantity is clamped to 1..999 (never thrown on) and to the stock left', () => {
    expect(addItem(emptyCart(), taza, 0).lines[0].quantity).toBe(1)
    expect(addItem(emptyCart(), taza, -5).lines[0].quantity).toBe(1)
    expect(addItem(emptyCart(), taza, Number.NaN).lines[0].quantity).toBe(1)
    expect(addItem(emptyCart(), taza, 2.9).lines[0].quantity).toBe(2)
    expect(addItem(emptyCart(), taza, 5000).lines[0].quantity).toBe(MAX_QUANTITY)
    const scarce: CounterItem = { ...taza, maxQuantity: 2 }
    const capped = incrementLine(incrementLine(addItem(emptyCart(), scarce), 'var_taza'), 'var_taza')
    expect(capped.lines[0].quantity).toBe(2)
    expect(addItem(addItem(emptyCart(), scarce, 2), scarce, 2).lines[0].quantity).toBe(2)
  })

  test('money that is not a non-negative integer is refused, not rounded', () => {
    expect(() => addItem(emptyCart(), { ...taza, unitCents: 10.5 })).toThrow(RangeError)
    expect(() => addItem(emptyCart(), { ...taza, unitCents: -1 })).toThrow(RangeError)
    expect(() => addItem(emptyCart(), { ...taza, unitCents: Number.NaN })).toThrow(RangeError)
    expect(() => cashResult(1000.5, 2000)).toThrow(RangeError)
    expect(() => cashResult(1000, -1)).toThrow(RangeError)
    expect(() => cashResult(1000, Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })

  test('the cart is immutable: operations return new carts', () => {
    const base = cartOf([taza, 1])
    incrementLine(base, 'var_taza')
    addItem(base, taza)
    expect(base.lines[0].quantity).toBe(1)
  })
})

test.describe('counter-cart · cash change and «falta»', () => {
  test('tendered above the total is Cambio, below is Falta, exact is neither', () => {
    expect(cashResult(24000, 30000)).toEqual({ change_cents: 6000, short_cents: 0 })
    expect(cashResult(24000, 20000)).toEqual({ change_cents: 0, short_cents: 4000 })
    expect(cashResult(24000, 24000)).toEqual({ change_cents: 0, short_cents: 0 })
  })

  test('nothing tendered against a real total is Falta the whole total', () => {
    expect(cashResult(24000, 0)).toEqual({ change_cents: 0, short_cents: 24000 })
  })

  test('an amount pad parses pesos to centavos and refuses anything else', () => {
    expect(parsePesosToCents('250')).toBe(25000)
    expect(parsePesosToCents('250.5')).toBe(25050)
    expect(parsePesosToCents('250.05')).toBe(25005)
    expect(parsePesosToCents(' 0.99 ')).toBe(99)
    for (const bad of ['', '.', '-5', '1e3', '12.345', 'abc', '1,000', '1234567890']) {
      expect(parsePesosToCents(bad), bad).toBeNull()
    }
  })
})

test.describe('counter-cart · the amount pad', () => {
  const type = (keys: PadKey[]) => keys.reduce((text, key) => applyPadKey(text, key), '')

  test('keys build a readable amount and refuse the ones that would not be', () => {
    expect(type(['2', '5', '0'])).toBe('250')
    expect(type(['.', '5'])).toBe('0.5')
    expect(type(['0', '0', '7'])).toBe('7')
    expect(type(['1', '.', '5', '.', '0'])).toBe('1.50')
    expect(type(['1', '.', '2', '5', '9'])).toBe('1.25')
    expect(type(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'])).toBe('123456789')
    expect(type(['1', '2', 'del', 'del', 'del'])).toBe('')
  })

  test('pad text round-trips to centavos, including a trailing dot', () => {
    expect(padTextToCents('12.')).toBe(1200)
    expect(padTextToCents('')).toBeNull()
    expect(padTextToCents('0.5')).toBe(50)
    expect(centsToPadText(24000)).toBe('240')
    expect(centsToPadText(24050)).toBe('240.5')
    expect(centsToPadText(24005)).toBe('240.05')
    for (const cents of [0, 1, 10, 99, 100, 12345, 24050]) expect(padTextToCents(centsToPadText(cents))).toBe(cents)
  })
})

test.describe('counter-cart · the sale lines the backend receives', () => {
  test('toSaleLines uses the backend shape and keeps first-seen order', () => {
    expect(toSaleLines(cartOf([taza, 2], [plato, 1]))).toEqual([
      { variant_id: 'var_taza', quantity: 2 },
      { variant_id: 'var_plato', quantity: 1 },
    ])
  })

  test('duplicate variant lines (a hand-built cart) are MERGED, never sent twice', () => {
    const line = { ...cartOf([taza, 2]).lines[0] }
    const hand: CounterCart = { lines: [line, { ...line, quantity: 3 }, { ...cartOf([plato, 1]).lines[0] }] }
    expect(toSaleLines(hand)).toEqual([
      { variant_id: 'var_taza', quantity: 5 },
      { variant_id: 'var_plato', quantity: 1 },
    ])
  })

  test('an empty cart sends no lines', () => {
    expect(toSaleLines(emptyCart())).toEqual([])
  })
})

test.describe('counter-catalog · the seller catalog flattened for the grid', () => {
  const level = (stocked: number, reserved = 0) => ({ inventory: { location_levels: [{ stocked_quantity: stocked, reserved_quantity: reserved }] } })
  const listings = [
    { id: 'p1', title: 'Taza de barro', status: 'active', images: [{ url: 'https://img/1.jpg' }] },
    { id: 'p2', title: 'Plato', status: 'paused', images: [] },
    { id: 'p3', title: 'Maceta', status: 'active', images: [] },
    { id: 'p4', title: 'Sin precio', status: 'active', images: [] },
  ]
  const raw = [
    {
      id: 'p1',
      variants: [
        { id: 'v1a', title: 'Chica', prices: [{ currency_code: 'mxn', amount: 12000, min_quantity: 1 }, { currency_code: 'mxn', amount: 9000, min_quantity: 10 }], manage_inventory: true, inventory_items: [level(5, 2)] },
        { id: 'v1b', title: 'Grande', prices: [{ currency_code: 'mxn', amount: 18000 }], manage_inventory: true, inventory_items: [level(0)] },
        { id: 'v1c', title: 'Fuera', prices: [{ currency_code: 'mxn', amount: 1 }], metadata: { disabled: true } },
      ],
    },
    { id: 'p2', variants: [{ id: 'v2', title: 'Default variant', prices: [{ currency_code: 'mxn', amount: 5000 }] }] },
    { id: 'p3', variants: [{ id: 'v3', title: 'Default variant', prices: [{ currency_code: 'mxn', amount: 7000 }], manage_inventory: true, allow_backorder: true, inventory_items: [level(0)] }] },
    { id: 'p4', variants: [{ id: 'v4', title: 'x', prices: [{ currency_code: 'usd', amount: 100 }] }] },
  ]

  test('only active, MXN-priced products; bulk tiers and disabled variants never show', () => {
    const products = toCounterProducts(listings, raw)
    expect(products.map((p) => p.productId)).toEqual(['p1', 'p3'])
    const [taza1] = products
    expect(taza1.imageUrl).toBe('https://img/1.jpg')
    expect(taza1.variants.map((v) => [v.variantId, v.title, v.unitCents, v.available])).toEqual([
      ['v1a', 'Chica', 12000, 3],
      ['v1b', 'Grande', 18000, 0],
    ])
  })

  test('a single-variant product hides «Default variant»; backorder is unlimited', () => {
    const maceta = toCounterProducts(listings, raw).find((p) => p.productId === 'p3')!
    expect(maceta.variants).toEqual([{ variantId: 'v3', title: null, unitCents: 7000, available: null }])
    expect(isSellable(maceta.variants[0])).toBe(true)
  })

  test('sold-out variants are not sellable and search ignores accents and case', () => {
    const grande = toCounterProducts(listings, raw)[0].variants[1]
    expect(isSellable(grande)).toBe(false)
    expect(matchesQuery('Cerámica de Oaxaca', 'ceramica')).toBe(true)
    expect(matchesQuery('Taza', 'PLATO')).toBe(false)
    expect(matchesQuery('Taza', '  ')).toBe(true)
  })
})

test.describe('sale-response · may the client_id be released?', () => {
  type Row = [string, Parameters<typeof classifySaleResponse>[0], ReturnType<typeof classifySaleResponse>]
  const fresh = { hadUncertainAttempt: false }
  const sticky = { hadUncertainAttempt: true }
  const rows: Row[] = [
    ['201 with order', { status: 201, hasOrder: true, ...fresh }, 'recorded'],
    ['200 replay with order', { status: 200, hasOrder: true, ...sticky }, 'recorded'],
    ['200 without readable order', { status: 200, hasOrder: false, ...fresh }, 'uncertain'],
    ['409 IN_PROGRESS', { status: 409, code: 'IN_PROGRESS', ...fresh }, 'retry_in_progress'],
    ['network failure', { status: null, ...fresh }, 'uncertain'],
    ['400 WITHOUT a code', { status: 400, ...fresh }, 'uncertain'],
    ['404 without a code', { status: 404, ...fresh }, 'uncertain'],
    ['502 BACKEND_UNREACHABLE', { status: 502, code: 'BACKEND_UNREACHABLE', ...fresh }, 'uncertain'],
    ['BAD_UPSTREAM', { status: 502, code: 'BAD_UPSTREAM', ...fresh }, 'uncertain'],
    ['503 RETRY_SAME_ID', { status: 503, code: 'RETRY_SAME_ID', ...fresh }, 'uncertain'],
    ['500 with an unknown code', { status: 500, code: 'WHATEVER', ...fresh }, 'uncertain'],
    ['409 CLIENT_ID_REUSED', { status: 409, code: 'CLIENT_ID_REUSED', ...fresh }, 'uncertain'],
    ['422 VARIANT_NOT_OWNED, first attempt', { status: 422, code: 'VARIANT_NOT_OWNED', ...fresh }, 'refused'],
    ['422 VARIANT_NOT_OWNED after an uncertain attempt', { status: 422, code: 'VARIANT_NOT_OWNED', ...sticky }, 'uncertain'],
    ['401 UNAUTHENTICATED, first attempt', { status: 401, code: 'UNAUTHENTICATED', ...fresh }, 'refused'],
    ['401 UNAUTHENTICATED after an uncertain attempt', { status: 401, code: 'UNAUTHENTICATED', ...sticky }, 'uncertain'],
    ['409 seller_not_active after an uncertain attempt', { status: 409, code: 'seller_not_active', ...sticky }, 'uncertain'],
    ['400 EMPTY_SALE, first attempt', { status: 400, code: 'EMPTY_SALE', ...fresh }, 'refused'],
    ['409 OUT_OF_STOCK after an uncertain attempt', { status: 409, code: 'OUT_OF_STOCK', ...sticky }, 'refused'],
    ['409 SALE_CLOSED after an uncertain attempt', { status: 409, code: 'SALE_CLOSED', ...sticky }, 'refused'],
    ['422 TENDERED_SHORT after an uncertain attempt', { status: 422, code: 'TENDERED_SHORT', ...sticky }, 'refused'],
  ]
  for (const [name, input, verdict] of rows) {
    test(name, () => expect(classifySaleResponse(input)).toBe(verdict))
  }
})
