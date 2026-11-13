import { expect, test } from '@playwright/test'
import {
  isSellerLocale,
  resolveSellerLocale,
  sellerCopyBoundaryNeeded,
} from '../lib/seller-locale'
import {
  LEGACY_SELLER_LOCALE_COOKIE,
  SITE_LANGUAGE_COOKIE,
  languagePreferenceFromCookieHeader,
} from '../lib/site-language'

test.describe('seller locale · market default with an explicit override', () => {
  test('falls back to the market when no preference is stored', () => {
    expect(resolveSellerLocale({ market: 'us' })).toBe('en')
    expect(resolveSellerLocale({ market: 'mx' })).toBe('es')
    expect(resolveSellerLocale({ market: null })).toBe('es')
    expect(resolveSellerLocale({})).toBe('es')
  })

  test('an explicit preference wins over the market, in BOTH directions', () => {
    // The direction that proves this is a preference and not a market alias: a US
    // shop asking for Spanish. A `market === 'us'` check cannot express it.
    expect(resolveSellerLocale({ preference: 'es', market: 'us' })).toBe('es')
    expect(resolveSellerLocale({ preference: 'en', market: 'mx' })).toBe('en')
  })

  test('an unparseable preference is absent, never a third language', () => {
    for (const junk of ['fr', '', ' ', 'EN', null, undefined, 0, {}, ['en']]) {
      expect(isSellerLocale(junk)).toBe(false)
      expect(resolveSellerLocale({ preference: junk, market: 'us' })).toBe('en')
      expect(resolveSellerLocale({ preference: junk, market: 'mx' })).toBe('es')
    }
  })

  test('Spanish is the identity case — only English is a transform', () => {
    expect(sellerCopyBoundaryNeeded('es')).toBe(false)
    expect(sellerCopyBoundaryNeeded('en')).toBe(true)
  })

  test('the portal reads the ONE site-wide choice, and still honours a choice stored before the merge', () => {
    // 2026-11-13: the portal's own `seller_locale` cookie became the site-wide `ms_lang`, so a language picked in the
    // back office survives "Volver a comprar". The old cookie is read as a fallback, never written.
    expect(SITE_LANGUAGE_COOKIE).toBe('ms_lang')
    expect(LEGACY_SELLER_LOCALE_COOKIE).toBe('seller_locale')
    expect(languagePreferenceFromCookieHeader('seller_locale=en')).toBe('en')
    expect(languagePreferenceFromCookieHeader('seller_locale=en; ms_lang=es')).toBe('es')
  })
})
