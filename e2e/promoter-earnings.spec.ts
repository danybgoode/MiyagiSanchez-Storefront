import { test, expect } from '@playwright/test'
import {
  computePromoterSkuEarnings,
  buildPromoterEarningsTable,
  promoterHeroCommissionStat,
  buildPromoterEarningsExample,
  PROMOTER_SKU_BASE_PRICE_MXN,
} from '../lib/promoter-earnings'
import { DEFAULT_COMMISSION_RATES } from '../lib/promoter-commission'
import type { PromoterSettings } from '../lib/promoter'
import type { PromoterSku } from '../lib/promoter-skus'

// promoter-funnel-v2 · Sprint 1 · US-1.4 — the pure earnings/table computation over the existing
// admin config (getCommissionRates + getPromoterSettings, already read by /admin/promoter). No DB,
// no next — asserts the acceptance bar directly: passing a different rates/settings object changes
// the output, which is what "Daniel changes a % in /admin/promoter → the landing changes" reduces to
// at the pure-function seam (the live confirmation is the sprint-1 smoke walkthrough).

const NO_DISCOUNT: PromoterSettings = { enabled: false, discount_type: 'fixed', discount_amount_cents: 0 , bundle_skus: [], bundle_price_mxn: null }
const FIXED_DISCOUNT: PromoterSettings = { enabled: true, discount_type: 'fixed', discount_amount_cents: 10000 , bundle_skus: [], bundle_price_mxn: null } // $100 off
const ZERO_RATES: Record<PromoterSku, number> = { ...DEFAULT_COMMISSION_RATES }

test.describe('computePromoterSkuEarnings', () => {
  test('zero rate degrades commissionMxn to null (never $0)', () => {
    const r = computePromoterSkuEarnings(499, 0, NO_DISCOUNT)
    expect(r.commissionMxn).toBeNull()
    expect(r.regularPriceMxn).toBe(499)
    expect(r.promoterPriceMxn).toBe(499)
  })

  test('a configured rate computes a positive commission in whole pesos', () => {
    const r = computePromoterSkuEarnings(499, 20, NO_DISCOUNT)
    expect(r.commissionMxn).toBe(100) // 20% of $499 ≈ $99.80 → rounds to $100
  })

  test('the promoter price reflects the seller discount, floored at 0', () => {
    const r = computePromoterSkuEarnings(499, 20, FIXED_DISCOUNT)
    expect(r.promoterPriceMxn).toBe(399) // $499 − $100 discount
    expect(r.regularPriceMxn).toBe(499)
  })

  test('commission is computed off the DISCOUNTED price, matching real accrual (markAttributionPaid charges the discounted amount)', () => {
    const r = computePromoterSkuEarnings(499, 20, FIXED_DISCOUNT)
    // 20% of $399 (promoter price), NOT 20% of $499 (regular price) — a commission based on the
    // regular price would overstate what Sprint 3's ledger actually accrues.
    expect(r.commissionMxn).toBe(80)
    expect(r.commissionMxn).not.toBe(100)
  })

  test('a discount larger than the price floors the promoter price at 0', () => {
    const bigDiscount: PromoterSettings = { enabled: true, discount_type: 'fixed', discount_amount_cents: 100000 , bundle_skus: [], bundle_price_mxn: null }
    const r = computePromoterSkuEarnings(199, 10, bigDiscount)
    expect(r.promoterPriceMxn).toBe(0)
  })
})

test.describe('buildPromoterEarningsTable', () => {
  test('one row per PROMOTER_SKUS entry; print_ad + migration are variablePrice (no fixed mxn)', () => {
    const table = buildPromoterEarningsTable(ZERO_RATES, NO_DISCOUNT)
    expect(table).toHaveLength(9) // 5 items + 3 packages + the renewal share (plans-gratis-negocio S4)
    const printAd = table.find((r) => r.sku === 'print_ad')
    expect(printAd?.variablePrice).toBe(true)
    if (printAd?.variablePrice) expect(printAd.commissionPct).toBeNull()
    // migration has no PROMOTER_SKU_BASE_PRICE_MXN entry — same "absent = variable"
    // convention as print_ad (flat ≤150 or a per-merchant quote above it).
    const migration = table.find((r) => r.sku === 'migration')
    expect(migration?.variablePrice).toBe(true)
  })

  test('priced SKUs carry the single-source base prices', () => {
    const table = buildPromoterEarningsTable(ZERO_RATES, NO_DISCOUNT)
    const domain = table.find((r) => r.sku === 'custom_domain')
    expect(domain?.variablePrice).toBe(false)
    if (!domain?.variablePrice) expect(domain?.regularPriceMxn).toBe(PROMOTER_SKU_BASE_PRICE_MXN.custom_domain)
  })

  test('a changed rate changes the row output — the admin-config-drives-the-landing acceptance check', () => {
    const before = buildPromoterEarningsTable(ZERO_RATES, NO_DISCOUNT)
    const after = buildPromoterEarningsTable({ ...ZERO_RATES, custom_domain: 25 }, NO_DISCOUNT)
    const beforeRow = before.find((r) => r.sku === 'custom_domain')
    const afterRow = after.find((r) => r.sku === 'custom_domain')
    expect(beforeRow?.variablePrice === false && beforeRow.commissionMxn).toBeNull()
    expect(afterRow?.variablePrice === false && afterRow.commissionMxn).not.toBeNull()
  })
})

test.describe('promoterHeroCommissionStat', () => {
  test('degrades to null when nothing is configured — never a placeholder', () => {
    expect(promoterHeroCommissionStat(ZERO_RATES)).toBeNull()
  })

  test('returns the max configured rate across SKUs', () => {
    const rates = { ...ZERO_RATES, custom_domain: 15, subdomain: 30 }
    expect(promoterHeroCommissionStat(rates)).toBe('30%')
  })
})

test.describe('buildPromoterEarningsExample', () => {
  test('null when the representative SKU has no configured rate', () => {
    expect(buildPromoterEarningsExample(ZERO_RATES, NO_DISCOUNT, [3, 10])).toBeNull()
  })

  test('projects monthly earnings at each closes/month figure once configured', () => {
    const rates = { ...ZERO_RATES, custom_domain: 20 }
    const example = buildPromoterEarningsExample(rates, NO_DISCOUNT, [3, 10])
    expect(example).toEqual([
      { closesPerMonth: 3, estimatedMonthlyMxn: 300 },
      { closesPerMonth: 10, estimatedMonthlyMxn: 1000 },
    ])
  })
})
