import { test, expect } from '@playwright/test'
import {
  makeSalePayable,
  manualFromSellerMetadata,
  pickCardProvider,
  pickTransferSubType,
  startCheckoutBody,
  type OrchestrateDeps,
  type SaleStatus,
} from '../lib/in-person/counter-checkout'
import { classifySaleResponse } from '../lib/in-person/sale-response'
import { cancelVerdict, screenForState } from '../lib/in-person/sale-screen'
import { COUNTER_PLACEHOLDER_EMAIL, isRealBuyerEmail, shouldEmailBuyer, shouldNotifySellerOfSale, telegramBuyerLabel } from '../lib/in-person/notify-policy'
import { filterBySource, inPersonBadgeLabel, presentSources, summarizeBySource } from '../lib/in-person/order-source'
import { parseStoredSale } from '../lib/in-person/stored-sale'
import { buildReceiptText } from '../lib/in-person/receipt'

/** In-person sales · Sprint 2 — the rules that must hold without a network. */

const status = (over: Partial<SaleStatus> = {}): SaleStatus => ({
  state: 'awaiting_payment', order_id: null, cart_id: 'cart_1', checkout_url: null, total_cents: 24000, ...over,
})

function fakeDeps(reads: SaleStatus[], opts: { startOk?: boolean; startReason?: 'exists' | 'closed' | 'failed'; startCode?: string; startMessage?: string; completeOk?: boolean; cancelOk?: boolean } = {}) {
  const calls = { start: 0, complete: 0, cancel: 0, read: 0, manualFallback: 0 }
  const deps: OrchestrateDeps = {
    async getStatus() { const s = reads[Math.min(calls.read, reads.length - 1)]; calls.read += 1; return s },
    async startCheckout() {
      calls.start += 1
      return opts.startOk === false ? { ok: false as const, reason: opts.startReason ?? 'failed', code: opts.startCode, message: opts.startMessage } : { ok: true, manual_payment: { spei: { clabe: '012345678901234567', bank_name: 'BBVA', account_holder: 'Ana' }, dimo: null } }
    },
    async completeCart() { calls.complete += 1; return opts.completeOk !== false },
    async manualFallback() { calls.manualFallback += 1; return { spei: null, dimo: { phone: '5512345678' } } },
    async cancelSale() { calls.cancel += 1; return opts.cancelOk === true },
  }
  return { deps, calls }
}

test.describe('counter-checkout · card QR', () => {
  test('start-checkout runs once and the QR url is READ BACK from the backend status', async () => {
    const { deps, calls } = fakeDeps([status(), status({ checkout_url: 'https://pay.example/abc' })])
    const r = await makeSalePayable('card', deps)
    expect(calls.start).toBe(1)
    expect(r.ok && r.status.checkout_url).toBe('https://pay.example/abc')
  })

  test('a checkout that is already open is NOT started again (a second call opens a second payable checkout)', async () => {
    const { deps, calls } = fakeDeps([status({ checkout_url: 'https://pay.example/abc' })])
    const r = await makeSalePayable('card', deps)
    expect(calls.start).toBe(0)
    expect(r.ok && r.status.checkout_url).toBe('https://pay.example/abc')
  })

  test('a sale that is already paid or cancelled starts nothing', async () => {
    for (const state of ['paid', 'cancelled', 'failed'] as const) {
      const { deps, calls } = fakeDeps([status({ state, order_id: state === 'paid' ? 'order_1' : null })])
      const r = await makeSalePayable('card', deps)
      expect(calls.start, state).toBe(0)
      expect(r.ok && r.status.state).toBe(state)
    }
  })

  test('no url after starting is an error, never a blank QR', async () => {
    const { deps } = fakeDeps([status(), status()])
    const r = await makeSalePayable('card', deps)
    expect(r.ok).toBe(false)
  })

})

test.describe('counter-checkout · start-checkout refusals (security review)', () => {
  test('CHECKOUT_EXISTS reuses the open checkout: no second start, no cancel, the url is read back', async () => {
    const { deps, calls } = fakeDeps([status(), status({ checkout_url: 'https://pay.example/abc' })], { startOk: false, startReason: 'exists' })
    const r = await makeSalePayable('card', deps)
    expect(calls.start).toBe(1)
    expect(calls.cancel).toBe(0)
    expect(r.ok && r.status.checkout_url).toBe('https://pay.example/abc')
  })
  test('SALE_CLOSED is the cancelled path: a definite refusal, and nothing else is called', async () => {
    const { deps, calls } = fakeDeps([status()], { startOk: false, startReason: 'closed' })
    const r = await makeSalePayable('card', deps)
    expect(!r.ok && r.code).toBe('SALE_CLOSED')
    expect(calls.cancel + calls.complete).toBe(0)
    expect(classifySaleResponse({ status: 409, code: 'SALE_CLOSED', hadUncertainAttempt: true })).toBe('refused')
  })
  test('CHECKOUT_EXISTS on a transfer still completes the cart once and takes the CLABE from settings', async () => {
    const { deps, calls } = fakeDeps([status(), status({ checkout_url: 'u' }), status({ state: 'pending_confirmation', order_id: 'order_9' })], { startOk: false, startReason: 'exists' })
    const r = await makeSalePayable('transfer', deps)
    expect(calls.complete).toBe(1)
    expect(r.ok && r.manual_payment?.dimo?.phone).toBe('5512345678')
  })
})

test.describe('counter-checkout · refusals that release the id and failures that do not', () => {
  test('CART_CHANGED is a definite refusal: id released, merchant told to ring it up again, nothing cancelled', async () => {
    const deps = fakeDeps([status()], { startOk: false, startReason: 'closed', startCode: 'CART_CHANGED', startMessage: 'Esta venta cambió. Vuelve a cobrarla desde el mostrador.' })
    const r = await makeSalePayable('card', deps.deps)
    expect(!r.ok && r.code).toBe('CART_CHANGED')
    expect(!r.ok && r.message).toContain('cambió')
    expect(deps.calls.cancel).toBe(0)
    expect(classifySaleResponse({ status: 409, code: 'CART_CHANGED', hadUncertainAttempt: true })).toBe('refused')
  })
  test('a failed checkout open surfaces the backend reason, stays retryable and cancels nothing', async () => {
    const deps = fakeDeps([status()], { startOk: false, startReason: 'failed', cancelOk: true, startCode: 'SELLER_MP_NOT_CONNECTED', startMessage: 'Tu Mercado Pago no está conectado.' })
    const r = await makeSalePayable('card', deps.deps)
    expect(!r.ok && r.code).toBe('CHECKOUT_START_FAILED')
    expect(!r.ok && r.message).toContain('Tu Mercado Pago no está conectado.')
    expect(deps.calls.cancel).toBe(0)
    expect(classifySaleResponse({ status: 502, code: 'CHECKOUT_START_FAILED', hadUncertainAttempt: false })).toBe('uncertain')
  })
})

test.describe('sale-screen · what a state may show', () => {
  test('only paid is paid; unverified is its own warning, never paid', () => {
    expect(screenForState('paid')).toBe('paid')
    expect(screenForState('unverified')).toBe('unverified')
    expect(screenForState('cancelled')).toBe('released')
    expect(screenForState('failed')).toBe('released')
    expect(screenForState('awaiting_payment')).toBe('waiting')
    expect(screenForState('pending_confirmation')).toBe('waiting')
  })
  test('a cancel only cancels on an explicit cancelled; PAYMENT_IN_PROGRESS and CANCEL_FAILED keep waiting', () => {
    expect(cancelVerdict({ ok: true, state: 'cancelled' })).toBe('cancelled')
    expect(cancelVerdict({ ok: true, state: 'paid' })).toBe('paid')
    expect(cancelVerdict({ ok: true, state: 'unverified' })).toBe('unverified')
    expect(cancelVerdict({ ok: false, code: 'PAYMENT_IN_PROGRESS' })).toBe('keep_waiting')
    expect(cancelVerdict({ ok: false, code: 'CANCEL_FAILED' })).toBe('keep_waiting')
    expect(cancelVerdict({ ok: true, state: 'awaiting_payment' })).toBe('keep_waiting')
    expect(cancelVerdict({ ok: false, code: 'TRANSFER_ORDER_EXISTS' })).toBe('leave_pending')
  })
})

test.describe('counter-checkout · transfer', () => {
  test('starts once, completes the cart so the order exists, returns the snapshot, confirms nothing', async () => {
    const { deps, calls } = fakeDeps([status(), status({ checkout_url: 'https://x/pending' }), status({ state: 'pending_confirmation', order_id: 'order_9' })])
    const r = await makeSalePayable('transfer', deps)
    expect(calls.start).toBe(1)
    expect(calls.complete).toBe(1)
    expect(r.ok && r.status.state).toBe('pending_confirmation')
    expect(r.ok && r.manual_payment?.spei?.clabe).toBe('012345678901234567')
  })

  test('a replay after the session opened skips start-checkout and falls back to the shop settings for the CLABE', async () => {
    const { deps, calls } = fakeDeps([status({ checkout_url: 'https://x/pending' }), status({ state: 'pending_confirmation', order_id: 'order_9' })])
    const r = await makeSalePayable('transfer', deps)
    expect(calls.start).toBe(0)
    expect(calls.complete).toBe(1)
    expect(r.ok && r.manual_payment?.dimo?.phone).toBe('5512345678')
  })

  test('an already pending order is not completed again', async () => {
    const { deps, calls } = fakeDeps([status({ state: 'pending_confirmation', order_id: 'order_9' })])
    await makeSalePayable('transfer', deps)
    expect(calls.start + calls.complete).toBe(0)
  })

  test('if the cart became an order while we started the checkout, it is not completed a second time', async () => {
    const { deps, calls } = fakeDeps([status(), status({ state: 'pending_confirmation', order_id: 'order_9' })])
    await makeSalePayable('transfer', deps)
    expect(calls.start).toBe(1)
    expect(calls.complete).toBe(0)
  })

  test('a failed completion is retryable (503) and keeps the id', async () => {
    const r = await makeSalePayable('transfer', fakeDeps([status(), status({ checkout_url: 'u' })], { completeOk: false }).deps)
    expect(!r.ok && r.code).toBe('TRANSFER_COMPLETE_FAILED')
    expect(classifySaleResponse({ status: 503, code: 'TRANSFER_COMPLETE_FAILED', hadUncertainAttempt: false })).toBe('uncertain')
  })
})

test.describe('counter-checkout · planning helpers', () => {
  test('Mercado Pago wins over Stripe; none is null', () => {
    expect(pickCardProvider([{ id: 'stripe' }, { id: 'mercadopago' }])).toBe('mercadopago')
    expect(pickCardProvider([{ id: 'stripe' }, { id: 'manual' }])).toBe('stripe')
    expect(pickCardProvider([{ id: 'manual' }])).toBeNull()
  })
  test('transfer needs CLABE or DiMo from the manual method', () => {
    expect(pickTransferSubType([{ id: 'manual', sub_options: [{ type: 'cash' }, { type: 'clabe' }] }])).toBe('clabe')
    expect(pickTransferSubType([{ id: 'manual', sub_options: [{ type: 'dimo' }] }])).toBe('dimo')
    expect(pickTransferSubType([{ id: 'manual', sub_options: [{ type: 'cash' }] }])).toBeNull()
    expect(pickTransferSubType([{ id: 'stripe' }])).toBeNull()
  })
  test('the start-checkout bodies carry the seller and local pickup', () => {
    expect(startCheckoutBody('card', 'sel_1', 'stripe', null)).toEqual({ provider: 'stripe', seller_id: 'sel_1', fulfillment_method: 'local_pickup' })
    expect(startCheckoutBody('transfer', 'sel_1', null, 'clabe')).toEqual({ provider: 'manual', manual_sub_type: 'clabe', seller_id: 'sel_1', fulfillment_method: 'local_pickup' })
  })
  test('the CLABE fallback applies the backend acceptance rules (18 digits, enabled)', () => {
    const md = (checkout: unknown) => ({ settings: { checkout } })
    expect(manualFromSellerMetadata(md({ bank_transfer: { clabe: '0123 4567 8901 2345 67', bank_name: 'BBVA' } })).spei?.clabe).toBe('012345678901234567')
    expect(manualFromSellerMetadata(md({ bank_transfer: { clabe: '123' } })).spei).toBeNull()
    expect(manualFromSellerMetadata(md({ bank_transfer: { enabled: false, clabe: '012345678901234567' } })).spei).toBeNull()
    expect(manualFromSellerMetadata(md({ dimo: { enabled: true, phone: '55 1234 5678' } })).dimo?.phone).toBe('5512345678')
    expect(manualFromSellerMetadata(md({ dimo: { phone: '5512345678' } })).dimo).toBeNull()
    expect(manualFromSellerMetadata(undefined)).toEqual({ spei: null, dimo: null })
  })
})

test.describe('sale-response · the S2 codes', () => {
  test('a shop with no card provider or no CLABE is refused before the claim, and stays refused only on a fresh sale', () => {
    for (const code of ['NO_CARD_PROVIDER', 'SELLER_MANUAL_MISSING']) {
      expect(classifySaleResponse({ status: 422, code, hadUncertainAttempt: false })).toBe('refused')
      expect(classifySaleResponse({ status: 422, code, hadUncertainAttempt: true })).toBe('uncertain')
    }
  })
  test('a card / transfer claim answer with a cart but no order is still a recorded sale', () => {
    expect(classifySaleResponse({ status: 201, hasOrder: true, hadUncertainAttempt: false })).toBe('recorded')
  })
})

test.describe('notify-policy · no self-notification for a counter sale (D7)', () => {
  test('the seller is told about every sale EXCEPT an in-person one', () => {
    expect(shouldNotifySellerOfSale({ source: 'in_person' })).toBe(false)
    expect(shouldNotifySellerOfSale({ source: 'payment_link' })).toBe(true)
    expect(shouldNotifySellerOfSale({ source: 'mercadolibre' })).toBe(true)
    expect(shouldNotifySellerOfSale({})).toBe(true)
    expect(shouldNotifySellerOfSale(null)).toBe(true)
    expect(shouldNotifySellerOfSale(undefined)).toBe(true)
  })
  test('the placeholder buyer address is never emailed, a real one is, and normal orders are unchanged', () => {
    expect(isRealBuyerEmail(COUNTER_PLACEHOLDER_EMAIL)).toBe(false)
    expect(isRealBuyerEmail(COUNTER_PLACEHOLDER_EMAIL.toUpperCase())).toBe(false)
    expect(isRealBuyerEmail('ana@example.com')).toBe(true)
    expect(isRealBuyerEmail('  ')).toBe(false)
    expect(shouldEmailBuyer({ source: 'in_person' }, COUNTER_PLACEHOLDER_EMAIL)).toBe(false)
    expect(shouldEmailBuyer({ source: 'in_person' }, 'ana@example.com')).toBe(true)
    expect(shouldEmailBuyer({}, 'ana@example.com')).toBe(true)
    expect(shouldEmailBuyer({}, null)).toBe(false)
  })
})

test.describe('order-source · inbox badge, filter and the Ganancias split', () => {
  const orders = [
    { id: 'a', source: 'miyagi' }, { id: 'b', source: 'in_person' }, { id: 'c', source: 'mercadolibre' }, { id: 'd', source: null }, { id: 'e', source: 'in_person' },
  ]
  test('badge only for counter and link sales; unknown sources read as the online shop', () => {
    expect(inPersonBadgeLabel('in_person')).toBe('En persona')
    expect(inPersonBadgeLabel('payment_link')).toBe('Cobro con link')
    expect(inPersonBadgeLabel('mercadolibre')).toBeNull()
    expect(inPersonBadgeLabel('whatever')).toBeNull()
  })
  test('the filter keeps only the chosen source; null keeps all; options list only what is present', () => {
    expect(filterBySource(orders, 'in_person').map((o) => o.id)).toEqual(['b', 'e'])
    expect(filterBySource(orders, 'miyagi').map((o) => o.id)).toEqual(['a', 'd'])
    expect(filterBySource(orders, null)).toHaveLength(5)
    expect(presentSources(orders)).toEqual(['miyagi', 'in_person', 'mercadolibre'])
    expect(presentSources([{ source: 'miyagi' }])).toEqual(['miyagi'])
  })
  test('Ganancias splits per source and currency without mixing', () => {
    const rows = [
      { source: 'native', currency_code: 'mxn', revenue_cents: 1000, margin_cents: 400 },
      { source: 'in_person', currency_code: 'mxn', revenue_cents: 500, margin_cents: 200 },
      { source: 'in_person', currency_code: 'mxn', revenue_cents: 700, margin_cents: null },
      { source: 'in_person', currency_code: 'usd', revenue_cents: 100, margin_cents: 10 },
    ]
    expect(summarizeBySource(rows).map((b) => [b.source, b.currency_code, b.orders, b.revenue_cents, b.margin_cents])).toEqual([
      ['miyagi', 'mxn', 1, 1000, 400],
      ['in_person', 'mxn', 2, 1200, 200],
      ['in_person', 'usd', 1, 100, 10],
    ])
  })
})

test('receipt text lists the shop, items, total, date and method', () => {
  const text = buildReceiptText({
    shopName: 'Barro Vivo', date: '30 oct 2026', total: '$240', method: 'transfer',
    lines: [{ title: 'Taza', variantTitle: 'Chica', quantity: 2, lineTotal: '$240' }],
  })
  expect(text).toBe(['Recibo de Barro Vivo', '30 oct 2026', '', '2 x Taza (Chica): $240', '', 'Total: $240', 'Pago: Transferencia', 'Gracias por tu compra'].join('\n'))
})

test.describe('notify-policy · the admin Telegram notice', () => {
  test('a counter sale never carries the buyer address; other orders keep it', () => {
    expect(telegramBuyerLabel({ source: 'in_person' }, 'ana@example.com')).toBe('comprador en mostrador')
    expect(telegramBuyerLabel({}, 'ana@example.com')).toBe('ana@example.com')
    expect(telegramBuyerLabel({}, null)).toBe('comprador')
    expect(telegramBuyerLabel(undefined, null, 'anunciante')).toBe('anunciante')
  })
})

test.describe('stored-sale · restoring from sessionStorage', () => {
  const base = { sale: { clientId: 'c1', lines: [], tenderedCents: null, uncertain: true }, cart: { lines: [] }, padText: '' }
  test('a sale saved by the S1 build (no kind) restores as cash', () => {
    expect(parseStoredSale<{ sale: { kind: string } }>(JSON.stringify(base))?.sale.kind).toBe('cash')
  })
  test('a known kind is kept; an unknown one falls back to cash', () => {
    expect(parseStoredSale<{ sale: { kind: string } }>(JSON.stringify({ ...base, sale: { ...base.sale, kind: 'transfer' } }))?.sale.kind).toBe('transfer')
    expect(parseStoredSale<{ sale: { kind: string } }>(JSON.stringify({ ...base, sale: { ...base.sale, kind: 'bitcoin' } }))?.sale.kind).toBe('cash')
  })
  test('garbage and half-written entries are refused, not crashed on', () => {
    expect(parseStoredSale('')).toBeNull()
    expect(parseStoredSale(null)).toBeNull()
    expect(parseStoredSale('{not json')).toBeNull()
    expect(parseStoredSale(JSON.stringify({ sale: { clientId: 'c1' } }))).toBeNull()
  })
})
