import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { OFFER_PAYMENT_WINDOW_MS, OFFER_RESERVATION_PERMANENT_ISO, effectivePaymentDeadline, isDealExpired, offerPaymentDeadline, offerTurn } from '../lib/offers'

/**
 * Every accepted offer has 24h to be paid (Daniel, 2026-11-17).
 *
 * Until then the deadline was set only when accepting ALSO created a Stripe Checkout session — a session
 * whose URL was never stored or sent (buyers pay from the conversation, through the checkout routes that
 * reserve the offer). So a Stripe shop's buyer had 24h and every other buyer had no deadline at all, and
 * each accept at a Stripe shop left an orphan session behind. The session is gone; the deadline is
 * written in the same conditional update that accepts the offer, on both accept paths.
 */
const ROOT = path.resolve(import.meta.dirname, '..')
const src = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8')
const ACCEPT_PATHS = ['lib/offer-respond.ts', 'app/api/offers/[id]/buyer-respond/route.ts']

test.describe('offer · 24h to pay, for every accepted offer', () => {
  test('the deadline is 24h after acceptance', () => {
    const now = new Date('2026-11-17T10:00:00.000Z')
    expect(OFFER_PAYMENT_WINDOW_MS).toBe(24 * 3600 * 1000)
    expect(offerPaymentDeadline(now)).toBe('2026-11-18T10:00:00.000Z')
  })

  test('an accepted offer is live before its deadline and expired after it', () => {
    const accepted = new Date('2026-11-17T10:00:00.000Z')
    const offer = { status: 'accepted', expires_at: null, counter_expires_at: null, checkout_expires_at: offerPaymentDeadline(accepted) }
    expect(isDealExpired(offer, new Date('2026-11-18T09:59:00.000Z'))).toBe(false)
    expect(isDealExpired(offer, new Date('2026-11-18T10:01:00.000Z'))).toBe(true)
  })

  for (const file of ACCEPT_PATHS) {
    test(`${file}: the deadline is written IN the accept claim, for every shop`, () => {
      const code = src(file)
      // The accepting update itself carries the deadline — not a later, Stripe-conditional write.
      expect(code).toMatch(/status: 'accepted', checkout_expires_at: checkoutExpires/)
      expect(code).toMatch(/const checkoutExpires = offerPaymentDeadline\(\)/)
    })

    test(`${file}: accepting creates no Stripe session`, () => {
      const code = src(file)
      expect(code).not.toMatch(/checkout\.sessions\.create/)
      expect(code).not.toMatch(/checkout_session_id/)
    })
  }
})

/**
 * A buyer who ORDERED the offer by Pago directo (transfer, cash, DiMo) leaves it `accepted` with the
 * backend's permanent reservation. With 24h for every offer, that buyer would otherwise see «Trato
 * expirado» and get a «time is running out» email after ordering (fresh review, PR 506).
 */
test.describe('offer · a buyer who ordered by direct payment is never shown an expired deal', () => {
  const deadline = '2026-11-18T10:00:00.000Z'
  const later = new Date('2026-11-19T10:00:00.000Z')
  const accepted = { status: 'accepted' as const, expires_at: '2026-11-15T00:00:00.000Z', counter_expires_at: null, checkout_expires_at: deadline }

  test('the permanent reservation removes the deadline, in either timestamp spelling', () => {
    expect(effectivePaymentDeadline({ ...accepted, checkout_reserved_at: OFFER_RESERVATION_PERMANENT_ISO })).toBeNull()
    expect(effectivePaymentDeadline({ ...accepted, checkout_reserved_at: '9999-12-31T00:00:00+00:00' })).toBeNull()
  })

  test('the negation: an open card checkout (ordinary reservation) keeps the deadline', () => {
    expect(effectivePaymentDeadline({ ...accepted, checkout_reserved_at: '2026-11-17T12:00:00.000Z' })).toBe(deadline)
    expect(effectivePaymentDeadline({ ...accepted, checkout_reserved_at: null })).toBe(deadline)
    expect(isDealExpired({ ...accepted, checkout_reserved_at: null }, later)).toBe(true)
  })

  test('ordered by direct payment: not expired, and no «pay by» deadline in the panel', () => {
    const ordered = { ...accepted, checkout_reserved_at: OFFER_RESERVATION_PERMANENT_ISO }
    expect(isDealExpired(ordered, later)).toBe(false)
    expect(offerTurn(ordered, 'buyer').deadlineIso).toBeNull()
  })

  for (const file of ['app/(shell)/messages/[id]/page.tsx', 'app/api/conversations/[id]/route.ts']) {
    test(`${file} reads the reservation and serves the effective deadline`, () => {
      const code = src(file)
      expect(code).toMatch(/checkout_expires_at, checkout_reserved_at'\)/)
      expect(code).toMatch(/checkout_expires_at: effectivePaymentDeadline\(offerWithCurrency\)/)
    })
  }

  test('the PDP deal and the offers API serve the effective deadline', () => {
    expect(src('lib/active-deal.ts')).toMatch(/effectivePaymentDeadline\(typedOffer/)
    expect(src('app/api/offers/route.ts')).toMatch(/checkout_expires_at: effectivePaymentDeadline\(data\)/)
  })

  test('a direct-payment order of an offer cancels its scheduled reminder', () => {
    expect(src('lib/cart.ts')).toMatch(/cancelPaymentReminderForDirectOrder\(offerId, buyerClerkUserId\)/)
    // Only the offer's own buyer can trigger it (security lens, PR 506).
    expect(src('lib/offer-state.ts')).toMatch(/\.eq\('buyer_clerk_user_id', buyerClerkUserId\)/)
    expect(src('lib/offer-state.ts')).toMatch(/if \(!buyerClerkUserId\) return/)
    // The reservation, not the caller, decides the offer was ordered.
    expect(src('lib/offer-state.ts')).toMatch(/if \(!data \|\| !orderedByDirectPayment\(data\)\) return/)
  })
})
