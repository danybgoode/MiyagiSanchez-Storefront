import { test, expect } from '@playwright/test'
import {
  acceptOwnedListing,
  resolveCheckoutListing,
  shopScopedListingPath,
  type CheckoutListingShape,
} from '../lib/checkout-listing'

/**
 * `/checkout` for a «Solo mi tienda» product (reported live 2026-11-11, miel-verduras).
 *
 * The cart already admits a product that is buyable on its own shop but not
 * published into the Mexico marketplace; the checkout PAGE read only the
 * marketplace PDP and 404'd it. These pin the fallback — and, just as hard, every
 * way it must refuse. Pure: no Medusa, no Supabase.
 */

type L = CheckoutListingShape & { title: string }

const owned = (over: Partial<L> = {}): L => ({
  id: 'prod_A',
  title: 'Ensalada',
  shop: { slug: 'miel-verduras', market_code: 'mx' },
  ...over,
})

function deps(over: {
  marketplace?: L | null
  slug?: string | null
  owned?: L | null
} = {}) {
  const calls: string[] = []
  return {
    calls,
    deps: {
      marketplace: async (id: string) => { calls.push(`marketplace:${id}`); return over.marketplace ?? null },
      mirrorShopSlug: async (id: string) => { calls.push(`mirror:${id}`); return over.slug === undefined ? 'miel-verduras' : over.slug },
      owned: async (slug: string, id: string) => { calls.push(`owned:${slug}:${id}`); return over.owned === undefined ? owned() : over.owned },
    },
  }
}

test.describe('checkout listing · marketplace first, shop second', () => {
  test('a marketplace product is read from the marketplace and nothing else', async () => {
    const m = owned({ title: 'from marketplace' })
    const { deps: d, calls } = deps({ marketplace: m })
    expect(await resolveCheckoutListing('prod_A', 'mx', d)).toEqual({ kind: 'marketplace', listing: m })
    expect(calls).toEqual(['marketplace:prod_A'])
  })

  test('🚨 THE REPORTED BUG: a shop-only product resolves through its own shop', async () => {
    const { deps: d, calls } = deps()
    const got = await resolveCheckoutListing('prod_A', 'mx', d)
    expect(got).toEqual({ kind: 'owned', listing: owned(), shopSlug: 'miel-verduras' })
    expect(calls).toEqual(['marketplace:prod_A', 'mirror:prod_A', 'owned:miel-verduras:prod_A'])
  })
})

test.describe('checkout listing · every refusal fails closed', () => {
  test('no mirror row → absent, and the owned read is never asked', async () => {
    const { deps: d, calls } = deps({ slug: null })
    expect(await resolveCheckoutListing('prod_A', 'mx', d)).toEqual({ kind: 'absent' })
    expect(calls).not.toContain('owned:miel-verduras:prod_A')
  })

  test('the shop does not own / has not published it → absent', async () => {
    const { deps: d } = deps({ owned: null })
    expect(await resolveCheckoutListing('prod_A', 'mx', d)).toEqual({ kind: 'absent' })
  })

  test('outside Mexico there is no shop fallback (owned-shop-only is MX-only)', async () => {
    const { deps: d, calls } = deps()
    expect(await resolveCheckoutListing('prod_A', 'us', d)).toEqual({ kind: 'absent' })
    expect(calls).toEqual(['marketplace:prod_A'])
  })

  test('an owned read naming another product, another shop, or another market is refused', () => {
    const args = { id: 'prod_A', shopSlug: 'miel-verduras', market: 'mx' as const }
    expect(acceptOwnedListing(owned(), args)).not.toBeNull() // the negation: a correct read passes
    expect(acceptOwnedListing(owned({ id: 'prod_B' }), args)).toBeNull()
    expect(acceptOwnedListing(owned({ shop: { slug: 'otra', market_code: 'mx' } }), args)).toBeNull()
    expect(acceptOwnedListing(owned({ shop: { slug: 'miel-verduras', market_code: 'us' } }), args)).toBeNull()
    expect(acceptOwnedListing(owned({ shop: null }), args)).toBeNull()
    expect(acceptOwnedListing(null, args)).toBeNull()
  })
})

test('the back link is the shop-scoped PDP route', () => {
  expect(shopScopedListingPath('miel-verduras', 'prod_A')).toBe('/mx/s/miel-verduras/l/prod_A')
})
