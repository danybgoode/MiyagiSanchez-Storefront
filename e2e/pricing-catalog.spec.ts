import { expect, test } from '@playwright/test'
import {
  buildPricingCatalog,
  fillPricingTokens,
  fillFixedPricingTokens,
  getExtra,
  yearlyAsMonthly,
  type PricingCatalogInput,
} from '../lib/pricing-catalog'
import { PROMOTER_SKUS } from '../lib/promoter-skus'
import { SUBDOMAIN_PRICE_YEARLY_MXN, SUBDOMAIN_PRICE_MONTHLY_MXN } from '../lib/subdomain-pricing'
import { CUSTOM_DOMAIN_PRICE_MXN, CUSTOM_DOMAIN_PRICE_MONTHLY_MXN } from '../lib/domain-pricing'
import { ML_SYNC_PRICE_YEARLY_MXN, ML_SYNC_PRICE_MONTHLY_MXN } from '../lib/ml-sync-pricing'
import { processorRatesFromDataset, validateDataset, type ComparatorDataset } from '../lib/cost-comparator-dataset'
import { ABOUT_SECTIONS, aboutCopy, getAboutSection } from '../lib/about-content'
import dataset from '../lib/cost-comparator-dataset.json' with { type: 'json' }

/**
 * pricing-page S1.1 — the ONE pricing catalog (README D1–D5). Fixed prices must equal their
 * single-source constants; admin prices degrade to «Precio a cotizar», never `$0`; every
 * PROMOTER_SKUS entry has a row.
 */

const DATASET = dataset as ComparatorDataset
const UNSET: PricingCatalogInput = {
  migrationPriceMxn: null,
  printAdTiersCents: null,
  processors: processorRatesFromDataset(DATASET),
}

test.describe('pricing catalog', () => {
  test('every PROMOTER_SKUS entry has exactly one extras row (D3)', () => {
    const catalog = buildPricingCatalog(UNSET)
    expect(catalog.extras.map((r) => r.sku)).toEqual([...PROMOTER_SKUS])
  })

  test('fixed prices equal their single-source constants', () => {
    const c = buildPricingCatalog(UNSET)
    const sub = getExtra(c, 'subdomain')
    expect([sub.yearlyMxn, sub.monthlyMxn]).toEqual([SUBDOMAIN_PRICE_YEARLY_MXN, SUBDOMAIN_PRICE_MONTHLY_MXN])
    const dom = getExtra(c, 'custom_domain')
    // D4: the custom domain is yearly-only — no monthly purchase is implied.
    expect([dom.yearlyMxn, dom.monthlyMxn]).toEqual([CUSTOM_DOMAIN_PRICE_MXN, null])
    expect(yearlyAsMonthly(CUSTOM_DOMAIN_PRICE_MXN)).toBe(CUSTOM_DOMAIN_PRICE_MONTHLY_MXN)
    const ml = getExtra(c, 'ml_sync')
    expect([ml.yearlyMxn, ml.monthlyMxn]).toEqual([ML_SYNC_PRICE_YEARLY_MXN, ML_SYNC_PRICE_MONTHLY_MXN])
  })

  test('labels are formatted from the numbers', () => {
    const c = buildPricingCatalog(UNSET)
    expect(getExtra(c, 'subdomain').priceLabel.es).toBe(
      `$${SUBDOMAIN_PRICE_YEARLY_MXN} MXN/año (~$${yearlyAsMonthly(SUBDOMAIN_PRICE_YEARLY_MXN)}/mes) o $${SUBDOMAIN_PRICE_MONTHLY_MXN} MXN/mes`,
    )
    expect(getExtra(c, 'custom_domain').priceLabel.en).toBe(
      `$${CUSTOM_DOMAIN_PRICE_MXN} MXN/year (~$${yearlyAsMonthly(CUSTOM_DOMAIN_PRICE_MXN)}/mo)`,
    )
  })

  test('an unset admin price reads «Precio a cotizar», never $0', () => {
    const c = buildPricingCatalog(UNSET)
    for (const sku of ['print_ad', 'migration'] as const) {
      const row = getExtra(c, sku)
      expect(row.quoted).toBe(true)
      expect(row.oneOffMxn).toBeNull()
      expect(row.priceLabel.es).toBe('Precio a cotizar')
      expect(row.priceLabel.es).not.toMatch(/\$\s?0\b/)
    }
  })

  test('a zero or broken admin price is treated as unset, not as free', () => {
    const c = buildPricingCatalog({ ...UNSET, migrationPriceMxn: 0, printAdTiersCents: [0, Number.NaN] })
    expect(getExtra(c, 'migration').quoted).toBe(true)
    expect(getExtra(c, 'print_ad').quoted).toBe(true)
  })

  test('set admin prices show: migration flat, print ad «desde» the cheapest open tier', () => {
    const c = buildPricingCatalog({ ...UNSET, migrationPriceMxn: 999, printAdTiersCents: [10000, 2500, 7500] })
    expect(getExtra(c, 'migration').priceLabel.es).toBe('$999 MXN, pago único')
    expect(getExtra(c, 'print_ad').priceLabel.es).toBe('Desde $25 MXN por edición')
    expect(getExtra(c, 'print_ad').quoted).toBe(false)
  })

  test('processors carry the dataset rates with source + date, and SPEI states no invented rate (D5)', () => {
    const c = buildPricingCatalog(UNSET)
    const [stripe, mp, spei] = c.processors
    expect(stripe.pct).toBe(DATASET.figures['miyagi.payment.pct'].value)
    expect(mp.pct).toBe(DATASET.figures['processor.mercadopago.pct'].value)
    expect(mp.fixedMxn).toBe(DATASET.figures['processor.mercadopago.fixedMxn'].value)
    for (const p of [stripe, mp]) {
      expect(p.source).toMatch(/^https:\/\//)
      expect(p.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(p.rateLabel.es).toContain('IVA')
    }
    expect(spei.pct).toBeNull()
    expect(spei.fixedMxn).toBeNull()
    expect(validateDataset(DATASET)).toEqual([])
  })

  test('the comparador Miyagi column cannot drift from the price modules', () => {
    // The dataset keeps its own copy of the SKU prices for the comparador's source tooltips;
    // this pins it to the constants so the comparador and /mx/precios cannot disagree.
    expect(DATASET.figures['miyagi.sku.subdomain.monthlyMxn'].value).toBe(SUBDOMAIN_PRICE_MONTHLY_MXN)
    expect(DATASET.figures['miyagi.sku.customDomain.monthlyMxn'].value).toBe(CUSTOM_DOMAIN_PRICE_MONTHLY_MXN)
    expect(DATASET.figures['miyagi.sku.mlSync.monthlyMxn'].value).toBe(ML_SYNC_PRICE_MONTHLY_MXN)
  })
})

test.describe('pricing tokens (D7)', () => {
  test('known tokens fill; an unknown token stays visible', () => {
    const c = buildPricingCatalog({ ...UNSET, migrationPriceMxn: 999 })
    expect(fillPricingTokens('Sub: {subdomainPrice}. Mig: {migrationPrice}. {typo}', c, 'es')).toBe(
      `Sub: ${getExtra(c, 'subdomain').priceLabel.es}. Mig: $999 MXN, pago único. {typo}`,
    )
  })

  test('the fixed-only filler leaves admin tokens as written', () => {
    expect(fillFixedPricingTokens('{customDomainYearly} · {printAdPrice}', 'es')).toBe(
      `$${CUSTOM_DOMAIN_PRICE_MXN} MXN al año · {printAdPrice}`,
    )
  })

  test('the about defaults carry real prices and no unfilled token', () => {
    for (const s of ABOUT_SECTIONS) {
      for (const locale of ['es', 'en'] as const) {
        const copy = aboutCopy(s, locale)
        expect([copy.lead ?? '', ...copy.body].join(' ')).not.toMatch(/\{\w+\}/)
      }
    }
    const es = aboutCopy(getAboutSection('pricing'), 'es').body.join(' ')
    expect(es).toContain(`$${ML_SYNC_PRICE_YEARLY_MXN}`)
    expect(es).toContain('/mx/precios')
  })
})
