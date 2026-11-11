import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  gateOfferPurchase, releaseOfferReservation, OFFER_IN_CHECKOUT_MESSAGE, OFFER_RESERVATION_STALE_MS, OFFER_SESSION_TTL_MS,
  type PurchasableOffer,
} from '../lib/offer-reservation'

/**
 * The legacy Stripe / Mercado Pago listing checkouts honoured any accepted offer id with no buyer
 * check and no reservation. These pin the new rule for both routes (they share this gate).
 */
const NOW = new Date('2026-11-11T12:00:00Z')
const offer = (over: Partial<PurchasableOffer> = {}): PurchasableOffer => ({
  status: 'accepted', offer_amount_cents: 80000, counter_amount_cents: null, buyer_clerk_user_id: 'user_1', ...over,
})
const gate = (o: { offer?: PurchasableOffer | null | Error; user?: string | null; claim?: boolean | Error; offerId?: string | undefined } = {}) =>
  gateOfferPurchase({
    offerId: 'offerId' in o ? o.offerId : 'off_1',
    listingId: 'lst_1',
    clerkUserId: 'user' in o ? o.user! : 'user_1',
    now: NOW,
    lookup: async () => { if (o.offer instanceof Error) throw o.offer; return o.offer === undefined ? offer() : o.offer },
    claim: async () => { if (o.claim instanceof Error) throw o.claim; return o.claim ?? true },
  })

test.describe('offer reservation gate', () => {
  test('the offer buyer wins the claim and pays the agreed amount', async () => {
    expect(await gate()).toEqual({ ok: true, offerId: 'off_1', priceCents: 80000, reservedAt: NOW.toISOString() })
  })
  test('a counter overrides the offer amount', async () => {
    expect(await gate({ offer: offer({ counter_amount_cents: 90000 }) })).toMatchObject({ ok: true, priceCents: 90000 })
  })
  test('no offer id is an ordinary purchase', async () => {
    expect(await gate({ offerId: undefined })).toEqual({ ok: true, offerId: null, priceCents: null, reservedAt: null })
  })
  test('an offer that is not accepted never lowers the price and is not stamped', async () => {
    expect(await gate({ offer: offer({ status: 'pending' }) })).toEqual({ ok: true, offerId: null, priceCents: null, reservedAt: null })
    expect(await gate({ offer: null })).toMatchObject({ ok: true, priceCents: null })
  })
  test('signed out -> 401, someone else -> 403', async () => {
    expect(await gate({ user: null })).toMatchObject({ ok: false, status: 401 })
    expect(await gate({ user: 'user_2' })).toMatchObject({ ok: false, status: 403 })
    expect(await gate({ offer: offer({ buyer_clerk_user_id: null }) })).toMatchObject({ ok: false, status: 403 })
  })
  test('a second checkout loses with 409 and the new copy', async () => {
    const r = await gate({ claim: false })
    expect(r).toMatchObject({ ok: false, status: 409, code: 'OFFER_IN_CHECKOUT', error: OFFER_IN_CHECKOUT_MESSAGE })
    expect(OFFER_IN_CHECKOUT_MESSAGE).toBe('Ya tienes un pago abierto para esta oferta. Termínalo o inténtalo de nuevo en 36 minutos.')
  })
  test('a lookup or claim error is 503, never valid', async () => {
    expect(await gate({ offer: new Error('x') })).toMatchObject({ ok: false, status: 503 })
    expect(await gate({ claim: new Error('x') })).toMatchObject({ ok: false, status: 503 })
  })
  test('the reservation outlives the 31-minute session by 5 minutes', () => {
    expect(OFFER_SESSION_TTL_MS).toBe(31 * 60_000)
    expect(OFFER_RESERVATION_STALE_MS).toBe(36 * 60_000)
  })
  test('release uses the id and timestamp written, and a failure is logged not thrown', async () => {
    const seen: string[][] = []
    expect(await releaseOfferReservation(async (a, b) => { seen.push([a, b]) }, 'off_1', 't1')).toBe(true)
    expect(seen).toEqual([['off_1', 't1']])
    const logs: string[] = []
    expect(await releaseOfferReservation(async () => { throw new Error('boom') }, 'off_1', 't1', (m) => logs.push(m))).toBe(false)
    expect(logs[0]).toContain('boom')
  })
})

test.describe('both legacy checkout routes go through the gate', () => {
  // Guard the POPULATION: a route that prices an accepted offer by itself would bypass the gate.
  for (const route of ['app/api/stripe/checkout/route.ts', 'app/api/mp/checkout/route.ts']) {
    test(`${route} uses gateOfferPurchase and never reads offers itself`, () => {
      const src = readFileSync(join(process.cwd(), route), 'utf8')
      expect(src).toContain('gateOfferPurchase(')
      expect(src).not.toMatch(/from\('marketplace_offers'\)/)
    })
  }
})
