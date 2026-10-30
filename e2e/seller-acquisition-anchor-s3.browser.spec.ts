import { expect, test } from '@playwright/test'

// Sprint 3 — rendered smoke for the two new anchor sections (benchmark US-3 + AI-channel US-4).
// Opt-in browser project (NOT the blocking gate): `npm run test:e2e:browser`, nightly via
// browser-smoke.yml. Asserts what an api spec can't see — the sections render and the table
// reflows without horizontal page overflow on narrow mobile widths.
test.describe('seller acquisition · anchor S3 sections (browser)', () => {
  for (const width of [360, 390]) {
    test(`benchmark + AI-channel render with no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 })
      const res = await page.goto('/')
      expect(res?.ok()).toBeTruthy()

      // US-3 — benchmark table renders with the competitor columns.
      await expect(page.getByRole('heading', { name: /Compara antes de decidir/i })).toBeVisible()
      await expect(page.getByRole('columnheader', { name: 'Mercado Libre' })).toBeVisible()
      await expect(page.getByRole('columnheader', { name: 'Shopify' })).toBeVisible()
      await expect(page.getByText(/Verificado:\s*25 de junio de 2026/i)).toBeVisible()

      // US-4 — AI-channel section renders with its three-step explainer. Scope the UCP/MCP
      // assertion to this section: the benchmark table also has a "Sí, nativo (UCP/MCP)" cell,
      // and getByText would otherwise hit a strict-mode violation across both matches.
      const aiChannelSection = page.getByRole('region', { name: /Que la IA también venda por ti/i })
      await expect(aiChannelSection.getByRole('heading', { name: /Que la IA también venda por ti/i })).toBeVisible()
      await expect(aiChannelSection.getByText(/UCP\/MCP/i)).toBeVisible()

      // S2 — benchmark worked-example block renders under the table (punchline visible).
      await expect(page.getByTestId('vende-benchmark-example-punchline')).toBeVisible()
      await expect(page.getByText(/Ejemplo: vendes un producto de \$1,000 MXN/i)).toBeVisible()

      // S2 — the anchor social-proof stats block is replaced by the premium-features grid.
      await expect(page.getByRole('heading', { name: /Todo esto ya viene incluido/i })).toBeVisible()

      // S2 — persona-router cards no longer render an eyebrow badge.
      await expect(page.locator('[data-testid^="vende-router-"] .badge-soft')).toHaveCount(0)

      // The table may scroll inside its own container, but the page itself must not overflow.
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement
        return doc.scrollWidth - doc.clientWidth
      })
      expect(overflow, 'no horizontal page overflow').toBeLessThanOrEqual(1)
    })
  }
})
