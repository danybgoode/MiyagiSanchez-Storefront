import { expect, test } from '@playwright/test'
import {
  buildCheckoutAdmissionPath,
  checkoutAdmissionMessage,
  classifyCheckoutAdmission,
  isOperatingChannelAdmitted,
  readAdmittedOwnerSlug,
} from '../lib/checkout-admission'
import { resolveCheckoutLines, type CheckoutAdmissionDeps } from '../lib/cart'

/**
 * Story 2.3 — checkout admission proves BUYABILITY, not marketplace publication
 * (epic 07 · owned-shop-operating-channel, decisions D7 + D8).
 *
 * Two layers are covered here on purpose:
 *
 *  1. The pure classifier. Every response the backend seam can produce, including
 *     the ones that must NOT be read as a refusal.
 *  2. `resolveCheckoutLines` itself, driven end to end through an injected fetch.
 *     This is where the regression this story could most easily cause is proven
 *     absent: the productId → variantId ownership proof must still fire under the
 *     NEW admission path, not only under the old one.
 */

const MX = { code: 'mx' as const, query: 'market=mx' }

/** A 200 from the operating-channel seam for a product that IS buyable. */
function admissionOk(productId: string) {
  return {
    market_code: 'mx',
    admitted: true,
    owned_shop_only_enabled: true,
    product: {
      id: productId,
      medusa_product_id: productId,
      status: 'published',
      in_operating_channel: true,
      in_marketplace_channel: false,
    },
  }
}

/** The one indistinguishable product-level refusal. No IDOR oracle. */
const PRODUCT_REFUSAL = { message: 'Listing not found' }

function unavailableBody(reason: string) {
  return { unavailable: true, market_code: 'mx', marketplace_status: 'active', reason }
}

// ── 1. The pure classifier ──────────────────────────────────────────────────────

test.describe('operating-channel admission · the 200 proof', () => {
  test('admits an exact product under a confirmed market echo', () => {
    expect(isOperatingChannelAdmitted(admissionOk('prod_mx'), 'mx', 'prod_mx')).toBe(true)
    expect(classifyCheckoutAdmission(200, admissionOk('prod_mx'), 'mx', 'prod_mx')).toEqual({
      kind: 'admitted',
    })
  })

  test('refuses a missing or foreign market echo — the money path has no compatibility window', () => {
    const noEcho = { ...admissionOk('prod_mx'), market_code: undefined }
    const foreignEcho = { ...admissionOk('prod_mx'), market_code: 'us' }
    expect(isOperatingChannelAdmitted(noEcho, 'mx', 'prod_mx')).toBe(false)
    expect(isOperatingChannelAdmitted(foreignEcho, 'mx', 'prod_mx')).toBe(false)
  })

  test('refuses admitted:false, and never widens to "any product id"', () => {
    const notAdmitted = { ...admissionOk('prod_mx'), admitted: false }
    expect(isOperatingChannelAdmitted(notAdmitted, 'mx', 'prod_mx')).toBe(false)
    // A response about a DIFFERENT product cannot admit the requested one.
    expect(isOperatingChannelAdmitted(admissionOk('prod_other'), 'mx', 'prod_mx')).toBe(false)
  })

  test('requires BOTH identifier fields — one matching field is not a proof', () => {
    // The precedent: an admission proof keyed on one identifier while the purchase
    // consumed another. Both fields carry the id, so both are checked.
    const halfMatch = {
      ...admissionOk('prod_mx'),
      product: { id: 'prod_mx', medusa_product_id: 'prod_smuggled' },
    }
    expect(isOperatingChannelAdmitted(halfMatch, 'mx', 'prod_mx')).toBe(false)
  })

  test('an unverifiable 2xx is UNPROVEN, which still fails closed', () => {
    expect(classifyCheckoutAdmission(200, null, 'mx', 'prod_mx')).toEqual({ kind: 'unproven' })
    expect(classifyCheckoutAdmission(200, { admitted: true }, 'mx', 'prod_mx')).toEqual({
      kind: 'unproven',
    })
  })
})

test.describe('operating-channel admission · a refusal and an outage are different facts', () => {
  test('an unstructured 404 is the product-level refusal', () => {
    expect(classifyCheckoutAdmission(404, PRODUCT_REFUSAL, 'mx', 'prod_mx')).toEqual({
      kind: 'refused',
    })
  })

  for (const [status, reason] of [
    [400, 'unknown_market'],
    [404, 'market_has_no_operating_channel'],
    [404, 'marketplace_not_open'],
    [503, 'operating_channel_unavailable'],
    [503, 'admission_read_failed'],
  ] as const) {
    test(`a structured ${status} ${reason} is UNAVAILABLE, not a refusal`, () => {
      expect(classifyCheckoutAdmission(status, unavailableBody(reason), 'mx', 'prod_mx')).toEqual({
        kind: 'unavailable',
        reason,
      })
    })
  }

  test('an unclassifiable 500 is an outage, never a refusal', () => {
    // Answering "not for sale" on behalf of a seam that did not answer is the exact
    // collapse of "I could not check" into "there is none".
    expect(classifyCheckoutAdmission(500, '<html>gateway</html>', 'mx', 'prod_mx')).toEqual({
      kind: 'unavailable',
      reason: 'admission_read_failed',
    })
    expect(classifyCheckoutAdmission(502, null, 'mx', 'prod_mx')).toEqual({
      kind: 'unavailable',
      reason: 'admission_read_failed',
    })
  })

  test('an unrecognised reason string is not laundered into a named refusal', () => {
    expect(
      classifyCheckoutAdmission(503, unavailableBody('something_invented'), 'mx', 'prod_mx'),
    ).toEqual({ kind: 'unavailable', reason: 'admission_read_failed' })
  })
})

test.describe('operating-channel admission · buyer copy keeps the three states apart', () => {
  const refused = checkoutAdmissionMessage({ kind: 'refused' }, 'prod_mx')
  const unproven = checkoutAdmissionMessage({ kind: 'unproven' }, 'prod_mx')
  const outage = checkoutAdmissionMessage(
    { kind: 'unavailable', reason: 'operating_channel_unavailable' },
    'prod_mx',
  )

  test('an outage never reads as "this is not sold here"', () => {
    expect(refused).toContain('no está a la venta')
    expect(outage).not.toContain('no está a la venta')
    expect(outage).toContain('operating_channel_unavailable')
  })

  test('the three messages are pairwise distinct and es-MX', () => {
    expect(new Set([refused, unproven, outage]).size).toBe(3)
    for (const message of [refused, unproven, outage]) {
      expect(message.length).toBeGreaterThan(0)
      expect(message).not.toMatch(/\b(?:Product|not available|could not)\b/)
    }
  })
})

test('the admission path is built once, and encodes the product id', () => {
  expect(buildCheckoutAdmissionPath('prod_mx', 'market=mx')).toBe(
    '/store/checkout-admission/prod_mx?market=mx',
  )
  expect(buildCheckoutAdmissionPath('a/b?c', 'market=mx')).toBe(
    '/store/checkout-admission/a%2Fb%3Fc?market=mx',
  )
})

// ── 2. `resolveCheckoutLines`, driven through an injected fetch ─────────────────

type Route = { status: number; body: unknown }

/**
 * A Medusa stub that records every path it was asked for. Anything not routed is a
 * 404, so a branch reaching an endpoint this test did not expect fails loudly
 * rather than silently resolving.
 */
function stubFetch(routes: Array<[RegExp, Route]>) {
  const calls: string[] = []
  const fetchImpl = async (path: string): Promise<Response> => {
    calls.push(path)
    const match = routes.find(([pattern]) => pattern.test(path))
    const route = match?.[1] ?? { status: 404, body: PRODUCT_REFUSAL }
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { calls, fetchImpl }
}

const PRODUCT_ONE_VARIANT: Route = {
  status: 200,
  body: { product: { metadata: { colour: 'verde' }, variants: [{ id: 'variant_a1' }] } },
}
const PRODUCT_TWO_VARIANTS: Route = {
  status: 200,
  body: { product: { metadata: null, variants: [{ id: 'variant_a1' }, { id: 'variant_a2' }] } },
}
const PRODUCT_NO_VARIANTS: Route = { status: 200, body: { product: { variants: [] } } }

const LISTING_OK: Route = {
  status: 200,
  body: { market_code: 'mx', listing: { id: 'prod_mx', medusa_product_id: 'prod_mx' } },
}
const ADMISSION_OK: Route = { status: 200, body: admissionOk('prod_mx') }

const LISTINGS = /^\/store\/listings\//
const ADMISSION = /^\/store\/checkout-admission\//
const PRODUCTS = /^\/store\/products\//

function deps(ownedShopOnlyEnabled: boolean, fetchImpl: CheckoutAdmissionDeps['fetch']) {
  return { ownedShopOnlyEnabled, fetch: fetchImpl }
}

test.describe('resolveCheckoutLines · flag OFF runs today’s marketplace admission, unchanged', () => {
  test('admits through the marketplace DETAIL endpoint and never touches the new seam', async () => {
    const { calls, fetchImpl } = stubFetch([
      [LISTINGS, LISTING_OK],
      [PRODUCTS, PRODUCT_ONE_VARIANT],
    ])
    const lines = await resolveCheckoutLines(
      [{ productId: 'prod_mx' }],
      MX,
      undefined,
      deps(false, fetchImpl),
    )
    expect(lines[0].resolvedVariantId).toBe('variant_a1')
    expect(lines[0].productMetadata).toEqual({ colour: 'verde' })
    expect(calls.some((path) => LISTINGS.test(path))).toBe(true)
    expect(calls.some((path) => ADMISSION.test(path))).toBe(false)
  })

  test('an operating-channel-only product is still REFUSED while the flag is off', async () => {
    // This is the behaviour D7 exists to change — and the proof that the change is
    // gated. With the flag off, the capability is unreachable, exactly as today.
    const { fetchImpl } = stubFetch([
      [LISTINGS, { status: 404, body: PRODUCT_REFUSAL }],
      [ADMISSION, ADMISSION_OK],
      [PRODUCTS, PRODUCT_ONE_VARIANT],
    ])
    await expect(
      resolveCheckoutLines([{ productId: 'prod_mx' }], MX, undefined, deps(false, fetchImpl)),
    ).rejects.toThrow('Product prod_mx is not available in this marketplace')
  })

  test('an unverifiable marketplace 200 keeps its shipped message', async () => {
    const { fetchImpl } = stubFetch([
      [LISTINGS, { status: 200, body: { listing: { id: 'prod_mx', medusa_product_id: 'prod_mx' } } }],
      [PRODUCTS, PRODUCT_ONE_VARIANT],
    ])
    await expect(
      resolveCheckoutLines([{ productId: 'prod_mx' }], MX, undefined, deps(false, fetchImpl)),
    ).rejects.toThrow('Product prod_mx could not be verified for this marketplace')
  })
})

test.describe('resolveCheckoutLines · flag ON admits buyability', () => {
  test('an operating-channel-only product is BOUGHT, without any marketplace read', async () => {
    // The capability the whole epic exists for: the marketplace detail endpoint
    // 404s this product, and it checks out anyway.
    const { calls, fetchImpl } = stubFetch([
      [LISTINGS, { status: 404, body: PRODUCT_REFUSAL }],
      [ADMISSION, ADMISSION_OK],
      [PRODUCTS, PRODUCT_ONE_VARIANT],
    ])
    const lines = await resolveCheckoutLines(
      [{ productId: 'prod_mx' }],
      MX,
      undefined,
      deps(true, fetchImpl),
    )
    expect(lines[0].resolvedVariantId).toBe('variant_a1')
    expect(calls.some((path) => ADMISSION.test(path))).toBe(true)
    expect(calls.some((path) => LISTINGS.test(path))).toBe(false)
    expect(calls).toContain('/store/checkout-admission/prod_mx?market=mx')
  })

  test('a refused product (another market’s seller, a draft, or absent) never reaches the product read', async () => {
    const { calls, fetchImpl } = stubFetch([
      [ADMISSION, { status: 404, body: PRODUCT_REFUSAL }],
      [PRODUCTS, PRODUCT_ONE_VARIANT],
    ])
    await expect(
      resolveCheckoutLines([{ productId: 'prod_mx' }], MX, undefined, deps(true, fetchImpl)),
    ).rejects.toThrow('no está a la venta en este mercado')
    expect(calls.some((path) => PRODUCTS.test(path))).toBe(false)
  })

  test('a 503 surfaces as an outage, NOT as "not sold in this marketplace"', async () => {
    const { fetchImpl } = stubFetch([
      [ADMISSION, { status: 503, body: unavailableBody('operating_channel_unavailable') }],
      [PRODUCTS, PRODUCT_ONE_VARIANT],
    ])
    const error = await resolveCheckoutLines(
      [{ productId: 'prod_mx' }],
      MX,
      undefined,
      deps(true, fetchImpl),
    ).catch((err: unknown) => err as Error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('operating_channel_unavailable')
    expect((error as Error).message).not.toContain('no está a la venta')
    expect((error as Error).message).not.toContain('not available in this marketplace')
  })
})

test.describe('resolveCheckoutLines · every downstream proof still fires under the NEW path', () => {
  test('THE REGRESSION: a variant of another product is refused even once admitted', async () => {
    // Widening admission by "buyable on its own shop" must not widen WHAT is bought.
    // Both identifiers are caller-supplied, so an admitted productId escorting a
    // foreign variantId is the bypass this assertion exists to keep closed.
    const { calls, fetchImpl } = stubFetch([
      [ADMISSION, ADMISSION_OK],
      [PRODUCTS, PRODUCT_TWO_VARIANTS],
    ])
    await expect(
      resolveCheckoutLines(
        [{ productId: 'prod_mx', variantId: 'variant_from_another_product' }],
        MX,
        undefined,
        deps(true, fetchImpl),
      ),
    ).rejects.toThrow('Variant variant_from_another_product does not belong to product prod_mx')
    // The admission DID pass — this refusal is the variant proof, not the gate.
    expect(calls.some((path) => ADMISSION.test(path))).toBe(true)
    expect(calls.some((path) => PRODUCTS.test(path))).toBe(true)
  })

  test('a variant that belongs to the admitted product is accepted', async () => {
    const { fetchImpl } = stubFetch([
      [ADMISSION, ADMISSION_OK],
      [PRODUCTS, PRODUCT_TWO_VARIANTS],
    ])
    const lines = await resolveCheckoutLines(
      [{ productId: 'prod_mx', variantId: 'variant_a2' }],
      MX,
      undefined,
      deps(true, fetchImpl),
    )
    expect(lines[0].resolvedVariantId).toBe('variant_a2')
  })

  test('a multi-variant product still demands an explicit variantId', async () => {
    const { fetchImpl } = stubFetch([
      [ADMISSION, ADMISSION_OK],
      [PRODUCTS, PRODUCT_TWO_VARIANTS],
    ])
    await expect(
      resolveCheckoutLines([{ productId: 'prod_mx' }], MX, undefined, deps(true, fetchImpl)),
    ).rejects.toThrow('has multiple variants; variantId is required')
  })

  test('a product with no variants is still refused', async () => {
    const { fetchImpl } = stubFetch([
      [ADMISSION, ADMISSION_OK],
      [PRODUCTS, PRODUCT_NO_VARIANTS],
    ])
    await expect(
      resolveCheckoutLines([{ productId: 'prod_mx' }], MX, undefined, deps(true, fetchImpl)),
    ).rejects.toThrow('Product prod_mx has no variants')
  })

  test('an unreachable product read is still fatal', async () => {
    const { fetchImpl } = stubFetch([
      [ADMISSION, ADMISSION_OK],
      [PRODUCTS, { status: 500, body: {} }],
    ])
    await expect(
      resolveCheckoutLines([{ productId: 'prod_mx' }], MX, undefined, deps(true, fetchImpl)),
    ).rejects.toThrow('Product prod_mx not found')
  })

  test('the same proofs fire on the OLD path — the two branches share them', async () => {
    const { fetchImpl } = stubFetch([
      [LISTINGS, LISTING_OK],
      [PRODUCTS, PRODUCT_TWO_VARIANTS],
    ])
    await expect(
      resolveCheckoutLines(
        [{ productId: 'prod_mx', variantId: 'variant_from_another_product' }],
        MX,
        undefined,
        deps(false, fetchImpl),
      ),
    ).rejects.toThrow('does not belong to product prod_mx')
  })
})

test.describe('owning shop · named only by a full admission (2026-11-11)', () => {
  // The checkout PAGE renders a «Solo mi tienda» product through its owning shop.
  // Medusa names the owner beside an admission; the storefront trusts that name
  // ONLY when the same payload is a complete admission proof for this product.
  const withSeller = (productId: string, slug: unknown) => ({ ...admissionOk(productId), seller: { slug } })

  test('an admission that names its shop → that slug', () => {
    expect(readAdmittedOwnerSlug(200, withSeller('prod_A', 'miel-verduras'), 'mx', 'prod_A')).toBe('miel-verduras')
  })

  test('no owner from anything short of an admission', () => {
    // An older backend that does not send the field.
    expect(readAdmittedOwnerSlug(200, admissionOk('prod_A'), 'mx', 'prod_A')).toBeNull()
    // A proof for ANOTHER product, or another market, names nobody.
    expect(readAdmittedOwnerSlug(200, withSeller('prod_B', 'miel-verduras'), 'mx', 'prod_A')).toBeNull()
    expect(readAdmittedOwnerSlug(200, { ...withSeller('prod_A', 'miel-verduras'), market_code: 'us' }, 'mx', 'prod_A')).toBeNull()
    // A refusal or an outage carrying a seller is still not an owner.
    expect(readAdmittedOwnerSlug(404, withSeller('prod_A', 'miel-verduras'), 'mx', 'prod_A')).toBeNull()
    expect(readAdmittedOwnerSlug(503, withSeller('prod_A', 'miel-verduras'), 'mx', 'prod_A')).toBeNull()
    // A malformed slug is not a shop (it becomes a URL segment downstream).
    expect(readAdmittedOwnerSlug(200, withSeller('prod_A', '../x'), 'mx', 'prod_A')).toBeNull()
    expect(readAdmittedOwnerSlug(200, withSeller('prod_A', 42), 'mx', 'prod_A')).toBeNull()
  })
})
