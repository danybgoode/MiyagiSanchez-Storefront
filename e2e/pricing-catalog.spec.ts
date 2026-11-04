import { expect, test } from '@playwright/test'
import {
  buildPricingCatalog,
  fillPricingTokens,
  fillFixedPricingTokens,
  fixedPricingTokens,
  getExtra,
  yearlyAsMonthly,
  type PricingCatalogInput,
} from '../lib/pricing-catalog'
import { PROMOTER_SKUS } from '../lib/promoter-skus'
import { NEGOCIO_PRICE_MONTHLY_MXN, NEGOCIO_PRICE_YEARLY_MXN, NEGOCIO_TRIAL_DAYS } from '../lib/negocio-pricing'
import { PLAN_ALLOWANCES } from '../lib/plan-allowances'
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
  test('the extras are exactly the print ad and the migration, in PROMOTER_SKUS order (plans D16)', () => {
    const catalog = buildPricingCatalog(UNSET)
    expect(catalog.extras.map((r) => r.sku)).toEqual(PROMOTER_SKUS.filter((s) => s === 'print_ad' || s === 'migration'))
    expect(catalog.extras.map((r) => r.sku).sort()).toEqual(['migration', 'print_ad'])
  })

  test('two plans: Gratis and Negocio, with Negocio priced from lib/negocio-pricing.ts (plans D16)', () => {
    const c = buildPricingCatalog(UNSET)
    expect(c.plans.map((p) => p.id)).toEqual(['gratis', 'negocio'])
    const [gratis, negocio] = c.plans
    expect([gratis.monthlyMxn, gratis.yearlyMxn, gratis.yearlyLabel]).toEqual([null, null, null])
    expect(gratis.priceLabel.es).toMatch(/^Gratis/)
    expect([negocio.monthlyMxn, negocio.yearlyMxn]).toEqual([NEGOCIO_PRICE_MONTHLY_MXN, NEGOCIO_PRICE_YEARLY_MXN])
    expect(negocio.priceLabel.es).toBe(`$${NEGOCIO_PRICE_MONTHLY_MXN} MXN/mes`)
    expect(negocio.yearlyLabel?.es).toBe(`$${NEGOCIO_PRICE_YEARLY_MXN.toLocaleString('en-US')} MXN/año (también a meses sin intereses)`)
    const incl = (p: typeof gratis, loc: 'es' | 'en') => p.includes.map((i) => i[loc]).join(' | ')
    for (const loc of ['es', 'en'] as const) {
      expect(incl(gratis, loc)).toContain(PLAN_ALLOWANCES.gratis.chatAnswersPerMonth.toLocaleString("en-US"))
      expect(incl(negocio, loc)).toContain(PLAN_ALLOWANCES.negocio.chatAnswersPerMonth.toLocaleString("en-US"))
      expect(incl(negocio, loc)).toContain(String(PLAN_ALLOWANCES.negocio.photosPerMonth))
      expect(incl(negocio, loc)).toContain(String(NEGOCIO_TRIAL_DAYS))
    }
    expect(incl(negocio, 'es')).toMatch(/Dominio propio/)
    expect(incl(negocio, 'es')).toMatch(/Mercado Libre/)
    expect(incl(gratis, 'es')).toMatch(/subdominio/)
    expect(incl(gratis, 'es')).toMatch(/Tienda impulsada por Miyagi Sánchez/)
  })

  test('the legacy SKU tokens still read their single-source constants', () => {
    // The SKU rows are no longer on the price list, but old copy's tokens must keep working.
    const f = fixedPricingTokens('es')
    expect(f.subdomainYearly).toContain(`$${SUBDOMAIN_PRICE_YEARLY_MXN}`)
    expect(f.mlSyncPrice).toContain(`$${ML_SYNC_PRICE_YEARLY_MXN}`)
    expect(f.customDomainYearly).toContain(`$${CUSTOM_DOMAIN_PRICE_MXN}`)
    expect(yearlyAsMonthly(CUSTOM_DOMAIN_PRICE_MXN)).toBe(CUSTOM_DOMAIN_PRICE_MONTHLY_MXN)
    expect(f.subdomainPrice).toContain(`$${SUBDOMAIN_PRICE_MONTHLY_MXN} MXN/mes`)
    expect(f.mlSyncPrice).toContain(`$${ML_SYNC_PRICE_MONTHLY_MXN} MXN/mes`)
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
    expect(fillPricingTokens('Print: {printAdPrice}. Mig: {migrationPrice}. {typo}', c, 'es')).toBe(
      `Print: ${getExtra(c, 'print_ad').priceLabel.es}. Mig: $999 MXN, pago único. {typo}`,
    )
  })

  test('{negocioMonthly} and {negocioYearly} fill from lib/negocio-pricing.ts, es and en', () => {
    const c = buildPricingCatalog(UNSET)
    expect(fillPricingTokens('{negocioMonthly} · {negocioYearly}', c, 'es')).toBe(
      `$${NEGOCIO_PRICE_MONTHLY_MXN} MXN al mes · $${NEGOCIO_PRICE_YEARLY_MXN.toLocaleString('en-US')} MXN al año`,
    )
    expect(fillFixedPricingTokens('{negocioMonthly}', 'en')).toBe(`$${NEGOCIO_PRICE_MONTHLY_MXN} MXN a month`)
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
    expect(es).toContain(`$${NEGOCIO_PRICE_MONTHLY_MXN} MXN al mes`)
    expect(es).toContain(`$${NEGOCIO_PRICE_YEARLY_MXN.toLocaleString('en-US')} MXN al año`)
    expect(es).toContain('/mx/precios')
  })
})
