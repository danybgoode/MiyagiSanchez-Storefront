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
import { isSeatedEvent } from '../lib/event-seats'
import { listingActivationBlock, readActivationSaleFacts } from '../lib/seller-products'

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

  test('public facts read delivery from the public shipping block, exactly like the owner side', () => {
    const meta = { settings: { shipping: { local_pickup: true } } }
    expect(publicShopFacts(meta).delivery).toEqual(ownerShopFacts(meta).delivery)
    expect(publicShopFacts({}).delivery).toEqual({ liveShipping: false, localPickup: false })
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
    // The flag is read only AFTER auth (security lens, PR 497).
    const p2s = read('app/api/p2s/publish/route.ts')
    expect(p2s.indexOf('await auth()')).toBeLessThan(p2s.indexOf('await req.text()'))
    expect(read('lib/seller-products.ts')).toContain('listingReadiness({ listingType, deliveryMode, shop: ownerShopFacts(shopMeta), ...facts })')
  })
})

test.describe('readiness · offers only where THIS listing can be paid (S1.3, D5)', () => {
  type Facts = { deliveryMode: 'carrier' | 'arranged' | null; priced?: boolean; isEvent?: boolean }
  const deps = (metadata: Record<string, unknown> | null, facts: Facts | undefined = { deliveryMode: null }) => ({
    sellerMetadata: async () => metadata,
    productSaleFacts: async () => facts,
  })
  const ask = (metadata: Record<string, unknown> | null, mode: 'carrier' | 'arranged' | null = null, listingType = 'product', extra: Omit<Facts, 'deliveryMode'> = {}) =>
    offerCanProceed({ slug: 's', productId: 'prod_1', listingType }, deps(metadata, { deliveryMode: mode, ...extra }))
  // Both deliver by pickup. The card-only shop turns cash off, so it really is card-only.
  const transfer = { settings: { checkout: { bank_transfer: { configured: true } }, shipping: { local_pickup: true } } }
  const cardOnly = { settings: { stripe: { connected: true, charges_enabled: true }, shipping: { local_pickup: true }, checkout: { cash_pickup: { enabled: false } } } }

  test('a transfer-only shop CAN take an offer (the mirror would have said no)', async () => {
    expect(await ask(transfer)).toBe('yes')
  })

  test('a carrier product on a shop with NO delivery path cannot take an offer (cross-family catch)', async () => {
    const noDelivery = { settings: { checkout: { bank_transfer: { configured: true } }, shipping: { local_pickup: false, envia_enabled: false } } }
    expect(await ask(noDelivery, 'carrier')).toBe('no')
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
      { sellerMetadata: async () => transfer, productSaleFacts: async () => undefined })).toBe('unavailable')
  })

  test('a PRICED service or rental is coordinated (manual only); other non-products need any rail', async () => {
    expect(await ask(cardOnly, null, 'service', { priced: true })).toBe('no')
    expect(await ask(transfer, null, 'service', { priced: true })).toBe('yes')
    expect(await ask(cardOnly, null, 'rental', { priced: true })).toBe('no')
    expect(await ask(cardOnly, null, 'auto')).toBe('yes')
    expect(await ask({ settings: {} }, null, 'auto')).toBe('no')
  })

  test('🚨 an offer on an UNPRICED service still needs a manual rail — the deal is priced (codex, PR 505)', async () => {
    expect(await ask(cardOnly, null, 'service', { priced: false })).toBe('no')
    expect(await ask({ settings: {} }, null, 'rental')).toBe('no')
    expect(await ask(transfer, null, 'service', { priced: false })).toBe('yes')
    // …while PUBLISHING it stays ungated (contact-only).
    expect(listingReadiness({ listingType: 'service', deliveryMode: null, shop: shop({}), priced: false }).mode).toBe('online')
  })

  test('🚨 a seated event ticket takes ANY rail (coordinated-sales-readiness D1) — the card shop can take the offer', async () => {
    expect(await ask(cardOnly, null, 'service', { priced: true, isEvent: true })).toBe('yes')
    expect(await ask({ settings: {} }, null, 'service', { priced: true, isEvent: true })).toBe('no')
  })

  test('anything unreadable FAILS CLOSED (503), never "accepted" and never "cannot collect"', async () => {
    expect(await ask(null)).toBe('unavailable')
    expect(await offerCanProceed({ slug: 's', productId: 'p', listingType: 'product' },
      { sellerMetadata: async () => { throw new Error('down') }, productSaleFacts: async () => ({ deliveryMode: null }) })).toBe('unavailable')
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
    // Each seller transition is a conditional CLAIM on the validated status (security lens, PR 497): no blind writes,
    // and accept claims BEFORE creating a payment session.
    expect(respond).toContain(".update(patch).eq('id', id).eq('status', fromStatus)")
    expect(respond).toContain("if (opts.unexpired) q = q.gt('expires_at', new Date().toISOString())")
    expect(respond).toContain("claim({ status: 'accepted' }, { unexpired: true })")
    expect(respond).not.toMatch(/update\(\{\s*status: '(accepted|countered|declined)'[^)]*\}\)\.eq\('id', id\)\s*$/m)
    const acceptAt = respond.indexOf("if (action === 'accept') {")
    expect(respond.indexOf("claim({ status: 'accepted' }", acceptAt)).toBeLessThan(respond.indexOf('stripe.checkout.sessions.create', acceptAt))
    // 🚨 The buyer accepting the SELLER'S counter is an accept too (fresh-review catch, PR 497).
    const buyer = read('app/api/offers/[id]/buyer-respond/route.ts')
    const acceptBranch = buyer.slice(buyer.indexOf("if (action === 'accept-counter') {"))
    expect(acceptBranch).toContain('offerCollectRefusal(await offerCanProceed({')
    expect(acceptBranch).toContain('if (collectRefusal) {')
    expect(acceptBranch.indexOf('if (collectRefusal) {')).toBeLessThan(acceptBranch.indexOf("status: 'accepted'"))
    // …and the buyer's accept is a conditional CLAIM from `countered`, before any payment session (security lens, PR 497).
    expect(acceptBranch).toContain(".update({ status: 'accepted' }).eq('id', id).eq('status', 'countered')")
    expect(acceptBranch).toContain(".gt('counter_expires_at', new Date().toISOString())")
    expect(acceptBranch.indexOf(".eq('status', 'countered')")).toBeLessThan(acceptBranch.indexOf('stripe.checkout.sessions.create'))
    const pdp = read('app/(shell)/l/[id]/ListingRenderer.tsx')
    expect(pdp).toContain('const hasAnyPayment = commerceReadiness.ready && listingPayable')
    expect(pdp).toContain('const offersOpen = hasAnyPayment')
    // Every MakeOfferButton render site and the island's canOffer are behind offersOpen.
    const sites = pdp.split('<MakeOfferButton').length - 1
    expect(sites).toBe(2)
    expect(pdp.match(/offersOpen && (?:activeDeal|\(\n\s*<MakeOfferButton)/g)?.length ?? 0).toBe(2)
    expect(pdp).toContain("listing.listing_type === 'product' && offersOpen,")
    // A cash-only shop can sell an ARRANGED product (cash at pickup is a manual rail) — the PDP counts it.
    expect(pdp).toContain("const arrangedCash = deliveryModeOf(listing.metadata) === 'arranged' && pdpShopFacts.payments.cash")
    expect(pdp).toContain('hasBankTransfer || hasDimo || arrangedCash,')
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
    expect(shopCatalogOnly({ shop: shop({}), listings: live })).toBe('payment')
    expect(shopCatalogOnly({ shop: shop({}), listings: [] })).toBeNull()
    expect(shopCatalogOnly({ shop: shop({}), listings: [{ listing_type: 'product', status: 'draft' }] })).toBeNull()
    expect(shopCatalogOnly({ shop: shop({}), listings: [{ listing_type: 'service', status: 'active' }] })).toBeNull()
    expect(shopCatalogOnly({ shop: shop({ bankTransfer: true }), listings: live })).toBeNull()
    // The banner names the real gap (cross-family catch): a card shop with no delivery is told about DELIVERY.
    expect(shopCatalogOnly({ shop: shop({ stripe: true }, { liveShipping: false, localPickup: false }), listings: live })).toBe('delivery')
    // The review cases: cash-at-pickup sells an arranged product; a card shop's arranged product does not.
    const arranged = [{ listing_type: 'product', status: 'active', delivery_mode: 'arranged' as const }]
    expect(shopCatalogOnly({ shop: shop({ cash: true }), listings: arranged })).toBeNull()
    expect(shopCatalogOnly({ shop: shop({ stripe: true }), listings: arranged })).toBe('manual_payment')
  })

  test('the form, the panel, the badges and the guide are wired to the same rule', () => {
    const wizard = read('app/(shell)/sell/SellWizard.tsx')
    expect(wizard).toContain('<ReadinessPanel')
    expect(wizard).toContain('isNotReadyAnswer(res.status, data)')
    expect(wizard).toContain('publish_as_catalog: true')
    expect(read('app/api/sell/readiness/route.ts')).toContain('listingReadiness({ listingType, deliveryMode, shop: ownerShopFacts(metadata), priced, isEvent })')
    expect(read('app/(shell)/sell/ReadinessPanel.tsx')).toContain('<CobrosChooser')
    expect(read('app/(shell)/shop/manage/page.tsx')).toContain('shopCatalogOnly({')
    expect(read('app/(shell)/shop/manage/ManageDashboard.tsx')).toContain('title={BANNER[catalogReason].title}')
    // The p2s flag body is read only when it declares itself tiny (security lens) — never buffered blind.
    expect(read('app/api/p2s/publish/route.ts')).toContain("declared > 0 && declared <= 1024 ? await req.text()")
    // The offer gate reads the delivery mode FRESH (security lens, PR 497) — never the 60s cached owned read.
    const collect = read('lib/shop-collect.ts')
    expect(collect).toContain('await readOwnedShopListingFresh(slug, productId)')
    expect(collect).not.toContain('getOwnedShopListing(')
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


test.describe('readiness · services, rentals and events (coordinated-sales-readiness, D1–D3)', () => {
  const cardOnly = shop({ stripe: true })
  const manual = shop({ bankTransfer: true })
  const r = (listingType: string, s: ShopFacts, priced?: boolean, isEvent?: boolean) =>
    listingReadiness({ listingType, deliveryMode: null, shop: s, priced, isEvent })

  test('🚨 a PRICED plain service or rental needs SPEI or cash — a card shop publishes it as catalog', () => {
    expect(r('service', cardOnly, true)).toEqual({ mode: 'catalog', missing: ['manual_payment'] })
    expect(r('rental', cardOnly, true)).toEqual({ mode: 'catalog', missing: ['manual_payment'] })
    expect(r('service', manual, true).mode).toBe('online')
    expect(r('service', shop({ cash: true }), true).mode).toBe('online')
  })

  test('🚨 a paid SEATED event takes any rail; with none it is catalog naming «cobro»', () => {
    expect(r('service', cardOnly, true, true).mode).toBe('online')
    expect(r('service', shop({ dimo: true }), true, true).mode).toBe('online')
    expect(r('service', shop({}), true, true)).toEqual({ mode: 'catalog', missing: ['payment'] })
    // A rental with an event block is still a rental (manual only), as on the backend.
    expect(r('rental', cardOnly, true, true).mode).toBe('catalog')
  })

  test('contact-only and free are never gated: «precio a consultar», a free event, an unknown price (MCP)', () => {
    expect(r('service', shop({}), false).mode).toBe('online')
    expect(r('service', shop({}), false, true).mode).toBe('online')
    expect(r('service', shop({}), undefined).mode).toBe('online')
  })

  test('the manual message names services and rentals, not only arranged delivery', () => {
    expect(readinessMessage(r('service', cardOnly, true))).toMatch(/servicios y las rentas/)
  })

  test('a SEATED event: an event block AND seats — mirrors the backend isSeatedEvent (security lens, PR 237)', () => {
    expect(isSeatedEvent({ attrs: { event_date: '2026-12-01' }, manage_inventory: true })).toBe(true)
    expect(isSeatedEvent({ attrs: { venue_name: 'Teatro' }, quantity: 40 })).toBe(true)
    expect(isSeatedEvent({ attrs: { venue_name: 'Teatro' }, manage_inventory: false })).toBe(false)
    expect(isSeatedEvent({ attrs: { event_date: '  ' }, manage_inventory: true })).toBe(false)
    expect(isSeatedEvent({ attrs: {}, manage_inventory: true })).toBe(false)
    // A backorder listing can sell past its seats — not capped, not a ticket (backend parity).
    expect(isSeatedEvent({ attrs: { event_date: '2026-12-01' }, manage_inventory: true, allow_backorder: true })).toBe(false)
  })

  test('every door passes price + seated-event to the rule', () => {
    expect(read('app/api/sell/create/route.ts')).toContain('isEvent: isEventCapableType(body.listing.listing_type) && isSeatedEvent({ attrs: body.listing.attrs, quantity: body.listing.quantity }),')
    const status = read('lib/listing-status.ts')
    expect(status).toContain('priced: product.priced,')
    expect(status).toContain("if (coordinated && (typeof product.priced !== 'boolean' || typeof product.is_event !== 'boolean')) return null")
    expect(read('app/(shell)/l/[id]/ListingRenderer.tsx')).toContain('isEvent: isSeatedEvent({ attrs: listing.attrs, manage_inventory: listing.manage_inventory, allow_backorder: listing.allow_backorder }),')
    expect(read('lib/shop-collect.ts')).toContain("if (listingType === 'product' || listingType === 'service' || listingType === 'rental') {")
    expect(read('app/(shell)/shop/manage/page.tsx')).toContain('priced: (l.price_cents ?? 0) > 0,')
    expect(read('app/(shell)/shop/manage/catalogo/CatalogTable.tsx')).toContain('priced: (listing.price_cents ?? 0) > 0,')
    expect(read('app/(shell)/sell/ReadinessPanel.tsx')).toContain("new Set(['product', 'service', 'rental'])")
  })

  test('🚨 the MCP doors gate a priced service/rental too — create and set_listing_status (fresh review, PR 505)', () => {
    const mcp = read('app/api/ucp/mcp/route.ts')
    expect(mcp).toContain("    : (listingType === 'service' || listingType === 'rental')\n      ? listingActivationBlock(shop.metadata, listingType, null, {")
    expect(mcp).toContain('isEvent: isEventCapableType(listingType) && isSeatedEvent({ attrs: listingAttrs, quantity: eventFields.quantity }),')
    expect(mcp).toContain('const facts = coordinated ? await readActivationSaleFacts(shop.slug, productId) : {}')
    expect(mcp).toContain('if (facts === null) return { isError: true, content: [{ type: \'text\', text: ACTIVATION_UNVERIFIED }] }')
    expect(mcp).toContain('const block = listingActivationBlock(shop.metadata, owned.listing_type, undefined, facts)')
    expect(listingActivationBlock({ settings: { stripe: { connected: true, charges_enabled: true } } }, 'service', null, { priced: true }))
      .toMatch(/SPEI o efectivo/)
    expect(listingActivationBlock({ settings: { stripe: { connected: true, charges_enabled: true } } }, 'service', null, { priced: true, isEvent: true }))
      .toBeNull()
  })

  test('🚨 MCP activation reads a DRAFT\'s facts (the public read 404s on drafts → failed open) and fails CLOSED', async () => {
    const card = { settings: { stripe: { connected: true, charges_enabled: true } } }
    const draft = { id: 'p1', price_cents: 50000, attrs: {}, manage_inventory: false }
    const ticket = { id: 'p2', price_cents: 50000, attrs: { event_date: '2026-12-01' }, manage_inventory: true }
    const deps = (drafts: Array<Record<string, unknown>> | null, mirror: { price_cents: number | null } | null | undefined = null) =>
      ({ drafts: async () => drafts, mirror: async () => mirror })
    // THE BYPASS: a draft priced service on a card-only shop is refused activation.
    const f = await readActivationSaleFacts('s', 'p1', deps([draft]))
    expect(f).toEqual({ priced: true, isEvent: false })
    expect(listingActivationBlock(card, 'service', undefined, f!)).toMatch(/SPEI o efectivo/)
    // A draft seated ticket activates on the card shop.
    const t = await readActivationSaleFacts('s', 'p2', deps([ticket]))
    expect(listingActivationBlock(card, 'service', undefined, t!)).toBeNull()
    // A paused listing (not in drafts) falls back to the mirror price, conservatively not a ticket.
    expect(await readActivationSaleFacts('s', 'p9', deps([], { price_cents: 100 }))).toEqual({ priced: true, isEvent: false })
    // Unreadable anywhere → null (the route refuses with ACTIVATION_UNVERIFIED).
    expect(await readActivationSaleFacts('s', 'p1', deps(null))).toBeNull()
    expect(await readActivationSaleFacts('s', 'p9', deps([], undefined))).toBeNull()
    expect(await readActivationSaleFacts('s', 'p9', deps([], null))).toBeNull()
  })

  test('🚨 checkout ASKS the backend with the seated-event hint, or a ticket buyer still sees only SPEI/cash', () => {
    const seated = 'isSeatedEvent({ attrs: listing.attrs, manage_inventory: listing.manage_inventory, allow_backorder: listing.allow_backorder })'
    expect(read('app/(shell)/checkout/page.tsx')).toContain(`isEvent={${seated}}`)
    expect(read('app/(shell)/checkout/CheckoutExperience.tsx')).toContain('market, isEvent: String(isEvent) })')
    expect(read('app/api/checkout/options/route.ts')).toContain('market, is_event: isEvent })')
    expect(read('app/api/ucp/checkout-session/route.ts')).toContain(`isEvent: ${seated},`)
    expect(read('lib/ucp/fulfillment-server.ts')).toContain('is_event: String(input.isEvent === true),')
  })
})
