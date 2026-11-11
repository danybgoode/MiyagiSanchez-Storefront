/**
 * lib/checkout-zero.ts — a $0 cart must not reach start-checkout (merchant-panel-gaps S2.1, review #491).
 *
 * The /checkout PAGE already redirects a listing priced 0/null away, but `POST /api/checkout/start` calls
 * startCheckout() directly and the backend's start-checkout has no zero-total refusal: a crafted request for
 * a free Evento could complete a $0 manual-payment order and walk past the RSVP capacity. This is the pure
 * decision; startCheckout() supplies the cart's own subtotal (read from Medusa after the lines are added).
 *
 * Three states, never two: a subtotal we could not read is UNKNOWN — it is neither «zero» nor «fine», and
 * is reported to the caller instead of being collapsed into either.
 *
 * Exempt on purpose, because their price is not the listing's: an accepted offer / coupon (negotiated),
 * the guest support widget and rentals (priced server-side).
 */
export const ZERO_TOTAL_CHECKOUT_MESSAGE = 'Este anuncio no tiene un precio para cobrar. Si es un evento gratis, regístrate desde su página.'

export type ZeroTotalDecision = 'refuse' | 'allow' | 'unknown'

export function zeroTotalDecision(input: {
  subtotal: unknown
  exempt: { offer?: boolean; coupon?: boolean; support?: boolean; rental?: boolean }
}): ZeroTotalDecision {
  const { offer, coupon, support, rental } = input.exempt
  if (offer || coupon || support || rental) return 'allow'
  if (typeof input.subtotal !== 'number' || !Number.isFinite(input.subtotal)) return 'unknown'
  return input.subtotal <= 0 ? 'refuse' : 'allow'
}
