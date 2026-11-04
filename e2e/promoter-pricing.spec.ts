import { test, expect } from '@playwright/test'
import {
  resolveSkuPromoterPriceCents,
  buildSkuPriceRow,
  buildSkuPriceTable,
  computeBundleRow,
  type PromoterSkuPrices,
  type BundleConfig,
} from '../lib/promoter-pricing'
import type { PromoterSettings } from '../lib/promoter'

/**
 * Promoter Funnel v2 · Sprint 3 (US-3.1) — the per-SKU + bundle pricing deriver
 * (api project — pure logic, no network, no Supabase).
 *
 * Covers the acceptance bar: bundle savings > sum-of-parts savings for a genuinely
 * bundled price; a shrinking bundle (fewer SKUs) ⇒ shrinking absolute discount;
 * every derived amount is never negative, regardless of bad admin input.
 */

const settingsFixed = (over: Partial<PromoterSettings> = {}): PromoterSettings => ({
  enabled: true,
  discount_type: 'fixed',
  discount_amount_cents: 10000, // $100 MXN off, the legacy global fallback
  bundle_skus: [],
  bundle_price_mxn: null,
  ...over,
})

test.describe('resolveSkuPromoterPriceCents', () => {
  test('falls back to the legacy global discount when no per-SKU override', () => {
    const cents = resolveSkuPromoterPriceCents({
      sku: 'custom_domain',
      regularPriceCents: 50000, // $500
      skuPrices: {},
      settings: settingsFixed(),
    })
    expect(cents).toBe(40000) // $500 − $100 global discount
  })

  test('an explicit per-SKU override wins over the global formula', () => {
    const cents = resolveSkuPromoterPriceCents({
      sku: 'subdomain',
      regularPriceCents: 19900, // $199
      skuPrices: { subdomain: 0 }, // free (US-3.2)
      settings: settingsFixed(),
    })
    expect(cents).toBe(0)
  })

  test('clamps a bad override to [0, regularPriceCents] — never negative, never above list', () => {
    const negative = resolveSkuPromoterPriceCents({
      sku: 'subdomain', regularPriceCents: 19900,
      skuPrices: { subdomain: -50 }, settings: settingsFixed(),
    })
    expect(negative).toBe(0)

    const tooHigh = resolveSkuPromoterPriceCents({
      sku: 'subdomain', regularPriceCents: 19900,
      skuPrices: { subdomain: 999 }, settings: settingsFixed(),
    })
    expect(tooHigh).toBe(19900)
  })

  test('a zero or negative regular price never yields a positive promoter price', () => {
    expect(resolveSkuPromoterPriceCents({
      sku: 'ml_sync', regularPriceCents: 0, skuPrices: {}, settings: settingsFixed(),
    })).toBe(0)
  })
})

test.describe('buildSkuPriceRow / buildSkuPriceTable', () => {
  test('a variable-price SKU (print_ad) degrades to nulls, not a fabricated number', () => {
    const row = buildSkuPriceRow('print_ad', null, {}, settingsFixed())
    expect(row).toMatchObject({ variablePrice: true, regularPriceMxn: null, promoterPriceMxn: null, savingsMxn: null, savingsPct: null, isFree: false })
  })

  test('a $0 override renders isFree true, not a fabricated regular row', () => {
    const row = buildSkuPriceRow('subdomain', 199, { subdomain: 0 }, settingsFixed())
    expect(row.isFree).toBe(true)
    expect(row.promoterPriceMxn).toBe(0)
    expect(row.savingsMxn).toBe(199)
    expect(row.savingsPct).toBe(100)
  })

  test('buildSkuPriceTable returns one row per PROMOTER_SKUS entry, in order', () => {
    const table = buildSkuPriceTable(
      { custom_domain: 500, subdomain: 199, ml_sync: 299 },
      { subdomain: 0 },
      settingsFixed(),
    )
    expect(table.map((r) => r.sku)).toEqual(['custom_domain', 'print_ad', 'subdomain', 'ml_sync', 'migration', 'negocio_anual', 'negocio_arranque', 'setup_gratis', 'negocio_renewal'])
    expect(table.find((r) => r.sku === 'print_ad')?.variablePrice).toBe(true)
    expect(table.find((r) => r.sku === 'subdomain')?.isFree).toBe(true)
    // migration has no `PROMOTER_SKU_BASE_PRICE_MXN` entry (variable — flat ≤150 or
    // a per-merchant quote above it, see lib/migration-estimate.ts) — same "absent =
    // variable" convention as print_ad, so it degrades to variablePrice here too.
    expect(table.find((r) => r.sku === 'migration')?.variablePrice).toBe(true)
  })
})

test.describe('computeBundleRow', () => {
  const rows = buildSkuPriceTable(
    { custom_domain: 500, subdomain: 199, ml_sync: 299 },
    {}, // no per-SKU overrides — each SKU uses the $100 global discount
    settingsFixed(),
  )
  // Regular total for the 3 fixed-price SKUs: 500+199+299=998. Per-item promoter
  // total at −$100 each (clamped): 400+99+199=698 → perItemSavingsSumMxn=300.

  test('not configured (no price / no skus) ⇒ null, never a fabricated bundle', () => {
    expect(computeBundleRow(rows, { skus: [], bundlePriceMxn: 500 })).toBeNull()
    expect(computeBundleRow(rows, { skus: ['custom_domain'], bundlePriceMxn: null })).toBeNull()
  })

  test('a genuinely bundled price saves MORE than buying the same items separately', () => {
    const bundle: BundleConfig = { skus: ['custom_domain', 'subdomain', 'ml_sync'], bundlePriceMxn: 550 }
    const row = computeBundleRow(rows, bundle)
    expect(row).not.toBeNull()
    expect(row!.regularTotalMxn).toBe(998)
    expect(row!.bundlePriceMxn).toBe(550)
    expect(row!.savingsMxn).toBe(448) // 998 - 550
    expect(row!.perItemSavingsSumMxn).toBe(300)
    // The acceptance bar: bundle savings > sum-of-parts savings.
    expect(row!.savingsMxn).toBeGreaterThan(row!.perItemSavingsSumMxn)
  })

  test('a shrinking bundle (fewer SKUs) yields a shrinking absolute discount', () => {
    const full = computeBundleRow(rows, { skus: ['custom_domain', 'subdomain', 'ml_sync'], bundlePriceMxn: 550 })!
    // Drop ml_sync, proportionally reduce the bundle price by its regular share (299/998).
    const partialPrice = Math.round(550 * ((998 - 299) / 998))
    const partial = computeBundleRow(rows, { skus: ['custom_domain', 'subdomain'], bundlePriceMxn: partialPrice })!
    expect(partial.savingsMxn).toBeLessThan(full.savingsMxn)
  })

  test('clamps a bundle price above list total — never a negative saving', () => {
    const bundle: BundleConfig = { skus: ['custom_domain', 'subdomain', 'ml_sync'], bundlePriceMxn: 5000 }
    const row = computeBundleRow(rows, bundle)!
    expect(row.bundlePriceMxn).toBe(998) // clamped to regularTotalMxn
    expect(row.savingsMxn).toBe(0)
    expect(row.savingsPct).toBe(0)
  })

  test('a bundle price of 0 is a real (extreme) config, not clamped away, and never negative', () => {
    const bundle: BundleConfig = { skus: ['custom_domain', 'subdomain', 'ml_sync'], bundlePriceMxn: 0 }
    const row = computeBundleRow(rows, bundle)!
    expect(row.bundlePriceMxn).toBe(0)
    expect(row.savingsMxn).toBe(998)
    expect(row.savingsMxn).toBeGreaterThanOrEqual(0)
  })

  test('ignores a variable-price SKU (print_ad) even if listed in bundle.skus', () => {
    const withPrint = computeBundleRow(rows, { skus: ['custom_domain', 'subdomain', 'ml_sync', 'print_ad'], bundlePriceMxn: 550 })
    const without = computeBundleRow(rows, { skus: ['custom_domain', 'subdomain', 'ml_sync'], bundlePriceMxn: 550 })
    expect(withPrint).toEqual(without)
  })
})
