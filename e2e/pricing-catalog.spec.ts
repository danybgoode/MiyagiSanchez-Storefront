import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import {
  buildPricingCatalog,
  fillPricingTokens,
  fillFixedPricingTokens,
  fixedPricingTokens,
  getExtra,
  tiendaIncludes,
  trialLengthLabel,
  yearlyAsMonthly,
  type PricingCatalogInput,
} from '../lib/pricing-catalog'
import { PROMOTER_SKUS } from '../lib/promoter-skus'
import { NEGOCIO_PRICE_MONTHLY_MXN, NEGOCIO_PRICE_YEARLY_MXN, NEGOCIO_TRIAL_DAYS } from '../lib/negocio-pricing'
import { TIENDA_PRICE_MONTHLY_MXN, TIENDA_PRICE_YEARLY_MXN } from '../lib/tienda-pricing'
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
  test('the only extra on the price list is the migration: no printed ad is sold (Daniel, 2026-11-05)', () => {
    const catalog = buildPricingCatalog(UNSET)
    expect(catalog.extras.map((r) => r.sku)).toEqual(PROMOTER_SKUS.filter((s) => s === 'migration'))
    expect(catalog.extras.map((r) => r.sku)).not.toContain('print_ad')
  })

  test('two PAID plans, Plan Tienda and Plan Negocio — Plan Gratis is no longer offered (plan-tienda S2.3)', () => {
    const c = buildPricingCatalog(UNSET)
    expect(c.plans.map((p) => p.id)).toEqual(['tienda', 'negocio'])
    // Always the full plan names, so «Negocio» never reads as "doing business" (Daniel, 2026-11-05).
    expect(c.plans.map((p) => p.name.es)).toEqual(['Plan Tienda', 'Plan Negocio'])
    expect(c.plans.map((p) => p.name.en)).toEqual(['Tienda plan', 'Negocio plan'])
    expect(JSON.stringify(c.plans)).not.toMatch(/Plan Gratis|Free plan|para siempre|forever/)
    const [tienda, negocio] = c.plans
    // Plan Tienda: «desde $19 al mes» is the yearly price over twelve months, never typed (D5).
    expect([tienda.monthlyMxn, tienda.yearlyMxn]).toEqual([TIENDA_PRICE_MONTHLY_MXN, TIENDA_PRICE_YEARLY_MXN])
    expect(tienda.priceLabel.es).toBe(`Desde $${yearlyAsMonthly(TIENDA_PRICE_YEARLY_MXN)} al mes`)
    expect(tienda.priceLabel.es).toBe('Desde $19 al mes')
    expect(tienda.priceDetail.es).toBe(`$${TIENDA_PRICE_YEARLY_MXN} MXN al año, en un solo pago, o $${TIENDA_PRICE_MONTHLY_MXN} MXN al mes`)
    expect([negocio.monthlyMxn, negocio.yearlyMxn]).toEqual([NEGOCIO_PRICE_MONTHLY_MXN, NEGOCIO_PRICE_YEARLY_MXN])
    expect(negocio.priceLabel.es).toBe(`$${NEGOCIO_PRICE_MONTHLY_MXN} MXN/mes`)
    expect(negocio.priceDetail.es).toBe(`o $${NEGOCIO_PRICE_YEARLY_MXN.toLocaleString('en-US')} MXN/año (también a meses sin intereses)`)
    // Prices include IVA, and both plans say so (D5).
    for (const p of c.plans) expect([p.ivaLabel.es, p.ivaLabel.en]).toEqual(['IVA incluido', 'IVA (VAT) included'])
    const incl = (p: typeof tienda, loc: 'es' | 'en') => p.includes.map((i) => i[loc]).join(' | ')
    for (const loc of ['es', 'en'] as const) {
      expect(incl(tienda, loc)).toContain(PLAN_ALLOWANCES.tienda.chatAnswersPerMonth.toLocaleString('en-US'))
      expect(incl(negocio, loc)).toContain(PLAN_ALLOWANCES.negocio.chatAnswersPerMonth.toLocaleString('en-US'))
      expect(incl(negocio, loc)).toContain(String(PLAN_ALLOWANCES.negocio.photosPerMonth))
      expect(incl(negocio, loc)).toContain(trialLengthLabel(NEGOCIO_TRIAL_DAYS, loc))
    }
    expect(incl(negocio, 'es')).toMatch(/propio dominio/)
    expect(incl(negocio, 'es')).toMatch(/Mercado Libre/)
    expect(incl(negocio, 'es')).toContain('Todo lo del Plan Tienda')
    expect(incl(negocio, 'es')).toContain('sin tarjeta')
    // Plan Tienda includes today's Plan Gratis list.
    expect(tienda.includes).toEqual(tiendaIncludes())
    expect(incl(tienda, 'es')).toMatch(/subdominio/)
    expect(incl(tienda, 'es')).toMatch(/Tienda impulsada por Miyagi Sánchez/)
  })

  test('the trial length reads «3 meses» only once it is 90 days, and its true length before that (D20)', () => {
    expect(trialLengthLabel(90, 'es')).toBe('3 meses')
    expect(trialLengthLabel(90, 'en')).toBe('3 months')
    expect(trialLengthLabel(30, 'es')).toBe('30 días')
    expect(trialLengthLabel(45, 'es')).toBe('45 días')
    expect(fixedPricingTokens('es').trialLength).toBe(trialLengthLabel(NEGOCIO_TRIAL_DAYS, 'es'))
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
    for (const sku of ['migration'] as const) {
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
  })

  test('a set migration price shows flat, and a print-ad price never reaches the list', () => {
    const c = buildPricingCatalog({ ...UNSET, migrationPriceMxn: 999, printAdTiersCents: [10000, 2500, 7500] })
    expect(getExtra(c, 'migration').priceLabel.es).toBe('$999 MXN, pago único')
    expect(() => getExtra(c, 'print_ad')).toThrow(/no row for print_ad/)
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
    // `{printAdPrice}` is gone with the printed ad, so it now stays visible like any unknown token.
    expect(fillPricingTokens('Print: {printAdPrice}. Mig: {migrationPrice}. {typo}', c, 'es')).toBe(
      'Print: {printAdPrice}. Mig: $999 MXN, pago único. {typo}',
    )
  })

  test('{negocioMonthly} and {negocioYearly} fill from lib/negocio-pricing.ts, es and en', () => {
    const c = buildPricingCatalog(UNSET)
    expect(fillPricingTokens('{negocioMonthly} · {negocioYearly}', c, 'es')).toBe(
      `$${NEGOCIO_PRICE_MONTHLY_MXN} MXN al mes · $${NEGOCIO_PRICE_YEARLY_MXN.toLocaleString('en-US')} MXN al año`,
    )
    expect(fillFixedPricingTokens('{negocioMonthly}', 'en')).toBe(`$${NEGOCIO_PRICE_MONTHLY_MXN} MXN a month`)
  })

  test('the Plan Tienda tokens fill from lib/tienda-pricing.ts, es and en', () => {
    expect(fillFixedPricingTokens('{tiendaFrom} · {tiendaYearly} · {tiendaMonthly}', 'es')).toBe(
      `desde $${yearlyAsMonthly(TIENDA_PRICE_YEARLY_MXN)} al mes · $${TIENDA_PRICE_YEARLY_MXN} MXN al año · $${TIENDA_PRICE_MONTHLY_MXN} MXN al mes`,
    )
    expect(fillFixedPricingTokens('{tiendaFrom}', 'es')).toBe('desde $19 al mes')
    expect(fillFixedPricingTokens('{tiendaFrom} · {tiendaMonthly}', 'en')).toBe(`from $19 a month · $${TIENDA_PRICE_MONTHLY_MXN} MXN a month`)
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
    // Both paid plans, IVA included, and no Plan Gratis offered to a new shop (plan-tienda S2.3).
    expect(es).toContain(`$${TIENDA_PRICE_YEARLY_MXN} MXN al año`)
    expect(es).toContain('desde $19 al mes')
    const lead = aboutCopy(getAboutSection('pricing'), 'es').lead ?? ''
    expect(lead).toContain('IVA incluido')
    expect(lead).not.toContain('gratis para siempre')
  })

  test('/acerca renders the LOCALES: their pricing section says exactly what lib/about-content.ts says', () => {
    // pricing-page memory: the live /acerca reads locales/*.json → acerca.sections.pricing, while llms.txt and the
    // agent surfaces read lib/about-content.ts. Two copies of one text: they must be the same text.
    for (const locale of ['es', 'en'] as const) {
      const json = JSON.parse(readFileSync(`locales/${locale}.json`, 'utf8')).acerca.sections.pricing
      // The about defaults are filled from a catalog with no admin prices (lib/about-content.ts); fill the locale the same way.
      const fill = (t: string) => fillPricingTokens(t, buildPricingCatalog(UNSET), locale)
      const section = getAboutSection('pricing')[locale]
      expect({ heading: json.heading, lead: fill(json.lead), body: json.body.map(fill) }).toEqual({ heading: section.heading, lead: section.lead, body: section.body })
    }
  })
})

test.describe('/mx/precios copy (plan-tienda S2.3)', () => {
  test('the headline stops leading with free-forever; the page offers two paid plans, IVA included, and 3 free months of Negocio without a card', () => {
    for (const locale of ['es', 'en'] as const) {
      const ui = JSON.parse(readFileSync(`locales/${locale}.json`, 'utf8')).precios
      const all = JSON.stringify(ui)
      expect(all).not.toMatch(/gratis para siempre|free forever/i)
      // Plan Gratis is not OFFERED: it is named only in the FAQ answer that tells an existing shop it keeps it.
      const offer = JSON.stringify({ metadata: ui.metadata, hero: [ui.heroTitle, ui.heroLead, ui.primaryCta], plans: ui.plans })
      expect(offer).not.toMatch(/Plan Gratis|Free plan/)
      expect(ui.faq.items.filter((i: { a: string }) => /Plan Gratis|Free plan/.test(i.a))).toHaveLength(1)
      expect(all).not.toContain('{trialDays}')
      const fill = (t: string) => fillFixedPricingTokens(t, locale)
      // Every token in the copy is a known one.
      expect(fill(all)).not.toMatch(/\{\w+\}/)
      expect(fill(ui.plans.lead)).toContain(trialLengthLabel(NEGOCIO_TRIAL_DAYS, locale))
      expect(fill(ui.heroLead)).toContain(locale === 'es' ? 'desde $19 al mes' : 'from $19 a month')
      expect(fill(ui.heroLead)).toMatch(locale === 'es' ? /incluyen IVA/ : /includes IVA/)
      expect(ui.plans.lead).toMatch(locale === 'es' ? /sin tarjeta/ : /no card/)
    }
    const es = JSON.parse(readFileSync('locales/es.json', 'utf8')).precios
    expect(es.heroTitle).toBe('Tu propia tienda en línea, sin comisión por venta.')
    expect(fillFixedPricingTokens(es.plans.lead, 'es')).toMatch(/^(3 meses|\d+ días) gratis del Plan Negocio para empezar, sin tarjeta\./)
  })
})
