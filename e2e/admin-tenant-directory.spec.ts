import { test, expect } from '@playwright/test'
import {
  shapeTenantRow,
  readAllPages,
  mapWithConcurrency,
  filterTenants,
  medusaSellerIdOf,
  entitlementReasonLabel,
  claimStatusLabel,
  domainStatusLabel,
  type RawTenantRow,
  type TenantRow,
} from '../lib/admin/tenant-directory'

/**
 * Admin tenant directory — pure read-model shaper (api gate, no browser). The
 * directory page and this spec share `shapeTenantRow`/`filterTenants`, so the
 * claim/entitlement/domain derivation is covered for free and can't drift.
 */

const base: RawTenantRow = {
  id: 'shop_uuid_1',
  slug: 'la-tienda',
  name: 'La Tienda',
  clerk_user_id: 'user_abc',
  custom_domain: null,
  custom_domain_verified: false,
  metadata: { medusa_seller_id: 'sel_123' },
  created_at: '2026-01-01T00:00:00.000Z',
}

test.describe('admin tenant-directory · complete mirror reads', () => {
  test('walks every page, including an exact multiple of the page size', async () => {
    const ranges: Array<[number, number]> = []
    const read = await readAllPages(2, async (from, to) => {
      ranges.push([from, to])
      return { data: [0, 1, 2, 3].slice(from, to + 1), error: null }
    })
    expect(read).toEqual({ state: 'resolved', rows: [0, 1, 2, 3] })
    expect(ranges).toEqual([[0, 1], [2, 3], [4, 5]])
  })

  test('marks the entire read unavailable when a later page fails', async () => {
    const read = await readAllPages(2, async (from) => from === 0
      ? { data: [0, 1], error: null }
      : { data: null, error: { message: 'database unavailable' } })
    expect(read).toEqual({ state: 'unavailable', reason: 'database unavailable' })
  })
})

test.describe('admin tenant-directory · shapeTenantRow', () => {
  test('the plan marks: the legacy marker in three states and the pause job\'s claim (plan-tienda S3)', () => {
    const shape = (metadata: unknown) => shapeTenantRow({ ...base, metadata }, { paywallEnabled: false, listingCount: 0 })
    expect(shape({})).toMatchObject({ planLegacy: 'absent', pausedForPlan: false })
    expect(shape({ plan_legacy: { marked_at: '2026-11-12T00:00:00Z' } }).planLegacy).toBe('marked')
    expect(shape({ plan_legacy: 'x' }).planLegacy).toBe('unreadable')
    expect(shape({ plan_pause: { paused_at: '2027-02-09T00:00:00Z' } }).pausedForPlan).toBe(true)
    expect(shape({ plan_pause: null }).pausedForPlan).toBe(false)
  })
  test('canonical Medusa ownership overrides stale mirror claim state', () => {
    const row = shapeTenantRow(base, {
      paywallEnabled: false, listingCount: 0,
      publicSellerClaimed: false, publicSellerId: 'sel_123',
      registrationEmail: null,
    })
    expect(row.claimed).toBe(false)
    expect(row.registrationEmail).toBeNull()
  })
  test('bounds authoritative public-seller reads while preserving directory order', async () => {
    let active = 0
    let peak = 0
    const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      return value * 10
    })

    expect(peak).toBe(2)
    expect(result).toEqual([10, 20, 30, 40, 50])
  })

  test('surfaces the canonical Medusa seller id as identity', () => {
    const row = shapeTenantRow(base, { paywallEnabled: false, listingCount: 3 })
    expect(row.medusaSellerId).toBe('sel_123')
    expect(row.shopId).toBe('shop_uuid_1')
    expect(row.listingCount).toBe(3)
    expect(row.operatingMarketCode).toBeNull()
    expect(row.marketplacePublicationLabel).toBe('Estado de marketplace no disponible')
  })

  test('uses the public Medusa seller projection for market labels, never mirror metadata', () => {
    const row = shapeTenantRow(
      { ...base, metadata: { medusa_seller_id: 'sel_123', operating_market: 'us' } },
      {
        paywallEnabled: false,
        listingCount: 0,
        publicSellerMarket: {
          market_code: 'mx',
          country_code: 'mx',
          currency_code: 'mxn',
          marketplace_status: 'active',
          market: { code: 'mx', country_code: 'mx', currency_code: 'mxn', default_locale: 'es-MX', timezone: 'America/Mexico_City', marketplace_status: 'active' },
        },
      },
    )
    expect(row.operatingMarketCode).toBe('mx')
    expect(row.marketplacePublicationLabel).toBe('Marketplace MX')
  })

  test('flags an un-imported gem (no medusa_seller_id) with null identity', () => {
    const row = shapeTenantRow({ ...base, metadata: { source: 'scraped' } }, { paywallEnabled: false, listingCount: 0 })
    expect(row.medusaSellerId).toBeNull()
  })

  test('claim: real owner → claimed; null and pending: → not claimed', () => {
    expect(shapeTenantRow(base, { paywallEnabled: false, listingCount: 0 }).claimed).toBe(true)
    expect(shapeTenantRow({ ...base, clerk_user_id: null }, { paywallEnabled: false, listingCount: 0 }).claimed).toBe(false)
    expect(shapeTenantRow({ ...base, clerk_user_id: 'pending:tok' }, { paywallEnabled: false, listingCount: 0 }).claimed).toBe(false)
  })

  test('domain status: none / pending (set, unverified) / verified', () => {
    expect(shapeTenantRow(base, { paywallEnabled: false, listingCount: 0 }).domainStatus).toBe('none')
    expect(shapeTenantRow({ ...base, custom_domain: 'shop.mx' }, { paywallEnabled: false, listingCount: 0 }).domainStatus).toBe('pending')
    expect(shapeTenantRow({ ...base, custom_domain: 'shop.mx', custom_domain_verified: true }, { paywallEnabled: false, listingCount: 0 }).domainStatus).toBe('verified')
  })

  test('entitlement: flag off → flag_off & entitled, regardless of grant', () => {
    const row = shapeTenantRow(base, { paywallEnabled: false, listingCount: 0 })
    expect(row.entitlementReason).toBe('flag_off')
    expect(row.entitled).toBe(true)
  })

  test('entitlement: paywall on, no grant → none & not entitled, flagged subscription-unchecked', () => {
    const row = shapeTenantRow(base, { paywallEnabled: true, listingCount: 0 })
    expect(row.entitlementReason).toBe('none')
    expect(row.entitled).toBe(false)
    // List skips the per-seller subscription lookup, so 'none' is only indicative here.
    expect(row.subscriptionUnchecked).toBe(true)
  })

  test('subscriptionUnchecked is false when paywall off, or when a grant entitles', () => {
    expect(shapeTenantRow(base, { paywallEnabled: false, listingCount: 0 }).subscriptionUnchecked).toBe(false)
    const comp = shapeTenantRow(
      { ...base, metadata: { custom_domain_grant: { type: 'comp', granted_at: '2026-01-01T00:00:00Z' } } },
      { paywallEnabled: true, listingCount: 0 },
    )
    expect(comp.subscriptionUnchecked).toBe(false)
  })

  test('entitlement: paywall on, comp grant → comp & entitled', () => {
    const row = shapeTenantRow(
      { ...base, metadata: { medusa_seller_id: 'sel_1', custom_domain_grant: { type: 'comp', granted_at: '2026-01-01T00:00:00Z' } } },
      { paywallEnabled: true, listingCount: 0 },
    )
    expect(row.entitlementReason).toBe('comp')
    expect(row.entitled).toBe(true)
  })

  test('entitlement: paywall on, grandfather grant → grandfathered & entitled', () => {
    const row = shapeTenantRow(
      { ...base, metadata: { custom_domain_grant: { type: 'grandfather', granted_at: '2026-01-01T00:00:00Z' } } },
      { paywallEnabled: true, listingCount: 0 },
    )
    expect(row.entitlementReason).toBe('grandfathered')
  })

  test('name falls back to slug then a placeholder; listing count is clamped', () => {
    expect(shapeTenantRow({ ...base, name: '  ' }, { paywallEnabled: false, listingCount: 5 }).name).toBe('la-tienda')
    expect(shapeTenantRow({ ...base, name: '', slug: '' }, { paywallEnabled: false, listingCount: 0 }).name).toBe('(sin nombre)')
    expect(shapeTenantRow(base, { paywallEnabled: false, listingCount: -4 }).listingCount).toBe(0)
  })
})

test.describe('admin tenant-directory · medusaSellerIdOf', () => {
  test('reads a string id, ignores empties / non-objects', () => {
    expect(medusaSellerIdOf({ medusa_seller_id: 'sel_9' })).toBe('sel_9')
    expect(medusaSellerIdOf({ medusa_seller_id: '' })).toBeNull()
    expect(medusaSellerIdOf(null)).toBeNull()
    expect(medusaSellerIdOf('nope')).toBeNull()
  })
})

test.describe('admin tenant-directory · filterTenants', () => {
  const rows: TenantRow[] = [
    shapeTenantRow({ ...base, id: 's1', slug: 'cafe-luna', name: 'Café Luna', custom_domain: 'cafeluna.mx', metadata: { medusa_seller_id: 'sel_aaa' } }, { paywallEnabled: false, listingCount: 1 }),
    shapeTenantRow({ ...base, id: 's2', slug: 'tacos-rex', name: 'Tacos Rex', metadata: { medusa_seller_id: 'sel_bbb' } }, { paywallEnabled: false, listingCount: 2 }),
  ]

  test('empty query returns all rows', () => {
    expect(filterTenants(rows, '')).toHaveLength(2)
    expect(filterTenants(rows, '   ')).toHaveLength(2)
  })

  test('matches by name (case-insensitive)', () => {
    expect(filterTenants(rows, 'café').map(r => r.slug)).toEqual(['cafe-luna'])
    expect(filterTenants(rows, 'TACOS').map(r => r.slug)).toEqual(['tacos-rex'])
  })

  test('matches by slug, domain, and Medusa seller id', () => {
    expect(filterTenants(rows, 'rex').map(r => r.slug)).toEqual(['tacos-rex'])
    expect(filterTenants(rows, 'cafeluna.mx').map(r => r.slug)).toEqual(['cafe-luna'])
    expect(filterTenants(rows, 'sel_bbb').map(r => r.slug)).toEqual(['tacos-rex'])
  })

  test('no match returns empty', () => {
    expect(filterTenants(rows, 'zzz-nada')).toHaveLength(0)
  })
})

test.describe('admin tenant-directory · es-MX labels', () => {
  test('entitlement reason labels are Spanish and total', () => {
    for (const reason of ['flag_off', 'grandfathered', 'comp', 'subscription', 'none'] as const) {
      expect(entitlementReasonLabel(reason).length).toBeGreaterThan(0)
    }
  })
  test('claim + domain labels', () => {
    expect(claimStatusLabel(true)).toBe('Reclamada')
    expect(claimStatusLabel(false)).toBe('Sin reclamar')
    expect(domainStatusLabel('verified')).toBe('Verificado')
    expect(domainStatusLabel('none')).toBe('Sin dominio')
  })
})
