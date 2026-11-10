import { test, expect, type Page } from '@playwright/test'
import { authEnabled, requireEnv, sellerEmail, signIn } from './_helpers/auth'
import { resolveClaimedShop } from './_helpers/claimed-shop-fixture'

/**
 * Seller & unclaimed-shop bug sweep — Sprint 3 UI polish (browser smoke).
 *
 * S3.1 (legible accent buttons) and S3.2 (responsive sub-nav) are CSS-only, so a
 * browser is the only thing that sees the *rendered* result. The deterministic
 * guard (`design-token-foundation.spec.ts` → no `bg-[var(--accent)]` + untyped
 * `text-[var(--fg-inverse)]`) + the contrast-pair audit already lock the invariant
 * in CI; these specs confirm it renders.
 *
 *  - 3.1 runs ANONYMOUSLY on the public claim page (`/s/<slug>/claim`), the one
 *    surface among the five reachable without auth. Fixture: a claimed shop
 *    DISCOVERED from the live catalog (`_helpers/claimed-shop-fixture.ts`);
 *    MS_TEST_CLAIMED_SLUG is only a checked, optional pin. A dead pin
 *    (`miyagiprints`) kept the nightly red 2026-10-15 → 2026-11-03.
 *  - 3.2 is auth-gated (`/shop/manage` is behind `auth.protect()`), so it needs a
 *    seller session and skips unless `MS_TEST_BROWSER_AUTH=1` + `MS_TEST_SELLER_EMAIL`.
 *    Until that fixture exists the 375px sub-nav check is owed to Daniel.
 */

function parseRgb(value: string): [number, number, number] | null {
  const match = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

test.describe('seller bug sweep S3.1 · legible accent button (browser)', () => {
  test('the claim-page primary CTA shows a white label on green (not green-on-green)', async ({ page, request }) => {
    const fixture = await resolveClaimedShop(request, process.env.MS_TEST_CLAIMED_SLUG)
    test.skip(fixture.slug === null, `FIXTURE UNAVAILABLE — ${fixture.reason ?? 'no reason given'}`)
    await page.goto(`/s/${fixture.slug}/claim`)

    const cta = page.getByRole('link', { name: /ir a mi panel de ventas/i }).first()
    await expect(cta).toBeVisible()

    const { color, background } = await cta.evaluate((el) => {
      const s = getComputedStyle(el)
      return { color: s.color, background: s.backgroundColor }
    })

    const label = parseRgb(color)
    const bg = parseRgb(background)
    expect(label, `unparsable label color: ${color}`).not.toBeNull()
    expect(bg, `unparsable background: ${background}`).not.toBeNull()

    // Label is near-white (the bug rendered it green, inheriting :where(a) color).
    expect(label!.every((c) => c >= 200), `label not legibly light: ${color}`).toBeTruthy()
    // …and clearly distinct from the green button fill.
    expect(color).not.toBe(background)
  })
})

test.describe('seller bug sweep S3.2 · responsive manage sub-nav (browser, authed)', () => {
  test.beforeEach(() => {
    test.skip(!authEnabled(), 'Set MS_TEST_BROWSER_AUTH=1 (dev/preview) to run authed smokes.')
    requireEnv(sellerEmail(), 'MS_TEST_SELLER_EMAIL')
  })

  test('at 375px every sub-nav item is reachable and the page does not scroll sideways', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await signIn(page as Page, sellerEmail()!)
    await page.goto('/shop/manage')

    // The strip is the row holding "Ver tienda pública" → "Importar catálogo".
    const firstLink = page.getByRole('link', { name: /ver tienda pública/i }).first()
    const lastLink = page.getByRole('link', { name: /importar catálogo/i }).first()
    await expect(firstLink).toBeVisible()

    // The strip is an internal horizontal scroller (content wider than its box),
    // so the clipped items are reachable by scrolling — not lost off the page.
    const strip = firstLink.locator('xpath=..')
    const overflows = await strip.evaluate((el) => el.scrollWidth > el.clientWidth)
    expect(overflows, 'sub-nav should be a horizontal scroller at 375px').toBeTruthy()

    // The last item is reachable once scrolled into view.
    await lastLink.scrollIntoViewIfNeeded()
    await expect(lastLink).toBeVisible()

    // The page itself must not scroll sideways.
    const pageOverflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    )
    expect(pageOverflows, 'the page must not overflow horizontally at 375px').toBeFalsy()
  })
})
