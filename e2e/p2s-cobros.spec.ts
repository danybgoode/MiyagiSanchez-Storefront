import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkoutOptionsQuery, checkoutPreview, type CheckoutOptions } from '../lib/checkout-options'
import { clabeComplete, normalizeClabeInput } from '../lib/clabe'
import { fetchCheckoutPreview } from '../lib/prompt-to-shop/client'
import { MP_CONNECT_HREF, cashPatch, correosPatch, handDeliveryPatch, readChooserState, speiOffPatch, speiPatch } from '../lib/prompt-to-shop/cobros'

// Prompt-to-shop S5.1 — the cobros / entregas chooser and the buyer checkout preview (HIGH risk: money settings).
//
// The rule "which methods a buyer is offered" lives ONCE, in the Medusa backend (`checkout-options`). The preview must
// not re-derive it: it asks the same endpoint with the same query CheckoutExperience sends, and projects the answer
// the way CheckoutExperience draws it. These specs hold that, and that the chooser writes only the existing keys.

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/** Exactly what the backend answers for a shop with SPEI + hand delivery (cash default-on) and nothing else. */
const SPEI_AND_HAND: CheckoutOptions = {
  payment_methods: [{
    id: 'manual', kind: 'manual', label: 'Pago directo al vendedor', note: 'Acuerdas el pago…', instant: false, protected: false,
    sub_options: [
      { type: 'clabe', label: 'Transferencia SPEI', note: 'BBVA', requires_pickup: false },
      { type: 'cash', label: 'Efectivo al recoger', note: 'Pagas en efectivo al recoger tu pedido.', requires_pickup: true },
    ],
  }],
  payment_default: 'manual',
  delivery_methods: [{ id: 'local_pickup', label: 'Recolección en mano', note: 'Coordina el punto de entrega con la tienda.', requires_pickup_spot: false, pickup_spots: [] }],
  delivery_default: 'local_pickup',
  only_coordinated: false,
  preparation: null,
}

const MP_ONLY: CheckoutOptions = {
  payment_methods: [{ id: 'mercadopago', kind: 'online', label: 'Mercado Pago', note: 'Tarjeta, wallet, OXXO y meses sin intereses.', instant: true, protected: true }],
  payment_default: 'mercadopago',
  delivery_methods: [{ id: 'shipping', label: 'Envío a domicilio', note: 'Cotiza y elige paquetería antes de pagar.', requires_address: true }],
  delivery_default: 'shipping',
  only_coordinated: false,
  preparation: null,
}

// ── The preview is checkout's own answer ─────────────────────────────────────────────────────────────────────────

test('the preview shows the chosen methods ONLY — exactly what checkout answered, «Pago directo» expanded', () => {
  const p = checkoutPreview(SPEI_AND_HAND)
  expect(p.kind).toBe('ready')
  if (p.kind !== 'ready') return
  expect(p.payments.map((m) => m.key)).toEqual(['manual:clabe', 'manual:cash'])
  expect(p.payments.map((m) => m.label)).toEqual(['Transferencia SPEI', 'Efectivo al recoger'])
  expect(p.delivery.map((d) => d.key)).toEqual(['local_pickup'])
  // Nothing the shop did not choose appears: no card, no Mercado Pago, no shipping.
  const keys = [...p.payments, ...p.delivery].map((m) => m.key)
  for (const absent of ['mercadopago', 'stripe', 'shipping', 'manual_carrier', 'coord']) expect(keys).not.toContain(absent)

  const mp = checkoutPreview(MP_ONLY)
  expect(mp).toEqual({
    kind: 'ready',
    payments: [{ key: 'mercadopago', label: 'Mercado Pago', note: 'Tarjeta, wallet, OXXO y meses sin intereses.' }],
    delivery: [{ key: 'shipping', label: 'Envío a domicilio', note: 'Cotiza y elige paquetería antes de pagar.' }],
  })
})

test('an answer checkout would not render is «could not tell», never an empty list', () => {
  for (const bad of [null, undefined, {}, { error: 'No se pudo' }, { payment_methods: [] }, 'html', 42]) {
    expect(checkoutPreview(bad)).toEqual({ kind: 'unavailable' })
  }
  // A real answer with nothing in it IS empty — that is checkout saying "nobody can pay", and the card says so.
  expect(checkoutPreview({ ...SPEI_AND_HAND, payment_methods: [], delivery_methods: [] })).toEqual({ kind: 'ready', payments: [], delivery: [] })
})

test('the preview asks the SAME endpoint with the SAME query CheckoutExperience sends', async () => {
  const calls: string[] = []
  const fetch = (async (url: string) => {
    calls.push(String(url))
    return new Response(JSON.stringify(MP_ONLY), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  const p = await fetchCheckoutPreview('tamales-la-abuela', 'mx', { fetch })
  expect(p.kind).toBe('ready')
  expect(calls).toHaveLength(1)
  const url = new URL(calls[0], 'https://x')
  expect(url.pathname).toBe('/api/checkout/options')
  expect(Object.fromEntries(url.searchParams)).toEqual({ sellerId: 'tamales-la-abuela', listingType: 'product', isDigital: 'false', deliveryMode: 'carrier', market: 'mx' })

  // …and those are checkout's own parameter names, read from the checkout source, not restated here.
  const checkout = read('app/(shell)/checkout/CheckoutExperience.tsx')
  const built = checkout.match(/new URLSearchParams\(\{([^}]+)\}\)/)?.[1] ?? ''
  const names = built.split(',').map((s) => s.split(':')[0].trim()).filter(Boolean).sort()
  expect(names.length).toBeGreaterThan(3)
  expect([...new URLSearchParams(checkoutOptionsQuery('x')).keys()].sort()).toEqual(names)
  expect(checkout).toContain('fetch(`/api/checkout/options?${qs}`)')
})

test('a failed or thrown request is unavailable', async () => {
  const notOk = (async () => new Response('{"error":"x"}', { status: 502 })) as unknown as typeof globalThis.fetch
  const throws = (async () => { throw new Error('offline') }) as unknown as typeof globalThis.fetch
  expect(await fetchCheckoutPreview('s', 'mx', { fetch: notOk })).toEqual({ kind: 'unavailable' })
  expect(await fetchCheckoutPreview('s', 'mx', { fetch: throws })).toEqual({ kind: 'unavailable' })
})

test('no parallel rule: the preview module never reads shop settings, and checkout reads its shape from it', () => {
  const src = read('lib/checkout-options.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  for (const key of ['settings', 'bank_transfer', 'clabe', 'local_pickup', 'charges_enabled', 'mercadopago', 'metadata']) {
    expect(src, key).not.toContain(key)
  }
  expect(read('app/(shell)/checkout/CheckoutExperience.tsx')).toContain("import type { CheckoutOptions } from '@/lib/checkout-options'")
  // The chooser's buyer card is fed only by checkout's answer.
  const chooser = read('app/(shell)/p2s/_components/CobrosChooser.tsx')
  expect(chooser).toContain('fetchCheckoutPreview(shopSlug, market)')
})

// ── The rails are the existing ones ──────────────────────────────────────────────────────────────────────────────

test('SPEI saves through the Pagos rule: 18 digits, digits only, or nothing is sent', () => {
  expect(normalizeClabeInput('0121 8000 1234 5678 90')).toBe('012180001234567890')
  expect(normalizeClabeInput('0121800012345678901234')).toHaveLength(18)
  expect(clabeComplete('01218000123456789')).toBe(false)
  expect(speiPatch({ clabe: '01218000123456789', bankName: 'BBVA', accountHolder: 'Ana' })).toBeNull()
  expect(speiPatch({ clabe: '0121 8000 1234 5678 90', bankName: ' BBVA ', accountHolder: '' })).toEqual({
    settings: { checkout: { bank_transfer: { enabled: true, clabe: '012180001234567890', bank_name: 'BBVA', account_holder: null } } },
  })
  // Turning SPEI off sends only the switch, so the merge keeps the CLABE.
  expect(speiOffPatch()).toEqual({ settings: { checkout: { bank_transfer: { enabled: false } } } })
  // Pagos itself now reads the rule from the same module, not an inline copy.
  const pagos = read('app/(shell)/shop/manage/settings/_sections/Pagos.tsx')
  expect(pagos).toContain("from '@/lib/clabe'")
  expect(pagos).not.toMatch(/clabe\.length [!=]== 18/)
})

test('every switch writes a key the settings pages already write — no new setting', () => {
  const pagos = read('app/(shell)/shop/manage/settings/_sections/Pagos.tsx')
  const envios = read('app/(shell)/shop/manage/settings/_sections/Envios.tsx')
  expect(cashPatch(false)).toEqual({ settings: { checkout: { cash_pickup: { enabled: false } } } })
  expect(handDeliveryPatch(true)).toEqual({ settings: { shipping: { local_pickup: true } } })
  expect(correosPatch(true)).toEqual({ settings: { shipping: { correos_enabled: true } } })
  for (const k of ['bank_transfer: {', 'cash_pickup: {', 'account_holder:', 'bank_name:']) expect(pagos, k).toContain(k)
  for (const k of ['local_pickup:', 'correos_enabled:']) expect(envios, k).toContain(k)
})

test('Mercado Pago is the existing OAuth start, with the return the cobros wizard already uses', () => {
  expect(MP_CONNECT_HREF).toBe('/api/mp/connect?redirect_to=wizard')
  expect(read('app/(shell)/shop/manage/settings/pagos/wizard/CobrosWizardClient.tsx')).toContain('href="/api/mp/connect?redirect_to=wizard"')
  expect(read('app/api/mp/connect/route.ts')).toContain("req.nextUrl.searchParams.get('redirect_to') === 'wizard'")
})

test('the switches start from what the shop row holds', () => {
  expect(readChooserState(null)).toMatchObject({ mercadopago: false, spei: false, cash: true, handDelivery: false, correos: false, hasOrigin: false })
  const s = readChooserState({
    mercadopago: { connected: true },
    checkout: { bank_transfer: { enabled: true, clabe: '012180001234567890', bank_name: 'BBVA' }, cash_pickup: { enabled: false } },
    shipping: { local_pickup: true, correos_enabled: true, origin_address: { street: 'Reforma 1', city: 'CDMX', state: 'CDMX', postal_code: '06600' } },
  })
  expect(s).toMatchObject({ mercadopago: true, spei: true, clabe: '012180001234567890', cash: false, handDelivery: true, correos: true, hasOrigin: true })
  // A CLABE that is not 18 digits is not SPEI on, and a switched-off SPEI is off.
  expect(readChooserState({ checkout: { bank_transfer: { clabe: '123' } } }).spei).toBe(false)
  expect(readChooserState({ checkout: { bank_transfer: { enabled: false, clabe: '012180001234567890' } } }).spei).toBe(false)
})
