import { test, expect } from '@playwright/test'
import { resolvedSellTarget } from './_helpers/seller-acquisition'

test.describe('seller acquisition · Mundial wedge', () => {
  test('anonymous visitor sees the page and reaches service onboarding with attribution', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })

    const res = await page.goto('/mx/vende/mundial')
    expect(res?.ok()).toBeTruthy()

    await expect(
      page.getByRole('heading', { name: /Captura al público global del Mundial/i }),
    ).toBeVisible()
    // one-front-door-both-markets S3.1/S3.2 — the hero is the describe box; no self-check line, no copy-prompt block.
    await expect(page.getByText(/Compruébalo tú mismo/i)).toHaveCount(0)
    await expect(page.getByTestId('mundial-prompt-copy')).toHaveCount(0)
    await expect(page.getByTestId('p2s-describe-box')).toBeVisible()
    await expect(page.locator('.badge-promo')).toHaveCount(0)

    await page.getByTestId('mundial-primary-cta').click()
    await expect(page).toHaveURL((url) => (
      resolvedSellTarget(url)?.pathname === '/sell' &&
      resolvedSellTarget(url)?.searchParams.get('type') === 'service' &&
      resolvedSellTarget(url)?.searchParams.get('from') === 'mundial'
    ))
  })
})
