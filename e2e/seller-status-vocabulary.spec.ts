/**
 * The storefront's seller-status vocabulary must match the backend's
 * (tenant-lifecycle-admin · D1).
 *
 * Medusa owns the seller, so `apps/backend/src/lib/seller-status.ts` is the
 * authoritative definition. These are separate repositories with separate deploys, so
 * the storefront carries a copy of the value list — and a copy that nobody checks is
 * the paraphrased contract that drifts permissive, which this codebase records as
 * having bitten it five times.
 *
 * This spec reads the backend's own source and asserts the lists agree. If the
 * backend adds a state, this goes red here rather than the admin silently rendering
 * an unknown status as a blank cell.
 *
 * ── THE CROSS-REPO CHECK IS A DEV-TIME AID, NOT THE PROTECTION ────────────────
 * It SKIPS when the sibling repo is absent, which is exactly what CI does — so on its
 * own it would be a drift guard that is green precisely where drift ships. Raised in
 * review, and correct.
 *
 * The real protection is therefore NOT this check: it is that the frontend DEGRADES
 * correctly when the backend adds a state. An unrecognised status renders as "No
 * disponible" rather than blank or "Activa", the lifecycle panel refuses to act on
 * it, and no filter silently matches it. Those properties hold without knowing what
 * the new state is, and they are asserted below — unskippably, in CI.
 *
 * The cross-repo read stays because it turns a silent drift into a loud one for
 * anyone working in the monorepo, which is where the change would actually be made.
 */
import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SELLER_STATUSES,
  parseSellerStatus,
  sellerStatusLabel,
  sellerStatusTone,
} from '../lib/seller-status'
import { selectTenants, type TenantRow } from '../lib/admin/tenant-directory'

function row(overrides: Partial<TenantRow> = {}): TenantRow {
  return {
    medusaSellerId: 'sel_1', shopId: 'shop_1', slug: 's', name: 'S', claimed: true,
    publicSellerClaimed: true, publicSellerId: 'sel_1', publicSellerVerified: true,
    customDomain: null, domainStatus: 'none', entitlementReason: 'flag_off', entitled: true,
    subscriptionUnchecked: false, listingCount: 0, operatingMarketCode: 'mx',
    operatingMarketLabel: 'México', marketplacePublicationLabel: 'Publicada',
    createdAt: null, status: 'active', registrationEmail: null, planLegacy: 'absent', pausedForPlan: false,
    ...overrides,
  }
}

const BACKEND_SOURCE = join(process.cwd(), '..', 'backend', 'src', 'lib', 'seller-status.ts')

test.describe('seller status vocabulary', () => {
  test('matches the backend definition, or says why it could not check', () => {
    if (!existsSync(BACKEND_SOURCE)) {
      // Three states, never two: "checked and matched", "checked and differs", and
      // "could not check". Announce the third rather than passing silently.
      console.warn(
        `[seller-status-vocabulary] SKIPPED — ${BACKEND_SOURCE} not present. ` +
          'This runs in a full monorepo checkout; CI clones this repo alone.',
      )
      test.skip()
      return
    }
    const source = readFileSync(BACKEND_SOURCE, 'utf8')
    const match = source.match(/export const SELLER_STATUSES = \[([^\]]+)\]/)
    expect(match, 'backend SELLER_STATUSES not found — did it move or get renamed?').toBeTruthy()
    const backendValues = [...(match?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect(backendValues).toEqual([...SELLER_STATUSES])
  })

  test('every status has a distinct es-MX label', () => {
    const labels = SELLER_STATUSES.map((status) => sellerStatusLabel(status))
    expect(new Set(labels).size).toBe(labels.length)
    for (const label of labels) expect(label.length).toBeGreaterThan(0)
  })

  test('an unreadable status renders as unavailable, NEVER as active', () => {
    // The admin is where an operator decides whether to intervene. Showing "Activa"
    // for a shop whose status we could not read is a confident falsehood on exactly
    // the wrong screen.
    expect(parseSellerStatus(undefined)).toBeNull()
    expect(parseSellerStatus('suspended')).toBeNull()
    expect(sellerStatusLabel(null)).toBe('No disponible')
    expect(sellerStatusLabel(null)).not.toBe(sellerStatusLabel('active'))
  })
})

test.describe('degrading on a status this deploy has never heard of', () => {
  // THE assertions that hold in CI. A backend that adds `suspended` tomorrow ships
  // against a frontend that has never heard of it — these are what make that safe.

  test('an unknown status renders as unavailable, never blank and never active', () => {
    expect(sellerStatusLabel(parseSellerStatus('suspended'))).toBe('No disponible')
    expect(sellerStatusLabel(parseSellerStatus('suspended')).trim().length).toBeGreaterThan(0)
    expect(sellerStatusLabel(parseSellerStatus('suspended'))).not.toBe(sellerStatusLabel('active'))
  })

  test('an unknown status is never toned as OK', () => {
    // Green is the one colour that would tell an operator "nothing to see here".
    expect(sellerStatusTone(parseSellerStatus('suspended'))).not.toBe('ok')
  })

  test('an unknown status matches no status filter', () => {
    const unknown = row({ shopId: 'x', status: 'unavailable' })
    for (const status of SELLER_STATUSES) {
      expect(selectTenants([unknown], { status })).toHaveLength(0)
    }
    // …but it is still visible with no filter. Degrading must not HIDE a shop.
    expect(selectTenants([unknown], {})).toHaveLength(1)
  })
})
