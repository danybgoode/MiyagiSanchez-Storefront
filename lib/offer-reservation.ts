/**
 * The legacy Stripe / Mercado Pago listing checkouts (app/api/stripe/checkout, app/api/mp/checkout)
 * honoured ANY accepted offer id for the listing: no buyer check and nothing stopping several
 * discounted checkouts on one offer. They now follow the same rule as the Medusa start-checkout
 * rail (backend lib/offer-checkout.ts): only the buyer who made the offer may pay it, and one
 * accepted offer opens one checkout at a time.
 *
 *   decide (pure) -> claim (conditional update, read back with .select()) -> create the session
 *
 * The claim uses `checkout_reserved_at`; `checkout_expires_at` is the 24h payment window written when
 * the offer is accepted (lib/offers.ts offerPaymentDeadline) — an offer past it cannot be paid here,
 * exactly as the backend refuses it (security lens, PR 506). The
 * constants and the 409 copy mirror the backend on purpose; they are one reservation shared by
 * both rails, so a reservation made by one blocks the other.
 *
 * Pure decisions with injected I/O, so the spec needs no Supabase.
 */

export const OFFER_SESSION_TTL_MS = 31 * 60 * 1000
export const OFFER_RESERVATION_STALE_MS = OFFER_SESSION_TTL_MS + 5 * 60 * 1000
export const OFFER_IN_CHECKOUT_MESSAGE =
  `Ya tienes un pago abierto para esta oferta. Termínalo o inténtalo de nuevo en ${Math.round(OFFER_RESERVATION_STALE_MS / 60000)} minutos.`
export const OFFER_UNAVAILABLE_MESSAGE = 'No pudimos verificar la oferta. Inténtalo de nuevo en un momento.'

export type PurchasableOffer = {
  status: string | null
  offer_amount_cents: number | null
  counter_amount_cents: number | null
  buyer_clerk_user_id: string | null
  /** The 24h window to pay. NULL only on offers accepted before 2026-11-17 at a shop without Stripe: no deadline. */
  checkout_expires_at?: string | null
}

export const OFFER_EXPIRED_MESSAGE = 'El plazo para pagar esta oferta ya venció. Haz una nueva oferta.'

export type OfferGate =
  | { ok: true; offerId: string | null; priceCents: number | null; reservedAt: string | null }
  | { ok: false; status: 401 | 403 | 409 | 410 | 503; code: string; error: string }

/** A THROW = could not look / could not claim (unavailable, never "free to pay"). */
export type OfferLookup = (offerId: string, listingId: string) => Promise<PurchasableOffer | null>
export type OfferClaim = (offerId: string, nowIso: string, staleBeforeIso: string) => Promise<boolean>

export async function gateOfferPurchase(input: {
  offerId: string | undefined
  listingId: string
  clerkUserId: string | null
  now: Date
  lookup: OfferLookup
  claim: OfferClaim
}): Promise<OfferGate> {
  // No offer named: an ordinary purchase at the listing price, nothing to gate.
  if (!input.offerId) return { ok: true, offerId: null, priceCents: null, reservedAt: null }

  let offer: PurchasableOffer | null
  try {
    offer = await input.lookup(input.offerId, input.listingId)
  } catch {
    return { ok: false, status: 503, code: 'OFFER_UNAVAILABLE', error: OFFER_UNAVAILABLE_MESSAGE }
  }
  // A missing or not-accepted offer never lowered the price here (it falls back to the listing
  // price), so it stays that way and the offer id is not stamped on the session.
  if (!offer || offer.status !== 'accepted') return { ok: true, offerId: null, priceCents: null, reservedAt: null }

  // The negotiated price belongs to the buyer who made the offer.
  if (!input.clerkUserId) {
    return { ok: false, status: 401, code: 'OFFER_SIGN_IN', error: 'Inicia sesión para pagar tu oferta.' }
  }
  if (!offer.buyer_clerk_user_id || offer.buyer_clerk_user_id !== input.clerkUserId) {
    return { ok: false, status: 403, code: 'OFFER_NOT_YOURS', error: 'Esta oferta no es tuya.' }
  }
  if (offer.checkout_expires_at) {
    const exp = Date.parse(offer.checkout_expires_at)
    if (!Number.isFinite(exp) || exp <= input.now.getTime()) {
      return { ok: false, status: 410, code: 'OFFER_EXPIRED', error: OFFER_EXPIRED_MESSAGE }
    }
  }
  const agreed = offer.counter_amount_cents ?? offer.offer_amount_cents
  if (typeof agreed !== 'number' || !Number.isInteger(agreed) || agreed <= 0) {
    return { ok: false, status: 503, code: 'OFFER_UNAVAILABLE', error: OFFER_UNAVAILABLE_MESSAGE }
  }

  const nowIso = input.now.toISOString()
  const staleBeforeIso = new Date(input.now.getTime() - OFFER_RESERVATION_STALE_MS).toISOString()
  let won: boolean
  try {
    won = await input.claim(input.offerId, nowIso, staleBeforeIso)
  } catch {
    return { ok: false, status: 503, code: 'OFFER_UNAVAILABLE', error: OFFER_UNAVAILABLE_MESSAGE }
  }
  if (!won) return { ok: false, status: 409, code: 'OFFER_IN_CHECKOUT', error: OFFER_IN_CHECKOUT_MESSAGE }
  return { ok: true, offerId: input.offerId, priceCents: agreed, reservedAt: nowIso }
}

/** Best-effort release of OUR reservation (same id + the timestamp we wrote). Logged, never thrown. */
export async function releaseOfferReservation(
  release: (offerId: string, reservedAtIso: string) => Promise<void>,
  offerId: string,
  reservedAt: string,
  log: (m: string) => void = (m) => console.error(m),
): Promise<boolean> {
  try {
    await release(offerId, reservedAt)
    return true
  } catch (e) {
    log(`[offer-reservation] release of offer ${offerId} failed: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a structural Supabase client, kept loose so the helpers stay unit-testable
type Db = { from: (t: string) => any }

export function dbOfferLookup(db: Db): OfferLookup {
  return async (offerId, listingId) => {
    const { data, error } = await db
      .from('marketplace_offers')
      .select('status, offer_amount_cents, counter_amount_cents, buyer_clerk_user_id, checkout_expires_at')
      .eq('id', offerId)
      .eq('listing_id', listingId)
      .maybeSingle()
    if (error) throw new Error(error.message ?? 'offer lookup failed')
    return data ?? null
  }
}

export function dbOfferClaim(db: Db): OfferClaim {
  return async (offerId, nowIso, staleBeforeIso) => {
    const { data, error } = await db
      .from('marketplace_offers')
      .update({ checkout_reserved_at: nowIso })
      .eq('id', offerId)
      .eq('status', 'accepted')
      .or(`checkout_reserved_at.is.null,checkout_reserved_at.lt.${staleBeforeIso}`)
      // The window is part of the claim too (the read above can outlast it). Two `or=` params are ANDed by
      // PostgREST (verified live 2026-11-12); the backend claims with the same pair.
      .or(`checkout_expires_at.is.null,checkout_expires_at.gt.${nowIso}`)
      .select('id')
    if (error) throw new Error(error.message ?? 'offer claim failed')
    return Array.isArray(data) && data.length > 0
  }
}

export function dbOfferRelease(db: Db) {
  return async (offerId: string, reservedAtIso: string) => {
    const { error } = await db
      .from('marketplace_offers')
      .update({ checkout_reserved_at: null })
      .eq('id', offerId)
      .eq('checkout_reserved_at', reservedAtIso)
    if (error) throw new Error(error.message ?? 'offer release failed')
  }
}
