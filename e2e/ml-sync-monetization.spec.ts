import { test, expect } from '@playwright/test'
import {
  asMlSyncInterval,
  coerceMlSyncInterval,
  mlSyncPriceIdForInterval,
  mlSyncIntervalLabel,
  DEFAULT_ML_SYNC_INTERVAL,
} from '../lib/ml-sync-billing'
import {
  ML_SYNC_PRICE_YEARLY_CENTS,
  ML_SYNC_PRICE_MONTHLY_CENTS,
  ML_SYNC_CURRENCY,
} from '../lib/ml-sync-pricing'
import { deriveMlSyncEntitlement, readMlSyncGrant, ML_SYNC_GRANT_KEY } from '../lib/ml-sync-entitlement'
import { buildCompGrant, buildOneTimeGrant } from '../lib/domain-entitlement'
import { isPromoterSku } from '../lib/promoter-skus'

/**
 * Mercado Libre sync · Sprint 6 (epic 03) — monetization (self-serve + promoter + admin grant).
 *
 * The Stripe checkout, the webhook grant-write, and the Medusa subscription live
 * server-side (unreachable from the `api` runner), so this gate covers what the
 * frontend owns deterministically:
 *   - the billing-interval coercion + interval→price selection (US-17),
 *   - the pricing constants (the yearly one-time charge amount is a code constant),
 *   - the entitlement precedence WITH a subscription + SKU-key isolation (US-17),
 *   - `ml_sync` as a promoter SKU (US-18), and
 *   - the buy / promoter-close / admin-grant route auth shapes (both flag states).
 * The live money-path smokes (buy yearly/monthly, promoter close, admin grant) are
 * owed to Daniel — see sprint-6.md.
 */

// ── US-17: billing interval ─────────────────────────────────────────────────────
test.describe('ml-sync-billing (S6)', () => {
  test('asMlSyncInterval narrows only month|year', () => {
    expect(asMlSyncInterval('month')).toBe('month')
    expect(asMlSyncInterval('year')).toBe('year')
    expect(asMlSyncInterval('week')).toBeNull()
    expect(asMlSyncInterval('')).toBeNull()
    expect(asMlSyncInterval(undefined)).toBeNull()
  })

  test('coerceMlSyncInterval defaults blank/unknown to year (back-compat)', () => {
    expect(coerceMlSyncInterval('month')).toBe('month')
    expect(coerceMlSyncInterval('nonsense')).toBe(DEFAULT_ML_SYNC_INTERVAL)
    expect(DEFAULT_ML_SYNC_INTERVAL).toBe('year')
  })

  test('interval→price selection returns the right id (or null pre-seed)', () => {
    const prices = { yearly: 'price_yr', monthly: 'price_mo' }
    expect(mlSyncPriceIdForInterval('year', prices)).toBe('price_yr')
    expect(mlSyncPriceIdForInterval('month', prices)).toBe('price_mo')
    expect(mlSyncPriceIdForInterval('month', { yearly: 'price_yr', monthly: null })).toBeNull()
  })

  test('labels are es-MX with the price', () => {
    expect(mlSyncIntervalLabel('year')).toMatch(/Anual/)
    expect(mlSyncIntervalLabel('month')).toMatch(/Mensual/)
  })
})

// ── US-17: pricing constants (the yearly one-time charge is a code constant) ─────
test.describe('ml-sync-pricing (S6)', () => {
  test('yearly $299 / monthly $30, MXN', () => {
    expect(ML_SYNC_PRICE_YEARLY_CENTS).toBe(29900)
    expect(ML_SYNC_PRICE_MONTHLY_CENTS).toBe(3000)
    expect(ML_SYNC_CURRENCY).toBe('MXN')
  })
})

// ── US-17: entitlement precedence WITH subscription + SKU isolation ──────────────
test.describe('ml-sync entitlement · subscription (S6)', () => {
  test('an active subscription entitles under the paywall', () => {
    const e = deriveMlSyncEntitlement({ paywallEnabled: true, grant: null, hasActiveSubscription: true })
    expect(e).toEqual({ entitled: true, reason: 'subscription' })
  })

  test('paywall on + no grant + no subscription ⇒ not entitled (upsell)', () => {
    expect(deriveMlSyncEntitlement({ paywallEnabled: true, grant: null, hasActiveSubscription: false }).entitled).toBe(false)
  })

  test('a grant outranks the subscription lookup (grant wins)', () => {
    const grant = readMlSyncGrant({ [ML_SYNC_GRANT_KEY]: buildCompGrant({ note: 't' }) })
    expect(deriveMlSyncEntitlement({ paywallEnabled: true, grant, hasActiveSubscription: false }).reason).toBe('comp')
  })

  test('a live one-time grant entitles; a subdomain grant never does (SKU isolation)', () => {
    const now = new Date('2026-07-01T00:00:00Z')
    const live = readMlSyncGrant({ [ML_SYNC_GRANT_KEY]: buildOneTimeGrant({ now }) })
    expect(deriveMlSyncEntitlement({ paywallEnabled: true, grant: live, now }).entitled).toBe(true)
    expect(readMlSyncGrant({ subdomain_grant: buildCompGrant() })).toBeNull()
  })

  test('fail-safe: paywall OFF ⇒ entitled regardless of subscription', () => {
    expect(deriveMlSyncEntitlement({ paywallEnabled: false, grant: null, hasActiveSubscription: false }).entitled).toBe(true)
  })
})

// ── US-18: ml_sync promoter SKU ─────────────────────────────────────────────────
test.describe('ml_sync promoter SKU (S6)', () => {
  test('ml_sync is a recognized promoter SKU (promoter close attributes to it)', () => {
    expect(isPromoterSku('ml_sync')).toBe(true)
  })
})

// ── Route auth shapes (auth-before-flag; agnostic to the live flag value) ────────
test.describe('ml-sync money routes · anonymous is rejected (S6)', () => {
  // Mercado Libre sync is part of the Negocio plan now: its standalone purchase is retired (410 for everyone).
  test('POST /api/sell/ml/subscribe → 410 (retired)', async ({ request }) => {
    const res = await request.post('/api/sell/ml/subscribe', { data: { cadence: 'recurring', interval: 'year' } })
    expect(res.status()).toBe(410)
  })

  test('POST /api/promoter/close/ml-sync → 404 (hidden) or 410 (retired)', async ({ request }) => {
    const res = await request.post('/api/promoter/close/ml-sync', { data: { slug: 'x' } })
    expect([404, 410]).toContain(res.status())
  })

  test('GET /api/admin/tenants/:id?sku=ml_sync → 401 (admin-gated, anon)', async ({ request }) => {
    const res = await request.get('/api/admin/tenants/shop_x?sku=ml_sync')
    expect(res.status()).toBe(401)
  })

  test('POST /api/admin/tenants/:id (grant ml_sync) → 401 (auth precedes the write)', async ({ request }) => {
    const res = await request.post('/api/admin/tenants/shop_x', { data: { action: 'grant', sku: 'ml_sync' } })
    expect(res.status()).toBe(401)
  })
})
