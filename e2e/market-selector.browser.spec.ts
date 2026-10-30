import { test, expect } from '@playwright/test'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'https://miyagisanchez.com'

test.describe.configure({ mode: 'serial' })

/**
 * Runs on a Spanish browser — from the suite default (`playwright.config.ts`, the
 * `browser` project), NOT a pin here.
 *
 * `one-landing-per-market` (#399) gave the market selector two documents — `/` in
 * Spanish, `/en` in English — and `RootLanguageSwitch` hops between them once, on the
 * client, from `navigator.languages`. Playwright's default locale is `en-US`, so from
 * 2026-08-19 this spec landed on `/en` and failed its very first assertion against a
 * feature working exactly as designed. `admin-seleccion` broke the same way.
 *
 * The first fix pinned the locale here. That was wrong in the same way the four stale
 * `/vende` links were wrong: it fixes the instance you found and leaves the class. The
 * locale is a property of the market this whole suite tests, so it belongs to the
 * project — and once it is there, a second pin in this file is a second derivation of
 * one question that can silently disagree with the first.
 *
 * The subject here is the MARKET contract — a browser signal may recommend a market but
 * must never choose one. The hop itself is guarded on its own terms, in a real browser,
 * by e2e/root-language-hop.browser.spec.ts, which opts INTO `en-US` explicitly.
 */

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 900 },
]) {
  test(`root is the shop builder and reaches Mexico without an automatic redirect (${viewport.name})`, async ({ page }) => {
    /**
     * Three listeners, because "is this page healthy" is three different questions
     * and the old single `console` listener conflated them into one.
     *
     * This spec went red on 2026-08-01, 08-03 and 08-05 against an unchanged `main`,
     * and was written off three times as a flaky third-party resource. It was not
     * flaky — it was right. `/` was serving a SEVEN-DAY-OLD Cloudflare copy whose
     * build-hashed `/_next/static/chunks/*` no longer existed (see
     * `app/(site)/page.tsx`'s `revalidate` note). The CSS 404 made the homepage
     * render unstyled; the JS 404 threw ChunkLoadError, so the page never finished
     * loading — which is the 08-05 `page.goto` timeout that got filed as "transient
     * network unavailability". The variable was never the repo; it was the edge cache.
     */

    // 1. FIRST-PARTY ASSETS — a `/_next/*` 4xx/5xx is never noise. This is a direct
    //    assertion on the failure itself rather than an inference from Chromium's
    //    console prose, so it cannot be silenced by the message filter below. No
    //    third party serves `/_next/`, so the path alone establishes first-party.
    const brokenAssets: string[] = []
    page.on('response', (res) => {
      const { pathname } = new URL(res.url())
      if (pathname.startsWith('/_next/') && res.status() >= 400) {
        brokenAssets.push(`${res.status()} ${pathname}`)
      }
    })

    // 2. UNCAUGHT EXCEPTIONS — the listener this spec never had, so a throw (exactly
    //    the ChunkLoadError above) passed silently. Kept from the #344 draft, which
    //    got this part right.
    const jsErrors: string[] = []
    page.on('pageerror', (err) => jsErrors.push(`pageerror: ${err.message}`))

    // 3. CONSOLE ERRORS — minus Chromium's own resource-load-failure prose, which
    //    duplicates listener 1 for first-party assets and is genuine noise for
    //    third-party ones (remote/hotlinked images 4xx routinely, and that is a
    //    content problem, not a defect in this page's code). Safe to filter ONLY
    //    because listener 1 now asserts the first-party case precisely; filtering it
    //    with nothing underneath — as the original #344 draft proposed — would have
    //    blinded this spec to the very outage it was reporting.
    const RESOURCE_LOAD_FAILURE = /^Failed to load resource: the server responded with a status of \d+/

    // 3b. THE PREVIEW'S OWN BYPASS HEADER — and only on a preview.
    //
    // Reaching an SSO-gated Vercel preview means sending `x-vercel-protection-bypass`
    // on every request, and that turns same-origin-ish fetches into CORS preflights
    // that Clerk's CDN and fonts.gstatic.com then refuse ("Redirect is not allowed for
    // a preflight request", "x-vercel-protection-bypass is not allowed by
    // Access-Control-Allow-Headers"). Eighteen console errors, none of them about this
    // page's code, all of them caused by the act of observing it. This spec has failed
    // on every preview run for as long as the bypass has existed, which is precisely
    // how a console-error assertion earns a reputation for noise and gets deleted —
    // and this one is load-bearing (it is what caught the seven-day stale-CDN outage).
    //
    // Filtered ONLY when the target actually is a preview host, so production keeps
    // the full, unfiltered assertion. The negation stays available: the same CORS text
    // against production is still a failure, because that would be real.
    // Read from the CONFIGURED target, not `page.url()` — the listener is registered
    // before the first navigation, when the page is still `about:blank`.
    const onVercelPreview = /\.vercel\.app$/.test(new URL(BASE_URL).hostname)
    const PREVIEW_BYPASS_CORS = /blocked by CORS policy|net::ERR_FAILED/

    // 3c. THE TURNSTILE WIDGET'S OWN FRAME. Since root-shop-builder-home, `/` mounts the
    //     prompt-to-shop describe box, whose bot check is Cloudflare Turnstile in an iframe. That
    //     frame logs its own CSP and debug messages to the console intermittently (1 run in 4),
    //     and Playwright surfaces iframe console output on the page. Filtered by the message's
    //     SOURCE, never by its text: anything logged by our own origin still fails the spec.
    const TURNSTILE_FRAME = /^https:\/\/challenges\.cloudflare\.com\//

    page.on('console', (message) => {
      const text = message.text()
      if (message.type() !== 'error') return
      if (TURNSTILE_FRAME.test(message.location().url ?? '')) return
      if (RESOURCE_LOAD_FAILURE.test(text)) return
      if (onVercelPreview && PREVIEW_BYPASS_CORS.test(text)) return
      jsErrors.push(text)
    })

    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto('/')

    // root-shop-builder-home: `/` is the Mexico shop builder. The describe box is the first
    // action, the picker is gone from here (it lives on at `/en`), and D7's promise holds —
    // the brand's front door previews no catalog. The markets are a quiet strip of links.
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByTestId('p2s-describe-box')).toBeVisible()
    await expect(page.getByTestId('market-selector')).toHaveCount(0)
    await expect(page.getByTestId('root-market-link-mx')).toHaveAttribute('href', '/mx')
    await expect(page.getByTestId('root-market-link-us')).toHaveAttribute('href', '/us')
    await expect(page.locator('[data-listing-id]')).toHaveCount(0)

    await page.getByTestId('root-market-link-mx').click()
    await expect(page).toHaveURL(/\/mx$/)
    await expect(page.locator('body')).toContainText('Lo que tu barrio vende, compra y recomienda')

    // Asserted separately so the failure message names WHICH kind of broken this is:
    // a stale-CDN asset problem reads nothing like an application JS error, and the
    // three months this spec spent being dismissed as flaky is what conflating them
    // costs.
    expect(brokenAssets, 'first-party /_next asset(s) failed to load').toEqual([])
    expect(jsErrors).toEqual([])
  })
}

test('US is an English marketplace home, not the former recruiting surface', async ({ page }) => {
  const response = await page.goto('/us')

  expect(response?.status()).toBe(200)
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
  await expect(page.getByTestId('us-invitation')).toHaveCount(0)
  await expect(page.locator('body')).toContainText('What your neighborhood sells, buys, and recommends')
  await expect(page.locator('body')).not.toContainText('Working hypothesis')
})

test('US marketplace children resolve while a cross-market fixture remains absent', async ({ page }) => {
  const browse = await page.goto('/us/l')
  expect(browse?.status()).toBe(200)
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
  const missing = await page.goto('/us/l/prod_market_boundary_fixture')
  expect(missing?.status()).toBe(404)
})
