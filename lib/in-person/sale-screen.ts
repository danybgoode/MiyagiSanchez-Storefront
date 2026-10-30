/**
 * What the counter shows for a backend sale state, and what a cancel answer means
 * (in-person-sales S2, D9 + the security review). PURE: the one place that decides whether
 * a screen may say «Pagado».
 *
 * `unverified` is a card sale whose cart became an order WITHOUT going through Stripe /
 * Mercado Pago (a buyer swapped the payment session to cash). It is NEVER paid: the merchant
 * is told not to hand the goods over, and polling stops.
 */
import type { SaleState } from './counter-checkout'

export type SaleScreen = 'waiting' | 'paid' | 'released' | 'unverified'

export function screenForState(state: SaleState): SaleScreen {
  switch (state) {
    case 'paid': return 'paid'
    case 'cancelled':
    case 'failed': return 'released'
    case 'unverified': return 'unverified'
    default: return 'waiting' // awaiting_payment, pending_confirmation
  }
}

export type CancelVerdict = 'cancelled' | 'paid' | 'unverified' | 'keep_waiting'

/**
 * A cancel answer. Anything that is not an explicit `cancelled` keeps the sale waiting:
 * CANCEL_FAILED (the QR may still be payable) and PAYMENT_IN_PROGRESS (the buyer is paying
 * right now) must never look like a cancellation.
 */
export function cancelVerdict(input: { ok: boolean; code?: string | null; state?: SaleState | null }): CancelVerdict {
  if (input.ok && input.state) {
    const screen = screenForState(input.state)
    if (screen === 'paid') return 'paid'
    if (screen === 'unverified') return 'unverified'
    if (input.state === 'cancelled') return 'cancelled'
  }
  return 'keep_waiting'
}

export const UNVERIFIED_MESSAGE = 'No pudimos confirmar el pago con tarjeta. No entregues el producto.'
