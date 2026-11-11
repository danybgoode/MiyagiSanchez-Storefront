import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { agreedDealDisplay } from '../lib/pdp-viewer-state'
import { shopAcceptsAnyPayment } from '../lib/public-shop-commerce'

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

  test('the conversation offers «Comprar» whenever the shop takes ANY payment', () => {
    const page = readFileSync(path.join(ROOT, 'app/(shell)/messages/[id]/page.tsx'), 'utf8')
    const client = readFileSync(path.join(ROOT, 'app/(shell)/messages/[id]/ConversationClient.tsx'), 'utf8')
    expect(page).toContain('const checkoutAvailable = !!checkoutProvider || await shopTakesAnyPayment(')
    expect(page).toContain('checkout_available: checkoutAvailable,')
    expect(client).toContain('{listing && (checkoutProvider || checkoutAvailable) ? (')
    // No provider forced for a transfer-only shop — the checkout page lets the buyer choose.
    expect(client).toContain('provider={checkoutProvider ?? undefined}')
  })
})
