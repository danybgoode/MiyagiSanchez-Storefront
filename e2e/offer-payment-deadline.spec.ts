import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { OFFER_PAYMENT_WINDOW_MS, isDealExpired, offerPaymentDeadline } from '../lib/offers'

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
