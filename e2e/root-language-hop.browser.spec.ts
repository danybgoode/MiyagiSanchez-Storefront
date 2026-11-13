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
/** The header's ES/EN switch. The chrome renders a mobile and a desktop header; exactly one is visible. */
function switchTo(page: Page, language: 'es' | 'en') {
  return page.getByTestId(`language-switch-${language}`).locator('visible=true').first()
}

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
 * one-front-door-both-markets D16 (2026-11-12): `/` and `/en` are the SAME shop builder in two languages.
 *
 * An `en-US` browser on `/` is moved once to `/en`, the English builder. An `en-MX` phone is NOT
 * (root-shop-builder-home D5 still holds: an English-set phone in Mexico must not skip the Mexican pitch) — see the
 * `en-MX` block below. `/en` hops a Spanish browser to `/`, and a stored choice beats both.
 */
test.describe('an English browser', () => {
  test.use({ locale: 'en-US' })

  test('/ hops once to the English builder', async ({ page }) => {
    await page.goto('/')

    expect(await settledPath(page)).toBe('/en')
    await expect(page.getByTestId('p2s-describe-box')).toBeVisible()
    await expect(page.getByTestId('p2s-describe-box')).toContainText('Tell us what you sell')
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
    await expect(page.getByTestId('p2s-describe-box')).toBeVisible()
  })

  test('Español on /en lands on the shop builder, and it stays there', async ({ page }) => {
    await page.goto('/en')
    expect(await settledPath(page)).toBe('/en')

    // Settling BEFORE the click is load-bearing, not defensive padding: clicking while a
    // hop is still committing hits a node React is replacing, and no navigation happens.
    const toSpanish = switchTo(page, 'es')
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

  test('EN in the header on / is a real choice: it lands on /en and stays there', async ({ page }) => {
    // /en hops a Spanish browser to / unless a choice is stored; the switch stores it (the `ms_lang` cookie).
    await page.goto('/')
    expect(await settledPath(page)).toBe('/')
    await switchTo(page, 'en').click()
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe('/en')
    expect(await settledPath(page)).toBe('/en')
    await expect(page.getByTestId('p2s-describe-box')).toContainText('Tell us what you sell')
  })

  test('/en hops back to the Spanish document, which is now the shop builder', async ({ page }) => {
    await page.goto('/en')
    expect(await settledPath(page)).toBe('/')
    await expect(page.getByTestId('p2s-describe-box')).toBeVisible()
  })
})

test.describe('an English-set phone in Mexico stays on the Mexican builder (D5 kept)', () => {
  test.use({ locale: 'en-MX' })

  test('/ does not hop for en-MX', async ({ page }) => {
    await page.goto('/')
    expect(await settledPath(page)).toBe('/')
    await expect(page.getByTestId('p2s-describe-box')).toContainText('Cuéntanos qué vendes')
  })
})

test.describe('a browser that reads neither language falls to Spanish', () => {
  test.use({ locale: 'de-DE' })

  test('/ is the default and does not hop', async ({ page }) => {
    // Spanish is the canonical locale and the deliberate fallback for the majority of
    // the world's languages — not a claim the visitor reads it, which is why the
    // English document stays one tap away, in the header.
    await page.goto('/')
    expect(await settledPath(page)).toBe('/')
    await expect(switchTo(page, 'en')).toBeVisible()
  })
})

test.describe('one choice, everywhere (2026-11-13)', () => {
  test.use({ locale: 'es-MX' })

  test('EN on a marketplace page re-renders the same page in English, and the choice follows to the front door', async ({ page }) => {
    await page.goto('/mx')
    await expect(page.locator('html')).toHaveAttribute('lang', 'es-MX')
    await switchTo(page, 'en').click()
    // Same URL, same market, other language: the switch refreshes in place rather than moving to /us.
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-MX', { timeout: 10_000 })
    expect(new URL(page.url()).pathname).toBe('/mx')
    await expect(switchTo(page, 'en')).toHaveAttribute('aria-pressed', 'true')

    // The stored choice outranks a Spanish browser on the front door — the back-office complaint that started this.
    await page.goto('/')
    expect(await settledPath(page)).toBe('/en')

    // And back: ES on /en returns to / and stays there.
    await switchTo(page, 'es').click()
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe('/')
    expect(await settledPath(page)).toBe('/')
  })
})
