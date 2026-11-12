import { expect, test } from '@playwright/test'
import { computeShopCompletion, getSetupSteps, type ShopRow } from '../lib/setup-guide'

/**
 * Pure-logic spec (api project, no DOM/network) for the seller-portal-setup-guide
 * epic, Story B.1. Exercises the extraction directly: `computeShopCompletion` must
 * reproduce the settings page's old inline logic exactly (regression guard for the
 * "identical render" refactor), and `getSetupSteps` covers the 5-step guide's
 * done/open resolution the dashboard card (B.2) will render.
 */

const emptyShop: ShopRow = {
  name: '',
  description: null,
  metadata: null,
  mp_enabled: null,
  custom_domain: null,
  ucp_webhook_url: null,
}

function shopWith(overrides: Partial<ShopRow>): ShopRow {
  return { ...emptyShop, ...overrides }
}

test.describe('setup-guide · computeShopCompletion', () => {
  test('an empty shop has no completed sections', () => {
    const flags = computeShopCompletion(emptyShop)
    expect(Object.values(flags).every((v) => v === false)).toBe(true)
  })

  test('perfil requires BOTH name and description', () => {
    expect(computeShopCompletion(shopWith({ name: 'Mi Tienda', description: null })).perfil).toBe(false)
    expect(computeShopCompletion(shopWith({ name: '', description: 'Vendo cosas' })).perfil).toBe(false)
    expect(computeShopCompletion(shopWith({ name: 'Mi Tienda', description: 'Vendo cosas' })).perfil).toBe(true)
  })

  test('pagos is done via stripe, mercado pago, OR clabe (any one)', () => {
    // Since listing-readiness S2.2 «pagos» IS the readiness rule's canCollect: a Stripe account must exist
    // (`account_id`), a CLABE must be all 18 digits, and DiMo counts — the same facts activation checks.
    expect(computeShopCompletion(shopWith({ metadata: { settings: { mercadopago: { connected: true } } } })).pagos).toBe(true)
    expect(computeShopCompletion(shopWith({ metadata: { settings: { stripe: { charges_enabled: true, account_id: 'acct_1' } } } })).pagos).toBe(true)
    expect(computeShopCompletion(shopWith({ metadata: { settings: { checkout: { bank_transfer: { clabe: '01218' } } } } })).pagos).toBe(false)
    expect(computeShopCompletion(shopWith({ metadata: { settings: { checkout: { dimo: { enabled: true, phone: '5512345678' } } } } })).pagos).toBe(true)
    expect(computeShopCompletion(shopWith({ metadata: { settings: { checkout: { bank_transfer: { clabe: '012180001234567895' } } } } })).pagos).toBe(true)
    expect(computeShopCompletion(emptyShop).pagos).toBe(false)
  })

  test('pagos is NOT done from mp_enabled alone (Sprint 3 bug fix) — it is an opt-out column, not a connected-state flag', () => {
    // Regression guard for the onboarding-three-doors Sprint 3 fix: mp_enabled
    // defaults `true` for every shop (supabase/20260521_shops_mp_settings.sql),
    // so using it as the "pagos done" signal made this step read as complete
    // for every fresh shop that never connected anything.
    expect(computeShopCompletion(shopWith({ mp_enabled: true })).pagos).toBe(false)
  })

  test('envios is done via local pickup, envia, an origin address field, or a pickup spot', () => {
    expect(computeShopCompletion(shopWith({ metadata: { settings: { shipping: { local_pickup: true } } } })).envios).toBe(true)
    expect(computeShopCompletion(shopWith({ metadata: { settings: { shipping: { origin_address: { city: 'CDMX' } } } } })).envios).toBe(true)
    expect(computeShopCompletion(shopWith({ metadata: { settings: { shipping: { pickup_spots: [{ id: '1' }] } } } })).envios).toBe(true)
    expect(computeShopCompletion(shopWith({ metadata: { settings: { shipping: { origin_address: { city: '' } } } } })).envios).toBe(false)
  })

  test('diseno rejects the default accent color as an empty shell', () => {
    expect(computeShopCompletion(shopWith({ metadata: { settings: { theme: { accent_color: '#1d6f42' } } } })).diseno).toBe(false)
    expect(computeShopCompletion(shopWith({ metadata: { settings: { theme: { accent_color: '#ff0000' } } } })).diseno).toBe(true)
    expect(computeShopCompletion(shopWith({ metadata: { settings: { theme: { tagline: 'Lo mejor de CDMX' } } } })).diseno).toBe(true)
  })

  test('agentes reflects the raw ucp_webhook_url column, not metadata', () => {
    expect(computeShopCompletion(shopWith({ ucp_webhook_url: 'https://agent.example/hook' })).agentes).toBe(true)
    expect(computeShopCompletion(emptyShop).agentes).toBe(false)
  })

  test('canal reflects the raw custom_domain column', () => {
    expect(computeShopCompletion(shopWith({ custom_domain: 'tienda-propia.mx' })).canal).toBe(true)
    expect(computeShopCompletion(emptyShop).canal).toBe(false)
  })
})

test.describe('setup-guide · getSetupSteps', () => {
  test('all incomplete: step 3 (pagos) is open, not step 1 — payments is escalated ahead of order', () => {
    const steps = getSetupSteps({ shop: emptyShop, productCount: 0, shareDone: false })
    expect(steps.map((s) => s.id)).toEqual(['perfil', 'catalogo', 'pagos', 'envios', 'comparte'])
    expect(steps.every((s) => !s.done)).toBe(true)
    expect(steps.filter((s) => s.open).map((s) => s.id)).toEqual(['pagos'])
  })

  test('profile done but payments incomplete: pagos is still open, not catálogo — payments beats fixed order', () => {
    // The real-world case this guards: /sell only requires a shop NAME, not a
    // description, so perfil can be incomplete while catálogo (a listing was
    // created in the same wizard) is done. Payments must still surface, not
    // hide behind whichever step comes first numerically.
    const shop = shopWith({ name: 'Mi Tienda', description: 'Vendo artesanías' })
    const steps = getSetupSteps({ shop, productCount: 1, shareDone: false })
    const byId = Object.fromEntries(steps.map((s) => [s.id, s]))

    expect(byId.perfil.done).toBe(true)
    expect(byId.catalogo.done).toBe(true)
    expect(byId.pagos.done).toBe(false)
    expect(steps.filter((s) => s.open).map((s) => s.id)).toEqual(['pagos'])
  })

  test('profile + payments only: steps 1 & 3 done, step 2 (catálogo) is the open one (payments falls through once done)', () => {
    const shop = shopWith({
      name: 'Mi Tienda',
      description: 'Vendo artesanías',
      metadata: { settings: { mercadopago: { connected: true } } },
    })
    const steps = getSetupSteps({ shop, productCount: 0, shareDone: false })
    const byId = Object.fromEntries(steps.map((s) => [s.id, s]))

    expect(byId.perfil.done).toBe(true)
    expect(byId.pagos.done).toBe(true)
    expect(byId.catalogo.done).toBe(false)
    expect(byId.envios.done).toBe(false)
    expect(byId.comparte.done).toBe(false)
    expect(steps.filter((s) => s.open).map((s) => s.id)).toEqual(['catalogo'])
  })

  test('catálogo is done purely from productCount, no metadata needed', () => {
    const steps = getSetupSteps({ shop: emptyShop, productCount: 3, shareDone: false })
    expect(steps.find((s) => s.id === 'catalogo')?.done).toBe(true)
  })

  test('all 5 done: nothing is open (supports auto-collapse)', () => {
    const shop = shopWith({
      name: 'Mi Tienda',
      description: 'Vendo artesanías',
      metadata: { settings: { mercadopago: { connected: true }, shipping: { local_pickup: true } } },
    })
    const steps = getSetupSteps({ shop, productCount: 1, shareDone: true })
    expect(steps.every((s) => s.done)).toBe(true)
    expect(steps.some((s) => s.open)).toBe(false)
  })

  test('payments (step 3) is open on a fresh shop and carries the "~4 min" estimate, the exact sprint-1.md body copy, and the pagos CTA', () => {
    // The CTA points at the pagos SECTION, not `/pagos/wizard`. The wizard is one
    // guided path through a section that also shows what is already connected and
    // offers the direct Stripe/Mercado Pago/SPEI controls; a merchant dropped
    // straight into the wizard could not see the state they were being asked to
    // change. The wizard is one click from the section.
    const steps = getSetupSteps({ shop: emptyShop, productCount: 0, shareDone: false })
    const pagos = steps.find((s) => s.id === 'pagos')
    expect(pagos?.open).toBe(true)
    expect(pagos?.estimate).toBe('~4 min')
    expect(pagos?.body).toBe('Conecta Mercado Pago, Stripe o SPEI. Sin esto tus compradores no pueden pagarte.')
    expect(pagos?.ctaLabel).toBe('Configurar cobros')
    expect(pagos?.ctaHref).toBe('/shop/manage/settings/pagos')
  })
})
