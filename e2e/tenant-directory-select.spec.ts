/**
 * The tenant directory's filter + sort (tenant-lifecycle-admin · D6).
 *
 * Pure over shaped rows, so the behaviour an operator relies on — "show me the
 * unclaimed shops", "sort by listings" — is pinned without a database. The screen
 * calls the SAME `selectTenants`, so what this proves and what it renders cannot
 * drift.
 */
import { test, expect } from '@playwright/test'
import { selectTenants, type TenantRow } from '../lib/admin/tenant-directory'

function row(overrides: Partial<TenantRow> = {}): TenantRow {
  return {
    medusaSellerId: 'sel_1',
    shopId: 'shop_1',
    slug: 'tienda',
    name: 'Tienda',
    claimed: true,
    publicSellerClaimed: true,
    publicSellerId: 'sel_1',
    publicSellerVerified: true,
    customDomain: null,
    domainStatus: 'none',
    entitlementReason: 'flag_off',
    entitled: true,
    subscriptionUnchecked: false,
    listingCount: 0,
    operatingMarketCode: 'mx',
    operatingMarketLabel: 'México',
    marketplacePublicationLabel: 'Publicada',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    registrationEmail: 'a@example.com', planLegacy: 'absent', pausedForPlan: false,
    ...overrides,
  }
}

test.describe('filtering', () => {
  test('no filter returns everything', () => {
    const rows = [row({ shopId: 'a' }), row({ shopId: 'b' })]
    expect(selectTenants(rows)).toHaveLength(2)
  })

  test('absent and unavailable are DISTINCT, never collapsed', () => {
    // An orphaned mirror row (Medusa has no such seller) is a repair job; an
    // unreachable backend is a retry. Collapsing them, as the first revision did,
    // hid the orphan inside a glitch nobody would go fix.
    const rows = [row({ shopId: 'orphan', status: 'absent' }), row({ shopId: 'glitch', status: 'unavailable' })]
    expect(selectTenants(rows, { status: 'absent' }).map((r) => r.shopId)).toEqual(['orphan'])
    expect(selectTenants(rows, { status: 'unavailable' }).map((r) => r.shopId)).toEqual(['glitch'])
    expect(selectTenants(rows, {}).map((r) => r.shopId).sort()).toEqual(['glitch', 'orphan'])
  })

  test('by status', () => {
    const rows = [row({ shopId: 'a', status: 'active' }), row({ shopId: 'b', status: 'paused' })]
    expect(selectTenants(rows, { status: 'paused' }).map((r) => r.shopId)).toEqual(['b'])
  })

  test('by claimed / unclaimed', () => {
    const rows = [row({ shopId: 'a', claimed: true }), row({ shopId: 'b', claimed: false })]
    expect(selectTenants(rows, { claimed: 'unclaimed' }).map((r) => r.shopId)).toEqual(['b'])
    expect(selectTenants(rows, { claimed: 'claimed' }).map((r) => r.shopId)).toEqual(['a'])
  })

  test('by market, with an unresolved market matchable as `unknown`', () => {
    // A shop whose market could not be resolved is exactly the kind an operator wants
    // to find, so it must be selectable rather than only excluded.
    const rows = [row({ shopId: 'a', operatingMarketCode: 'mx' }), row({ shopId: 'b', operatingMarketCode: null })]
    expect(selectTenants(rows, { market: 'unknown' }).map((r) => r.shopId)).toEqual(['b'])
    expect(selectTenants(rows, { market: 'mx' }).map((r) => r.shopId)).toEqual(['a'])
  })

  test('by domain state and entitlement', () => {
    const rows = [
      row({ shopId: 'a', domainStatus: 'verified', entitled: true }),
      row({ shopId: 'b', domainStatus: 'pending', entitled: false }),
    ]
    expect(selectTenants(rows, { domain: 'pending' }).map((r) => r.shopId)).toEqual(['b'])
    expect(selectTenants(rows, { entitlement: 'not_entitled' }).map((r) => r.shopId)).toEqual(['b'])
  })

  test('free text matches name, slug, domain, seller id AND the registration email', () => {
    const rows = [
      row({ shopId: 'a', name: 'Bazar', slug: 'bazar', registrationEmail: 'ana@example.com' }),
      row({ shopId: 'b', name: 'Otro', slug: 'otro', registrationEmail: 'beto@example.com' }),
    ]
    // Finding a shop from an inbox is the realistic operator path.
    expect(selectTenants(rows, { q: 'ana@' }).map((r) => r.shopId)).toEqual(['a'])
    expect(selectTenants(rows, { q: 'BAZAR' }).map((r) => r.shopId)).toEqual(['a'])
  })

  test('the `unavailable` email sentinel is NOT searchable text', () => {
    // Otherwise searching "unavailable" would return every shop Clerk could not be
    // reached for, as though that were their address.
    const rows = [row({ shopId: 'a', registrationEmail: 'unavailable' })]
    expect(selectTenants(rows, { q: 'unavailable' })).toHaveLength(0)
  })

  test('filters compose', () => {
    const rows = [
      row({ shopId: 'a', status: 'paused', claimed: true }),
      row({ shopId: 'b', status: 'paused', claimed: false }),
      row({ shopId: 'c', status: 'active', claimed: false }),
    ]
    expect(selectTenants(rows, { status: 'paused', claimed: 'unclaimed' }).map((r) => r.shopId))
      .toEqual(['b'])
  })
})

test.describe('sorting', () => {
  test('by listing count, both directions', () => {
    const rows = [row({ shopId: 'a', listingCount: 2 }), row({ shopId: 'b', listingCount: 9 })]
    expect(selectTenants(rows, {}, { key: 'listings', direction: 'desc' }).map((r) => r.shopId))
      .toEqual(['b', 'a'])
    expect(selectTenants(rows, {}, { key: 'listings', direction: 'asc' }).map((r) => r.shopId))
      .toEqual(['a', 'b'])
  })

  test('by status puts the ones needing attention first', () => {
    const rows = [
      row({ shopId: 'active', status: 'active' }),
      row({ shopId: 'paused', status: 'paused' }),
      row({ shopId: 'deleted', status: 'deleted' }),
    ]
    expect(selectTenants(rows, {}, { key: 'status', direction: 'asc' }).map((r) => r.shopId))
      .toEqual(['paused', 'deleted', 'active'])
  })

  test('is STABLE — equal keys keep a deterministic order', () => {
    // An order that changes when nothing changed makes an operator distrust the
    // screen. Ties break by name, always.
    const rows = [
      row({ shopId: 'z', name: 'Zeta', listingCount: 5 }),
      row({ shopId: 'a', name: 'Alfa', listingCount: 5 }),
    ]
    const once = selectTenants(rows, {}, { key: 'listings', direction: 'desc' }).map((r) => r.shopId)
    const twice = selectTenants(rows, {}, { key: 'listings', direction: 'desc' }).map((r) => r.shopId)
    expect(once).toEqual(['a', 'z'])
    expect(once).toEqual(twice)
  })

  test('a missing createdAt sorts as oldest rather than corrupting the order', () => {
    const rows = [row({ shopId: 'dated', createdAt: '2026-05-01T00:00:00.000Z' }), row({ shopId: 'undated', createdAt: null })]
    expect(selectTenants(rows, {}, { key: 'created', direction: 'asc' }).map((r) => r.shopId))
      .toEqual(['undated', 'dated'])
  })

  test('sorting runs over the WHOLE set, not a page', () => {
    // The screen loads every shop. Sorting a page would sort the wrong thing — the
    // top of a name-ordered page is not the shop with the most listings.
    const rows = Array.from({ length: 50 }, (_, i) =>
      row({ shopId: `s${i}`, name: `Shop ${String(i).padStart(2, '0')}`, listingCount: i }),
    )
    const top = selectTenants(rows, {}, { key: 'listings', direction: 'desc' })[0]
    expect(top.listingCount).toBe(49)
  })

  test('does not mutate its input', () => {
    const rows = [row({ shopId: 'b', name: 'B' }), row({ shopId: 'a', name: 'A' })]
    selectTenants(rows, {}, { key: 'name', direction: 'asc' })
    expect(rows.map((r) => r.shopId)).toEqual(['b', 'a'])
  })
})
