import { test, expect } from '@playwright/test'
import {
  deriveDomainEntitlement,
  readDomainGrant,
  type DomainGrant,
} from '../lib/domain-entitlement'
import {
  CAMPAIGN_COUPON_CODE,
  CAMPAIGN_COUPON_CAP,
  isCampaignCode,
  normalizeCouponCode,
  couponRedeemable,
  couponRefusalReason,
  formatRedemptionCount,
} from '../lib/domain-coupon'

/**
 * Custom-domain paywall · Sprint 1 (Gate + entitlement).
 *
 * Two layers, mirroring the established pattern (pure seam + auth boundary):
 *
 *  1. PURE SEAM — deriveDomainEntitlement / readDomainGrant unit-tested directly.
 *     This is the whole decision logic for "may this shop connect a domain?" and
 *     proves every branch (flag off / grandfather / comp / subscription / none)
 *     without auth or network.
 *
 *  2. AUTH BOUNDARY — the gated connect/provision routes still reject anonymous
 *     callers (401), confirming the paywall change didn't break the pre-existing
 *     auth check that precedes it.
 *
 * NOT covered here (owed to Daniel — sprint-1.md smoke walkthrough): the live
 * 402 path. Golden decides domain.paywall_enabled (served ON in production; compile
 * default OFF). Exercising the 402 + the rendered upsell needs a real Clerk seller session.
 */

const GRANDFATHER: DomainGrant = { type: 'grandfather', granted_at: '2026-01-01T00:00:00.000Z', note: 'cutover' }
const COMP: DomainGrant = { type: 'comp', granted_at: '2026-06-10T00:00:00.000Z', note: 'WC26 partner' }

test.describe('domain-entitlement · deriveDomainEntitlement', () => {
  test('flag off ⇒ everyone entitled (today’s free behavior)', () => {
    expect(deriveDomainEntitlement({ paywallEnabled: false, grant: null })).toEqual({
      entitled: true, reason: 'flag_off',
    })
    // flag off wins even with no grant and no subscription
    expect(deriveDomainEntitlement({ paywallEnabled: false, grant: null, hasActiveSubscription: false }).entitled).toBe(true)
  })

  test('flag on + grandfather grant ⇒ entitled', () => {
    expect(deriveDomainEntitlement({ paywallEnabled: true, grant: GRANDFATHER })).toEqual({
      entitled: true, reason: 'grandfathered',
    })
  })

  test('flag on + comp grant ⇒ entitled', () => {
    expect(deriveDomainEntitlement({ paywallEnabled: true, grant: COMP })).toEqual({
      entitled: true, reason: 'comp',
    })
  })

  test('flag on + active subscription (S2 hook) ⇒ entitled', () => {
    expect(deriveDomainEntitlement({ paywallEnabled: true, grant: null, hasActiveSubscription: true })).toEqual({
      entitled: true, reason: 'subscription',
    })
  })

  test('flag on + no grant + no subscription ⇒ NOT entitled', () => {
    expect(deriveDomainEntitlement({ paywallEnabled: true, grant: null })).toEqual({
      entitled: false, reason: 'none',
    })
    expect(deriveDomainEntitlement({ paywallEnabled: true, grant: null, hasActiveSubscription: false }).entitled).toBe(false)
  })

  test('precedence: a grant is honored over an absent subscription', () => {
    expect(deriveDomainEntitlement({ paywallEnabled: true, grant: GRANDFATHER, hasActiveSubscription: false }).reason)
      .toBe('grandfathered')
  })
})

test.describe('domain-entitlement · readDomainGrant', () => {
  test('parses a valid grandfather grant off metadata', () => {
    expect(readDomainGrant({ custom_domain_grant: GRANDFATHER })).toEqual(GRANDFATHER)
  })

  test('parses a valid comp grant (note optional)', () => {
    const noNote = { type: 'comp', granted_at: '2026-06-10T00:00:00.000Z' }
    expect(readDomainGrant({ custom_domain_grant: noNote })).toEqual(noNote)
  })

  test('returns null for missing / empty metadata', () => {
    expect(readDomainGrant(null)).toBeNull()
    expect(readDomainGrant(undefined)).toBeNull()
    expect(readDomainGrant({})).toBeNull()
    expect(readDomainGrant({ settings: {} })).toBeNull()
  })

  test('returns null for malformed grants (bad type, missing granted_at)', () => {
    expect(readDomainGrant({ custom_domain_grant: { type: 'bogus', granted_at: '2026-01-01' } })).toBeNull()
    expect(readDomainGrant({ custom_domain_grant: { type: 'grandfather' } })).toBeNull()
    expect(readDomainGrant({ custom_domain_grant: { type: 'grandfather', granted_at: '' } })).toBeNull()
    expect(readDomainGrant({ custom_domain_grant: 'grandfather' })).toBeNull()
  })

  test('a malformed grant + flag on ⇒ NOT entitled (corrupt value never grants)', () => {
    const grant = readDomainGrant({ custom_domain_grant: { type: 'bogus' } })
    expect(deriveDomainEntitlement({ paywallEnabled: true, grant }).entitled).toBe(false)
  })
})

test.describe('domain connect/provision routes · auth boundary', () => {
  test('POST /api/sell/shop/domain rejects anonymous', async ({ request }) => {
    const res = await request.post('/api/sell/shop/domain', { data: { domain: 'paywall-smoke.example' } })
    expect(res.status()).toBe(401)
  })

  test('DELETE /api/sell/shop/domain rejects anonymous', async ({ request }) => {
    const res = await request.delete('/api/sell/shop/domain')
    expect(res.status()).toBe(401)
  })

  test('POST /api/sell/shop/domain/cloudflare rejects anonymous', async ({ request }) => {
    const res = await request.post('/api/sell/shop/domain/cloudflare', { data: { cf_token: 'x' } })
    expect(res.status()).toBe(401)
  })

  test('GET /api/sell/shop/domain/cloudflare/oauth/start rejects anonymous', async ({ request }) => {
    const res = await request.get('/api/sell/shop/domain/cloudflare/oauth/start', { maxRedirects: 0 })
    expect(res.status()).toBe(401)
  })

  // The standalone domain purchase is retired: the custom domain is part of the Negocio plan. The route answers 410 to
  // everyone (no checkout can start), so the purchase is retired (plans-gratis-negocio S2/S3): 410 for everyone, before any auth.
  test('POST /api/sell/shop/domain/subscribe is retired (410)', async ({ request }) => {
    const res = await request.post('/api/sell/shop/domain/subscribe')
    expect(res.status()).toBe(410)
  })
})

/**
 * Sprint 2 — the lapse contract expressed through the pure deriver. The webhook
 * flips the Medusa subscription status; entitlement is derived from whether an
 * active subscription remains. So "active ⇒ entitled, lapsed ⇒ not entitled
 * (flag on, no grant)" is exactly the deriver's subscription/none branches.
 */
test.describe('domain-entitlement · S2 subscription lifecycle', () => {
  test('paid + active ⇒ entitled; lapsed (no active sub) + flag on ⇒ NOT entitled', () => {
    // bought + active → hasActiveSubscription true
    expect(deriveDomainEntitlement({ paywallEnabled: true, grant: null, hasActiveSubscription: true }).entitled).toBe(true)
    // canceled lapse → hasActiveSubscription false → reverts to free addressing (gated)
    expect(deriveDomainEntitlement({ paywallEnabled: true, grant: null, hasActiveSubscription: false })).toEqual({
      entitled: false, reason: 'none',
    })
  })

  test('a grandfathered shop survives a lapse (grant outranks subscription)', () => {
    expect(deriveDomainEntitlement({ paywallEnabled: true, grant: GRANDFATHER, hasActiveSubscription: false }).entitled).toBe(true)
  })
})

/**
 * Sprint 3 — campaign coupon `miyagisan` (100% off year 1, capped at 100) + the
 * agent (UCP/MCP) surface for the domain SKU.
 *
 * Layer 1 (PURE): the cap-of-100 decision logic in lib/domain-coupon.ts —
 *   matching, the redeemable boundary (99 ok / 100 refused / 101 refused), and
 *   the display counter — unit-tested directly, no Stripe, no network. This is
 *   the authoritative-cap mirror of Stripe's own max_redemptions rule.
 * Layer 2 (DISCOVERY/AUTH): the MCP server lists the two new shop-scoped tools,
 *   an unauthenticated tools/call is refused (Unauthorized), the manifest
 *   advertises the new capability, and the admin coupon route is secret-gated.
 *
 * NOT covered here (owed to Daniel — sprint-3.md smoke): the live coupon
 * redemption ($0 first-year subscription → connect domain), the admin counter
 * moving, and the no-card year-end lapse — all need real Stripe events + a Clerk
 * seller session. The new MCP/manifest/admin assertions are CI-vs-preview
 * authoritative (these routes return the OLD shape on prod until this deploys).
 */
test.describe('domain-coupon · campaign code matching', () => {
  test('isCampaignCode matches miyagisan, trims + lowercases', () => {
    expect(isCampaignCode('miyagisan')).toBe(true)
    expect(isCampaignCode('  MIYAGISAN  ')).toBe(true)
    expect(isCampaignCode('MiYaGiSaN')).toBe(true)
    expect(isCampaignCode('otro')).toBe(false)
    expect(isCampaignCode('')).toBe(false)
    expect(isCampaignCode(null)).toBe(false)
    expect(isCampaignCode(undefined)).toBe(false)
    expect(normalizeCouponCode(' MIYAGISAN ')).toBe(CAMPAIGN_COUPON_CODE)
  })
})

test.describe('domain-coupon · cap-of-100 boundary', () => {
  const cap = CAMPAIGN_COUPON_CAP // 100

  test('redeemable up to but not including the cap (99 ok, 100 refused, 101 refused)', () => {
    expect(couponRedeemable({ active: true, timesRedeemed: 0, maxRedemptions: cap })).toBe(true)
    expect(couponRedeemable({ active: true, timesRedeemed: 99, maxRedemptions: cap })).toBe(true)
    // the 100th redemption has happened ⇒ the 101st is refused
    expect(couponRedeemable({ active: true, timesRedeemed: 100, maxRedemptions: cap })).toBe(false)
    expect(couponRedeemable({ active: true, timesRedeemed: 101, maxRedemptions: cap })).toBe(false)
  })

  test('an inactive coupon is never redeemable, even below the cap', () => {
    expect(couponRedeemable({ active: false, timesRedeemed: 0, maxRedemptions: cap })).toBe(false)
  })

  test('couponRefusalReason: unknown code, exhausted, or null (proceed)', () => {
    const live = { active: true, timesRedeemed: 0, maxRedemptions: cap }
    const full = { active: true, timesRedeemed: cap, maxRedemptions: cap }
    expect(couponRefusalReason('otro', live)).toBe('unknown')
    expect(couponRefusalReason('miyagisan', live)).toBeNull()
    // the 101st: campaign code but exhausted
    expect(couponRefusalReason('miyagisan', full)).toBe('exhausted')
    expect(couponRefusalReason('miyagisan', { active: false, timesRedeemed: 0, maxRedemptions: cap })).toBe('exhausted')
  })

  test('formatRedemptionCount renders the n/cap counter', () => {
    expect(formatRedemptionCount(0, cap)).toBe('0/100')
    expect(formatRedemptionCount(7, cap)).toBe('7/100')
    expect(formatRedemptionCount(100, cap)).toBe('100/100')
    expect(formatRedemptionCount(0)).toBe('0/100') // default cap
  })
})

test.describe('domain SKU · agent (MCP/manifest) surface', () => {
  async function mcp(request: import('@playwright/test').APIRequestContext, method: string, params?: unknown) {
    const res = await request.post('/api/ucp/mcp', {
      data: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
      headers: { 'Content-Type': 'application/json' },
    })
    return res
  }

  test('tools/list advertises the two new shop-scoped domain tools', async ({ request }) => {
    const res = await mcp(request, 'tools/list')
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    const names = (body.result?.tools ?? []).map((t: { name: string }) => t.name)
    expect(names).toContain('get_domain_entitlement')
    expect(names).toContain('start_domain_subscription')
  })

  test('get_domain_entitlement without a shop token is refused (shop-scoped)', async ({ request }) => {
    const res = await mcp(request, 'tools/call', { name: 'get_domain_entitlement', arguments: {} })
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    const text = (body.result?.content ?? []).map((c: { text?: string }) => c.text ?? '').join('\n')
    expect(text).toContain('Unauthorized')
  })

  test('start_domain_subscription without a shop token is refused (shop-scoped)', async ({ request }) => {
    const res = await mcp(request, 'tools/call', { name: 'start_domain_subscription', arguments: { coupon: 'miyagisan' } })
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    const text = (body.result?.content ?? []).map((c: { text?: string }) => c.text ?? '').join('\n')
    expect(text).toContain('Unauthorized')
  })

  test('the manifest advertises the seller_domain_subscription capability + tools', async ({ request }) => {
    const res = await request.get('/api/ucp/manifest')
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.capabilities).toContain('seller_domain_subscription')
    const tools = body.endpoints?.seller_domain_subscription?.mcp_tools ?? []
    expect(tools).toContain('get_domain_entitlement')
    expect(tools).toContain('start_domain_subscription')
    // MCP_TOOL_NAMES (single source) also lists them.
    expect(body.endpoints?.mcp?.mcp_tools ?? []).toEqual(
      expect.arrayContaining(['get_domain_entitlement', 'start_domain_subscription']),
    )
  })
})

test.describe('admin · domain campaign coupon route is secret-gated', () => {
  test('GET /api/admin/domain-coupon rejects without the secret (401)', async ({ request }) => {
    const res = await request.get('/api/admin/domain-coupon')
    expect(res.status()).toBe(401)
  })

  test('POST /api/admin/domain-coupon rejects without the secret (401)', async ({ request }) => {
    const res = await request.post('/api/admin/domain-coupon')
    expect(res.status()).toBe(401)
  })
})
