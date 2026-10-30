import { test, expect } from '@playwright/test'

/**
 * Navigation & Settings Reorg — Sprint 4 (entry-point wiring) — real-browser, ANONYMOUS.
 *
 * The signed-out seller CTA and the Vecindario feed entry both render without a
 * login and (the feed card) without the Medusa catalog, so these are deterministic
 * in any environment and go green only where this sprint is deployed. Covers
 * Story 4.1 (signed-out CTA → /mx/vende) and 4.2 (Vecindario reachable from the feed).
 * The signed-in "Publicar" → /sell and PWA-standalone checks stay owed to Daniel.
 */

test.describe('nav entry points (desktop, anonymous)', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('the signed-out "Publicar gratis" CTA leads to the shop builder at /', async ({ page }) => {
    await page.goto('/mx')
    const cta = page.getByRole('link', { name: 'Publicar gratis' }).first()
    await expect(cta).toBeVisible()
    await expect(cta).toHaveAttribute('href', '/')
  })

  test('the Inicio feed surfaces a Vecindario entry that opens /vecindario', async ({ page }) => {
    await page.goto('/mx')
    const entry = page.getByTestId('vecindario-feed-entry')
    await expect(entry).toBeVisible()
    await expect(entry).toHaveAttribute('href', '/vecindario')

    await entry.click()
    await expect(page).toHaveURL(/\/vecindario/)
  })
})
