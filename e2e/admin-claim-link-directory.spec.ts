import { test, expect } from '@playwright/test'
import { claimLinkAvailability, claimLinkPreviewUrl, claimLinkRegistrationEmail, selectClaimLinkShops } from '../lib/admin/claim-link-directory'
import type { TenantRow } from '../lib/admin/tenant-directory'
import { claimLinksCsv } from '../lib/admin/claim-link-csv'
import { publicClaimLinkEmail } from '../lib/admin/claim-link-public-emails'
import { prepareClaimLinkBatch } from '../lib/admin/claim-link-bulk'

const base: TenantRow = {
  medusaSellerId: 'sel_1', shopId: 'shop_1', slug: 'terrumaco', name: 'Terrumaco',
  claimed: false, publicSellerClaimed: false, publicSellerId: 'sel_1', publicSellerVerified: true,
  customDomain: null, domainStatus: 'none',
  entitlementReason: 'flag_off', entitled: true, subscriptionUnchecked: false,
  listingCount: 5, operatingMarketCode: 'mx', operatingMarketLabel: 'México',
  marketplacePublicationLabel: 'Publicada', createdAt: '2026-01-01T00:00:00.000Z',
  status: 'active', registrationEmail: null, planLegacy: 'absent', pausedForPlan: false,
}

test('an active unclaimed seller with a market is ready even before shop verification', () => {
  expect(claimLinkAvailability(base)).toEqual({ ready: true })
  expect(claimLinkAvailability({ ...base, publicSellerVerified: false })).toEqual({ ready: true })
  expect(claimLinkAvailability({ ...base, publicSellerVerified: null })).toEqual({ ready: true })
  for (const patch of [
    { publicSellerClaimed: true }, { publicSellerClaimed: null }, { medusaSellerId: null },
    { publicSellerId: 'sel_other' }, { slug: '' }, { status: 'paused' },
    { operatingMarketCode: null },
  ] as Partial<TenantRow>[]) {
    expect(claimLinkAvailability({ ...base, ...patch }).ready).toBe(false)
  }
})

test('a held or unreadable merchant preview never produces a public shop link', () => {
  expect(claimLinkPreviewUrl('mx', 'terrumaco', false)).toBeNull()
  expect(claimLinkPreviewUrl('mx', 'terrumaco', null, 'https://miyagisanchez.com')).toBeNull()
  expect(claimLinkPreviewUrl('mx', 'terrumaco', true)).toBe('/mx/s/terrumaco')
  expect(claimLinkPreviewUrl('mx', 'terrumaco', true, 'https://miyagisanchez.com'))
    .toBe('https://miyagisanchez.com/mx/s/terrumaco')
})

test('unclaimed view includes unavailable shops, ready view narrows them, all view shows claimed', () => {
  const rows = [
    base,
    { ...base, shopId: 'shop_2', slug: 'unverified', name: 'Unverified', publicSellerVerified: false },
    { ...base, shopId: 'shop_3', slug: 'claimed', name: 'Claimed', publicSellerClaimed: true },
  ]
  const sort = { key: 'name' as const, direction: 'asc' as const }
  expect(selectClaimLinkShops(rows, 'unclaimed', {}, sort).map(row => row.shopId)).toEqual(['shop_1', 'shop_2'])
  expect(selectClaimLinkShops(rows, 'ready', {}, sort).map(row => row.shopId)).toEqual(['shop_1', 'shop_2'])
  expect(selectClaimLinkShops(rows, 'all', {}, sort)).toHaveLength(3)
  expect(selectClaimLinkShops(rows, 'all', { q: 'terrumaco' }, sort)).toHaveLength(1)
})

test('a stale mirror cannot make a claimed Medusa seller look ready', () => {
  const staleMirror = { ...base, claimed: false, publicSellerClaimed: true }
  expect(claimLinkAvailability(staleMirror)).toEqual({ ready: false, reason: 'Ya reclamada' })
  expect(selectClaimLinkShops([staleMirror], 'unclaimed', {}, { key: 'name', direction: 'asc' })).toEqual([])
})

test('a slug resolving to another seller is flagged for repair', () => {
  expect(claimLinkAvailability({ ...base, publicSellerId: 'sel_other' }))
    .toEqual({ ready: false, reason: 'Identidad de vendedor inconsistente' })
})

test('a stale mirror email is never shown for an unclaimed or unreadable Medusa seller', () => {
  const oldEmail = { ...base, claimed: true, registrationEmail: 'old-owner@example.com' }
  expect(claimLinkRegistrationEmail(oldEmail)).toBe('Sin reclamar')
  expect(claimLinkRegistrationEmail({ ...oldEmail, publicSellerClaimed: null })).toBe('No disponible')
  expect(claimLinkRegistrationEmail({ ...oldEmail, publicSellerClaimed: true })).toBe('old-owner@example.com')
})

test('bulk CSV has the four requested columns and protects imported spreadsheet values', () => {
  const csv = claimLinksCsv([
    { shopName: 'Tienda, "Uno"', email: 'merchant@example.com', previewUrl: 'https://miyagisanchez.com/mx/s/uno', claimUrl: 'https://miyagisanchez.com/claim?t=one' },
    { shopName: '=IMPORTRANGE(1)', email: '', previewUrl: null, claimUrl: 'https://miyagisanchez.com/claim?t=two' },
  ])
  expect(csv).toBe('\uFEFF"Name","Email","Link1","Link2"\r\n'
    + '"Tienda, ""Uno""","merchant@example.com","https://miyagisanchez.com/mx/s/uno","https://miyagisanchez.com/claim?t=one"\r\n'
    + '"\'=IMPORTRANGE(1)","","","https://miyagisanchez.com/claim?t=two"\r\n')
})

test('researched public email belongs to the canonical seller ID, not a matching shop name', () => {
  expect(publicClaimLinkEmail('sel_01M0HCS0RXRCEW5ZNXY7GV2HEB')).toBe('info@curatedbasics.com')
  expect(publicClaimLinkEmail('sel_01M0GJY4G6R9ARRXNDGN1VPQ4H')).toBe('') // retired lookalike preview
  expect(publicClaimLinkEmail('sel_unknown')).toBe('')
})

test('bulk preparation keeps successful shops in order and reports a stale seller separately', async () => {
  const shops = ['first', 'stale', 'last'].map((shopSlug) => ({ shopSlug, market: 'mx' as const }))
  const batch = await prepareClaimLinkBatch(shops, async (shop) => {
    if (shop.shopSlug === 'stale') throw new Error('Already claimed')
    return { shopSlug: shop.shopSlug, claimUrl: `https://miyagisanchez.com/claim?shop=${shop.shopSlug}` }
  }, (error) => error instanceof Error ? error.message : 'Unknown')
  expect(batch).toEqual({
    results: [
      { shopSlug: 'first', claimUrl: 'https://miyagisanchez.com/claim?shop=first' },
      { shopSlug: 'last', claimUrl: 'https://miyagisanchez.com/claim?shop=last' },
    ],
    failures: [{ shopSlug: 'stale', market: 'mx', error: 'Already claimed' }],
  })
})
