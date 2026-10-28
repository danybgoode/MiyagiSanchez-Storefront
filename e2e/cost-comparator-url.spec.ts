import { expect, test } from '@playwright/test'
import {
  buildComparadorShareParams,
  parseComparadorState,
  searchParamsToRecord,
  type ComparadorState,
} from '../lib/cost-comparator-url'

// Comparador de costos (epic 08 · cost-comparator-homepage, Sprint 2 · US-2.2) — the
// pure codec unit spec sprint-2.md requires: "prefill URL round-trips a known
// state." Build → parse must return the EXACT state that was built, for every
// platform branch (each platform only writes its own tier/band/type/hosting/
// gateway params — the round trip must still hold with the others at defaults).

const VALID_APP_IDS = ['liveChat', 'coupons', 'offers']

test.describe('cost-comparator-url · build → parse round trip', () => {
  test('Shopify, with apps + all three Miyagi SKUs + a hand-edited line override', () => {
    const state: ComparadorState = {
      platform: 'shopify',
      shopifyTier: 'avanzado',
      mlBand: 'media',
      mlPublicationType: 'clasica',
      wooTier: 'entrada',
      tnTier: 'basico',
      tnOwnGateway: true,
      t1Tier: 'basico',
      t1Pagos: true,
      volume: 250,
      aov: 899.5,
      selectedAppIds: ['liveChat', 'coupons'],
      miyagiSkus: { subdomain: true, customDomain: true, mlSync: true },
      lineOverrides: { 'shopify:avanzado:plan': 999.99 },
    }
    const params = buildComparadorShareParams(state)
    const parsed = parseComparadorState(searchParamsToRecord(params), VALID_APP_IDS)

    expect(parsed.platform).toBe('shopify')
    expect(parsed.shopifyTier).toBe('avanzado')
    expect(parsed.volume).toBe(250)
    expect(parsed.aov).toBe(899.5)
    expect(parsed.selectedAppIds.sort()).toEqual(['coupons', 'liveChat'])
    expect(parsed.miyagiSkus).toEqual({ subdomain: true, customDomain: true, mlSync: true })
    expect(parsed.lineOverrides).toEqual({ 'shopify:avanzado:plan': 999.99 })
  })

  test('Mercado Libre band/publication type round-trip; unrelated params stay default', () => {
    const state: ComparadorState = {
      platform: 'mercadolibre',
      shopifyTier: 'basico',
      mlBand: 'alta',
      mlPublicationType: 'premium',
      wooTier: 'entrada',
      tnTier: 'basico',
      tnOwnGateway: true,
      t1Tier: 'basico',
      t1Pagos: true,
      volume: 40,
      aov: 1200,
      selectedAppIds: [],
      miyagiSkus: { subdomain: false, customDomain: false, mlSync: false },
      lineOverrides: {},
    }
    const params = buildComparadorShareParams(state)
    // Only platform/band/type/volume/aov are written — no leftover shopify `tier`,
    // no `apps`, no SKU flags, no `ov` — proving the "no stale params" contract.
    expect(params.get('tier')).toBeNull()
    expect(params.get('apps')).toBeNull()
    expect(params.get('sub')).toBeNull()
    expect(params.get('ov')).toBeNull()

    const parsed = parseComparadorState(searchParamsToRecord(params), VALID_APP_IDS)
    expect(parsed.platform).toBe('mercadolibre')
    expect(parsed.mlBand).toBe('alta')
    expect(parsed.mlPublicationType).toBe('premium')
    expect(parsed.selectedAppIds).toEqual([])
    expect(parsed.lineOverrides).toEqual({})
  })

  test('Tiendanube external gateway round-trips (own-gateway is the default, so only `false` is ever written)', () => {
    const state: ComparadorState = {
      platform: 'tiendanube',
      shopifyTier: 'basico',
      mlBand: 'media',
      mlPublicationType: 'clasica',
      wooTier: 'entrada',
      tnTier: 'avanzado',
      tnOwnGateway: false,
      t1Tier: 'basico',
      t1Pagos: true,
      volume: 10,
      aov: 50,
      selectedAppIds: ['offers'],
      miyagiSkus: { subdomain: false, customDomain: false, mlSync: false },
      lineOverrides: {},
    }
    const params = buildComparadorShareParams(state)
    expect(params.get('gateway')).toBe('external')

    const parsed = parseComparadorState(searchParamsToRecord(params), VALID_APP_IDS)
    expect(parsed.tnTier).toBe('avanzado')
    expect(parsed.tnOwnGateway).toBe(false)
    expect(parsed.selectedAppIds).toEqual(['offers'])
  })

  test('an unknown app id in the URL is silently dropped, never fabricated', () => {
    const parsed = parseComparadorState({ platform: 'shopify', apps: 'liveChat,not-a-real-app' }, VALID_APP_IDS)
    expect(parsed.selectedAppIds).toEqual(['liveChat'])
  })

  test('a WooCommerce state round-trips its hosting tier', () => {
    const state: ComparadorState = {
      platform: 'woocommerce',
      shopifyTier: 'basico',
      mlBand: 'media',
      mlPublicationType: 'clasica',
      wooTier: 'crecimiento',
      tnTier: 'basico',
      tnOwnGateway: true,
      t1Tier: 'basico',
      t1Pagos: true,
      volume: 5,
      aov: 300,
      selectedAppIds: [],
      miyagiSkus: { subdomain: false, customDomain: false, mlSync: false },
      lineOverrides: {},
    }
    const params = buildComparadorShareParams(state)
    const parsed = parseComparadorState(searchParamsToRecord(params), VALID_APP_IDS)
    expect(parsed.wooTier).toBe('crecimiento')
  })

  test('a malformed or non-finite `ov` payload is dropped, never fabricates a number (fail-open)', () => {
    expect(parseComparadorState({ platform: 'shopify', ov: 'not-json' }, VALID_APP_IDS).lineOverrides).toEqual({})
    expect(parseComparadorState({ platform: 'shopify', ov: '[1,2,3]' }, VALID_APP_IDS).lineOverrides).toEqual({})
    expect(
      parseComparadorState({ platform: 'shopify', ov: JSON.stringify({ 'shopify:basico:plan': 'not-a-number', 'shopify:basico:payment': 42 }) }, VALID_APP_IDS).lineOverrides,
    ).toEqual({ 'shopify:basico:payment': 42 })
  })
})

test.describe('cost-comparator-url · tier param does not bleed across platforms (PR #278 review)', () => {
  test('a Shopify link with tier=avanzado does NOT seed Tiendanube tier to avanzado', () => {
    // Regression for the bug found in review: both shopifyTier and tnTier used to
    // parse from the SAME `sp.tier` unconditionally, so switching the platform
    // dropdown client-side (no new page load) would silently carry the wrong
    // tier over. Parsing is now gated by the ACTIVE platform.
    const parsed = parseComparadorState({ platform: 'shopify', tier: 'avanzado' }, VALID_APP_IDS)
    expect(parsed.shopifyTier).toBe('avanzado')
    expect(parsed.tnTier).toBe('basico') // the untouched default, not the bled-over value
  })

  test('a Tiendanube link with tier=avanzado does NOT seed Shopify tier to avanzado', () => {
    const parsed = parseComparadorState({ platform: 'tiendanube', tier: 'avanzado' }, VALID_APP_IDS)
    expect(parsed.tnTier).toBe('avanzado')
    expect(parsed.shopifyTier).toBe('basico')
  })

  test('build only ever writes the ACTIVE platform tier — parse/build stay symmetric', () => {
    const state: ComparadorState = {
      platform: 'shopify',
      shopifyTier: 'crecimiento',
      mlBand: 'media',
      mlPublicationType: 'clasica',
      wooTier: 'entrada',
      tnTier: 'avanzado', // deliberately non-default, to prove it's never written
      tnOwnGateway: true,
      t1Tier: 'basico',
      t1Pagos: true,
      volume: 10,
      aov: 100,
      selectedAppIds: [],
      miyagiSkus: { subdomain: false, customDomain: false, mlSync: false },
      lineOverrides: {},
    }
    const params = buildComparadorShareParams(state)
    expect(params.get('tier')).toBe('crecimiento') // Shopify's, not Tiendanube's

    const parsed = parseComparadorState(searchParamsToRecord(params), VALID_APP_IDS)
    expect(parsed.shopifyTier).toBe('crecimiento')
    expect(parsed.tnTier).toBe('basico') // the default — tnTier was never in the URL
  })
})
