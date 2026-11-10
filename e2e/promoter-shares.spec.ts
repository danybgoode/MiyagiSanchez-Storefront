/**
 * The promoter's shares after the sale (epic 08 · plan-tienda-three-free-months S4.2, S4.3, README D14):
 * `tienda_renewal` 10% of a Plan Tienda payment in months [12, 24) after the shop's first package, and
 * `negocio_upgrade` 20% of the FIRST Plan Negocio payment within 12 months of a `tienda_anual`. Each once.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import {
  NEGOCIO_PACKAGE_SKUS,
  RENEWAL_ANCHOR_SKUS,
  decideRenewalShare,
  decideUpgradeShare,
  upgradePaymentRef,
  isRenewalPayment,
  startsRenewalWindow,
} from '../lib/promoter-packages'

const PACKAGE_PAID = new Date('2026-11-10T12:00:00.000Z')

test.describe('tienda_renewal — 10% of a Plan Tienda payment in year 2 (S4.2)', () => {
  const tienda = (sku: string | null, paidAt: string) =>
    decideRenewalShare({ renewalSku: 'tienda_renewal', anchor: sku ? { sku, paidAt: PACKAGE_PAID } : null, paidAt: new Date(paidAt) })

  test('the window is months [12, 24) after the first package payment: the edges, exactly', () => {
    expect(tienda('tienda_anual', '2027-11-10T11:59:59.999Z')).toEqual({ action: 'skip', reason: 'outside_window' })
    expect(tienda('tienda_anual', '2027-11-10T12:00:00.000Z')).toEqual({ action: 'record' })
    expect(tienda('tienda_anual', '2028-06-01T00:00:00.000Z')).toEqual({ action: 'record' })
    expect(tienda('tienda_anual', '2028-11-10T11:59:59.999Z')).toEqual({ action: 'record' })
    expect(tienda('tienda_anual', '2028-11-10T12:00:00.000Z')).toEqual({ action: 'skip', reason: 'outside_window' })
    // A tienda_anual's own Tienda months run to month 15 — paid by the promoter's package, never a merchant payment —
    // so the first merchant Tienda payment it can see is in the window.
    expect(isRenewalPayment(PACKAGE_PAID, new Date('2028-02-10T12:00:00.000Z'))).toBe(true)
  })

  test('every package that sold a plan opens it; the free setup and no package do not', () => {
    for (const sku of ['tienda_anual', 'negocio_semestral', 'negocio_anual', 'negocio_arranque']) {
      expect(tienda(sku, '2028-01-01T00:00:00.000Z'), sku).toEqual({ action: 'record' })
    }
    expect(tienda('setup_gratis', '2028-01-01T00:00:00.000Z')).toEqual({ action: 'skip', reason: 'not_attributed' })
    expect(tienda(null, '2028-01-01T00:00:00.000Z')).toEqual({ action: 'skip', reason: 'not_attributed' })
    // A share is never an anchor: a renewal does not open another renewal's window.
    for (const share of ['negocio_renewal', 'tienda_renewal', 'negocio_upgrade']) {
      expect(tienda(share, '2028-01-01T00:00:00.000Z'), share).toEqual({ action: 'skip', reason: 'not_attributed' })
    }
  })

  test('the Negocio renewal keeps its own anchors: Negocio packages only (a tienda_anual is an upgrade, not a renewal)', () => {
    expect([...RENEWAL_ANCHOR_SKUS.negocio_renewal].sort()).toEqual(['negocio_anual', 'negocio_arranque', 'negocio_semestral'])
    expect(startsRenewalWindow('tienda_anual', 'negocio_renewal')).toBe(false)
    expect(startsRenewalWindow('tienda_anual', 'tienda_renewal')).toBe(true)
  })

  test('once per payment: the share is keyed by the payment id, and a duplicate re-runs only the idempotent accrual', () => {
    const src = readFileSync('lib/promoter-renewal-server.ts', 'utf8')
    // The anchor query reads the anchors of THIS renewal, never a hand-kept list.
    expect(src).toContain(".in('sku', [...RENEWAL_ANCHOR_SKUS[renewalSku]])")
    expect(src).toContain('payment_ref: input.paymentRef')
    expect(src).toContain("if (insertError.code !== '23505')")
    expect(src).toContain("outcome = 'replay'")
    // The index that makes it once (plans-gratis-negocio M1).
    const m1 = readFileSync('supabase/migrations/20261105000000_plans_negocio.sql', 'utf8')
    expect(m1).toContain('create unique index if not exists marketplace_promoter_attributions_payment_ref_key')
    // The Tienda entry point for sprint 2's payment paths: the Tienda renewal sku, the merchant's own amount.
    const entry = src.slice(src.indexOf('export function accrueTiendaPaymentShare'))
    expect(entry).toContain('recordRenewalShareFor(TIENDA_RENEWAL_SKU, {')
    expect(entry).toContain('grossCents: input.amountCents')
  })
})

test.describe('negocio_upgrade — 20% of the FIRST Plan Negocio payment within 12 months of a tienda_anual (S4.3)', () => {
  const anchor = { attributionId: 'attr-tienda-1', paidAt: PACKAGE_PAID }
  const upgrade = (paidAt: string, opts: { anchor?: typeof anchor | null; superseded?: boolean } = {}) =>
    decideUpgradeShare({ anchor: opts.anchor === undefined ? anchor : opts.anchor, paidAt: new Date(paidAt), negocioPackageAfterAnchor: opts.superseded ?? false })

  test('within 12 months of the package: recorded under the ANCHOR\'s ref', () => {
    expect(upgrade('2026-11-10T12:00:00.000Z')).toEqual({ action: 'record', paymentRef: 'negocio_upgrade:attr-tienda-1' })
    expect(upgrade('2027-11-10T11:59:59.999Z')).toEqual({ action: 'record', paymentRef: 'negocio_upgrade:attr-tienda-1' })
  })

  test('at or after 12 months, or before the package: nothing', () => {
    expect(upgrade('2027-11-10T12:00:00.000Z')).toEqual({ action: 'skip', reason: 'outside_window' })
    expect(upgrade('2026-11-09T00:00:00.000Z')).toEqual({ action: 'skip', reason: 'outside_window' })
  })

  test('only after a tienda_anual: a shop with none earns nothing', () => {
    expect(upgrade('2027-01-01T00:00:00.000Z', { anchor: null })).toEqual({ action: 'skip', reason: 'no_anchor' })
  })

  test('the first payment only: every payment under one tienda_anual gets the SAME ref, so the unique index admits one', () => {
    const first = upgrade('2027-01-01T00:00:00.000Z')
    const second = upgrade('2027-02-01T00:00:00.000Z')
    expect(first).toEqual(second)
    expect(first.action === 'record' && first.paymentRef).toBe(upgradePaymentRef('attr-tienda-1'))
    // A different tienda_anual (a later sale) opens its own single share.
    expect(upgradePaymentRef('attr-tienda-2')).not.toBe(upgradePaymentRef('attr-tienda-1'))
    // The ref can never collide with a Stripe payment id (the renewals' key) in the same unique index.
    expect(upgradePaymentRef('x').startsWith('negocio_upgrade:')).toBe(true)
  })

  test('a Negocio PACKAGE sold after the tienda_anual supersedes it: the move up was a package sale', () => {
    expect(upgrade('2027-01-01T00:00:00.000Z', { superseded: true })).toEqual({ action: 'skip', reason: 'superseded' })
    expect([...NEGOCIO_PACKAGE_SKUS].sort()).toEqual(['negocio_anual', 'negocio_arranque', 'negocio_semestral'])
  })

  test('wired into the merchant Negocio payments only — yearly (not a promoter checkout) and every paid invoice; never a package', () => {
    const webhook = readFileSync('lib/negocio-webhook.ts', 'utf8')
    const yearly = webhook.slice(webhook.indexOf('export async function handleNegocioOneTimeComplete'), webhook.indexOf('export async function handleNegocioSubscriptionChanged'))
    expect(yearly).toContain("if (outcome === 'written' && !promoterSku) {")
    expect(yearly.indexOf('recordNegocioPaymentShares(')).toBeGreaterThan(yearly.indexOf("if (outcome === 'written' && !promoterSku) {"))
    const invoice = webhook.slice(webhook.indexOf('export async function handleNegocioInvoicePaid'))
    expect(invoice).toContain('if ((invoice.amount_paid ?? 0) <= 0) return')
    expect(invoice).toContain('recordNegocioPaymentShares({ shopId, paymentRef: invoice.id')
    expect(webhook).not.toContain('recordRenewalShare(')
    for (const pkg of ['lib/promoter-package-server.ts', 'lib/promoter-grant-server.ts']) {
      expect(readFileSync(pkg, 'utf8'), pkg).not.toMatch(/recordNegocioPaymentShares|recordUpgradeShare/)
    }
    const shares = readFileSync('lib/promoter-renewal-server.ts', 'utf8')
    const both = shares.slice(shares.indexOf('export async function recordNegocioPaymentShares'))
    expect(both).toContain('await recordRenewalShare(input)')
    expect(both).toContain('await recordUpgradeShare(input)')
    // The upgrade's row is keyed by the decision's ref, never by the Stripe payment id.
    const up = shares.slice(shares.indexOf('export async function recordUpgradeShare'), shares.indexOf('export async function recordNegocioPaymentShares'))
    expect(up).toContain('paymentRef: decision.paymentRef')
    // Could not read the later packages ≠ none.
    expect(up).toContain('if (laterError) throw')
  })
})
