import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { sellerLandingPath, sellerLandingRedirectPath, usSellerCtaHref } from '../lib/seller-acquisition'
import { buildUsMarketPageConfig } from '../app/(shell)/mx/vende/_components/page-config'
import { resolveSellerSignupMarket } from '../lib/seller-signup-market'
import { validatePlatformDictionaries } from '../lib/dictionary-contract'

const ROOT = path.resolve(import.meta.dirname, '..')
const source = (relativePath: string) => readFileSync(path.join(ROOT, relativePath), 'utf8')
const load = (relativePath: string) => JSON.parse(source(relativePath))

const publishTarget = (href: string) =>
  decodeURIComponent(new URL(href, 'https://miyagisanchez.com').searchParams.get('redirect_url') ?? '')

test.describe('US seller recruiting · signed-out /sell', () => {
  test('the CTA converts on sign-up and carries the immutable market through it', () => {
    const href = usSellerCtaHref({ utm_source: 'newsletter', v: 'b' })

    expect(new URL(href, 'https://miyagisanchez.com').pathname).toBe('/sign-up')

    // `market` is the whole point: a shop's market cannot be changed after
    // creation, so if it does not survive account creation the seller silently
    // gets a Mexican shop — the exact defect us-marketplace S5.2 was built to stop.
    const target = new URL(publishTarget(href), 'https://miyagisanchez.com')
    expect(target.pathname).toBe('/sell')
    expect(target.searchParams.get('market')).toBe('us')
    expect(resolveSellerSignupMarket(target.searchParams.get('market'))).toBe('us')
    expect(target.searchParams.get('from')).toBe('us')
    expect(target.searchParams.get('v')).toBe('b')
    expect(target.searchParams.get('utm_source')).toBe('newsletter')
  })

  test('both dictionaries carry a US block and the pair stays in contract', () => {
    const es = load('locales/es.json')
    const en = load('locales/en.json')

    expect(en.sellerAcquisition.us).toBeTruthy()
    expect(es.sellerAcquisition.us).toBeTruthy()
    expect(validatePlatformDictionaries(es, en)).toEqual([])
  })

  test('the page is authored US truth, not the Mexican page translated', () => {
    const en = load('locales/en.json')
    const config = buildUsMarketPageConfig(en.sellerAcquisition, {})

    expect(config.pageId).toBe('us')

    // Every claim on the page is rendered from these fields, so this is where a
    // Mexico-only promise would leak into a US recruiting surface. `admitMarketCheckout`
    // refuses MercadoPago, SPEI and cash on a US checkout, and refuses `shipping`
    // outright because there is no US carrier rate seam — so none of those words
    // may appear here whatever the translation says.
    const rendered = JSON.stringify([
      config.title, config.lead, config.proofPoints, config.steps, config.faqs,
      config.heroStats, config.heroValues, config.closingTitle, config.closingBody,
    ]).toLowerCase()
    for (const impossible of ['mercadopago', 'mercado pago', 'spei', 'peso', 'mxn', 'méxico', 'mexico']) {
      expect(rendered, `US page must not promise ${impossible}`).not.toContain(impossible)
    }
    expect(rendered).toContain('stripe')
    expect(rendered).toContain('usd')

    // Both CTAs convert on sign-up — the routing change this page exists to serve.
    for (const cta of [config.primaryCta, config.closingCta]) {
      expect(cta).not.toBeNull()
      expect(new URL(cta!.href, 'https://miyagisanchez.com').pathname).toBe('/sign-up')
    }
  })

  test('/sell sends a signed-out visitor to their market landing and still renders the wizard signed-in', () => {
    const page = source('app/(shell)/sell/page.tsx')

    // The wizard is load-bearing: ~25 `redirect('/sell')` call sites across the
    // merchant hub and four payment-connect return routes land on this page. So the
    // assertion is POSITIONAL, not "both strings appear" — the signed-out redirect
    // has to sit inside the signed-out branch, ABOVE the guard that resolves an
    // existing shop, and the wizard has to stay below it. A redirect after that
    // guard would bounce a merchant who was trying to publish.
    const signedOutBranch = page.indexOf('if (!user) {')
    const signedInGuard = page.indexOf('const existingShop = await getMySeller()')
    const landingRedirect = page.indexOf('redirect(sellerLandingRedirectPath(')
    const wizardRender = page.search(/<SellWizard\s/)

    expect(signedOutBranch).toBeGreaterThan(-1)
    expect(signedInGuard).toBeGreaterThan(-1)
    expect(landingRedirect).toBeGreaterThan(-1)
    expect(wizardRender).toBeGreaterThan(-1)

    expect(landingRedirect).toBeGreaterThan(signedOutBranch)
    expect(landingRedirect).toBeLessThan(signedInGuard)
    expect(wizardRender).toBeGreaterThan(signedInGuard)

    // The landing no longer RENDERS here — it has its own route. `/sell` holding a
    // second copy of it is the state this epic removed, and re-introducing one would
    // recreate the page that nobody linked to and nobody noticed was wrong.
    expect(page).not.toContain('buildUsMarketPageConfig(')
    expect(page).not.toContain('SellerAcquisitionPage')
  })

  test('the landing lives at /us/sell, under the US market chrome', () => {
    // Where the page went. `(us-site)` is the English shell — `<html lang="en-US">`,
    // English Clerk localization, the US market's own header and footer — so the
    // landing's language now follows from its ROUTE rather than from a `?market=us`
    // any link, ad or paste could drop.
    const landing = source('app/(us-site)/us/sell/page.tsx')

    expect(landing).toContain('buildUsMarketPageConfig(')
    expect(landing).toContain('SellerAcquisitionPage')
    expect(landing).toContain("alternates: { canonical: `${BASE_URL}${PAGE_PATH}` }")
    expect(landing).toContain("const PAGE_PATH = '/us/sell'")
    // The canonical is a real path, not the query string it used to be. Asserted on
    // the EMITTED urls rather than on the file text — the header comment explains the
    // old `?market=us` shape by name, and a whole-file negative would forbid saying so.
    // Two legitimate shapes: the page's own URL, and the CTA target (which is
    // `/sign-up?redirect_url=…` by design — account creation first).
    for (const emitted of landing.match(/\$\{BASE_URL\}[^`'"]*/g) ?? []) {
      expect(
        ['${BASE_URL}${PAGE_PATH}', '${BASE_URL}${usSellerCtaHref(query)}'],
        'every emitted absolute URL is the page path or the sign-up CTA',
      ).toContain(emitted)
    }
    // And it is the market registry, not this page, that says where a US seller goes.
    expect(sellerLandingPath('us')).toBe('/us/sell')
  })

  test('one effective locale drives the wizard — the preference is never overridden by the market', () => {
    const page = source('app/(shell)/sell/page.tsx')

    // Cross-family review (PR 389, Codex) caught this: the pre-seller US branch
    // hardcoded `locale="en"`, so a signup who had explicitly chosen Spanish still
    // got an English wizard. A visitor with no shop has no Medusa market, so the
    // validated SIGNUP market defaults the language — and the stored preference
    // still overrides it, exactly as it does once a shop exists.
    expect(page).toContain('resolveSellerLocale({')
    expect(page).toContain('market: signupMarket,')
    expect(page).not.toMatch(/locale="en"/)
    expect(page).not.toMatch(/getDictionary\('en'\)/)

    // Spanish stays the identity case here too: no boundary, no dictionary.
    expect(page).toContain('if (existingShop || !sellerCopyBoundaryNeeded(locale)) return content')
  })

  test('the signed-out hop keeps the campaign that paid for it', () => {
    // A visitor who clicked an ad pointing at `/sell` is redirected to the landing.
    // If the hop dropped attribution, every one of those visits would report as
    // direct traffic on a page that has an A/B test running on it.
    const target = new URL(
      sellerLandingRedirectPath('us', 'from=us&v=b&utm_source=newsletter&utm_medium=email&market=us'),
      'https://miyagisanchez.com',
    )
    expect(target.pathname).toBe('/us/sell')
    expect(target.searchParams.get('from')).toBe('us')
    expect(target.searchParams.get('v')).toBe('b')
    expect(target.searchParams.get('utm_source')).toBe('newsletter')
    expect(target.searchParams.get('utm_medium')).toBe('email')
    // `market` is NOT carried: the path states it now, and two authorities for one
    // fact is how they drift.
    expect(target.searchParams.get('market')).toBeNull()

    // No campaign, no empty query string dangling off the URL.
    expect(sellerLandingRedirectPath('mx')).toBe('/')
    // An unknown/absent market falls back to the default market's landing rather
    // than to a dead link.
    expect(sellerLandingRedirectPath(undefined)).toBe('/')
  })
})
