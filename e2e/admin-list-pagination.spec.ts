import { expect, test } from '@playwright/test'
import { ADMIN_LIST_FIRST_PAGE, paginate } from '../lib/admin-pagination'
import { selectTenants, type TenantRow } from '../lib/admin/tenant-directory'
import { COMMUNICATION_CATALOG, filterCommunications } from '../lib/notifications/catalog'

function tenant(index: number, overrides: Partial<TenantRow> = {}): TenantRow {
  return {
    medusaSellerId: `sel_${index}`,
    shopId: `shop_${index}`,
    slug: `tienda-${index}`,
    name: `Tienda ${String(index).padStart(2, '0')}`,
    claimed: true,
    publicSellerClaimed: true,
    publicSellerId: `sel_${index}`,
    publicSellerVerified: true,
    customDomain: null,
    domainStatus: 'none',
    entitlementReason: 'flag_off',
    entitled: true,
    subscriptionUnchecked: false,
    listingCount: index,
    operatingMarketCode: 'mx',
    operatingMarketLabel: 'México',
    marketplacePublicationLabel: 'Publicada',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    registrationEmail: `shop-${index}@example.com`, planLegacy: 'absent', pausedForPlan: false,
    ...overrides,
  }
}

test.describe('admin list pagination', () => {
  test('slices a filtered tenant set completely and without overlapping rows', () => {
    const filtered = selectTenants(Array.from({ length: 53 }, (_, index) => tenant(index)), { q: 'tienda' })
    const firstPage = paginate(filtered, 1, 25)
    const served = Array.from({ length: firstPage.totalPages }, (_, index) => paginate(filtered, index + 1, 25).pageItems)
    const servedIds = served.flatMap((rows) => rows.map((row) => row.shopId))

    expect(servedIds).toEqual(filtered.map((row) => row.shopId))
    expect(new Set(servedIds).size).toBe(filtered.length)
  })

  test('clamps a page beyond a filtered communications result instead of serving an empty page', () => {
    const filtered = filterCommunications(COMMUNICATION_CATALOG, { to: 'seller' })
    const result = paginate(filtered, 99, 25)

    expect(result.page).toBe(result.totalPages)
    expect(result.pageItems).not.toEqual([])
  })

  test('narrowing a filter while on a later page never shows an empty list', () => {
    // The property, not the helper. A user on page 3 of every tenant who then
    // filters down to 4 paused shops must see those four — asserted against the
    // real selector + paginate composition, so it stays true no matter how the
    // components choose to reset.
    const rows = Array.from({ length: 80 }, (_, index) => tenant(index, { status: index < 4 ? 'paused' : 'active' }))
    const filtered = selectTenants(rows, { status: 'paused' })
    expect(filtered).toHaveLength(4)

    const afterReset = paginate(filtered, ADMIN_LIST_FIRST_PAGE, 25)
    expect(afterReset.page).toBe(1)
    expect(afterReset.pageItems).toHaveLength(4)
  })

  test('and even if a caller FORGOT to reset, the clamp still shows rows', () => {
    // Defence in depth, stated on purpose. The components reset to page 1 on a
    // filter change; `paginate` clamps independently. A missed reset at one call
    // site must degrade to "shows the last page", never to "shows nothing" —
    // this is what keeps a future call site from shipping a blank admin list.
    const rows = Array.from({ length: 80 }, (_, index) => tenant(index, { status: index < 4 ? 'paused' : 'active' }))
    const filtered = selectTenants(rows, { status: 'paused' })

    const staleThirdPage = paginate(filtered, 3, 25)
    expect(staleThirdPage.page).toBe(1)
    expect(staleThirdPage.pageItems).toHaveLength(4)
  })
})
