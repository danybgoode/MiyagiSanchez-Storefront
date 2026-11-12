import type { ActiveDeal } from '@/lib/active-deal'

export type BuyerPrefill = { name: string; email: string }

export type PdpViewerState = {
  signedIn: boolean
  ownsListing: boolean
  favorited: boolean
  activeDeal: ActiveDeal | null
  buyerPrefill: BuyerPrefill | null
}

export const SIGNED_OUT_PDP_VIEWER_STATE: PdpViewerState = {
  signedIn: false,
  ownsListing: false,
  favorited: false,
  activeDeal: null,
  buyerPrefill: null,
}

/**
 * What the cached (public-read) PDP shows for an ACCEPTED, unpaid offer: the agreed
 * price, and the list price struck through when the deal is below it.
 *
 * The dynamic PDP always showed the agreed price; the public-read island showed only
 * «oferta aceptada» with no number — so a buyer who opened the product page after
 * the seller accepted saw the OLD price and nothing else (reported live 2026-11-11,
 * miel-verduras: offer $225, countered and accepted at $300). `null` when there is
 * no accepted deal with a price — the island then shows no deal box at all.
 */
export function agreedDealDisplay(
  deal: Pick<ActiveDeal, 'status' | 'dealPriceCents' | 'currency'> | null,
  listPriceCents: number | null,
): { dealCents: number; currency: string; listCents: number | null } | null {
  if (deal?.status !== 'accepted_unpaid' || !deal.dealPriceCents || deal.dealPriceCents <= 0) return null
  return {
    dealCents: deal.dealPriceCents,
    currency: deal.currency,
    listCents: listPriceCents && listPriceCents > deal.dealPriceCents ? listPriceCents : null,
  }
}
