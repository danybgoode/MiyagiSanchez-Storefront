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

export type CancelVerdict = 'cancelled' | 'paid' | 'unverified' | 'keep_waiting' | 'leave_pending'

/**
 * A cancel answer. Anything that is not an explicit `cancelled` keeps the sale waiting:
 * CANCEL_FAILED (the QR may still be payable) and PAYMENT_IN_PROGRESS (the buyer is paying
 * right now) must never look like a cancellation.
 */
export function cancelVerdict(input: { ok: boolean; code?: string | null; state?: SaleState | null }): CancelVerdict {
  // A transfer is already a pending order once its CLABE shows; the backend will not cancel it
  // from the counter. The order stays in Pedidos for the merchant to confirm or cancel there.
  if (!input.ok && input.code === 'TRANSFER_ORDER_EXISTS') return 'leave_pending'
  if (input.ok && input.state) {
    const screen = screenForState(input.state)
    if (screen === 'paid') return 'paid'
    if (screen === 'unverified') return 'unverified'
    if (input.state === 'cancelled') return 'cancelled'
  }
  return 'keep_waiting'
}

export const LEAVE_PENDING_NOTE = 'El pedido queda en Pedidos como pendiente de pago. Ahí lo confirmas o lo cancelas cuando quieras.'
export const UNVERIFIED_MESSAGE = 'No pudimos confirmar el pago con tarjeta. No entregues el producto.'
