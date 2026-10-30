import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import {
  buildLinkBody, extraPayments, isLinkCancellable, isLinkToken, linkShortUrl, linkStateLabel, linkTitle, linkUrl, linkWhatsAppUrl,
  payChoices, payFailureKind, linkBadge, payScreen, payStartBody, shouldRebuildCart,
} from '../lib/in-person/payment-link'
import { runPayFlow, type PayFlowDeps } from '../lib/in-person/payment-link-flow'
import { filterLinksByState, formatLinkForAgent, mapCancelLinkArgs, mapCreateLinkArgs, pesosToCents } from '../lib/in-person/payment-link-mcp'

/** In-person sales · Sprint 4 — payment links: form, pay page, flow, agent tools. */

const TOKEN = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'
const form = { mode: 'products' as const, lines: [{ variant_id: 'v1', quantity: 2 }], uses: 'single' as const, days: 7, concept: '', amountText: '' }

test.describe('link form to request body', () => {
  test('products: lines, uses and expiry only — never a price', () => {
    expect(buildLinkBody(form)).toEqual({ ok: true, body: { kind: 'products', lines: form.lines, uses: 'single', expires_in_days: 7 } })
    const multi = buildLinkBody({ ...form, uses: 'multi' })
    expect(multi.ok && multi.body.uses).toBe('multi')
    expect(JSON.stringify(buildLinkBody(form))).not.toMatch(/amount|price/)
  })
  test('products with nothing picked, and a bad expiry, are refused with words', () => {
    expect(buildLinkBody({ ...form, lines: [] })).toMatchObject({ ok: false, message: 'Elige al menos un producto.' })
    for (const days of [0, 31, 1.5, Number.NaN]) expect(buildLinkBody({ ...form, days }).ok, String(days)).toBe(false)
    expect(buildLinkBody({ ...form, days: 30 }).ok).toBe(true)
  })
  test('free amount: pesos to centavos, concept trimmed, always single-use even if multi was chosen', () => {
    const r = buildLinkBody({ ...form, mode: 'amount', uses: 'multi', concept: '  Anticipo   de pedido ', amountText: '500.5' })
    expect(r).toEqual({ ok: true, body: { kind: 'amount', concept: 'Anticipo de pedido', amount_cents: 50050, uses: 'single', expires_in_days: 7 } })
  })
  test('free amount bounds: $10 to $50,000, concept 3 to 80', () => {
    const base = { ...form, mode: 'amount' as const, concept: 'Anticipo' }
    expect(buildLinkBody({ ...base, amountText: '9.99' }).ok).toBe(false)
    expect(buildLinkBody({ ...base, amountText: '10' }).ok).toBe(true)
    expect(buildLinkBody({ ...base, amountText: '50000' }).ok).toBe(true)
    expect(buildLinkBody({ ...base, amountText: '50000.01' }).ok).toBe(false)
    expect(buildLinkBody({ ...base, amountText: 'abc' }).ok).toBe(false)
    expect(buildLinkBody({ ...base, amountText: '100', concept: 'ab' }).ok).toBe(false)
    expect(buildLinkBody({ ...base, amountText: '100', concept: 'x'.repeat(81) }).ok).toBe(false)
  })
})

test.describe('link views and urls', () => {
  test('urls are built only from a real token', () => {
    expect(linkUrl(TOKEN)).toBe(`https://miyagisanchez.com/pagar/${TOKEN}`)
    expect(linkShortUrl(TOKEN)).toBe(`https://mschz.org/pagar/${TOKEN}`)
    for (const bad of ['', 'short', '../etc', 'a b'.repeat(8), 'x'.repeat(200)]) {
      expect(isLinkToken(bad)).toBe(false)
      expect(linkUrl(bad)).toBeNull()
      expect(linkShortUrl(bad)).toBeNull()
    }
    expect(linkWhatsAppUrl(TOKEN, 'Barro Vivo', 'tu pedido')).toContain('wa.me')
    expect(decodeURIComponent(linkWhatsAppUrl(TOKEN, 'Barro Vivo', 'tu pedido')!)).toContain(`mschz.org/pagar/${TOKEN}`)
    expect(linkWhatsAppUrl('bad', 'x', 'y')).toBeNull()
  })
  test('state labels, cancellable only while pending, titles, repeat payments shown', () => {
    expect(linkStateLabel('paid')).toBe('Pagado')
    expect(linkStateLabel('pending')).toBe('Esperando pago')
    expect(isLinkCancellable('pending')).toBe(true)
    for (const s of ['paid', 'expired', 'cancelled']) expect(isLinkCancellable(s)).toBe(false)
    expect(linkTitle({ kind: 'amount', concept: 'Anticipo', lines: null })).toBe('Anticipo')
    expect(linkTitle({ kind: 'products', concept: null, lines: [{ variant_id: 'a', quantity: 2 }, { variant_id: 'b', quantity: 1 }] })).toBe('3 productos')
    expect(extraPayments({ uses: 'single', paid_order_ids: ['o1', 'o2'] })).toBe(1)
    expect(extraPayments({ uses: 'single', paid_order_ids: ['o1'] })).toBe(0)
    expect(extraPayments({ uses: 'multi', paid_order_ids: ['o1', 'o2', 'o3'] })).toBe(0)
  })
})

test.describe('pay page state to screen', () => {
  test('only an explicit pending link is payable', () => {
    expect(payScreen({ httpStatus: 200, state: 'pending' })).toEqual({ screen: 'ready' })
    for (const state of [undefined, null, '', 'weird']) expect(payScreen({ httpStatus: 200, state }).screen, String(state)).toBe('unavailable')
  })
  test('paid, expired, cancelled and missing say the agreed words', () => {
    expect(payScreen({ httpStatus: 200, state: 'paid' })).toEqual({ screen: 'paid', message: 'Este cobro ya se pagó.' })
    expect(payScreen({ httpStatus: 200, state: 'expired' })).toEqual({ screen: 'expired', message: 'Este link ya venció. Pídele uno nuevo a la tienda.' })
    expect(payScreen({ httpStatus: 200, state: 'cancelled' }).screen).toBe('cancelled')
    expect(payScreen({ httpStatus: 409, code: 'LINK_PAID' }).screen).toBe('paid')
    expect(payScreen({ httpStatus: 410, code: 'LINK_EXPIRED' }).screen).toBe('expired')
    expect(payScreen({ httpStatus: 410, code: 'LINK_CANCELLED' }).screen).toBe('cancelled')
    expect(payScreen({ httpStatus: 404, code: 'LINK_NOT_FOUND' }).screen).toBe('not_found')
    expect(payScreen({ httpStatus: 502 }).screen).toBe('unavailable')
  })
  test('the shop\'s methods become choices; the start body never names seller, price or a real fulfilment', () => {
    expect(payChoices([{ id: 'stripe' }, { id: 'mercadopago' }, { id: 'manual', sub_options: [{ type: 'cash' }, { type: 'clabe' }] }]).map((c) => c.id)).toEqual(['mercadopago', 'stripe', 'manual'])
    expect(payChoices([{ id: 'manual', sub_options: [{ type: 'cash' }] }])).toEqual([])
    expect(payStartBody('stripe', null)).toEqual({ provider: 'stripe', fulfillment_method: 'digital' })
    expect(payStartBody('manual', 'dimo')).toEqual({ provider: 'manual', manual_sub_type: 'dimo', fulfillment_method: 'digital' })
    expect(Object.keys(payStartBody('mercadopago', null))).not.toEqual(expect.arrayContaining(['seller_id', 'amount', 'offer_amount_cents']))
  })
})

test.describe('link busy, closed and pending-confirmation', () => {
  test('closed codes close the page, LINK_BUSY offers a retry, the rest retry plainly', () => {
    for (const c of ['LINK_PAID', 'LINK_EXPIRED', 'LINK_CANCELLED']) expect(payFailureKind(c)).toBe('closed')
    expect(payFailureKind('LINK_BUSY')).toBe('busy')
    for (const c of ['CHECKOUT_START_FAILED', undefined, 'CART_CHANGED']) expect(payFailureKind(c)).toBe('retry')
  })
  test('a LINK_BUSY from start-checkout is passed through, not retried into a second cart', async () => {
    let carts = 0
    const d: PayFlowDeps = {
      async buildCart() { carts += 1; return { ok: true, cart_id: 'c' } },
      async startCheckout() { return { ok: false, status: 409, code: 'LINK_BUSY', message: 'Alguien está pagando este cobro.' } },
      async completeCart() { return true },
    }
    expect(await runPayFlow('stripe', d)).toMatchObject({ ok: false, code: 'LINK_BUSY' })
    expect(carts).toBe(1)
  })
  test('a pending single-use link with an order reads «Pago por confirmar»; otherwise the plain state', () => {
    expect(linkBadge({ state: 'pending', paid_order_ids: ['o1'] }).label).toBe('Pago por confirmar')
    expect(linkBadge({ state: 'pending', paid_order_ids: [] }).label).toBe('Esperando pago')
    expect(linkBadge({ state: 'paid', paid_order_ids: ['o1'] })).toEqual({ label: 'Pagado', token: 'success' })
    expect(linkBadge({ state: 'cancelled', paid_order_ids: ['o1'] }).label).toBe('Cancelado')
  })
})

test.describe('pay flow', () => {
  type Start = Awaited<ReturnType<PayFlowDeps['startCheckout']>>
  function deps(starts: Start[], opts: { completeOk?: boolean } = {}) {
    const calls = { cart: 0, start: 0, complete: 0 }
    const d: PayFlowDeps = {
      async buildCart() { calls.cart += 1; return { ok: true, cart_id: `cart_${calls.cart}` } },
      async startCheckout() { const r = starts[Math.min(calls.start, starts.length - 1)]; calls.start += 1; return r },
      async completeCart() { calls.complete += 1; return opts.completeOk !== false },
    }
    return { d, calls }
  }
  const card: Start = { ok: true, redirect_url: 'https://pay.example/x', manual_payment: null }
  const manualPay = { spei: { clabe: '012345678901234567', bank_name: null, account_holder: null }, dimo: null }

  test('card: a fresh cart, one start, the provider url; nothing completed here', async () => {
    const { d, calls } = deps([card])
    expect(await runPayFlow('stripe', d)).toEqual({ ok: true, kind: 'redirect', url: 'https://pay.example/x' })
    expect(calls).toEqual({ cart: 1, start: 1, complete: 0 })
  })
  test('manual: start then complete the cart, show the transfer data', async () => {
    const { d, calls } = deps([{ ok: true, redirect_url: null, manual_payment: manualPay }])
    expect(await runPayFlow('manual', d)).toEqual({ ok: true, kind: 'manual', manual: manualPay })
    expect(calls.complete).toBe(1)
  })
  test('manual whose cart cannot be completed is an error, not a shown CLABE', async () => {
    const { d } = deps([{ ok: true, redirect_url: null, manual_payment: manualPay }], { completeOk: false })
    expect(await runPayFlow('manual', d)).toMatchObject({ ok: false, code: 'COMPLETE_FAILED' })
  })
  test('CHECKOUT_EXISTS or CART_CHANGED build ONE fresh cart and retry once, never loop', async () => {
    for (const code of ['CHECKOUT_EXISTS', 'CART_CHANGED']) {
      const ok = deps([{ ok: false, status: 409, code }, card])
      expect((await runPayFlow('stripe', ok.d)).ok).toBe(true)
      expect(ok.calls.cart).toBe(2)
      const stuck = deps([{ ok: false, status: 409, code }])
      expect(await runPayFlow('stripe', stuck.d)).toMatchObject({ ok: false, code })
      expect(stuck.calls.cart).toBe(2)
    }
    expect(shouldRebuildCart(409, 'CHECKOUT_EXISTS')).toBe(true)
    expect(shouldRebuildCart(422, 'CHECKOUT_EXISTS')).toBe(false)
    expect(shouldRebuildCart(409, 'SALE_CLOSED')).toBe(false)
  })
  test('a cart refusal (paid, expired) is passed through unchanged', async () => {
    const d: PayFlowDeps = { async buildCart() { return { ok: false, status: 409, code: 'LINK_PAID', message: 'Este cobro ya se pagó.' } }, async startCheckout() { throw new Error('no') }, async completeCart() { return true } }
    expect(await runPayFlow('stripe', d)).toEqual({ ok: false, status: 409, code: 'LINK_PAID', message: 'Este cobro ya se pagó.' })
  })
  test('a card start with no url is an error', async () => {
    expect(await runPayFlow('stripe', deps([{ ok: true, redirect_url: null, manual_payment: null }]).d)).toMatchObject({ ok: false, code: 'CHECKOUT_URL_MISSING' })
  })
})

test.describe('agent tools', () => {
  test('create args: products pass through, amounts convert pesos to centavos and force single use', () => {
    expect(mapCreateLinkArgs({ kind: 'products', lines: [{ variant_id: 'v', quantity: 1, extra: 'x' }], uses: 'multi', expires_in_days: 3 })).toEqual({
      ok: true, body: { kind: 'products', lines: [{ variant_id: 'v', quantity: 1 }], uses: 'multi', expires_in_days: 3 },
    })
    expect(mapCreateLinkArgs({ kind: 'amount', concept: 'Anticipo', amount_mxn: 120.5, uses: 'multi' })).toEqual({
      ok: true, body: { kind: 'amount', concept: 'Anticipo', amount_cents: 12050, uses: 'single' },
    })
    expect(pesosToCents(19.99)).toBe(1999)
    for (const bad of [0, -1, Number.NaN, '5', null, undefined]) expect(pesosToCents(bad)).toBeNull()
    expect(mapCreateLinkArgs({ kind: 'amount', concept: 'x', amount_mxn: 0 }).ok).toBe(false)
    expect(mapCreateLinkArgs({ kind: 'products', lines: [] }).ok).toBe(false)
    expect(mapCreateLinkArgs({ kind: 'nope' }).ok).toBe(false)
  })
  test('the shop is never an argument: slug and seller fields are not forwarded', () => {
    const r = mapCreateLinkArgs({ kind: 'products', lines: [{ variant_id: 'v', quantity: 1 }], seller_slug: 'otra-tienda', seller_id: 'sel_x', shop_slug: 'otra' })
    expect(JSON.stringify(r)).not.toMatch(/otra|sel_x|seller/)
  })
  test('cancel id is validated; list filters by state; the view carries both urls', () => {
    expect(mapCancelLinkArgs({ link_id: 'plink_01ABC' })).toEqual({ ok: true, id: 'plink_01ABC' })
    for (const bad of [{}, { link_id: '../x' }, { link_id: '' }, { link_id: 5 }]) expect(mapCancelLinkArgs(bad).ok).toBe(false)
    const rows = [{ state: 'paid' }, { state: 'pending' }]
    expect(filterLinksByState(rows, 'pending')).toEqual([{ state: 'pending' }])
    expect(filterLinksByState(rows, undefined)).toHaveLength(2)
    const v = formatLinkForAgent({ id: 'l1', token: TOKEN, kind: 'amount', concept: 'A', amount_cents: 12050, uses: 'single', expires_at: 'x', state: 'pending', paid_order_ids: ['o1'] })
    expect(v).toMatchObject({ amount_mxn: 120.5, paid_orders: 1, url: `https://miyagisanchez.com/pagar/${TOKEN}`, short_url: `https://mschz.org/pagar/${TOKEN}` })
  })
  test('the tools are declared, dispatched, listed as seller tools, and read the shop from the token only', () => {
    const src = readFileSync(path.resolve(import.meta.dirname, '../app/api/ucp/mcp/route.ts'), 'utf8')
    for (const t of ['create_payment_link', 'list_payment_links', 'cancel_payment_link']) {
      expect(src).toContain(`name: '${t}'`)
      expect(src).toContain(`case '${t}'`)
    }
    const handler = src.slice(src.indexOf('async function paymentLinkTool('), src.indexOf('async function handleListOrders('))
    expect(handler).toContain('resolveToolShop(')
    expect(handler).not.toMatch(/args\.(seller|shop|slug)/)
    const caps = readFileSync(path.resolve(import.meta.dirname, '../lib/ucp/capabilities.ts'), 'utf8')
    expect(caps).toContain("'create_payment_link'")
  })
})
