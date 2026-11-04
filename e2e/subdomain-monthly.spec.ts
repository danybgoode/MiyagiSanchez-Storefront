import { test, expect } from '@playwright/test'
import { deriveDomainEntitlement } from '../lib/domain-entitlement'
import { subdomainServeDecision } from '../lib/subdomain-entitlement'
import {
  SUBDOMAIN_PRICE_MONTHLY_MXN,
  SUBDOMAIN_PRICE_MONTHLY_CENTS,
  SUBDOMAIN_PRICE_MONTHLY_LABEL,
  SUBDOMAIN_PRICE_LABEL,
} from '../lib/subdomain-pricing'
import {
  asSubdomainInterval,
  coerceSubdomainInterval,
  subdomainIntervalLabel,
  subdomainPriceIdForInterval,
  decideCadenceSwitch,
  cadenceSwitchRefusalMessage,
  DEFAULT_SUBDOMAIN_INTERVAL,
  SUBDOMAIN_INTERVALS,
} from '../lib/subdomain-billing'
import { getAboutSection, aboutCopy, type AboutLocale } from '../lib/about-content'

/**
 * Subdomain pricing · Sprint 3 — monthly recurring cadence ($25/mo) + the
 * monthly↔yearly switch (api project: pure seams + anonymous route guards + the
 * public manifest; no browser, no Stripe, no Medusa). Mirrors
 * e2e/subdomain-checkout.spec.ts.
 *
 * Layers:
 *  1. PRICING SINGLE-SOURCE — $25/mo from one place, surfaced bilingually on /acerca
 *     alongside the yearly discount (US-6).
 *  2. INTERVAL SEAM — coercion (unknown → year, back-compat) + the interval→price
 *     selection (yearly column vs monthly metadata) (US-6).
 *  3. SWITCH DECISION — the pure decideCadenceSwitch: noop when already on target,
 *     switch when different, refuse when there's no active sub / no target price
 *     (US-6).
 *  4. ENTITLEMENT is interval-agnostic — an active subscription serves white-label
 *     whether it bills monthly or yearly (US-6).
 *  5. ROUTE GUARD + UCP — the buy + switch routes need auth (401 before any secret);
 *     the manifest advertises the monthly price + the switch tool (US-6).
 *
 * NOT covered (owed to Daniel): a real $25/mo Stripe charge → white-label serves, a
 * simulated renewal, a cancel/fail → 301 lapse, and the live proration on a real
 * monthly↔yearly switch. See sprint-3.md.
 */

const LOCALES: AboutLocale[] = ['es', 'en']

// ── 1. Pricing single-source + bilingual /acerca copy ─────────────────────────

test.describe('subdomain-monthly · pricing single-source', () => {
  test('the monthly price constants are the locked $25/mo values', () => {
    expect(SUBDOMAIN_PRICE_MONTHLY_MXN).toBe(25)
    expect(SUBDOMAIN_PRICE_MONTHLY_CENTS).toBe(2500)
    expect(SUBDOMAIN_PRICE_MONTHLY_LABEL.es).toContain('$25')
    expect(SUBDOMAIN_PRICE_MONTHLY_LABEL.en).toContain('$25')
    // Yearly stays the discounted option, still surfaced.
    expect(SUBDOMAIN_PRICE_LABEL.es).toContain('$199')
  })

  test('/acerca names no subdomain price in either locale: the subdomain is free (plans-gratis-negocio D11)', () => {
    const pricing = getAboutSection('pricing')
    expect(pricing.stub).toBe(false)
    for (const locale of LOCALES) {
      const text = aboutCopy(pricing, locale).body.join(' ')
      expect(text, `${locale} names no monthly subdomain price`).not.toContain('$25 ')
      expect(text, `${locale} names no yearly subdomain price`).not.toContain('$199')
    }
  })
})

// ── 2. Interval coercion + interval→price selection ───────────────────────────

test.describe('subdomain-monthly · interval seam', () => {
  test('the interval set is exactly month + year, default year (back-compat)', () => {
    expect([...SUBDOMAIN_INTERVALS].sort()).toEqual(['month', 'year'])
    expect(DEFAULT_SUBDOMAIN_INTERVAL).toBe('year')
  })

  test('asSubdomainInterval narrows; coerce defaults unknown/blank to year', () => {
    expect(asSubdomainInterval('month')).toBe('month')
    expect(asSubdomainInterval('year')).toBe('year')
    expect(asSubdomainInterval('weekly')).toBeNull()
    expect(asSubdomainInterval(undefined)).toBeNull()
    expect(coerceSubdomainInterval('month')).toBe('month')
    expect(coerceSubdomainInterval('')).toBe('year')
    expect(coerceSubdomainInterval(null)).toBe('year')
    expect(coerceSubdomainInterval('nonsense')).toBe('year')
  })

  test('interval→price picks the yearly column vs the monthly metadata price', () => {
    const prices = { yearly: 'price_year', monthly: 'price_month' }
    expect(subdomainPriceIdForInterval('year', prices)).toBe('price_year')
    expect(subdomainPriceIdForInterval('month', prices)).toBe('price_month')
    // Pre-seed: the monthly price is null → the caller degrades gracefully.
    expect(subdomainPriceIdForInterval('month', { yearly: 'price_year', monthly: null })).toBeNull()
  })

  test('interval label reads es-MX for each cadence', () => {
    expect(subdomainIntervalLabel('month')).toContain('$25')
    expect(subdomainIntervalLabel('year')).toContain('$199')
  })
})

// ── 3. The pure monthly↔yearly switch decision ────────────────────────────────

test.describe('subdomain-monthly · switch decision', () => {
  const targetPriceId = 'price_target'

  test('switches when the target cadence differs from the current one', () => {
    expect(
      decideCadenceSwitch({ current: 'year', target: 'month', hasActiveRecurring: true, targetPriceId }),
    ).toEqual({ action: 'switch', target: 'month' })
    expect(
      decideCadenceSwitch({ current: 'month', target: 'year', hasActiveRecurring: true, targetPriceId }),
    ).toEqual({ action: 'switch', target: 'year' })
  })

  test('is a no-op (never re-charges) when already on the target cadence', () => {
    expect(
      decideCadenceSwitch({ current: 'month', target: 'month', hasActiveRecurring: true, targetPriceId }),
    ).toEqual({ action: 'noop', target: 'month' })
  })

  test('refuses when there is no active recurring subscription to switch', () => {
    const d = decideCadenceSwitch({ current: null, target: 'month', hasActiveRecurring: false, targetPriceId })
    expect(d).toEqual({ action: 'refuse', reason: 'no_subscription' })
    expect(cadenceSwitchRefusalMessage('no_subscription')).toContain('suscripción activa')
  })

  test('refuses when the target price is not seeded yet', () => {
    const d = decideCadenceSwitch({ current: 'year', target: 'month', hasActiveRecurring: true, targetPriceId: null })
    expect(d).toEqual({ action: 'refuse', reason: 'no_price' })
    expect(cadenceSwitchRefusalMessage('no_price')).toContain('disponible')
  })
})

// ── 4. Entitlement is interval-agnostic ───────────────────────────────────────

test.describe('subdomain-monthly · entitlement is interval-agnostic', () => {
  test('an active subscription entitles regardless of monthly/yearly', () => {
    // The gate + deriver only see a boolean — the S2 lapse webhook is likewise
    // interval-agnostic, so nothing about "monthly" changes the entitlement rule.
    expect(subdomainServeDecision({ paywallEnabled: true, grant: null, hasActiveSubscription: true }))
      .toBe('white-label')
    expect(deriveDomainEntitlement({ paywallEnabled: true, grant: null, hasActiveSubscription: true }))
      .toEqual({ entitled: true, reason: 'subscription' })
    expect(subdomainServeDecision({ paywallEnabled: true, grant: null, hasActiveSubscription: false }))
      .toBe('redirect')
  })
})

// ── 5. Route guards + UCP manifest ────────────────────────────────────────────

test.describe('subdomain-monthly · buy + switch routes require auth', () => {
  test('POST /api/sell/shop/subdomain/subscribe (monthly) → 401 anonymously', async ({ request }) => {
    const res = await request.post('/api/sell/shop/subdomain/subscribe', {
      data: { cadence: 'recurring', interval: 'month' },
    })
    expect(res.status()).toBe(401)
  })

  test('POST /api/sell/shop/subdomain/switch → 401 anonymously (auth before secret)', async ({ request }) => {
    const res = await request.post('/api/sell/shop/subdomain/switch', {
      data: { interval: 'year' },
    })
    expect(res.status()).toBe(401)
  })
})

test.describe('subdomain-monthly · UCP manifest advertises monthly + switch', () => {
  test('GET /api/ucp/manifest lists the monthly price + the switch tool', async ({ request }) => {
    const res = await request.get('/api/ucp/manifest')
    expect(res.ok()).toBeTruthy()
    const body = await res.text()
    expect(body).toContain('seller_subdomain_subscription')
    expect(body).toContain('switch_subdomain_cadence')
    expect(body).toContain('$25')
  })
})
