import { test, expect } from '@playwright/test'
import {
  buildOneTimeGrant,
  buildCompGrant,
  isOneTimeGrantLive,
  readDomainGrant,
  deriveDomainEntitlement,
  ONE_TIME_GRANT_MONTHS,
  type DomainGrant,
} from '../lib/domain-entitlement'
import {
  asDomainCadence,
  coerceDomainCadence,
  stripeModeForCadence,
  domainCadenceLabel,
  DOMAIN_CADENCES,
} from '../lib/domain-cadence'
import { promoterCouponKey, type PromoterSettings } from '../lib/promoter'

/**
 * Promoter Program · Sprint 2 — the one-time payment cadence (api project: pure
 * seams + anonymous route guards, no browser, no Stripe, no Supabase). Mirrors
 * e2e/promoter-program.spec.ts (S1) and e2e/custom-domain-paywall.spec.ts.
 *
 * Layers:
 *  1. ENTITLEMENT — the dated `one_time` grant: build dates, lapse-on-read, and
 *     the precedence vs grandfather/comp/subscription (US-4).
 *  2. CADENCE — the cadence validator + the cadence→Stripe-mode map. `one_time →
 *     'payment'` is the load-bearing "NO Stripe subscription object" guarantee (US-4/US-6).
 *  3. PROMOTER COUPON KEY — the deterministic, amount-keyed Stripe/Medusa coupon
 *     ids that back the REAL billed discount; `name` stays ≤ 40 chars (US-4/US-5).
 *  4. ROUTE GUARDS — the buy route needs auth; the public manifest advertises BOTH
 *     cadences (US-6). The live money path (real Stripe charge + the no-recurring
 *     assertion) is owed to Daniel — see sprint-2.md.
 *
 * NOT covered (owed to Daniel): a real one-time Stripe charge + confirming no
 * subscription/upcoming-invoice is created, and the year-end lapse + sweep.
 */

const NOW = new Date('2026-06-29T12:00:00.000Z')
const GRANDFATHER: DomainGrant = { type: 'grandfather', granted_at: '2026-01-01T00:00:00.000Z', note: 'cutover' }
const COMP: DomainGrant = { type: 'comp', granted_at: '2026-06-10T00:00:00.000Z' }

// ── 1. Entitlement: the dated one-time grant ──────────────────────────────────

test.describe('promoter-cadence · buildOneTimeGrant', () => {
  test('stamps a 12-month dated grant (calendar month, not +365d)', () => {
    const g = buildOneTimeGrant({ now: NOW })
    expect(g.type).toBe('one_time')
    expect(g.granted_at).toBe(NOW.toISOString())
    // Default term is 12 months → 2026-06-29 → 2027-06-29.
    expect(g.expires_at).toBe(new Date('2027-06-29T12:00:00.000Z').toISOString())
    expect(ONE_TIME_GRANT_MONTHS).toBe(12)
  })

  test('honors a custom term + optional note', () => {
    const g = buildOneTimeGrant({ now: NOW, months: 6, note: '  promoter  ' })
    expect(g.expires_at).toBe(new Date('2026-12-29T12:00:00.000Z').toISOString())
    expect(g.note).toBe('promoter') // trimmed
  })
})

test.describe('promoter-cadence · isOneTimeGrantLive (lapse on read)', () => {
  const grant = buildOneTimeGrant({ now: NOW }) // expires 2027-06-29

  test('live before expiry', () => {
    expect(isOneTimeGrantLive(grant, new Date('2027-06-28T00:00:00.000Z'))).toBe(true)
  })
  test('lapsed at/after expiry', () => {
    expect(isOneTimeGrantLive(grant, new Date('2027-06-30T00:00:00.000Z'))).toBe(false)
  })
  test('non-one-time / malformed grants are never "live"', () => {
    expect(isOneTimeGrantLive(GRANDFATHER, NOW)).toBe(false)
    expect(isOneTimeGrantLive(null, NOW)).toBe(false)
    expect(isOneTimeGrantLive({ type: 'one_time', granted_at: NOW.toISOString() } as DomainGrant, NOW)).toBe(false)
  })
})

test.describe('promoter-cadence · deriveDomainEntitlement with a one-time grant', () => {
  const live = buildOneTimeGrant({ now: NOW })           // expires 2027-06-29
  const beforeExpiry = new Date('2026-12-01T00:00:00.000Z')
  const afterExpiry = new Date('2027-07-01T00:00:00.000Z')

  test('live one-time grant ⇒ entitled (reason one_time)', () => {
    expect(deriveDomainEntitlement({ paywallEnabled: true, grant: live, now: beforeExpiry })).toEqual({
      entitled: true, reason: 'one_time',
    })
  })

  test('expired one-time grant ⇒ falls through to subscription', () => {
    expect(deriveDomainEntitlement({ paywallEnabled: true, grant: live, hasActiveSubscription: true, now: afterExpiry }).reason)
      .toBe('subscription')
  })

  test('expired one-time grant + no subscription ⇒ NOT entitled', () => {
    expect(deriveDomainEntitlement({ paywallEnabled: true, grant: live, now: afterExpiry })).toEqual({
      entitled: false, reason: 'none',
    })
  })

  test('precedence: grandfather/comp still win over a live one-time grant', () => {
    expect(deriveDomainEntitlement({ paywallEnabled: true, grant: GRANDFATHER, now: beforeExpiry }).reason).toBe('grandfathered')
    expect(deriveDomainEntitlement({ paywallEnabled: true, grant: COMP, now: beforeExpiry }).reason).toBe('comp')
  })

  test('precedence: a live one-time grant wins over an absent subscription', () => {
    expect(deriveDomainEntitlement({ paywallEnabled: true, grant: live, hasActiveSubscription: false, now: beforeExpiry }).reason)
      .toBe('one_time')
  })

  test('flag off still ungates everyone regardless of grant', () => {
    expect(deriveDomainEntitlement({ paywallEnabled: false, grant: live, now: afterExpiry }).entitled).toBe(true)
  })
})

test.describe('promoter-cadence · readDomainGrant parses one_time', () => {
  test('round-trips a one-time grant (type + dates)', () => {
    const g = buildOneTimeGrant({ now: NOW })
    expect(readDomainGrant({ custom_domain_grant: g })).toEqual(g)
  })

  test('rejects a one-time grant missing/blank expires_at (never entitles forever)', () => {
    expect(readDomainGrant({ custom_domain_grant: { type: 'one_time', granted_at: NOW.toISOString() } })).toBeNull()
    expect(readDomainGrant({ custom_domain_grant: { type: 'one_time', granted_at: NOW.toISOString(), expires_at: '' } })).toBeNull()
  })

  test('grandfather/comp grants are unchanged (no expires_at key added)', () => {
    expect(readDomainGrant({ custom_domain_grant: GRANDFATHER })).toEqual(GRANDFATHER)
    expect(readDomainGrant({ custom_domain_grant: buildCompGrant({ now: NOW }) }))
      .toEqual({ type: 'comp', granted_at: NOW.toISOString() })
  })
})

// ── 2. Cadence validator + cadence→Stripe-mode map ────────────────────────────

test.describe('promoter-cadence · cadence helpers', () => {
  test('one_time maps to Stripe mode "payment" (NO subscription object)', () => {
    expect(stripeModeForCadence('one_time')).toBe('payment')
    expect(stripeModeForCadence('recurring')).toBe('subscription')
  })

  test('asDomainCadence narrows known values, rejects junk', () => {
    expect(asDomainCadence('recurring')).toBe('recurring')
    expect(asDomainCadence('one_time')).toBe('one_time')
    expect(asDomainCadence('monthly')).toBeNull()
    expect(asDomainCadence(undefined)).toBeNull()
    expect(asDomainCadence('')).toBeNull()
  })

  test('coerceDomainCadence defaults unknown/blank to recurring (back-compat)', () => {
    expect(coerceDomainCadence('one_time')).toBe('one_time')
    expect(coerceDomainCadence(null)).toBe('recurring')
    expect(coerceDomainCadence('garbage')).toBe('recurring')
    expect(DOMAIN_CADENCES).toEqual(['recurring', 'one_time'])
  })

  test('cadence labels are non-empty es-MX with no placeholder/leak', () => {
    for (const c of DOMAIN_CADENCES) {
      const label = domainCadenceLabel(c)
      expect(label.length).toBeGreaterThan(0)
      expect(label).not.toMatch(/undefined|null|TODO|PEGA_|XXX/)
    }
    expect(domainCadenceLabel('one_time')).toContain('pago único')
  })
})

// ── 3. Promoter coupon key (deterministic, amount-keyed, name ≤ 40) ────────────

test.describe('promoter-cadence · promoterCouponKey', () => {
  const fixed = (cents: number): PromoterSettings => ({ enabled: true, discount_type: 'fixed', discount_amount_cents: cents , bundle_skus: [], bundle_price_mxn: null })
  const pct = (p: number): PromoterSettings => ({ enabled: true, discount_type: 'percentage', discount_amount_cents: p , bundle_skus: [], bundle_price_mxn: null })

  test('fixed: deterministic id keyed by cents; name ≤ 40 chars', () => {
    const k = promoterCouponKey(fixed(10000))!
    expect(k.couponId).toBe('promoter_disc_fixed_10000')
    expect(k.promoCode).toBe('PROMOTERDISCF10000')
    expect(k.name.length).toBeLessThanOrEqual(40)
    // A different amount yields a different id (immutable-by-amount).
    expect(promoterCouponKey(fixed(15000))!.couponId).toBe('promoter_disc_fixed_15000')
  })

  test('percentage: deterministic id keyed by percent; name ≤ 40 chars', () => {
    const k = promoterCouponKey(pct(15))!
    expect(k.couponId).toBe('promoter_disc_pct_15')
    expect(k.promoCode).toBe('PROMOTERDISCPCT15')
    expect(k.name.length).toBeLessThanOrEqual(40)
  })

  test('returns null when the discount cannot back a coupon', () => {
    expect(promoterCouponKey({ enabled: false, discount_type: 'fixed', discount_amount_cents: 10000 , bundle_skus: [], bundle_price_mxn: null })).toBeNull()
    expect(promoterCouponKey(fixed(0))).toBeNull()
    expect(promoterCouponKey(pct(0))).toBeNull()
    expect(promoterCouponKey(pct(150))).toBeNull() // percent > 100
  })
})

// ── 4. Route guards + the agent-facing manifest advertises both cadences ───────

// The standalone domain purchase is retired (the purchase is retired (plans-gratis-negocio S2/S3): 410 for everyone, before any auth).
test.describe('promoter-cadence · the domain buy route is retired', () => {
  test('POST /api/sell/shop/domain/subscribe → 410', async ({ request }) => {
    const res = await request.post('/api/sell/shop/domain/subscribe', {
      data: { cadence: 'one_time', promoterCode: 'PRM-ABC123' },
    })
    expect(res.status()).toBe(410)
  })
})

test.describe('promoter-cadence · the UCP manifest says the domain is part of Negocio', () => {
  // The domain is no longer sold on its own, so the manifest offers no cadences for it: it points agents to the plan.
  test('GET /api/ucp/manifest sends the domain to start_negocio and sells no domain cadence', async ({ request }) => {
    const res = await request.get('/api/ucp/manifest')
    expect(res.ok()).toBeTruthy()
    const domain = JSON.stringify((await res.json()).endpoints?.seller_domain_subscription ?? null)
    expect(domain).toContain('start_domain_subscription is retired and points to start_negocio')
    expect(domain).not.toContain('one_time')
  })
})
