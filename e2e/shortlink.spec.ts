import { test, expect } from '@playwright/test'
import {
  isShortLinkHost, firstSegment, shopTarget, listingTarget,
  HOME_TARGET, NOT_FOUND_TARGET, PLATFORM_ORIGIN,
  PASSTHROUGH_PREFIXES, passthroughTarget,
} from '../lib/shortlink'

/**
 * Short links · US-1. Pure-logic guards on the mschz.org redirector: host match,
 * case-insensitive single-segment parsing, and canonical targets. The DB lookups
 * (shop slug / alias / product code) live in middleware; these are deterministic.
 */
test.describe('shortlink · host + segment', () => {
  test('isShortLinkHost matches mschz.org (+ www, port-tolerant)', () => {
    expect(isShortLinkHost('mschz.org')).toBe(true)
    expect(isShortLinkHost('www.mschz.org')).toBe(true)
    expect(isShortLinkHost('MSCHZ.ORG:443')).toBe(true)
    expect(isShortLinkHost('miyagisanchez.com')).toBe(false)
    expect(isShortLinkHost('shop.miyagisanchez.com')).toBe(false)
    expect(isShortLinkHost(null)).toBe(false)
  })

  test('firstSegment is case-insensitive, decoded, empty→null', () => {
    expect(firstSegment('/Mi-Tienda')).toBe('mi-tienda')
    expect(firstSegment('/mi-tienda/extra/parts')).toBe('mi-tienda')
    expect(firstSegment('/ShopName?x=1'.split('?')[0])).toBe('shopname')
    expect(firstSegment('/')).toBeNull()
    expect(firstSegment('')).toBeNull()
    expect(firstSegment('/caf%C3%A9')).toBe('café')
  })
})

test.describe('shortlink · targets', () => {
  test('shop + listing canonical targets', () => {
    expect(shopTarget('mi-tienda')).toBe(`${PLATFORM_ORIGIN}/mx/s/mi-tienda`)
    expect(listingTarget('prod_01ABC')).toBe(`${PLATFORM_ORIGIN}/mx/l/prod_01ABC`)
  })

  test('home + branded 404 targets', () => {
    expect(HOME_TARGET).toBe('https://miyagisanchez.com/mx')
    expect(NOT_FOUND_TARGET).toBe('https://miyagisanchez.com/404')
  })
})

/**
 * mschz-full-coverage · Sprint 1, Story 1.1 — known-prefix passthrough. Pure
 * matcher: multi-segment `mschz.org/<prefix>/…` 301s to the IDENTICAL path+query
 * on miyagisanchez.com for the allowlisted prefixes (g/e/v/s/l); everything else
 * multi-segment → null (caller sends it to the branded 404); single-segment paths
 * are untouched (defer to the flat resolver) even when the segment happens to
 * match a prefix letter.
 */
test.describe('shortlink · known-prefix passthrough', () => {
  test('allowlist contains exactly g, e, v, s, l', () => {
    const payToken = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v'
    expect(passthroughTarget(`/pagar/${payToken}`, '')).toBe(`${PLATFORM_ORIGIN}/pagar/${payToken}`)
    expect([...PASSTHROUGH_PREFIXES].sort()).toEqual(['e', 'g', 'l', 'pagar', 's', 'v'])
  })

  test('marketplace prefixes canonicalize to MX; out-of-scope prefixes keep the identical path', () => {
    expect(passthroughTarget('/g/verano-2026', '')).toBe(`${PLATFORM_ORIGIN}/g/verano-2026`)
    expect(passthroughTarget('/e/lanzamiento', '')).toBe(`${PLATFORM_ORIGIN}/e/lanzamiento`)
    expect(passthroughTarget('/v/vota-mi-obra', '')).toBe(`${PLATFORM_ORIGIN}/v/vota-mi-obra`)
    expect(passthroughTarget('/l/prod_01ABC', '')).toBe(`${PLATFORM_ORIGIN}/mx/l/prod_01ABC`)
    expect(passthroughTarget('/s/mi-tienda/c/coleccion', '')).toBe(`${PLATFORM_ORIGIN}/mx/s/mi-tienda/c/coleccion`)
  })

  test('prefix match is case-insensitive; path case is preserved verbatim', () => {
    expect(passthroughTarget('/G/Verano-2026', '')).toBe(`${PLATFORM_ORIGIN}/G/Verano-2026`)
    expect(passthroughTarget('/E/lanzamiento', '')).toBe(`${PLATFORM_ORIGIN}/E/lanzamiento`)
    expect(passthroughTarget('/S/Mi-Tienda', '?ref=QR'))
      .toBe(`${PLATFORM_ORIGIN}/mx/S/Mi-Tienda?ref=QR`)
    expect(passthroughTarget('/L/prod_ABC', ''))
      .toBe(`${PLATFORM_ORIGIN}/mx/L/prod_ABC`)
  })

  test('query string is preserved verbatim alongside the path', () => {
    expect(passthroughTarget('/e/lanzamiento', '?lang=en')).toBe(`${PLATFORM_ORIGIN}/e/lanzamiento?lang=en`)
    expect(passthroughTarget('/s/mi-tienda/c/coleccion', '?utm_source=ig&ref=abc'))
      .toBe(`${PLATFORM_ORIGIN}/mx/s/mi-tienda/c/coleccion?utm_source=ig&ref=abc`)
  })

  test('multi-segment, non-allowlisted prefix → null (caller 404s it)', () => {
    expect(passthroughTarget('/checkout/anything', '')).toBeNull()
    expect(passthroughTarget('/shop/manage', '')).toBeNull()
    expect(passthroughTarget('/admin/whatever', '')).toBeNull()
  })

  test('single-segment paths never trigger passthrough, even on a prefix letter', () => {
    expect(passthroughTarget('/g', '')).toBeNull()
    expect(passthroughTarget('/g/', '')).toBeNull()
    expect(passthroughTarget('/s', '')).toBeNull()
    expect(passthroughTarget('/mi-tienda', '')).toBeNull()
  })
})
