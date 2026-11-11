/**
 * Which listing a checkout page is buying — the marketplace one, or the shop's own.
 *
 * `/checkout` used to read ONLY the marketplace PDP (`getListing`), which knows
 * nothing about a «Solo mi tienda» product: a product a shop sells but never
 * published into the Mexico marketplace. The cart already admits such a product
 * (`lib/cart.ts` → the operating-channel admission seam, D7 of
 * owned-shop-operating-channel), so the page in front of it was the one thing
 * refusing the sale — every Buy click 404'd (reported live 2026-11-11).
 *
 * The fallback is the shop-scoped read the shop's own PDP uses
 * (`getOwnedShopListing`), which proves the product is published AND owned by
 * that seller. The seller is found through the Supabase listings mirror — the
 * same lookup middleware already uses to route `/mx/l/<id>` — because the
 * marketplace read is not allowed to say who owns a product it does not carry.
 *
 * This decides DISPLAY and the back link only. It admits nothing on its own:
 * the cart admission seam stays the money gate, and every amount is still
 * re-derived server-side downstream. A mirror row naming the wrong shop fails
 * closed — the owned read refuses a product that shop does not own.
 *
 * Pure seam + injected I/O (AGENTS: "inject dependencies for I/O"), so both
 * branches and every refusal are testable without Medusa or Supabase.
 */

import type { MarketCode } from './markets'

/** Only what this decision reads from a listing — the rest passes through untouched. */
export type CheckoutListingShape = {
  id: string
  shop?: { slug?: string | null; market_code?: string | null } | null
}

export type CheckoutListingDeps<L extends CheckoutListingShape> = {
  /** The marketplace PDP read (`getListing`). `null` = not in this marketplace. */
  readonly marketplace: (id: string, market: MarketCode) => Promise<L | null>
  /** The owning shop's slug from the listings mirror, or `null` when there is no active row. */
  readonly mirrorShopSlug: (id: string) => Promise<string | null>
  /** The shop-scoped read (`getOwnedShopListing`): published AND owned by `slug`, else `null`. */
  readonly owned: (slug: string, id: string) => Promise<L | null>
}

export type CheckoutListing<L> =
  | { kind: 'marketplace'; listing: L }
  | { kind: 'owned'; listing: L; shopSlug: string }
  | { kind: 'absent' }

/**
 * Accept an owned-read result only when it names the requested product, belongs to
 * the shop we asked about, and sells in the checkout's market. The owned read
 * already checks the first two; checking again here keeps this seam honest if
 * that read ever loosens, and the market check is new: a checkout in `mx` must
 * not render a product whose shop operates elsewhere.
 */
export function acceptOwnedListing<L extends CheckoutListingShape>(
  listing: L | null,
  args: { id: string; shopSlug: string; market: MarketCode },
): L | null {
  if (!listing) return null
  if (listing.id !== args.id) return null
  if (listing.shop?.slug !== args.shopSlug) return null
  if (listing.shop?.market_code !== args.market) return null
  return listing
}

/** The one market whose checkout falls back to the shop's own read. */
export const OWNED_CHECKOUT_MARKET: MarketCode = 'mx'

export async function resolveCheckoutListing<L extends CheckoutListingShape>(
  id: string,
  market: MarketCode,
  deps: CheckoutListingDeps<L>,
): Promise<CheckoutListing<L>> {
  const fromMarketplace = await deps.marketplace(id, market)
  if (fromMarketplace) return { kind: 'marketplace', listing: fromMarketplace }
  // Owned-shop-only selling is a Mexico capability (owned-shop-operating-channel
  // non-goal: nothing US), and only `/mx` has a shop-scoped PDP to send the buyer back to.
  if (market !== OWNED_CHECKOUT_MARKET) return { kind: 'absent' }

  const shopSlug = await deps.mirrorShopSlug(id)
  if (!shopSlug) return { kind: 'absent' }

  const owned = acceptOwnedListing(await deps.owned(shopSlug, id), { id, shopSlug, market })
  return owned ? { kind: 'owned', listing: owned, shopSlug } : { kind: 'absent' }
}

/** The shop-scoped PDP path on the platform host. Mirrors `app/(shell)/mx/s/[slug]/l/[id]`. */
export function shopScopedListingPath(shopSlug: string, id: string): string {
  return `/mx/s/${encodeURIComponent(shopSlug)}/l/${encodeURIComponent(id)}`
}
