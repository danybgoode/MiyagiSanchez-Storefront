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

import { canCollect, publicShopFacts, READINESS_COPY } from './listing-readiness'

export type CollectAnswer = 'yes' | 'no' | 'unavailable'

export type ShopCollectDeps = {
  /** The Medusa seller's PUBLIC metadata by slug; `null` = not found / unreadable. May throw. */
  readonly sellerMetadata: (slug: string) => Promise<Record<string, unknown> | null>
}

// Lazy: `lib/listings` pulls in `next/cache`, which keeps this module out of the node test runner if imported on top.
const defaultDeps: ShopCollectDeps = {
  sellerMetadata: async (slug) => {
    const { getShop } = await import('@/lib/listings')
    const shop = await getShop(slug)
    return shop ? ((shop.metadata ?? {}) as Record<string, unknown>) : null
  },
}

export async function shopCanCollect(slug: string | null | undefined, deps: ShopCollectDeps = defaultDeps): Promise<CollectAnswer> {
  if (!slug) return 'unavailable'
  try {
    const metadata = await deps.sellerMetadata(slug)
    if (!metadata) return 'unavailable'
    return canCollect(publicShopFacts(metadata).payments) ? 'yes' : 'no'
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
