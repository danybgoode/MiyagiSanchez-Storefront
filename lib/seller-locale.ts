import type { MarketCode } from './markets'

/** The two languages the seller portal is authored and translated into. */
export type SellerLocale = 'es' | 'en'

// The choice itself is the site-wide `ms_lang` cookie now (`lib/site-language.ts`): the portal and every buyer page
// read ONE preference, so picking English here still reads English on the way back to the shop.

export function isSellerLocale(value: unknown): value is SellerLocale {
  return value === 'es' || value === 'en'
}

/**
 * Which language the seller portal renders in.
 *
 * THREE states, not two — an absent preference is not the same fact as a
 * preference for the market default, and collapsing them is what would make the
 * toggle unable to express "Spanish, on a US shop":
 *
 *   · an explicit, valid preference  → that language, whatever the market is
 *   · no preference                  → the shop's market decides (us → en, else es)
 *   · an unparseable preference      → treated as absent, never as a third language
 *
 * The market stays the DEFAULT rather than the authority because it is stable and
 * shop-scoped: a bilingual merchant on an English phone should not silently get a
 * half-familiar portal, which is why browser Accept-Language is deliberately not
 * an input here.
 */
export function resolveSellerLocale(input: {
  preference?: unknown
  market?: MarketCode | null
}): SellerLocale {
  if (isSellerLocale(input.preference)) return input.preference
  return input.market === 'us' ? 'en' : 'es'
}

/**
 * Does this render need the seller-copy boundary at all?
 *
 * The authored TSX tree is Spanish, so Spanish is the identity case: no boundary,
 * no dictionary, no DOM walk — byte for byte the tree the components return. Only
 * English is a transform. Keeping this as its own named predicate is what stops a
 * caller re-deriving it as `market === 'us'` and losing the preference.
 */
export function sellerCopyBoundaryNeeded(locale: SellerLocale): boolean {
  return locale === 'en'
}
