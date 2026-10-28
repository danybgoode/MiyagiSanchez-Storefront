import type { RecentFavorite } from './home-favorites'
import type { OfferAlertInput } from './home-offer-alert'

/**
 * Marketplace static-shell — Sprint 4 (Phase 2): the next-free seam for the homepage
 * personalization client islands. The static homepage (`app/(site)/page.tsx`) can no
 * longer read `currentUser()` — so the signed-in modules return as client islands that
 * fetch the S3 Cloud Run endpoint (`GET /store/home/personalization`) after hydration.
 * This module holds the wire-contract type + the pure render helpers the islands need,
 * kept free of `next/*` and the db/SDK clients so a pure-logic `api` spec
 * (`e2e/home-personalization.spec.ts`) covers them without auth/network.
 *
 * (`lib/listings.ts conditionLabel` can't be reused here — that module imports
 * `next/cache`, which the islands + the Playwright runner can't load — so the condition
 * label is re-derived below as `favoriteConditionLabel`.)
 */

/** The exact JSON the S3 endpoint returns (raw data; the islands derive es-MX copy). */
export interface HomePersonalization {
  recentFavorites: RecentFavorite[]
  /** Buyer + seller pending offers; the island runs `deriveOfferAlerts` for the copy. */
  offerAlertInputs: OfferAlertInput[]
  sellerSnapshot: { shopName: string; visitas: number; ofertasNuevas: number } | null
  hasShop: boolean
}

/**
 * Price label for the retoma rail (a `RecentFavorite` carries cents + currency, not a
 * `Listing`). Lifted verbatim from the pre-S2 `app/page.tsx`.
 */
export function priceLabel(cents: number | null, currency: string): string {
  if (cents == null) return 'Precio a consultar'
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(cents / 100)
  } catch {
    // A malformed/missing currency code from the wire would throw a RangeError and blank
    // the whole client render — degrade to a plain amount instead.
    return new Intl.NumberFormat('es-MX').format(cents / 100)
  }
}

export interface PriceDrop {
  dropped: boolean
  dropAmountCents: number
}

/**
 * Price-drop derivation for the retoma rail's "↓ Bajó $N" badge (S2.2). Mirrors
 * exactly the comparison already proven on `/account/favorites`
 * (`app/(shell)/account/favorites/page.tsx`): both operands must be truthy
 * (non-null, non-zero) and the current price strictly less than the snapshot —
 * `priceCentsAtSave: null` (a favorite saved before the snapshot column existed,
 * or the listing price itself missing) degrades to no badge, never a crash.
 */
export function derivePriceDrop(priceCentsAtSave: number | null, priceCents: number | null): PriceDrop {
  const dropped = !!(priceCentsAtSave && priceCents && priceCents < priceCentsAtSave)
  return { dropped, dropAmountCents: dropped ? priceCentsAtSave! - priceCents! : 0 }
}

/**
 * es-MX condition label — the next-free twin of `lib/listings.ts conditionLabel`
 * (which can't be imported client-side). Same map; `null`/unknown degrade safely.
 */
export function favoriteConditionLabel(condition: string | null): string {
  const map: Record<string, string> = {
    new: 'Nuevo',
    like_new: 'Como nuevo',
    good: 'Buen estado',
    fair: 'Aceptable',
    parts: 'Para piezas',
  }
  return condition ? (map[condition] ?? condition) : ''
}

/**
 * Which seller module the signed-in homepage shows. This is the DEFENSIVE half of the
 * recruit-card-leak fix: it trusts `hasShop` and guarantees a shop owner is never shown
 * the "¿Vendes algo?" recruit card. The AUTHORITATIVE half is the backend — `hasShop`
 * itself must come from the canonical Medusa seller, not the best-effort Supabase mirror
 * (MiyagiSanchez-Backend #38); a wrong `hasShop=false` would still recruit and is fixed
 * there, not here. Given a correct `hasShop`:
 *   - no shop            → `recruit`  ("¿Vendes algo?" / Abre tu tienda)
 *   - shop + stats       → `snapshot` ("Tu tienda esta semana")
 *   - shop, no stats yet → `none`     (render nothing — never recruit a shop owner)
 */
export function sellerModule(p: {
  hasShop: boolean
  sellerSnapshot: HomePersonalization['sellerSnapshot']
}): 'snapshot' | 'recruit' | 'none' {
  if (!p.hasShop) return 'recruit'
  return p.sellerSnapshot ? 'snapshot' : 'none'
}

/**
 * The one breadcrumb for the island's fail-open fetch (S1.3) — "fail-open by design" must
 * never again mask a prod outage silently the way the build-arg bug did (sprint-1.md
 * Story 1.1). `reason` is either the HTTP status (non-ok response) or the caught error
 * (network/JSON failure). No retry, no UI — just a console signal an on-call human or a
 * log-based alert can pick up.
 */
export function logPersonalizationFetchFailure(reason: number | unknown): void {
  console.warn('[home-personalization] fetch failed', reason)
}
