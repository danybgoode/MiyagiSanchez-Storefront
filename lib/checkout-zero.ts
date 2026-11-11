/**
 * lib/checkout-zero.ts — a $0 cart must not reach start-checkout (merchant-panel-gaps S2.1, review #491).
 *
 * The /checkout PAGE already redirects a listing priced 0/null away, but `POST /api/checkout/start` calls
 * startCheckout() directly and the backend's start-checkout has no zero-total refusal: a crafted request for
 * a free Evento could complete a $0 manual-payment order and walk past the RSVP capacity. This is the pure
 * decision; startCheckout() supplies the cart's own subtotal (read from Medusa after the lines are added).
 *
 * Three states, never two: a subtotal we could not read is UNKNOWN — it is neither «zero» nor «fine», and
 * is reported to the caller instead of being collapsed into either. The call site then FAILS CLOSED on it
 * (`zeroTotalRefusal`): an unreadable subtotal is exactly what a flaky read or an attacker-induced error
 * looks like, and letting it through would reopen the $0-order hole this guard exists to close.
 *
 * NO exemptions, and nothing read from the request body: an earlier version exempted offers, coupons, the
 * support widget and rentals by caller-supplied flags, and `support: {}` in a crafted body skipped the guard
 * (codex security review #491). None of those has a legitimate $0 SUBTOTAL — offers, support and rentals price
 * their lines above 0, and a coupon is a discount, which Medusa's `subtotal` is computed before — so the
 * cart's own subtotal decides alone.
 */
export const ZERO_TOTAL_CHECKOUT_MESSAGE = 'Este anuncio no tiene un precio para cobrar. Si es un evento gratis, regístrate desde su página.'

/** Shown when the cart's total could not be read: retryable, and we do NOT proceed to start-checkout. */
export const CART_TOTAL_UNVERIFIED_MESSAGE = 'No pudimos confirmar el total del carrito. Intenta de nuevo.'

export type ZeroTotalDecision = 'refuse' | 'allow' | 'unknown'

export function zeroTotalDecision(input: { subtotal: unknown; lineUnitPrices?: unknown[] }): ZeroTotalDecision {
  if (typeof input.subtotal !== 'number' || !Number.isFinite(input.subtotal)) return 'unknown'
  if (input.subtotal <= 0) return 'refuse'
  // Per LINE, not just the total: a free Evento added next to any paid item must not ride the paid total
  // past its RSVP capacity (codex review #491). A line whose price we cannot read is unknown, not fine.
  for (const price of input.lineUnitPrices ?? []) {
    if (typeof price !== 'number' || !Number.isFinite(price)) return 'unknown'
    if (price <= 0) return 'refuse'
  }
  return 'allow'
}

/** The refusal message the call site must throw for a decision, or null when checkout may proceed. */
export function zeroTotalRefusal(decision: ZeroTotalDecision): string | null {
  if (decision === 'refuse') return ZERO_TOTAL_CHECKOUT_MESSAGE
  if (decision === 'unknown') return CART_TOTAL_UNVERIFIED_MESSAGE
  return null
}
