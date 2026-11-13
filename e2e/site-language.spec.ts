import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import {
  LEGACY_SELLER_LOCALE_COOKIE,
  SITE_LANGUAGE_COOKIE,
  languageCookieDomain,
  languagePreferenceFromCookieHeader,
  languagePreferenceFromCookies,
  languageSwitchTarget,
  serializeLanguageCookie,
  urlLanguage,
} from '../lib/site-language'
import { resolveMarketPresentation } from '../lib/market-presentation'

/**
 * One language preference, everywhere (2026-11-13). The product owner kept getting stuck: the front door switched by
 * browser, the back office kept its own cookie, and every buyer page took its language from the market with no way
 * to change it. These pin the pure core; the wiring checks below pin that every surface actually reads it.
 */

const ROOT = path.resolve(import.meta.dirname, '..')
const source = (relativePath: string) => readFileSync(path.join(ROOT, relativePath), 'utf8')

test.describe('the stored choice · three states, never two', () => {
  test('a valid choice is read; nothing stored is null, NOT Spanish', () => {
    expect(languagePreferenceFromCookieHeader('ms_lang=en')).toBe('en')
    expect(languagePreferenceFromCookieHeader('a=1; ms_lang=es; b=2')).toBe('es')
    // Null lets each page keep its own default — the market's language, and the crawler's view.
    expect(languagePreferenceFromCookieHeader('')).toBeNull()
    expect(languagePreferenceFromCookieHeader(null)).toBeNull()
  })

  test('junk is absent, never a third language', () => {
    for (const junk of ['fr', 'EN', '', ' en']) {
      expect(languagePreferenceFromCookies((n) => (n === SITE_LANGUAGE_COOKIE ? junk : undefined)), junk).toBeNull()
    }
  })

  test('the back office choice made before the merge still counts, and the new cookie wins over it', () => {
    expect(LEGACY_SELLER_LOCALE_COOKIE).toBe('seller_locale')
    expect(languagePreferenceFromCookieHeader('seller_locale=en')).toBe('en')
    expect(languagePreferenceFromCookieHeader('seller_locale=en; ms_lang=es')).toBe('es')
  })

  test('the cookie spans the apex and every shop subdomain, never a custom domain', () => {
    expect(languageCookieDomain('miyagisanchez.com')).toBe('.miyagisanchez.com')
    expect(languageCookieDomain('tacos.miyagisanchez.com')).toBe('.miyagisanchez.com')
    expect(languageCookieDomain('localhost:3001')).toBeNull()
    expect(languageCookieDomain('theirshop.mx')).toBeNull()
    // A suffix match must be a real subdomain, not a lookalike.
    expect(languageCookieDomain('evilmiyagisanchez.com')).toBeNull()
    expect(serializeLanguageCookie('en', 'miyagisanchez.com')).toBe(
      'ms_lang=en; path=/; max-age=31536000; samesite=lax; domain=.miyagisanchez.com',
    )
    expect(serializeLanguageCookie('es', 'localhost')).not.toContain('domain=')
  })
})

test.describe('URL-language pages · the switch navigates, everything else re-renders in place', () => {
  test('the twins point at each other', () => {
    expect(languageSwitchTarget('/', 'en')).toBe('/en')
    expect(languageSwitchTarget('/en', 'es')).toBe('/')
    expect(languageSwitchTarget('/us/sell', 'es')).toBe('/us/vende')
    expect(languageSwitchTarget('/us/vende', 'en')).toBe('/us/sell')
    expect(languageSwitchTarget('/us/vende/', 'en')).toBe('/us/sell')
  })

  test('already in the chosen language ⇒ stay', () => {
    expect(languageSwitchTarget('/', 'es')).toBeNull()
    expect(languageSwitchTarget('/en', 'en')).toBeNull()
  })

  test('a Spanish-only seller pitch sends an English reader to the English builder', () => {
    expect(urlLanguage('/mx/vende/plomeria')).toBe('es')
    expect(languageSwitchTarget('/mx/vende/plomeria', 'en')).toBe('/en')
  })

  test('market pages are preference-rendered: same URL, same shop, other language', () => {
    for (const p of ['/mx', '/us', '/mx/l/prod_1', '/mx/s/tacos', '/us/s/x/tienda', '/checkout', '/account', '/shop/manage', '/mx/precios']) {
      expect(urlLanguage(p), p).toBeNull()
      expect(languageSwitchTarget(p, 'en'), p).toBeNull()
      expect(languageSwitchTarget(p, 'es'), p).toBeNull()
    }
  })
})

test.describe('presentation · language changes the words, never the market', () => {
  test('no choice ⇒ exactly the market presentation, unchanged', () => {
    expect(resolveMarketPresentation('mx', null)).toEqual(resolveMarketPresentation('mx'))
    expect(resolveMarketPresentation('us', undefined)).toEqual(resolveMarketPresentation('us'))
    expect(resolveMarketPresentation('mx', 'klingon').language).toBe('es')
  })

  test('a Mexican shop read in English stays in pesos on Mexico City time', () => {
    const p = resolveMarketPresentation('mx', 'en')
    expect(p.language).toBe('en')
    expect(p.htmlLang).toBe('en-MX')
    expect(p.currency).toBe('MXN')
    expect(p.timezone).toBe(resolveMarketPresentation('mx').timezone)
    expect(p.market).toBe('mx')
  })

  test('a US shop read in Spanish stays in dollars', () => {
    const p = resolveMarketPresentation('us', 'es')
    expect(p.language).toBe('es')
    expect(p.htmlLang).toBe('es-US')
    expect(p.currency).toBe('USD')
  })
})

test.describe('wiring · every surface reads the one preference', () => {
  test('the shared public-read cache is bypassed for anyone who made a choice', () => {
    const mw = source('middleware.ts')
    expect(mw).toContain('const hasLanguageChoice = languagePreferenceFromCookies(')
    // All three public-read doors: marketplace, subdomain, embed.
    expect(mw.match(/!hasLanguageChoice/g)?.length).toBe(3)
  })

  test('the cached public-read route never imports the cookie reader', () => {
    for (const file of [
      'app/(public-read)/internal-public-read/[channel]/[identity]/[slug]/shop/[[...rest]]/page.tsx',
      'app/(public-read)/internal-public-read/[channel]/[identity]/[slug]/listing/[id]/page.tsx',
      'app/(shell)/s/[slug]/ShopRenderer.tsx',
      'app/(shell)/l/[id]/ListingRenderer.tsx',
      'lib/shop-presentation/context.ts',
    ]) {
      expect(source(file), file).not.toContain('site-language-server')
    }
  })

  test('every chrome carries the switch', () => {
    expect(source('app/components/PlatformShell.tsx').match(/<LanguageSwitch /g)?.length).toBe(2) // mobile + desktop
    expect(source('app/(shell)/s/[slug]/ChannelLayout.tsx')).toContain('<LanguageSwitch current={language} />')
    expect(source('app/(shell)/shop/manage/_components/SellerShellChrome.tsx')).toContain('<LanguageSwitch current={locale} variant="inverse" />')
    expect(source('app/(shell)/sell/(onboarding)/layout.tsx')).toContain('<LanguageSwitch current={language} variant="inverse" />')
  })

  test('"Volver a comprar" goes to the marketplace, not the builder that hopped by browser language', () => {
    expect(source('app/(shell)/shop/manage/_components/SellerShellChrome.tsx')).toContain('href={marketBasePath(market)}')
  })
})
