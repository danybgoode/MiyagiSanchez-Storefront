import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import {
  DEFAULT_ROOT_LANGUAGE,
  ROOT_LANGUAGE_PATHS,
  preferredRootLanguage,
  rootLanguageRedirect,
} from '../lib/root-language'
import { recommendedMarketForLocale } from '../lib/market-recommendation'
import { sellerLandingPath } from '../lib/seller-acquisition'

/**
 * The bilingual front door: `/` in Spanish, `/en` in English, chosen by the
 * browser once and by the visitor forever after.
 *
 * root-shop-builder-home (2026-10-29) changed what `/` IS: the Mexico shop builder, not
 * the Spanish copy of the selector. `/en` is untouched — it still renders the selector
 * and still hops a Spanish browser to `/` (which now lands them on the pitch). `/` no
 * longer hops anyone: an `en-MX` phone, common in Mexico, must see the pitch.
 *
 * The whole decision is a pure function so it can be pinned without a browser —
 * the client island is a five-line `useEffect` around it.
 */

const ROOT = path.resolve(import.meta.dirname, '..')
const source = (relativePath: string) => readFileSync(path.join(ROOT, relativePath), 'utf8')

test.describe('preferredRootLanguage · language, never region', () => {
  test('reads the language subtag and ignores the country', () => {
    expect(preferredRootLanguage(['es-MX'])).toBe('es')
    expect(preferredRootLanguage(['en-US'])).toBe('en')
    // Both of these are real people, and both used to be mis-served by any rule that
    // treated language and country as the same fact: a Spanish speaker in the US, and
    // an English speaker in Mexico.
    expect(preferredRootLanguage(['es-US'])).toBe('es')
    expect(preferredRootLanguage(['en-MX'])).toBe('en')
  })

  test('first match wins, in the browser own priority order', () => {
    // A bilingual visitor whose OS lists English first asked for English. "Any Spanish
    // anywhere in the list ⇒ Spanish" would overrule most bilingual users.
    expect(preferredRootLanguage(['en-GB', 'es'])).toBe('en')
    expect(preferredRootLanguage(['es', 'en-GB'])).toBe('es')
  })

  test('anything else falls to Spanish, and so does an absent or malformed list', () => {
    expect(preferredRootLanguage(['fr-FR', 'de'])).toBe('es')
    expect(preferredRootLanguage([])).toBe('es')
    expect(preferredRootLanguage(null)).toBe('es')
    expect(preferredRootLanguage(undefined)).toBe('es')
    expect(preferredRootLanguage([null, undefined, '', '   '])).toBe('es')
    expect(DEFAULT_ROOT_LANGUAGE).toBe('es')
    // But a later readable tag still counts — an empty first entry is not an answer.
    expect(preferredRootLanguage(['', 'en-US'])).toBe('en')
  })

  test('case and separator shape do not change the answer', () => {
    expect(preferredRootLanguage(['EN-US'])).toBe('en')
    expect(preferredRootLanguage(['en_US'])).toBe('en')
    expect(preferredRootLanguage([' es-MX '])).toBe('es')
  })
})

test.describe('rootLanguageRedirect · one hop, never a loop', () => {
  test('moves a visitor only toward the document they can read', () => {
    expect(rootLanguageRedirect({ current: 'es', languages: ['en-US'] })).toBe('/en')
    expect(rootLanguageRedirect({ current: 'en', languages: ['es-MX'] })).toBe('/')
  })

  test('a visitor already on their language is left alone', () => {
    expect(rootLanguageRedirect({ current: 'es', languages: ['es-MX'] })).toBeNull()
    expect(rootLanguageRedirect({ current: 'en', languages: ['en-US'] })).toBeNull()
  })

  test('the two documents can never bounce a visitor between them', () => {
    // The property, not two examples of it: for every browser preference, at most one
    // of the two documents wants to move, so a hop can never be answered by a hop back.
    for (const languages of [['es-MX'], ['en-US'], ['fr-FR'], [], ['en', 'es'], ['es', 'en']]) {
      const fromEs = rootLanguageRedirect({ current: 'es', languages })
      const fromEn = rootLanguageRedirect({ current: 'en', languages })
      expect([fromEs, fromEn].filter(Boolean).length, JSON.stringify(languages)).toBeLessThanOrEqual(1)
    }
  })

  test('an explicit choice outranks the browser, in both directions', () => {
    // Someone who clicked the switcher has out-voted their OS settings. Re-deciding on
    // the next load is what makes a language toggle look broken.
    expect(rootLanguageRedirect({ current: 'es', languages: ['en-US'], chosen: 'es' })).toBeNull()
    expect(rootLanguageRedirect({ current: 'en', languages: ['es-MX'], chosen: 'en' })).toBeNull()
    // A junk stored value is not a choice — fall back to the browser rather than
    // stranding the visitor on a page they cannot read.
    expect(rootLanguageRedirect({ current: 'es', languages: ['en-US'], chosen: 'klingon' })).toBe('/en')
    expect(rootLanguageRedirect({ current: 'es', languages: ['en-US'], chosen: null })).toBe('/en')
  })

  test('the paths are the real routes, stated once', () => {
    expect(ROOT_LANGUAGE_PATHS).toEqual({ es: '/', en: '/en' })
  })
})

test.describe('the selector wires language to destination', () => {
  test('each document sends a seller to the landing in its own language', () => {
    // The bottom CTA is the one thing on the page that varies by language rather than
    // being a translation: Spanish reader → the Spanish landing, English → the English.
    expect(sellerLandingPath('mx')).toBe('/')
    expect(sellerLandingPath('us')).toBe('/us/sell')

    const selector = source('app/(site)/MarketSelector.tsx')
    expect(selector).toContain("sellerLandingPath(language === 'en' ? 'us' : 'mx')")
    expect(selector).toContain('data-testid="market-selector-sell-cta"')
    // Never a literal — this CTA pointed at a hardcoded `/vende` in both languages.
    expect(selector).not.toMatch(/href="\/(?:vende|sell)"/)
  })

  test('language decides the document; region still only RECOMMENDS a market', () => {
    // Two browser-derived decisions live on this page and they must not merge.
    // Language navigates, because reading the page is a precondition for choosing at
    // all. Market only badges, because a market carries currency, payments and
    // shipping — consequences a visitor opts into. `es-US` proves they are separate:
    // Spanish document, United States suggestion.
    expect(preferredRootLanguage(['es-US'])).toBe('es')
    expect(recommendedMarketForLocale('es-US')).toBe('us')
    expect(preferredRootLanguage(['en-MX'])).toBe('en')
    expect(recommendedMarketForLocale('en-MX')).toBe('mx')

    const island = source('app/(site)/RootLanguageSwitch.tsx')
    expect(island).toContain("'use client'")
    // `replace`, so the back button leaves the site instead of bouncing off the
    // document the visitor was just moved out of.
    expect(island).toContain('router.replace(target)')
    expect(island).not.toContain('router.push(')
    // The selector's server render must read no request headers, or `/en` stops being a
    // static CDN asset — the ~30s cold start marketplace-static-shell fixed. `/` renders
    // per request now (root-shop-builder-home D2) but still has no reason to read them.
    for (const route of ['app/(site)/page.tsx', 'app/(en-site)/en/page.tsx', 'app/(site)/MarketSelector.tsx']) {
      expect(source(route), route).not.toMatch(/\bheaders\(\)|\bcookies\(\)/)
    }
  })

  test('both roots bound their CDN TTL', () => {
    // Duplicated from the population guard on purpose: this is the one property whose
    // absence is invisible until a deploy. `/en` is a 60 s ISR document; `/` renders per
    // request, which Cloudflare never stores (root-shop-builder-home D2).
    expect(source('app/(en-site)/en/page.tsx')).toMatch(/export const revalidate = 60\b/)
    expect(source('app/(site)/page.tsx')).toMatch(/export const dynamic = 'force-dynamic'/)
  })

  test('/ is the shop builder and never hops; /en still does', () => {
    const root = source('app/(site)/page.tsx')
    // The island that moves English browsers lives only in the selector, which `/` no
    // longer renders — so an en-MX phone stays on the pitch.
    // Imports, not text: the page's own comment explains the move and names the selector.
    expect(root).not.toMatch(/^import .*RootLanguageSwitch/m)
    expect(root).not.toMatch(/^import .*MarketSelector/m)
    expect(root).toMatch(/^import DescribeBox from /m)
    // `/en` keeps the island, and its target for a Spanish reader is still `/`.
    expect(source('app/(site)/MarketSelector.tsx')).toContain('<RootLanguageSwitch current={language} />')
    expect(rootLanguageRedirect({ current: 'en', languages: ['es-MX'] })).toBe('/')
  })
})
