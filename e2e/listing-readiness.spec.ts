import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  canCollect,
  listingNotReadyRefusal,
  listingReadiness,
  ownerShopFacts,
  publicShopFacts,
  readinessMessage,
  shopCatalogOnly,
  type PaymentFacts,
  type ShopFacts,
} from '../lib/listing-readiness'
import { deriveCheckoutViability } from '../lib/checkout-viability'
import { shopAcceptsAnyPayment, publicShopPaymentAvailability } from '../lib/public-shop-commerce'
import { offerCanProceed, offerCollectRefusal } from '../lib/shop-collect'
import { isNotReadyAnswer, readinessChecklist } from '../lib/readiness-view'

/**
 * Epic listing-readiness — every product sells online or is deliberately «Solo catálogo».
 * Reported live 2026-11-11 (miel-verduras): a product went live on a shop with no payment method, a buyer made an
 * offer, the seller accepted it, and nobody could pay. Pure: no Medusa, no Supabase.
 */
const ROOT = path.resolve(import.meta.dirname, '..')
const read = (f: string) => readFileSync(path.join(ROOT, f), 'utf8')

const NONE: PaymentFacts = { stripe: false, mercadopago: false, bankTransfer: false, dimo: false, cash: false }
const shop = (payments: Partial<PaymentFacts>, delivery: ShopFacts['delivery'] = { liveShipping: false, localPickup: true }): ShopFacts =>
  ({ payments: { ...NONE, ...payments }, delivery })

test.describe('readiness · the rule (D1)', () => {
  test('🚨 THE REPORTED BUG: a product on a shop with no payment method is catalog, naming «cobro»', () => {
    const r = listingReadiness({ listingType: 'product', deliveryMode: 'carrier', shop: shop({}) })
    expect(r).toEqual({ mode: 'catalog', missing: ['payment'] })
    expect(readinessMessage(r)).toMatch(/método de pago/)
  })

  test('each of the four rails makes it sell online; cash alone does not (it needs arranged delivery)', () => {
    for (const rail of ['stripe', 'mercadopago', 'bankTransfer', 'dimo'] as const) {
      expect(listingReadiness({ listingType: 'product', deliveryMode: 'carrier', shop: shop({ [rail]: true }) }).mode, rail).toBe('online')
    }
    expect(listingReadiness({ listingType: 'product', deliveryMode: 'carrier', shop: shop({ cash: true }) }).mode).toBe('catalog')
  })

  test('no delivery path is catalog too, and both gaps are named together', () => {
    expect(listingReadiness({ listingType: 'product', deliveryMode: null, shop: shop({}, { liveShipping: false, localPickup: false }) }))
      .toEqual({ mode: 'catalog', missing: ['delivery', 'payment'] })
  })

  test('arranged delivery sells with a MANUAL method (SPEI or cash) and asks for exactly that otherwise', () => {
    const noDelivery = { liveShipping: false, localPickup: false }
    expect(listingReadiness({ listingType: 'product', deliveryMode: 'arranged', shop: shop({ bankTransfer: true }, noDelivery) }).mode).toBe('online')
    expect(listingReadiness({ listingType: 'product', deliveryMode: 'arranged', shop: shop({ cash: true }, noDelivery) }).mode).toBe('online')
    expect(listingReadiness({ listingType: 'product', deliveryMode: 'arranged', shop: shop({ stripe: true }, noDelivery) }))
      .toEqual({ mode: 'catalog', missing: ['manual_payment'] })
  })

  test('🚨 an arranged product is a COORDINATED sale: card/MP/DiMo never make it sell, even with shipping (review catch)', () => {
    // arranged_only_enabled is ON in production: checkout drops carrier shipping and start-checkout refuses every
    // non-manual rail for it. The old "coexist" fallthrough published/offered it as buyable → a 422 at checkout.
    const withShipping = { liveShipping: true, localPickup: true }
    for (const rail of ['stripe', 'mercadopago', 'dimo'] as const) {
      expect(listingReadiness({ listingType: 'product', deliveryMode: 'arranged', shop: shop({ [rail]: true }, withShipping) }), rail)
        .toEqual({ mode: 'catalog', missing: ['manual_payment'] })
    }
    expect(listingReadiness({ listingType: 'product', deliveryMode: 'arranged', shop: shop({ stripe: true }, null) }).mode).toBe('catalog')
  })

  test('non-product types are never catalog here — they are contact- or flow-capable by design (the negation)', () => {
    for (const listingType of ['service', 'inmueble', 'auto', 'event', 'digital', 'subscription']) {
      expect(listingReadiness({ listingType, deliveryMode: null, shop: shop({}) }).mode, listingType).toBe('online')
    }
  })

  test('unknown delivery (the public view) never blocks — "could not see" is not "none"', () => {
    expect(listingReadiness({ listingType: 'product', deliveryMode: null, shop: shop({ dimo: true }, null) }).mode).toBe('online')
  })
})

test.describe('readiness · the old doors agree with the rule (S1.1)', () => {
  test('deriveCheckoutViability is the rule, with its old inputs', () => {
    const base = { listingType: 'product', deliveryMode: 'carrier' as const, hasLiveShipping: false, hasLocalPickup: true,
      hasStripe: false, hasMp: false, hasSpei: false, hasDimo: false, hasCash: false }
    expect(deriveCheckoutViability(base)).toBe(readinessMessage(listingReadiness({ listingType: 'product', deliveryMode: 'carrier', shop: shop({}) })))
    expect(deriveCheckoutViability({ ...base, hasSpei: true })).toBeNull()
  })

  test('shopAcceptsAnyPayment and canCollect agree on every public shop shape', () => {
    const shapes = [
      {},
      { settings: { checkout: { bank_transfer: { configured: true } } } },
      { settings: { checkout: { dimo: { configured: true, enabled: true } } } },
      { settings: { mercadopago: { connected: true } } },
      { mp_enabled: false, settings: { mercadopago: { connected: true } } },
      { settings: { stripe: { connected: true, charges_enabled: true } } },
    ]
    for (const meta of shapes) {
      expect(shopAcceptsAnyPayment(publicShopPaymentAvailability(meta)), JSON.stringify(meta))
        .toBe(canCollect(publicShopFacts(meta).payments))
    }
  })
})

test.describe('readiness · the two fact readers (D2)', () => {
  test('owner facts: a full 18-digit CLABE is a transfer; a partial one is not', () => {
    const ok = ownerShopFacts({ settings: { checkout: { bank_transfer: { clabe: '0021 8001 2345 6789 01' } } } })
    expect(ok.payments.bankTransfer).toBe(true)
    expect(ownerShopFacts({ settings: { checkout: { bank_transfer: { clabe: '12345' } } } }).payments.bankTransfer).toBe(false)
    expect(ownerShopFacts({ settings: { checkout: { bank_transfer: { clabe: '002180012345678901', enabled: false } } } }).payments.bankTransfer).toBe(false)
  })

  test('owner facts: a US Accounts v2 seller counts (the owner copy used to know only v1)', () => {
    const v2 = { settings: { stripe: { api_generation: 'v2', merchant_configuration: 'active', card_payments_status: 'active' } } }
    expect(ownerShopFacts(v2).payments.stripe).toBe(true)
    expect(ownerShopFacts({ settings: { stripe: { charges_enabled: true, account_id: 'acct_1' } } }).payments.stripe).toBe(true)
    expect(ownerShopFacts({ settings: { stripe: { charges_enabled: true, account_id: 'acct_1', enabled: false } } }).payments.stripe).toBe(false)
  })

  test('owner facts: cash needs pickup; delivery is read from shipping', () => {
    expect(ownerShopFacts({ settings: { shipping: { local_pickup: true } } }).payments.cash).toBe(true)
    expect(ownerShopFacts({ settings: { shipping: { local_pickup: false } } }).payments.cash).toBe(false)
    expect(ownerShopFacts({}).delivery).toEqual({ liveShipping: false, localPickup: false })
  })

  test('the empty shop (miel-verduras on 2026-11-11) has nothing to collect with', () => {
    const facts = ownerShopFacts({ settings: { theme: {}, faq: [], shipping: { local_pickup: true } } })
    expect(canCollect(facts.payments)).toBe(false)
  })

  test('public facts never claim to know delivery', () => {
    expect(publicShopFacts({ settings: { shipping: { local_pickup: true } } }).delivery).toBeNull()
  })
})

test.describe('readiness · publish/activate (S1.2, D4)', () => {
  const catalog = listingReadiness({ listingType: 'product', deliveryMode: 'carrier', shop: shop({}) })

  test('a catalog listing is refused with a machine code and what is missing…', () => {
    expect(listingNotReadyRefusal(catalog, false)).toEqual({
      code: 'LISTING_NOT_READY', error: readinessMessage(catalog), missing: ['payment'],
    })
  })

  test('…unless the merchant chose «Publicar como catálogo»; an online listing always goes (the negation)', () => {
    expect(listingNotReadyRefusal(catalog, true)).toBeNull()
    expect(listingNotReadyRefusal({ mode: 'online' }, false)).toBeNull()
  })

  test('🚨 every owner door that puts a product live asks the rule — the sweep, not the door we found', () => {
    // The new-listing form was the door that never asked. Every place that publishes must use the seam.
    const create = read('app/api/sell/create/route.ts')
    expect(create).toContain('listingNotReadyRefusal(')
    expect(create).toContain('body.publish_as_catalog === true')
    expect(create.indexOf('listingNotReadyRefusal(')).toBeLessThan(create.indexOf("medusaFetch('/store/sellers/me/products'"))
    const status = read('lib/listing-status.ts')
    expect(status).toContain('listingNotReadyRefusal(readiness, opts.publishAsCatalog === true)')
    // The activation gate reads the OWNER route (any status) — the public listing read 404'd every draft and failed open.
    expect(status).toContain('/store/sellers/me/products/${encodeURIComponent(listingId)}')
    expect(status).not.toContain('`/store/listings/${listingId}`')
    expect(read('app/api/sell/listing/[id]/route.ts')).toContain('publishAsCatalog: body.publish_as_catalog === true')
    expect(read('app/api/p2s/publish/route.ts')).toContain('{ publishAsCatalog }')
    expect(read('lib/seller-products.ts')).toContain('listingReadiness({ listingType, deliveryMode, shop: ownerShopFacts(shopMeta) })')
  })
})

test.describe('readiness · offers only where THIS listing can be paid (S1.3, D5)', () => {
  const deps = (metadata: Record<string, unknown> | null, mode: 'carrier' | 'arranged' | null | undefined = null) => ({
    sellerMetadata: async () => metadata,
    productDeliveryMode: async () => mode,
  })
  const ask = (metadata: Record<string, unknown> | null, mode?: 'carrier' | 'arranged' | null, listingType = 'product') =>
    offerCanProceed({ slug: 's', productId: 'prod_1', listingType }, deps(metadata, mode))
  const transfer = { settings: { checkout: { bank_transfer: { configured: true } } } }
  const cardOnly = { settings: { stripe: { connected: true, charges_enabled: true } } }

  test('a transfer-only shop CAN take an offer (the mirror would have said no)', async () => {
    expect(await ask(transfer)).toBe('yes')
  })

  test('🚨 a shop with no payment method cannot — buyer and seller each get their own sentence', async () => {
    const answer = await ask({ settings: {} })
    expect(answer).toBe('no')
    expect(offerCollectRefusal(answer, 'buyer')).toMatchObject({ status: 409, code: 'SHOP_CANNOT_COLLECT', error: expect.stringMatching(/Escríbele/) })
    expect(offerCollectRefusal(answer, 'seller')).toMatchObject({ status: 409, error: expect.stringMatching(/Activa cómo cobrar/) })
  })

  test('PER LISTING (cross-family review): the listing\'s own rule decides, with its delivery mode', async () => {
    // Arranged delivery sells on a MANUAL method — SPEI, or cash at pickup (visible in the public projection)…
    expect(await ask(transfer, 'arranged')).toBe('yes')
    expect(await ask({ settings: { shipping: { local_pickup: true } } }, 'arranged')).toBe('yes')
    // 🚨 …and ONLY on those: a card-only shop's arranged product is a coordinated sale checkout refuses (review catch).
    expect(await ask(cardOnly, 'arranged')).toBe('no')
    expect(await ask(cardOnly, 'carrier')).toBe('yes')
    // The delivery mode is READ per listing: an unreadable product fails closed instead of guessing.
    expect(await offerCanProceed({ slug: 's', productId: 'p', listingType: 'product' },
      { sellerMetadata: async () => transfer, productDeliveryMode: async () => undefined })).toBe('unavailable')
  })

  test('services and rentals are coordinated (manual only); other non-products need any rail', async () => {
    expect(await ask(cardOnly, null, 'service')).toBe('no')
    expect(await ask(transfer, null, 'service')).toBe('yes')
    expect(await ask(cardOnly, null, 'rental')).toBe('no')
    expect(await ask(cardOnly, null, 'auto')).toBe('yes')
    expect(await ask({ settings: {} }, null, 'auto')).toBe('no')
  })

  test('anything unreadable FAILS CLOSED (503), never "accepted" and never "cannot collect"', async () => {
    expect(await ask(null)).toBe('unavailable')
    expect(await offerCanProceed({ slug: 's', productId: 'p', listingType: 'product' },
      { sellerMetadata: async () => { throw new Error('down') }, productDeliveryMode: async () => null })).toBe('unavailable')
    expect(await offerCanProceed({ slug: null, productId: 'p', listingType: 'product' }, deps(transfer))).toBe('unavailable')
    expect(offerCollectRefusal('unavailable', 'buyer')).toMatchObject({ status: 503, code: 'COLLECT_UNVERIFIED' })
    expect(offerCollectRefusal('yes', 'seller')).toBeNull()
  })

  test('every offer door asks: create, seller accept/counter (web + MCP share it), and the PDP buttons', () => {
    const create = read('app/api/offers/route.ts')
    expect(create).toContain("offerCollectRefusal(\n    await offerCanProceed({")
    // Refused before the offer row is written.
    expect(create.indexOf('offerCollectRefusal(')).toBeGreaterThan(-1)
    expect(create.indexOf('offerCollectRefusal(')).toBeLessThan(create.indexOf('.insert('))
    const respond = read('lib/offer-respond.ts')
    expect(respond).toContain("if (action === 'accept' || action === 'counter') {")
    expect(respond).toContain('offerCollectRefusal(await offerCanProceed({')
    // The refusal is ACTED ON, not just computed (fresh review: a computed-and-ignored gate stays green on text).
    expect(create).toContain("if (collectRefusal) {\n    return NextResponse.json({ error: collectRefusal.error")
    expect(respond).toContain('if (refusal) return { ok: false, error: refusal.error, httpStatus: refusal.status }')
    // 🚨 The buyer accepting the SELLER'S counter is an accept too (fresh-review catch, PR 497).
    const buyer = read('app/api/offers/[id]/buyer-respond/route.ts')
    const acceptBranch = buyer.slice(buyer.indexOf("if (action === 'accept-counter') {"))
    expect(acceptBranch).toContain('offerCollectRefusal(await offerCanProceed({')
    expect(acceptBranch).toContain('if (collectRefusal) {')
    expect(acceptBranch.indexOf('if (collectRefusal) {')).toBeLessThan(acceptBranch.indexOf("status: 'accepted'"))
    const pdp = read('app/(shell)/l/[id]/ListingRenderer.tsx')
    expect(pdp).toContain('const offersOpen = hasAnyPayment && listingCanBePaid({')
    // Every MakeOfferButton render site and the island's canOffer are behind offersOpen.
    const sites = pdp.split('<MakeOfferButton').length - 1
    expect(sites).toBe(2)
    expect(pdp.match(/offersOpen && (?:activeDeal|\(\n\s*<MakeOfferButton)/g)?.length ?? 0).toBe(2)
    expect(pdp).toContain("listing.listing_type === 'product' && offersOpen,")
  })
})

test.describe('readiness · guided and visible (S2)', () => {
  const okView = (missing: Array<'payment' | 'delivery' | 'manual_payment'> | null) => ({
    state: 'ok' as const,
    readiness: missing ? { mode: 'catalog' as const, missing } : { mode: 'online' as const },
    chooser: { shopSlug: 's', market: 'mx', initial: {} as never, correosAvailable: false, shape: 'products' as const },
  })

  test('the panel shows a ✓/✗ checklist only for a listing nobody could pay for', () => {
    expect(readinessChecklist(okView(['payment']))).toEqual([
      { key: 'delivery', done: true },
      { key: 'payment', done: false, missing: 'payment' },
    ])
    expect(readinessChecklist(okView(['manual_payment']))).toEqual([{ key: 'payment', done: false, missing: 'manual_payment' }])
  })

  test('no panel when it sells online, or when we could not tell — never a false «✓ listo» (the negation)', () => {
    expect(readinessChecklist(okView(null))).toBeNull()
    expect(readinessChecklist({ state: 'unavailable' })).toBeNull()
    expect(readinessChecklist({ state: 'no_shop' })).toBeNull()
    expect(readinessChecklist(null)).toBeNull()
  })

  test('only the server\'s LISTING_NOT_READY re-opens the panel', () => {
    expect(isNotReadyAnswer(422, { code: 'LISTING_NOT_READY' })).toBe(true)
    expect(isNotReadyAnswer(422, { field: 'title' })).toBe(false)
    expect(isNotReadyAnswer(500, { code: 'LISTING_NOT_READY' })).toBe(false)
  })

  test('the panel state is PER LISTING: a live product nobody can pay for — an empty or early shop is not alarmed', () => {
    const live = [{ listing_type: 'product', status: 'active' }]
    expect(shopCatalogOnly({ shop: shop({}), listings: live })).toBe(true)
    expect(shopCatalogOnly({ shop: shop({}), listings: [] })).toBe(false)
    expect(shopCatalogOnly({ shop: shop({}), listings: [{ listing_type: 'product', status: 'draft' }] })).toBe(false)
    expect(shopCatalogOnly({ shop: shop({}), listings: [{ listing_type: 'service', status: 'active' }] })).toBe(false)
    expect(shopCatalogOnly({ shop: shop({ bankTransfer: true }), listings: live })).toBe(false)
    // The review cases: cash-at-pickup sells an arranged product; a card shop's arranged product does not.
    const arranged = [{ listing_type: 'product', status: 'active', delivery_mode: 'arranged' as const }]
    expect(shopCatalogOnly({ shop: shop({ cash: true }), listings: arranged })).toBe(false)
    expect(shopCatalogOnly({ shop: shop({ stripe: true }), listings: arranged })).toBe(true)
  })

  test('the form, the panel, the badges and the guide are wired to the same rule', () => {
    const wizard = read('app/(shell)/sell/SellWizard.tsx')
    expect(wizard).toContain('<ReadinessPanel')
    expect(wizard).toContain('isNotReadyAnswer(res.status, data)')
    expect(wizard).toContain('publish_as_catalog: true')
    expect(read('app/api/sell/readiness/route.ts')).toContain('listingReadiness({ listingType, deliveryMode, shop: ownerShopFacts(metadata) })')
    expect(read('app/(shell)/sell/ReadinessPanel.tsx')).toContain('<CobrosChooser')
    expect(read('app/(shell)/shop/manage/page.tsx')).toContain('shopCatalogOnly({')
    const card = read('app/(shell)/shop/manage/SetupGuideCard.tsx')
    expect(card).toContain('const visible = (!dismissed || locked) && loaded && !allDone')
    expect(read('app/(shell)/shop/manage/catalogo/page.tsx')).toContain('shopFacts={data.seller ? ownerShopFacts(data.seller.metadata ?? null) : null}')
    expect(read('app/(shell)/shop/manage/catalogo/CatalogTable.tsx')).toContain('deliveryMode: deliveryModeOf(listing.metadata),')
    expect(read('lib/setup-guide.ts')).toContain('pagos: canCollect(ownerShopFacts(')
    // The guide is locked only while its OWN «pagos» is undone — never "finish X" beside a ✓ X.
    expect(read('app/(shell)/shop/manage/ManageDashboard.tsx'))
      .toContain("locked={catalogOnly && setupSteps.some((step) => step.id === 'pagos' && !step.done)}")
    // Re-activating a catalog listing has the same way out as publishing one.
    const table = read('app/(shell)/shop/manage/catalogo/CatalogTable.tsx')
    expect(table).toContain("isNotReadyAnswer(res.status, data) && next === 'active'")
    expect(table).toContain("onClick: () => handleToggle(listing, 'active', { asCatalog: true })")
    // A backend without the new fields is "could not read" (fail open), never "a carrier product".
    expect(read('lib/listing-status.ts')).toContain("if (typeof product.listing_type !== 'string') return null")
    // The form keeps the server's sentence when the panel cannot render.
    expect(read('app/(shell)/sell/SellWizard.tsx')).toContain('setSubmitError(data.error ?? null)')
  })
})
