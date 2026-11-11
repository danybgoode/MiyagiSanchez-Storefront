import { expect, test } from '@playwright/test'
import {
  ABOUT_CTA_HREF,
  ABOUT_PAGE,
  ABOUT_SECTION_IDS,
  ABOUT_SECTIONS,
  aboutCopy,
  getAboutSection,
  type AboutLocale,
  type AboutSectionId,
} from '../lib/about-content'
import { NEGOCIO_PRICE_MONTHLY_MXN, NEGOCIO_PRICE_YEARLY_MXN } from '../lib/negocio-pricing'

const LOCALES: AboutLocale[] = ['es', 'en']
// custom-domain-paywall S2.3: `pricing` is now grounded (real $499/yr price).
// The /acerca mobile+content refresh: `founder` is now grounded too
// (real bio from the founder's own CV) — no section is a stub any more.
const STUB_IDS: readonly AboutSectionId[] = []
const GROUNDED_IDS = ['what_is', 'why_sell', 'how_to_start', 'cost_transparency', 'pricing', 'founder', 'philosophy'] as const

test.describe('about-content · single bilingual source', () => {
  test('section ids cover exactly the seven sections, in order, no dupes', () => {
    expect(ABOUT_SECTION_IDS).toEqual([
      'what_is',
      'why_sell',
      'how_to_start',
      'cost_transparency',
      'pricing',
      'founder',
      'philosophy',
    ])
    expect(ABOUT_SECTIONS.map((s) => s.id)).toEqual(ABOUT_SECTION_IDS)
  })

  test('every section has non-empty es AND en copy (heading + body)', () => {
    for (const section of ABOUT_SECTIONS) {
      for (const locale of LOCALES) {
        const copy = aboutCopy(section, locale)
        expect(copy.heading.trim(), `${section.id}.${locale}.heading`).not.toBe('')
        expect(copy.body.length, `${section.id}.${locale}.body`).toBeGreaterThan(0)
        for (const paragraph of copy.body) {
          expect(paragraph.trim(), `${section.id}.${locale}.body paragraph`).not.toBe('')
        }
        for (const point of copy.points ?? []) {
          expect(point.title.trim(), `${section.id}.${locale}.point.title`).not.toBe('')
          expect(point.body.trim(), `${section.id}.${locale}.point.body`).not.toBe('')
        }
      }
    }
  })

  test('no section is a flagged stub; all seven are grounded', () => {
    for (const id of STUB_IDS) {
      expect(getAboutSection(id).stub, `${id} should be a stub`).toBe(true)
    }
    for (const id of GROUNDED_IDS) {
      expect(getAboutSection(id).stub, `${id} should be grounded`).toBe(false)
    }
  })

  test('pricing section publishes the Negocio prices (from lib/negocio-pricing.ts) in both locales', () => {
    const pricing = getAboutSection('pricing')
    expect(pricing.stub, 'pricing must be grounded').toBe(false)
    for (const locale of LOCALES) {
      const text = aboutCopy(pricing, locale).body.join(' ')
      expect(text, `${locale} pricing mentions the monthly price`).toContain(`$${NEGOCIO_PRICE_MONTHLY_MXN} MXN`)
      expect(text, `${locale} pricing mentions the yearly price`).toContain(`$${NEGOCIO_PRICE_YEARLY_MXN.toLocaleString('en-US')} MXN`)
      expect(text, `${locale} pricing names both plans`).toContain('Negocio')
      expect(text.toLowerCase(), `${locale} pricing no longer says coming soon`).not.toMatch(/próximamente|coming soon/)
    }
  })

  test('founder section is grounded, names the founder, and no longer says coming soon', () => {
    const founder = getAboutSection('founder')
    expect(founder.stub, 'founder must be grounded').toBe(false)
    for (const locale of LOCALES) {
      const text = aboutCopy(founder, locale).body.join(' ')
      expect(text, `${locale} founder section names Daniel Vásquez`).toContain('Daniel Vásquez')
      expect(text, `${locale} founder section mentions a real, verifiable fact`).toContain('AB InBev')
      expect(text.toLowerCase(), `${locale} founder section no longer says coming soon`).not.toMatch(/próximamente|coming soon/)
    }
  })

  test('page-level copy present in both locales + CTA points at onboarding', () => {
    for (const locale of LOCALES) {
      const page = ABOUT_PAGE[locale]
      for (const [key, value] of Object.entries(page)) {
        expect(value.trim(), `ABOUT_PAGE.${locale}.${key}`).not.toBe('')
      }
    }
    expect(ABOUT_CTA_HREF).toBe('/')
  })

  test('getAboutSection throws on an unknown id', () => {
    // @ts-expect-error — intentionally invalid id
    expect(() => getAboutSection('nope')).toThrow()
  })
})
