import { test, expect } from '@playwright/test'
import {
  buildOneTimeGrant,
  deriveDomainEntitlement,
  type DomainGrant,
} from '../lib/domain-entitlement'
import {
  readSubdomainGrant,
  subdomainServeDecision,
  SUBDOMAIN_GRANT_KEY,
} from '../lib/subdomain-entitlement'
import {
  SUBDOMAIN_PRICE_YEARLY_MXN,
  SUBDOMAIN_PRICE_YEARLY_CENTS,
  SUBDOMAIN_PRICE_MONTHLY_MXN,
  SUBDOMAIN_PRICE_LABEL,
} from '../lib/subdomain-pricing'
import { PROMOTER_SKUS, isPromoterSku } from '../lib/promoter-skus'
import { DEFAULT_COMMISSION_RATES } from '../lib/promoter-commission'
import { stripeModeForCadence, asDomainCadence } from '../lib/domain-cadence'
import { promoterCouponKey, type PromoterSettings } from '../lib/promoter'
import { getAboutSection, aboutCopy, type AboutLocale } from '../lib/about-content'

/**
 * Subdomain pricing · Sprint 2 — paid yearly checkout (api project: pure seams +
 * anonymous route guards + the public manifest; no browser, no Stripe, no
 * Supabase). Mirrors e2e/promoter-cadence.spec.ts + e2e/about-content.spec.ts.
 *
 * Layers:
 *  1. PROMOTER SKU — the subdomain is a commissionable SKU (US-5).
 *  2. PRICING SINGLE-SOURCE — $199/yr from one place, surfaced bilingually on
 *     /acerca; the subdomain is no longer advertised as free (US-5).
 *  3. ENTITLEMENT — the recurring subscription + one-time grant flip the SAME
 *     subdomain seam on, reading the SKU's OWN grant key (US-4).
 *  4. CADENCE + COUPON — one_time → Stripe `payment` (no subscription object); the
 *     deterministic promoter coupon key (US-4).
 *  5. ROUTE GUARD + UCP — the buy route needs auth; the manifest advertises the
 *     subdomain SKU + both cadences (US-4/US-5).
 *
 * NOT covered (owed to Daniel): a real yearly Stripe charge → white-label serves,
 * the one-time "no recurring object" confirmation, and the year-end lapse → 301.
 * See sprint-2.md.
 */

const NOW = new Date('2026-06-30T12:00:00.000Z')
const LOCALES: AboutLocale[] = ['es', 'en']

// ── 1. Promoter SKU registry ──────────────────────────────────────────────────

test.describe('subdomain-checkout · promoter SKU', () => {
  test('subdomain is a registered, commissionable promoter SKU', () => {
    expect(PROMOTER_SKUS).toContain('subdomain')
    expect(isPromoterSku('subdomain')).toBe(true)
    // Default commission floor until the admin sets a percentage.
    expect(DEFAULT_COMMISSION_RATES.subdomain).toBe(0)
  })
})

// ── 2. Pricing single-source + bilingual /acerca copy ─────────────────────────

test.describe('subdomain-checkout · pricing single-source', () => {
  test('the price constants are the locked $199/yr values', () => {
    expect(SUBDOMAIN_PRICE_YEARLY_MXN).toBe(199)
    expect(SUBDOMAIN_PRICE_YEARLY_CENTS).toBe(19900)
    expect(SUBDOMAIN_PRICE_MONTHLY_MXN).toBe(25) // Sprint 3 monthly SKU
    expect(SUBDOMAIN_PRICE_LABEL.es).toContain('$199')
    expect(SUBDOMAIN_PRICE_LABEL.en).toContain('$199')
  })

  test('/acerca pricing: the subdomain is free and no retired standalone price is named (plans-gratis-negocio D11, D16)', () => {
    const pricing = getAboutSection('pricing')
    expect(pricing.stub).toBe(false)
    for (const locale of LOCALES) {
      const text = aboutCopy(pricing, locale).body.join(' ')
      // The subdomain and the custom domain are no longer sold on their own: Gratis includes one, Negocio the other.
      expect(text, `${locale} no longer names the subdomain price`).not.toContain('$199')
      expect(text, `${locale} no longer names the standalone custom-domain price`).not.toContain('$499')
    }
  })

  test('/acerca no longer advertises the subdomain as free', () => {
    const pricing = getAboutSection('pricing')
    const es = aboutCopy(pricing, 'es').body.join(' ')
    const en = aboutCopy(pricing, 'en').body.join(' ')
    // The old copy claimed the subdomain "no cuestan nada y nunca caducan" /
    // "cost nothing and never expire". That must be gone now that it's a paid SKU.
    expect(es).not.toContain('subdominio tu-tienda.miyagisanchez.com no cuestan nada')
    expect(en).not.toContain('subdomain your-shop.miyagisanchez.com cost nothing')
  })
})

// ── 3. Entitlement: subscription + one-time flip the SAME subdomain seam ───────

test.describe('subdomain-checkout · entitlement', () => {
  test('an active recurring subscription entitles the subdomain (US-4)', () => {
    expect(
      subdomainServeDecision({ paywallEnabled: true, grant: null, hasActiveSubscription: true }),
    ).toBe('white-label')
    expect(
      subdomainServeDecision({ paywallEnabled: true, grant: null, hasActiveSubscription: false }),
    ).toBe('redirect')
  })

  test('a live one-time grant entitles; an expired one lapses to redirect', () => {
    const grant = buildOneTimeGrant({ now: NOW }) // expires 2027-06-30
    expect(subdomainServeDecision({ paywallEnabled: true, grant, now: new Date('2026-12-01T00:00:00.000Z') }))
      .toBe('white-label')
    expect(subdomainServeDecision({ paywallEnabled: true, grant, now: new Date('2027-07-01T00:00:00.000Z') }))
      .toBe('redirect')
  })

  test('reads the subdomain SKUs OWN grant key, never custom_domain_grant', () => {
    expect(SUBDOMAIN_GRANT_KEY).toBe('subdomain_grant')
    const g = buildOneTimeGrant({ now: NOW })
    // The grant only resolves off `subdomain_grant`; a custom-domain grant can't leak.
    expect(readSubdomainGrant({ subdomain_grant: g })).toEqual(g)
    expect(readSubdomainGrant({ custom_domain_grant: g })).toBeNull()
  })

  test('subscription falls under the deriver as reason "subscription"', () => {
    const grant: DomainGrant | null = null
    expect(deriveDomainEntitlement({ paywallEnabled: true, grant, hasActiveSubscription: true }))
      .toEqual({ entitled: true, reason: 'subscription' })
  })
})

// ── 4. Cadence → Stripe mode + promoter coupon key ────────────────────────────

test.describe('subdomain-checkout · cadence + coupon', () => {
  test('one_time → Stripe mode "payment" (NO subscription object)', () => {
    expect(stripeModeForCadence('one_time')).toBe('payment')
    expect(stripeModeForCadence('recurring')).toBe('subscription')
    expect(asDomainCadence('one_time')).toBe('one_time')
  })

  test('promoter coupon key is deterministic + name ≤ 40 chars', () => {
    const fixed = (cents: number): PromoterSettings => ({ enabled: true, discount_type: 'fixed', discount_amount_cents: cents , bundle_skus: [], bundle_price_mxn: null })
    const k = promoterCouponKey(fixed(10000))!
    expect(k.couponId).toBe('promoter_disc_fixed_10000')
    expect(k.name.length).toBeLessThanOrEqual(40)
  })
})

// ── 5. Route guard + UCP manifest ─────────────────────────────────────────────

test.describe('subdomain-checkout · buy route requires auth', () => {
  test('POST /api/sell/shop/subdomain/subscribe → 401 anonymously (auth before secret)', async ({ request }) => {
    const res = await request.post('/api/sell/shop/subdomain/subscribe', {
      data: { cadence: 'one_time', promoterCode: 'PRM-ABC123' },
    })
    expect(res.status()).toBe(401)
  })
})

test.describe('subdomain-checkout · UCP manifest advertises the subdomain SKU', () => {
  test('GET /api/ucp/manifest lists the subdomain SKU + both cadences', async ({ request }) => {
    const res = await request.get('/api/ucp/manifest')
    expect(res.ok()).toBeTruthy()
    const body = await res.text()
    expect(body).toContain('seller_subdomain_subscription')
    expect(body).toContain('get_subdomain_entitlement')
    expect(body).toContain('start_subdomain_subscription')
    expect(body).toContain('one_time')
    expect(body).toContain('recurring')
  })
})
