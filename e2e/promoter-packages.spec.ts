/**
 * The promoter's three packages and the year-2 renewal share (epic 08 · plans-gratis-negocio S4, README D12, D13).
 *
 * Daniel's numbers are the contract: Anual 2,000 → 900 / 1,100; Arranque 600 → 300 / 300; Gratis 250 → 50 / 200; and
 * 10% of a merchant's Negocio payments in year 2 of a promoter's package.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import {
  PACKAGES,
  PACKAGE_SKUS,
  isPackageSku,
  isRenewalPayment,
  packageSentence,
  packageSplit,
  startsRenewalWindow,
} from '../lib/promoter-packages'
import { PROMOTER_SKUS } from '../lib/promoter-skus'
import { TRANSFER_SKUS } from '../lib/promoter-transfer'
import { promoterOpenedShop, promoterSourceUrl } from '../lib/promoter-close'

test('the packages are promoter SKUs and transfer SKUs (the DB CHECK was widened by M1)', () => {
  for (const sku of PACKAGE_SKUS) {
    expect(PROMOTER_SKUS).toContain(sku)
    expect(TRANSFER_SKUS).toContain(sku)
  }
  expect(PROMOTER_SKUS).toContain('negocio_renewal')
  expect(isPackageSku('negocio_anual')).toBe(true)
  expect(isPackageSku('custom_domain')).toBe(false)
})

test("Daniel's splits, exactly: charge, pay the platform, keep", () => {
  expect(packageSplit('negocio_anual', 55)).toEqual({ chargeCents: 200_000, keepCents: 110_000, payPlatformCents: 90_000 })
  expect(packageSplit('negocio_arranque', 50)).toEqual({ chargeCents: 60_000, keepCents: 30_000, payPlatformCents: 30_000 })
  expect(packageSplit('setup_gratis', 80)).toEqual({ chargeCents: 25_000, keepCents: 20_000, payPlatformCents: 5_000 })
  expect(packageSentence('negocio_anual', 55)).toBe('Cobras $2,000 · nos pagas $900 · te quedas $1,100')
})

test('what each package grants: 12 months, 3 months, nothing (the trial still runs)', () => {
  expect(PACKAGES.negocio_anual.negocioMonths).toBe(12)
  expect(PACKAGES.negocio_arranque.negocioMonths).toBe(3)
  expect(PACKAGES.setup_gratis.negocioMonths).toBe(0)
})

test('an unset rate means the promoter keeps nothing and the platform gets it all — never a negative share', () => {
  expect(packageSplit('negocio_anual', 0)).toEqual({ chargeCents: 200_000, keepCents: 0, payPlatformCents: 200_000 })
  expect(packageSplit('negocio_anual', 100).payPlatformCents).toBe(0)
})

test('the renewal window is months 12 to 24 after the first package payment', () => {
  const first = new Date('2026-11-10T12:00:00Z')
  expect(isRenewalPayment(first, new Date('2027-11-09T12:00:00Z'))).toBe(false) // still year 1
  expect(isRenewalPayment(first, new Date('2027-11-10T12:00:00Z'))).toBe(true)
  expect(isRenewalPayment(first, new Date('2028-05-01T00:00:00Z'))).toBe(true)
  expect(isRenewalPayment(first, new Date('2028-11-10T12:00:00Z'))).toBe(false) // year 3
  expect(startsRenewalWindow('negocio_anual')).toBe(true)
  expect(startsRenewalWindow('setup_gratis')).toBe(false)
})

test('a package transfer is charged at its own list price, never through the promoter discount (no clamp)', () => {
  const src = readFileSync('lib/promoter-transfers.ts', 'utf8')
  const branch = src.slice(src.indexOf('if (isPackageSku(sku)) {'), src.indexOf('} else {', src.indexOf('if (isPackageSku(sku)) {')))
  expect(branch).toContain('grossAmountCents = basePriceCents')
  const route = readFileSync('app/api/promoter/close/package/[sku]/route.ts', 'utf8')
  expect(route).toContain('basePriceCents: PACKAGES[sku].priceMxn * 100')
})

test('the close workspace offers the three packages first, and the card path pays only the platform share', () => {
  const ui = readFileSync('app/(shell)/promotor/cerrar/PromoterCloseClient.tsx', 'utf8')
  for (const sku of PACKAGE_SKUS) expect(ui).toContain(`id: 'package/${sku}'`)
  expect(ui).not.toContain("id: 'domain'")
  const card = readFileSync('lib/promoter-package-server.ts', 'utf8')
  expect(card).toContain('amountCents: split.payPlatformCents')
  expect(card).toContain("paymentMethodTypes: ['card']")
  expect(card).toContain("session.payment_status !== 'paid'")
})

test('a promoter may close a package only on a shop they opened (or their own relationship) — Codex security, #474', () => {
  const mine = promoterSourceUrl('PRM-EKTK5L', 'Tacos Don Beto')
  expect(promoterOpenedShop(mine, 'PRM-EKTK5L')).toBe(true)
  expect(promoterOpenedShop(mine, 'prm-ektk5l')).toBe(true) // codes are normalized
  expect(promoterOpenedShop(mine, 'PRM-OTHER1')).toBe(false)
  expect(promoterOpenedShop('https://supply.example/shop', 'PRM-EKTK5L')).toBe(false)
  expect(promoterOpenedShop(null, 'PRM-EKTK5L')).toBe(false)
  const route = readFileSync('app/api/promoter/close/package/[sku]/route.ts', 'utf8')
  // The check runs before EITHER payment path.
  expect(route.indexOf('promoterMayCloseShop(')).toBeGreaterThan(-1)
  expect(route.indexOf('promoterMayCloseShop(')).toBeLessThan(route.indexOf("if (body.paymentMethod === 'transfer')"))
})
