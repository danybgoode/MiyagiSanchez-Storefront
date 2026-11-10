import { test, expect } from '@playwright/test'
import {
  DEFAULT_COMMISSION_RATES,
  isValidRatePct,
  computeCommissionCents,
  decideAccrual,
  canTransition,
  summarizeCommissions,
  type AccrualAttribution,
  type CommissionLike,
} from '../lib/promoter-commission'

/**
 * Promoter Program · Sprint 3 — commission ledger (api project — pure seam + a few
 * anonymous route guards, no network, no Supabase). Mirrors promoter-program.spec.ts.
 *
 *  PURE LIB — rate validation (US-7), commission math, the accrual decision
 *  (paid+attributed, first-payment/exactly-once, self-referral guard — US-8), the
 *  settlement state machine + dashboard totals (US-9). The accrual rules are proven
 *  here for free; the DB wiring (lib/promoter.ts) is exercised by the owed smoke.
 *
 * NOT covered (owed to Daniel — sprint-3.md smoke): the dashboard + admin settlement
 * render with real attributed data from an S1/S2 test sale (needs the flag on + a
 * real paid attribution). No money-path smoke — settlement is offline.
 */

// A paid+attributed custom-domain sale, with overridable fields.
const paid = (over: Partial<AccrualAttribution> = {}): AccrualAttribution => ({
  status: 'paid',
  sku: 'custom_domain',
  gross_amount_cents: 49900,
  ...over,
})

test.describe('promoter-commission · rate validation (US-7)', () => {
  test('accepts whole percents in [0, 100]', () => {
    for (const n of [0, 1, 15, 50, 100]) expect(isValidRatePct(n)).toBe(true)
  })

  test('rejects negative, >100, fractional, and non-numeric', () => {
    for (const n of [-1, 101, 12.5, NaN, Infinity, '15', null, undefined]) {
      expect(isValidRatePct(n as unknown)).toBe(false)
    }
  })

  test('defaults are 0% for every known SKU', () => {
    expect(DEFAULT_COMMISSION_RATES).toEqual({
      custom_domain: 0, print_ad: 0, subdomain: 0, ml_sync: 0, migration: 0,
      // plans-gratis-negocio S4: the packages and the renewal share (real rates are rows seeded by M1).
      negocio_anual: 0, negocio_arranque: 0, setup_gratis: 0, negocio_renewal: 0,
      // plan-tienda S4: the two new packages and the two new shares (real rates are rows seeded by M1 20261111000000).
      tienda_anual: 0, negocio_semestral: 0, tienda_renewal: 0, negocio_upgrade: 0,
    })
  })
})

test.describe('promoter-commission · math (computeCommissionCents)', () => {
  test('is the percent of the gross, rounded, floored at 0', () => {
    expect(computeCommissionCents(15, 49900)).toBe(7485)
    expect(computeCommissionCents(10, 12345)).toBe(1235) // rounds
    expect(computeCommissionCents(100, 49900)).toBe(49900)
    expect(computeCommissionCents(0, 49900)).toBe(0)
    expect(computeCommissionCents(15, 0)).toBe(0)
  })
})

test.describe('promoter-commission · accrual decision (US-8)', () => {
  test('a paid + attributed one-time sale accrues exactly once at the right amount', () => {
    const d = decideAccrual({ attribution: paid(), ratePct: 15, existingCommission: false })
    expect(d).toEqual({ ok: true, commissionCents: 7485, ratePct: 15, grossAmountCents: 49900 })
  })

  test('a renewal / second pass of the same attribution accrues nothing (first-payment only)', () => {
    const d = decideAccrual({ attribution: paid(), ratePct: 15, existingCommission: true })
    expect(d).toEqual({ ok: false, reason: 'already_accrued' })
  })

  test('a self-attributed sale (promoter owns the shop) accrues nothing', () => {
    const d = decideAccrual({
      attribution: paid(),
      ratePct: 15,
      existingCommission: false,
      promoterClerkUserId: 'user_123',
      shopOwnerClerkUserId: 'user_123',
    })
    expect(d).toEqual({ ok: false, reason: 'self_referral' })
  })

  test('different promoter/owner ids are NOT self-referral', () => {
    const d = decideAccrual({
      attribution: paid(),
      ratePct: 15,
      existingCommission: false,
      promoterClerkUserId: 'user_123',
      shopOwnerClerkUserId: 'user_456',
    })
    expect(d.ok).toBe(true)
  })

  test('refuses an unpaid sale, an ineligible SKU, and a missing/zero rate', () => {
    expect(decideAccrual({ attribution: paid({ status: 'enrolled' }), ratePct: 15, existingCommission: false }))
      .toEqual({ ok: false, reason: 'not_paid' })
    expect(decideAccrual({ attribution: paid({ sku: 'subscription' }), ratePct: 15, existingCommission: false }))
      .toEqual({ ok: false, reason: 'sku_not_eligible' })
    expect(decideAccrual({ attribution: paid(), ratePct: null, existingCommission: false }))
      .toEqual({ ok: false, reason: 'no_rate' })
    expect(decideAccrual({ attribution: paid(), ratePct: 0, existingCommission: false }))
      .toEqual({ ok: false, reason: 'no_rate' })
  })

  test('a valid rate but missing gross has nothing to accrue (no_gross)', () => {
    expect(decideAccrual({ attribution: paid({ gross_amount_cents: 0 }), ratePct: 15, existingCommission: false }))
      .toEqual({ ok: false, reason: 'no_gross' })
  })
})

test.describe('promoter-commission · settlement machine (US-9)', () => {
  test('accrued → paid is allowed; reverse and other jumps are not', () => {
    expect(canTransition('accrued', 'paid')).toBe(true)
    expect(canTransition('paid', 'accrued')).toBe(false)
    expect(canTransition('accrued', 'accrued')).toBe(true) // no-op
    expect(canTransition('paid', 'paid')).toBe(true)        // idempotent settle
  })
})

test.describe('promoter-commission · dashboard totals (summarizeCommissions)', () => {
  test('earned / pending / paid reconcile', () => {
    const rows: CommissionLike[] = [
      { commission_cents: 7485, status: 'accrued' },
      { commission_cents: 3000, status: 'paid' },
      { commission_cents: 1500, status: 'accrued' },
    ]
    expect(summarizeCommissions(rows)).toEqual({ earnedCents: 11985, pendingCents: 8985, paidCents: 3000 })
  })

  test('empty ledger is all zeros', () => {
    expect(summarizeCommissions([])).toEqual({ earnedCents: 0, pendingCents: 0, paidCents: 0 })
  })
})

test.describe('promoter-commission · admin routes reject anonymously (401)', () => {
  test('GET /api/admin/promoter/commission → 401', async ({ request }) => {
    const res = await request.get('/api/admin/promoter/commission')
    expect(res.status()).toBe(401)
  })

  test('PATCH /api/admin/promoter/commission → 401', async ({ request }) => {
    const res = await request.patch('/api/admin/promoter/commission', { data: { sku: 'custom_domain', rate_pct: 15 } })
    expect(res.status()).toBe(401)
  })

  test('POST /api/admin/promoter/commission/<id>/settle → 401', async ({ request }) => {
    const res = await request.post('/api/admin/promoter/commission/abc/settle', { data: { reference: 'cash-001' } })
    expect(res.status()).toBe(401)
  })
})

test.describe('promoter-commission · dashboard 404s for a non-promoter code', () => {
  // 404 in BOTH flag states: flag off ⇒ hidden; flag on ⇒ the unknown code resolves
  // to no promoter ⇒ notFound(). Robust to the kill-switch (launched ON 2026-06-30).
  test('GET /promotor/PRM-ABC123 → 404', async ({ request }) => {
    const res = await request.get('/promotor/PRM-ABC123')
    expect(res.status()).toBe(404)
  })
})
