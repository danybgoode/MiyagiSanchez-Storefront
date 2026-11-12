import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { agreedDealDisplay } from '../lib/pdp-viewer-state'
import { shopAcceptsAnyPayment } from '../lib/public-shop-commerce'
import { resolveConversationCheckout } from '../lib/conversation-checkout'
import { isDealExpired } from '../lib/offers'

/**
 * An ACCEPTED offer, after the seller says yes (reported live 2026-11-11, miel-verduras:
 * buyer offered $225, the seller countered and it was accepted at $300).
 *
 *  1. The cached product page showed «Tu precio acordado» with NO price — the buyer
 *     saw only the old list price.
 *  2. A shop that takes payment only by bank transfer (or DiMo) showed «sin pagos en
 *     línea» in the conversation, with no way to pay, although checkout accepts a
 *     transfer for an offer.
 */
const ROOT = path.resolve(import.meta.dirname, '..')
const deal = (over: Partial<{ status: 'accepted_unpaid' | 'pending' | 'countered' | 'paid' | 'expired' | 'none'; dealPriceCents: number | null; currency: string }> = {}) => ({
  status: 'accepted_unpaid' as const,
  dealPriceCents: 30000,
  currency: 'MXN',
  ...over,
})

test.describe('offer · the cached PDP shows the agreed price', () => {
  test('an accepted deal shows its price, and the list price struck through', () => {
    expect(agreedDealDisplay(deal(), 35000)).toEqual({ dealCents: 30000, currency: 'MXN', listCents: 35000 })
  })

  test('the list price is struck only when the deal is actually below it', () => {
    expect(agreedDealDisplay(deal(), 30000)?.listCents).toBeNull()
    expect(agreedDealDisplay(deal(), null)?.listCents).toBeNull()
  })

  test('no deal box for anything but an accepted, priced deal', () => {
    expect(agreedDealDisplay(null, 35000)).toBeNull()
    for (const status of ['pending', 'countered', 'paid', 'expired', 'none'] as const) {
      expect(agreedDealDisplay(deal({ status }), 35000), status).toBeNull()
    }
    expect(agreedDealDisplay(deal({ dealPriceCents: null }), 35000)).toBeNull()
    expect(agreedDealDisplay(deal({ dealPriceCents: 0 }), 35000)).toBeNull()
  })

  test('the island renders the price from that decision, and pays exactly it', () => {
    const island = readFileSync(path.join(ROOT, 'app/components/PublicPdpViewerIsland.tsx'), 'utf8')
    expect(island).toContain('const agreed = agreedDealDisplay(deal, listing.priceCents)')
    expect(island).toContain('formatters.currency(agreed.dealCents, agreed.currency')
    expect(island).toContain('amountCents={agreed.dealCents}')
  })
})

test.describe('offer · any payment method can pay an accepted offer from the conversation', () => {
  const none = { stripe: false, mercadopago: false, bankTransfer: false, dimo: false }

  test('each of the four checkout paths counts; none means none', () => {
    expect(shopAcceptsAnyPayment(none)).toBe(false)
    for (const key of ['stripe', 'mercadopago', 'bankTransfer', 'dimo'] as const) {
      expect(shopAcceptsAnyPayment({ ...none, [key]: true }), key).toBe(true)
    }
  })

  // Behaviour, not text: the helper both conversation producers use, with the Medusa read injected.
  const transferOnly = { settings: { checkout: { bank_transfer: { configured: true } } } }
  const medusa = (metadata: Record<string, unknown> | null) => ({ sellerMetadata: async () => metadata })

  test('🚨 a transfer-only shop can be paid — no provider is forced, checkout lets the buyer choose', async () => {
    expect(await resolveConversationCheckout({ slug: 'miel-verduras', metadata: {} }, medusa(transferOnly)))
      .toEqual({ checkout_provider: null, checkout_available: true })
  })

  test('a shop with NO payment method shows no button (the negation)', async () => {
    expect(await resolveConversationCheckout({ slug: 'miel-verduras', metadata: {} }, medusa({ settings: {} })))
      .toEqual({ checkout_provider: null, checkout_available: false })
  })

  test('an unreadable or missing Medusa shop fails closed', async () => {
    const throwing = { sellerMetadata: async () => { throw new Error('down') } }
    expect((await resolveConversationCheckout({ slug: 'x', metadata: {} }, throwing)).checkout_available).toBe(false)
    expect((await resolveConversationCheckout({ slug: 'x', metadata: {} }, medusa(null))).checkout_available).toBe(false)
    expect((await resolveConversationCheckout({ slug: null, metadata: {} }, medusa(transferOnly))).checkout_available).toBe(false)
    expect((await resolveConversationCheckout(null, medusa(transferOnly))).checkout_available).toBe(false)
  })

  test('a card rail is still pre-selected, without a Medusa read', async () => {
    let asked = false
    const got = await resolveConversationCheckout(
      { slug: 'x', metadata: { settings: { mercadopago: { connected: true } } } },
      { sellerMetadata: async () => { asked = true; return null } },
    )
    expect(got).toEqual({ checkout_provider: 'mercadopago', checkout_available: true })
    expect(asked).toBe(false)
  })

  test('🚨 BOTH conversation producers use the shared helper — the refresh replaced a field set in only one', () => {
    // Fresh-review catch on PR 496: the first render set `checkout_available`, the
    // refresh endpoint did not, and the client swaps in the refresh payload moments
    // after mount. Sweep the population: every file that emits `checkout_provider`
    // must get it (with `checkout_available`) from `resolveConversationCheckout`.
    const producers = ['app/(shell)/messages/[id]/page.tsx', 'app/api/conversations/[id]/route.ts']
    for (const file of producers) {
      const source = readFileSync(path.join(ROOT, file), 'utf8')
      expect(source, file).toContain('const checkout = await resolveConversationCheckout(shopRaw)')
      expect(source, file).toContain('...checkout')
      expect(source, `${file}: no hand-built provider beside the helper`).not.toMatch(/checkout_provider\s*:/)
    }
    const client = readFileSync(path.join(ROOT, 'app/(shell)/messages/[id]/ConversationClient.tsx'), 'utf8')
    expect(client).toContain('{listing && (checkoutProvider || checkoutAvailable) ? (')
    expect(client).toContain('provider={checkoutProvider ?? undefined}')
  })
})

test.describe('offer · a deal expires only by its own clock (reported live 2026-11-12)', () => {
  const now = new Date('2026-11-12T21:00:00Z')
  const past = '2026-11-12T20:16:30Z'
  const future = '2026-11-13T20:06:47Z'

  test('🚨 THE REPORTED BUG: an accepted deal whose counter window passed is NOT expired', () => {
    // miel-verduras: accepted, no payment deadline (no Stripe), counter_expires_at already behind us.
    expect(isDealExpired({ status: 'accepted', expires_at: future, counter_expires_at: past, checkout_expires_at: null }, now)).toBe(false)
  })

  test('each status reads its own clock, and only its own', () => {
    expect(isDealExpired({ status: 'pending', expires_at: past, counter_expires_at: null }, now)).toBe(true)
    expect(isDealExpired({ status: 'pending', expires_at: future, counter_expires_at: past }, now)).toBe(false)
    expect(isDealExpired({ status: 'countered', expires_at: future, counter_expires_at: past }, now)).toBe(true)
    expect(isDealExpired({ status: 'accepted', expires_at: past, counter_expires_at: past, checkout_expires_at: past }, now)).toBe(true)
    expect(isDealExpired({ status: 'paid', expires_at: past, counter_expires_at: past, checkout_expires_at: past }, now)).toBe(false)
    expect(isDealExpired({ status: 'expired', expires_at: future, counter_expires_at: null }, now)).toBe(true)
  })

  test('both conversation producers select the PRODUCT id — the refresh used to drop it and the link 404d', () => {
    for (const file of ['app/(shell)/messages/[id]/page.tsx', 'app/api/conversations/[id]/route.ts']) {
      expect(readFileSync(path.join(ROOT, file), 'utf8'), file).toMatch(/marketplace_listings \( id, medusa_product_id,/)
    }
    expect(readFileSync(path.join(ROOT, 'app/(shell)/messages/[id]/ConversationClient.tsx'), 'utf8')).toContain('if (isDealExpired(offer)) {')
  })
})
