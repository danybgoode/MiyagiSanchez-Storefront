import { test, expect } from '@playwright/test'

/**
 * root-shop-builder-home S2.3 — a buyer who typed the bare domain is one tap from the marketplace.
 *
 * Position is a rendered fact, so this is a browser spec: «¿Vienes a comprar?» must be visible
 * without scrolling on desktop, and within the first two screens on a 390 px phone (the describe
 * box owns the first one, on purpose). The marketplace bonus sits further down as a section.
 */

test('desktop: the buyer link is visible without scrolling and opens the marketplace', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  const link = page.getByTestId('vende-buyer-link')
  await expect(link).toBeVisible()
  const box = await link.boundingBox()
  expect(box, 'buyer link has no layout box').not.toBeNull()
  expect(box!.y + box!.height, 'buyer link must sit inside the first desktop screen').toBeLessThanOrEqual(800)

  await link.getByRole('link').click()
  await expect(page).toHaveURL(/\/mx$/)
})

test('phone 390 px: the buyer link is within the first two screens; the bonus is further down', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByTestId('p2s-describe-box')).toBeVisible()

  const link = page.getByTestId('vende-buyer-link')
  await expect(link).toBeAttached()
  const box = await link.boundingBox()
  expect(box, 'buyer link has no layout box').not.toBeNull()
  expect(box!.y + box!.height, 'buyer link must sit within two phone screens').toBeLessThanOrEqual(844 * 2)

  const bonus = page.getByTestId('vende-marketplace-bonus')
  await expect(bonus).toHaveAttribute('href', '/mx')
  const bonusBox = await bonus.boundingBox()
  expect(bonusBox!.y, 'the marketplace bonus comes after what the merchant gets').toBeGreaterThan(box!.y)
})
