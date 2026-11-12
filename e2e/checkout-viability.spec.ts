import { test, expect } from '@playwright/test'
import { deriveCheckoutViability } from '../lib/checkout-viability'

/**
 * Checkout-viability deriver — pure logic (api gate, no browser). The
 * arranged-only-delivery epic, Sprint 1 · S1.2 publish-readiness gate: an
 * arranged listing needs a manual payment method, not a carrier/pickup path
 * (coexist-permissive with the traditional check — Daniel, 2026-07-11).
 */

const base = {
  listingType: 'product',
  hasLiveShipping: false,
  hasLocalPickup: false,
  hasStripe: false,
  hasMp: false,
  hasSpei: false,
  hasDimo: false,
  hasCash: false,
}

test.describe('deriveCheckoutViability · non-product listings always viable', () => {
  test('service/rental/digital/subscription skip the gate entirely', () => {
    for (const listingType of ['service', 'rental', 'digital', 'subscription']) {
      expect(deriveCheckoutViability({ ...base, listingType, deliveryMode: undefined })).toBeNull()
    }
  })
})

test.describe('deriveCheckoutViability · traditional path (delivery_mode carrier/absent, unchanged behavior)', () => {
  test('viable with delivery + payment', () => {
    expect(deriveCheckoutViability({ ...base, deliveryMode: 'carrier', hasLiveShipping: true, hasStripe: true })).toBeNull()
  })

  test('blocked missing delivery', () => {
    const msg = deriveCheckoutViability({ ...base, deliveryMode: 'carrier', hasStripe: true })
    expect(msg).toMatch(/forma de entrega/)
  })

  test('blocked missing payment', () => {
    const msg = deriveCheckoutViability({ ...base, deliveryMode: 'carrier', hasLiveShipping: true })
    expect(msg).toMatch(/método de pago/)
  })

  test('blocked missing both', () => {
    const msg = deriveCheckoutViability({ ...base, deliveryMode: 'carrier' })
    expect(msg).toMatch(/forma de entrega/)
    expect(msg).toMatch(/método de pago/)
  })
})

test.describe('deriveCheckoutViability · arranged path (epic S1.2)', () => {
  test('viable with SPEI, no carrier/pickup at all', () => {
    expect(deriveCheckoutViability({ ...base, deliveryMode: 'arranged', hasSpei: true })).toBeNull()
  })

  test('viable with cash (local pickup + cash enabled), no carrier', () => {
    expect(deriveCheckoutViability({ ...base, deliveryMode: 'arranged', hasLocalPickup: true, hasCash: true })).toBeNull()
  })

  test('blocked when arranged but no manual method configured', () => {
    const msg = deriveCheckoutViability({ ...base, deliveryMode: 'arranged' })
    expect(msg).toMatch(/pago.*manual/)
  })

  test('blocked even if arranged has an unrelated online rail (stripe) but no manual', () => {
    const msg = deriveCheckoutViability({ ...base, deliveryMode: 'arranged', hasStripe: true })
    expect(msg).toMatch(/pago.*manual/)
  })
})

test.describe('deriveCheckoutViability · arranged is a coordinated sale (manual only)', () => {
  // This block used to pin "coexist-permissive" (Daniel 2026-07-11): an arranged listing with shipping + card stayed
  // viable. That predates `shipping.arranged_only_enabled` (ON in production since 2026-09-22): with it on, checkout drops
  // carrier shipping for an arranged product and start-checkout refuses every non-manual rail (backend
  // `isCoordinatedListing`). So that listing published as buyable and every «Comprar» hit a 422 — caught by the fresh
  // review + cross-family pass on PR 497 (epic listing-readiness).
  test('an arranged listing with shipping + card but no manual method is NOT viable', () => {
    expect(deriveCheckoutViability({
      ...base, deliveryMode: 'arranged', hasLiveShipping: true, hasStripe: true,
    })).toMatch(/pago.*manual/)
  })
  test('the negation: arranged + a manual method is viable whatever else the shop has', () => {
    expect(deriveCheckoutViability({
      ...base, deliveryMode: 'arranged', hasLiveShipping: true, hasStripe: true, hasSpei: true,
    })).toBeNull()
  })
})
