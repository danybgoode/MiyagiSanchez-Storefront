import { expect, test } from '@playwright/test'
import { resolvedSellTarget } from './_helpers/seller-acquisition'

test.describe('seller acquisition · anchor page', () => {
  test('anonymous visitor sees the router and reaches onboarding with attribution', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])

    const res = await page.goto('/?utm_source=browser-smoke')
    expect(res?.ok()).toBeTruthy()

    await expect(
      page.getByRole('heading', { name: /Describe tu negocio/i }),
    ).toBeVisible()
    // one-front-door-both-markets S3.2 — the self-check line and the copy-prompt block are gone everywhere.
    await expect(page.getByText(/Compruébalo tú mismo/i)).toHaveCount(0)
    await expect(page.getByTestId('vende-prompt-copy')).toHaveCount(0)
    await expect(page.getByTestId('p2s-describe-box')).toBeVisible()
    await expect(page.getByTestId('vende-router-creadores')).toBeVisible()
    await expect(page.getByTestId('vende-router-negocios')).toBeVisible()
    await expect(page.getByTestId('vende-router-servicios')).toBeVisible()

    await page.getByTestId('vende-router-creadores').click()
    await expect(page).toHaveURL((url) => (
      url.pathname === '/mx/vende/creadores' &&
      url.searchParams.get('utm_source') === 'browser-smoke'
    ))

    await page.goto('/?utm_source=browser-smoke')
    await page.getByTestId('vende-router-servicios').click()
    await expect(page).toHaveURL((url) => (
      url.pathname === '/mx/vende/servicios' &&
      url.searchParams.get('utm_source') === 'browser-smoke'
    ))

    await page.goto('/?utm_source=browser-smoke')
    await page.getByTestId('vende-primary-cta').click()
    await expect(page).toHaveURL((url) => (
      resolvedSellTarget(url)?.pathname === '/sell' &&
      resolvedSellTarget(url)?.searchParams.get('from') === 'vende' &&
      resolvedSellTarget(url)?.searchParams.get('utm_source') === 'browser-smoke'
    ))
  })
})
