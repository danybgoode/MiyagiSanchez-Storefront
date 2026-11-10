/**
 * The promoter's shares after the sale (epic 08 · plan-tienda-three-free-months S4.2, S4.3, README D14):
 * `tienda_renewal` 10% of a Plan Tienda payment in the 12 months after the shop's first package's paid time ends, and
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
  UPGRADE_WINDOW_MONTHS,
  renewalWindowMonths,
  startsRenewalWindow,
} from '../lib/promoter-packages'

const PACKAGE_PAID = new Date('2026-11-10T12:00:00.000Z')

test('tienda_renewal is wired into both Plan Tienda payment paths, after the status landed and only for real money', () => {
  const webhook = readFileSync('lib/negocio-webhook.ts', 'utf8')
  const yearly = webhook.slice(webhook.indexOf('export async function handlePlanOneTimeComplete'), webhook.indexOf('function syncDeps('))
  expect(yearly).toContain("if (plan === 'negocio') return recordNegocioPaymentShares(")
  expect(yearly).toContain('accrueTiendaPaymentShare({ ...input, amountCents: session.amount_total ?? 0 })')
  const invoice = webhook.slice(webhook.indexOf('export async function handlePlanInvoicePaid'), webhook.indexOf('export async function handlePlanInvoiceFailed'))
  const zero = invoice.indexOf('if ((invoice.amount_paid ?? 0) <= 0) return')
  const patched = invoice.indexOf("if (out.outcome !== 'patched' || !shopId || !invoice.id) return result")
  const tienda = invoice.indexOf('accrueTiendaPaymentShare({ shopId, paymentRef: invoice.id, amountCents: invoice.amount_paid ?? 0, paidAt })')
  expect(zero).toBeGreaterThan(-1)
  expect(patched).toBeGreaterThan(zero)
  expect(tienda).toBeGreaterThan(patched)
})

test.describe('tienda_renewal — 10% of a Plan Tienda payment in year 2 (S4.2)', () => {
  const tienda = (sku: string | null, paidAt: string) =>
    decideRenewalShare({ renewalSku: 'tienda_renewal', anchor: sku ? { sku, paidAt: PACKAGE_PAID } : null, paidAt: new Date(paidAt) })

  test('the 12 months after each package\'s paid time ends — the edges, exactly, for both renewals (Daniel, 2026-11-10)', () => {
    const windows: Array<[string, string, string]> = [
      // sku, first month in, first month out (paid 2026-11-10T12:00Z)
      ['negocio_semestral', '2027-08-10T12:00:00.000Z', '2028-08-10T12:00:00.000Z'], // [9, 21)
      ['negocio_anual', '2028-02-10T12:00:00.000Z', '2029-02-10T12:00:00.000Z'], // [15, 27)
      ['tienda_anual', '2028-02-10T12:00:00.000Z', '2029-02-10T12:00:00.000Z'], // [15, 27): 3 free + 12
      ['negocio_arranque', '2027-11-10T12:00:00.000Z', '2028-11-10T12:00:00.000Z'], // retired: the old [12, 24), kept
    ]
    for (const renewalSku of ['negocio_renewal', 'tienda_renewal'] as const) {
      for (const [sku, open, close] of windows) {
        if (!startsRenewalWindow(sku, renewalSku)) continue // tienda_anual opens only the Tienda renewal
        const at = (iso: string) => decideRenewalShare({ renewalSku, anchor: { sku, paidAt: PACKAGE_PAID }, paidAt: new Date(iso) })
        const ms = (iso: string, d: number) => new Date(Date.parse(iso) + d).toISOString()
        expect(at(ms(open, -1)), `${renewalSku} ${sku} just before`).toEqual({ action: 'skip', reason: 'outside_window' })
        expect(at(open), `${renewalSku} ${sku} first instant`).toEqual({ action: 'record' })
        expect(at(ms(close, -1)), `${renewalSku} ${sku} last instant`).toEqual({ action: 'record' })
        expect(at(close), `${renewalSku} ${sku} first instant after`).toEqual({ action: 'skip', reason: 'outside_window' })
      }
    }
  })

  test('the windows are derived from the grants, and the retired packages keep the old one', () => {
    expect(renewalWindowMonths('negocio_semestral')).toEqual({ from: 9, to: 21 })
    expect(renewalWindowMonths('negocio_anual')).toEqual({ from: 15, to: 27 })
    expect(renewalWindowMonths('tienda_anual')).toEqual({ from: 15, to: 27 })
    expect(renewalWindowMonths('negocio_arranque')).toEqual({ from: 12, to: 24 })
    expect(renewalWindowMonths('setup_gratis')).toEqual({ from: 12, to: 24 })
    // A package's paid time is its own grants: the window follows them, nothing is typed per sku.
    const src = readFileSync('lib/promoter-packages.ts', 'utf8')
    const fn = src.slice(src.indexOf('export function renewalWindowMonths'), src.indexOf('\n}\n', src.indexOf('export function renewalWindowMonths')))
    expect(fn).not.toMatch(/negocio_|tienda_/)
    // The upgrade window is unchanged: [0, 12) from the tienda_anual payment.
    expect(UPGRADE_WINDOW_MONTHS).toEqual({ from: 0, to: 12 })
  })

  test('every package that sold a plan opens it; the free setup and no package do not', () => {
    for (const sku of ['tienda_anual', 'negocio_semestral', 'negocio_anual', 'negocio_arranque']) {
      expect(tienda(sku, '2028-03-01T00:00:00.000Z'), sku).toEqual({ action: 'record' })
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
    const yearly = webhook.slice(webhook.indexOf('export async function handlePlanOneTimeComplete'), webhook.indexOf('function syncDeps('))
    // A checkout carrying a promoter_sku is a promoter's sale: no share.
    expect(yearly.indexOf('if (promoterSku) return true')).toBeGreaterThan(-1)
    expect(yearly.indexOf('if (promoterSku) return true')).toBeLessThan(yearly.indexOf('recordNegocioPaymentShares('))
    const invoice = webhook.slice(webhook.indexOf('export async function handlePlanInvoicePaid'))
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
    const steps = readFileSync('lib/promoter-upgrade-share.ts', 'utf8')
    expect(steps).toContain('paymentRef: decision.paymentRef')
    expect(up).toContain('return await runUpgradeShare(')
    // Could not read the later packages ≠ none.
    expect(up).toContain("if (error) throw new Error(`Negocio package read failed: ${error.message}`)")
  })
})
