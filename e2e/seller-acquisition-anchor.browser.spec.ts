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
    await expect(page.getByText(/pídele a Claude, Gemini o ChatGPT/i)).toBeVisible()
    await expect(page.getByTestId('vende-router-creadores')).toBeVisible()
    await expect(page.getByTestId('vende-router-negocios')).toBeVisible()
    await expect(page.getByTestId('vende-router-servicios')).toBeVisible()

    // The hero PromptBlock shows the directive prompt as visible text + a copy button. Clicking it
    // copies the prompt, which must carry the per-page URL and the Mercado Libre / Shopify
    // cost-comparison instruction (the whole point of the visible prompt block).
    // The steps aside pairs the same trust prompt with a second PromptBlock, so this text renders
    // twice — assert the (first) hero occurrence.
    await expect(page.getByText(/Compara cuánto pagaría ahí contra Mercado Libre y Shopify/i).first()).toBeVisible()
    await page.getByTestId('vende-prompt-copy').click()
    const clipboard = await page.evaluate(() => navigator.clipboard.readText())
    expect(clipboard).toContain('https://miyagisanchez.com/')
    expect(clipboard).not.toContain('/mx/vende')
    expect(clipboard).toContain('Mercado Libre')
    expect(clipboard).toContain('Shopify')

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
