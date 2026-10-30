import { test, expect, type Page } from '@playwright/test'

/**
 * The `/` ↔ `/en` language hop, in a real browser.
 *
 * `one-landing-per-market` (#399) split the market selector into two prerendered
 * documents and hops between them on the client, from `navigator.languages`. The
 * decision is a pure function with its own unit coverage (`e2e/root-language.spec.ts`),
 * and the api suite cannot see any of this: the hop is `router.replace` after
 * hydration, so a `request.get('/')` returns 200 and learns nothing. A pure core is
 * only as true as its wiring, and the wiring is what this file measures.
 *
 * It also exists because of how the gap surfaced. The hop shipped on 2026-08-19 and
 * the first thing that noticed was `market-selector.browser.spec.ts` going red — an
 * unrelated spec failing its opening assertion because Playwright's default locale is
 * `en-US`. Nothing asserted the new behaviour on purpose; something else broke and
 * pointed at it. That is coverage by accident, and it ends the day someone pins a
 * locale to make the red go away.
 *
 * Two mechanics worth knowing before editing:
 *
 *  · `locale` is a browser-CONTEXT option, so `test.use` has to sit in a describe —
 *    the context is built before the test body runs.
 *  · Assertions are on `pathname`, never on the full URL. A regex over the href has
 *    to spell both `miyagisanchez.com/` and `localhost:3001/`, which is how a spec
 *    quietly becomes environment-specific.
 */

const QUIET_MS = 1500
const SETTLE_CAP_MS = 12_000

/**
 * Waits until the path has been UNCHANGED for QUIET_MS, then reports it.
 *
 * The hop is a `router.replace` inside an effect, so there is no load event to wait
 * on, and both directions of this file need care from opposite sides. Sampling too
 * early reads the pre-hop path and passes for the wrong reason; a fixed sleep long
 * enough for production hydration is a number that will be too short again on a
 * slower day — one run in seven did exactly that while the feature was fine.
 *
 * Quiescence solves both: a hop that has not happened yet keeps resetting the timer,
 * and a path that is genuinely staying put clears it in QUIET_MS.
 */
async function settledPath(page: Page): Promise<string> {
  const deadline = Date.now() + SETTLE_CAP_MS
  let last = new URL(page.url()).pathname
  let quietSince = Date.now()

  while (Date.now() < deadline) {
    await page.waitForTimeout(150)
    const current = new URL(page.url()).pathname
    if (current !== last) {
      last = current
      quietSince = Date.now()
      continue
    }
    if (Date.now() - quietSince >= QUIET_MS) return last
  }
  // Never silently return a path that never settled — that is the "unavailable"
  // state collapsing into an answer.
  throw new Error(`path never settled within ${SETTLE_CAP_MS}ms (last seen "${last}")`)
}

/**
 * root-shop-builder-home (2026-10-29): `/` is the Mexico shop builder and NEVER hops.
 *
 * Before this epic `/` was the Spanish copy of the selector and moved English browsers to
 * `/en`. That hop would now carry an `en-MX` phone — common in Mexico — straight past the
 * pitch onto a country picker, so the selector island is no longer mounted on `/`. `/en` is
 * untouched by product-owner decision: it still hops a Spanish browser to `/`, which now
 * lands them on the pitch, and its "Español" link still goes to `/`.
 */
test.describe('an English browser', () => {
  test.use({ locale: 'en-US' })

  test('/ does not hop: it stays on the shop builder', async ({ page }) => {
    await page.goto('/')

    expect(await settledPath(page)).toBe('/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'es-MX')
    await expect(page.getByTestId('p2s-describe-box')).toBeVisible()
    await expect(page.getByTestId('market-selector')).toHaveCount(0)
    // The English document is one deliberate tap away, never an automatic move.
    await expect(page.getByTestId('root-market-link-en')).toHaveAttribute('href', '/en')
  })

  test('/en is a terminus, not a bounce — an English browser stays put', async ({ page }) => {
    await page.goto('/en')

    // COUNTING the navigations, not sampling the URL. `rootLanguageRedirect` returns
    // a target only when the preference DIFFERS from what is on screen; if that ever
    // became symmetric the two documents would volley a visitor between them. A spec
    // that reads the URL once passes straight through a volley — verified, by making
    // the function symmetric on purpose: this test stayed GREEN while three others
    // went red, because after the settle the bouncing browser happened to be sitting
    // on `/en`. What distinguishes a terminus from a loop is that nothing moves.
    // Only navigations AWAY from /en count. The main frame re-announces its own URL
    // once as the client router takes over, which is not the browser being moved —
    // banning that would be a guard rejecting correct output.
    const movedAway: string[] = []
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      const pathname = new URL(frame.url()).pathname
      if (pathname !== '/en') movedAway.push(pathname)
    })

    await page.waitForTimeout(3000)

    expect(movedAway, 'an English browser on /en must not be moved anywhere').toEqual([])
    expect(new URL(page.url()).pathname).toBe('/en')
    await expect(page.getByTestId('market-selector')).toBeVisible()
  })

  test('Español on /en lands on the shop builder, and it stays there', async ({ page }) => {
    await page.goto('/en')
    expect(await settledPath(page)).toBe('/en')

    // Settling BEFORE the click is load-bearing, not defensive padding: clicking while a
    // hop is still committing hits a node React is replacing, and no navigation happens.
    const toSpanish = page.getByTestId('root-language-es')
    await expect(toSpanish).toBeVisible()
    await toSpanish.click()

    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe('/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'es-MX')
    await expect(page.getByTestId('p2s-describe-box')).toBeVisible()

    await page.goto('/')
    expect(await settledPath(page)).toBe('/')
  })
})

test.describe('a Spanish browser is left alone', () => {
  test.use({ locale: 'es-MX' })

  test('/ does not hop', async ({ page }) => {
    await page.goto('/')
    expect(await settledPath(page)).toBe('/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'es-MX')
  })

  test('the English link on / is a real choice: it lands on /en and stays there', async ({ page }) => {
    // A plain link bounced every es-MX phone straight back: /en hops a Spanish browser to / unless
    // a choice is stored. The strip's link stores it (reviewer finding on PR #454).
    await page.goto('/')
    expect(await settledPath(page)).toBe('/')
    await page.getByTestId('root-market-link-en').click()
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe('/en')
    expect(await settledPath(page)).toBe('/en')
    await expect(page.getByTestId('market-selector')).toBeVisible()
  })

  test('/en hops back to the Spanish document, which is now the shop builder', async ({ page }) => {
    await page.goto('/en')
    expect(await settledPath(page)).toBe('/')
    await expect(page.getByTestId('p2s-describe-box')).toBeVisible()
  })
})

test.describe('a browser that reads neither language falls to Spanish', () => {
  test.use({ locale: 'de-DE' })

  test('/ is the default and does not hop', async ({ page }) => {
    // Spanish is the canonical locale and the deliberate fallback for the majority of
    // the world's languages — not a claim the visitor reads it, which is why the
    // English document stays one link away.
    await page.goto('/')
    expect(await settledPath(page)).toBe('/')
    await expect(page.getByTestId('root-market-link-en')).toBeVisible()
  })
})
