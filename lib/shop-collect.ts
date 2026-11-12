/**
 * Can this shop take a payment right now? — the offer gate's question (epic listing-readiness S1.3, D5).
 *
 * An offer is a promise of a payable price. Reported live 2026-11-11 (miel-verduras): a buyer offered, the seller
 * accepted, and nobody could pay because the shop had no payment method. Offers now open, get accepted and get
 * countered only where the shop can collect.
 *
 * Read from the MEDUSA seller (the public projection, `publicShopFacts`), NEVER the Supabase mirror: the mirror has
 * no bank-transfer config at all, so a transfer-only shop would read as "cannot collect". THREE states, never two:
 * a shop we could not read is `unavailable`, and an offer path FAILS CLOSED on it (D3) — a 503 the buyer retries,
 * never "accepted" on a guess and never "this shop can't take payment" on an outage.
 */

import { listingCanBePaid, publicShopFacts, READINESS_COPY, type DeliveryMode } from './listing-readiness'

export type CollectAnswer = 'yes' | 'no' | 'unavailable'

export type ShopCollectDeps = {
  /** The Medusa seller's PUBLIC metadata by slug; `null` = not found / unreadable. May throw. */
  readonly sellerMetadata: (slug: string) => Promise<Record<string, unknown> | null>
  /** The product's delivery mode from Medusa (`null` = carrier/unset); `undefined` = unreadable. May throw. */
  readonly productDeliveryMode: (slug: string, productId: string) => Promise<DeliveryMode | undefined>
}

// Lazy: `lib/listings` pulls in `next/cache`, which keeps this module out of the node test runner if imported on top.
const defaultDeps: ShopCollectDeps = {
  // FRESH, not `getShop` (cached 120s): a money decision cannot wait out the cache (fresh-review catch on PR 497).
  sellerMetadata: async (slug) => {
    const { readShopFresh } = await import('@/lib/listings')
    const read = await readShopFresh(slug)
    if (read.state === 'unavailable') throw new Error(read.reason)
    return read.state === 'resolved' ? ((read.shop.metadata ?? {}) as Record<string, unknown>) : null
  },
  // FRESH (security lens on PR 497): the cached read could serve a stale `carrier` for a minute after a switch to arranged.
  productDeliveryMode: async (slug, productId) => {
    const { readOwnedShopListingFresh } = await import('@/lib/listings')
    const listing = await readOwnedShopListingFresh(slug, productId)
    if (!listing) return undefined
    const mode = (listing.metadata as Record<string, unknown> | null | undefined)?.delivery_mode
    return mode === 'arranged' || mode === 'carrier' ? mode : null
  },
}

/**
 * Can a checkout for THIS listing finish? (D5, per listing — cross-family review + fresh review on PR 497.) "The shop
 * takes some payment" is not enough: an arranged product, a service or a rental is a COORDINATED sale that checkout
 * takes only on SPEI or cash, so a card-only shop accepting an offer on one would leave the buyer an unpayable price.
 * The ONE rule over the public facts for products; manual-only for coordinated types; any rail for the rest.
 */
export async function offerCanProceed(
  input: { slug: string | null | undefined; productId: string | null | undefined; listingType: string | null | undefined },
  deps: ShopCollectDeps = defaultDeps,
): Promise<CollectAnswer> {
  if (!input.slug) return 'unavailable'
  try {
    const metadata = await deps.sellerMetadata(input.slug)
    if (!metadata) return 'unavailable'
    const shop = publicShopFacts(metadata)
    const listingType = input.listingType ?? 'product'
    // Only a product's delivery mode changes the answer; read it (fail closed when unreadable).
    let deliveryMode: DeliveryMode = null
    if (listingType === 'product') {
      if (!input.productId) return 'unavailable'
      const read = await deps.productDeliveryMode(input.slug, input.productId)
      if (read === undefined) return 'unavailable'
      deliveryMode = read
    }
    return listingCanBePaid({ listingType, deliveryMode, shop }) ? 'yes' : 'no'
  } catch {
    return 'unavailable'
  }
}

/** The refusal for an offer action, by who is acting; `null` = go ahead. Decline never comes through here. */
export function offerCollectRefusal(
  answer: CollectAnswer,
  actor: 'buyer' | 'seller',
): { status: 409 | 503; error: string; code: 'SHOP_CANNOT_COLLECT' | 'COLLECT_UNVERIFIED' } | null {
  if (answer === 'yes') return null
  if (answer === 'unavailable') return { status: 503, error: READINESS_COPY.offerCheckFailed, code: 'COLLECT_UNVERIFIED' }
  return {
    status: 409,
    error: actor === 'seller' ? READINESS_COPY.sellerOffersBlocked : READINESS_COPY.buyerOffersUnavailable,
    code: 'SHOP_CANNOT_COLLECT',
  }
}
