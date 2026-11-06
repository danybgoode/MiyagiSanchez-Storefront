/**
 * The ownership guard (promoter-panel D1): a promoter writes — adds a product, fills one from a photo, imports a
 * catalog — ONLY to a shop they opened (or hold a relationship for) that nobody has claimed.
 *
 * Before this, `/api/promoter/close/listing` checked only that the shop existed, so any promoter account could add a
 * product to any merchant's live shop with a hand-made request (pr-reviewer, #475). A claimed shop is the merchant's:
 * they add products from their own panel (Daniel, 2026-11-05).
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { decideShopEdit, shopEditRefusal } from '../lib/promoter-close'

test('decideShopEdit: claimed first, then opened or linked, otherwise not yours', () => {
  // A claimed shop is never writable, even by the promoter who opened it.
  expect(decideShopEdit({ claimed: true, openedByPromoter: true, linkedToPromoter: true })).toBe('claimed')
  expect(decideShopEdit({ claimed: false, openedByPromoter: true, linkedToPromoter: false })).toBe('ok')
  expect(decideShopEdit({ claimed: false, openedByPromoter: false, linkedToPromoter: true })).toBe('ok')
  // Someone else's unclaimed shop.
  expect(decideShopEdit({ claimed: false, openedByPromoter: false, linkedToPromoter: false })).toBe('not_yours')
})

test('each refusal says what to do, and "could not look" is a 503, never an allow', () => {
  expect(shopEditRefusal('ok')).toBeNull()
  expect(shopEditRefusal('claimed')).toEqual({ status: 403, error: 'Esta tienda ya es de su dueño. Pídele que agregue productos desde su panel.' })
  expect(shopEditRefusal('not_yours')?.status).toBe(403)
  expect(shopEditRefusal('unavailable')?.status).toBe(503)
})

test('the server check fails closed: a relationship that could not be read is unavailable', () => {
  const src = readFileSync('lib/promoter-shop-access.ts', 'utf8')
  const body = src.slice(src.indexOf('export async function promoterShopEditAccess'))
  expect(body).toContain("if (error) return 'unavailable'")
  // Claimed is decided from the shop row alone, before any relationship read.
  expect(body.indexOf('const claimed = !!input.shop.clerkUserId')).toBeLessThan(body.indexOf(".from('merchant_relationships')"))
})

for (const [route, firstWrite] of [
  ['app/api/promoter/close/listing/route.ts', 'resolvePromoterListingStatus('],
  ['app/api/promoter/close/photo/route.ts', 'suggestFromPhoto('],
] as const) {
  test(`${route} checks the guard before any write or model call`, () => {
    const src = readFileSync(route, 'utf8')
    const guard = src.indexOf('promoterShopEditAccess(')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(src.indexOf(firstWrite))
    expect(src).toContain('shopEditRefusal(')
  })
}
