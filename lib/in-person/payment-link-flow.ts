/**
 * «Pagar» on the pay page (in-person-sales S4.2, D15). PURE orchestration, I/O injected, so the
 * rules are testable without a network:
 *
 *  - Every opener gets a FRESH server-priced cart; the client never names a price or a seller.
 *  - A start-checkout that answers CHECKOUT_EXISTS or CART_CHANGED means that cart is spent: build
 *    another and try ONCE more, never loop.
 *  - A manual (transfer) payment completes the cart the same way the normal manual checkout does,
 *    so the order exists and the shop confirms it; a card payment hands back the provider URL.
 *  - Every refusal that matters (paid, expired, cancelled) is passed through in the page's words.
 */
import { shouldRebuildCart, type PayChoice } from './payment-link'
import type { ManualPayment } from './counter-checkout'

export type StartResult =
  | { ok: true; redirect_url: string | null; manual_payment: ManualPayment | null }
  | { ok: false; status: number; code?: string; message?: string }

export type CartResult =
  | { ok: true; cart_id: string }
  | { ok: false; status: number; code?: string; message?: string }

export interface PayFlowDeps {
  buildCart(): Promise<CartResult>
  startCheckout(cartId: string): Promise<StartResult>
  completeCart(cartId: string): Promise<boolean>
}

export type PayFlowResult =
  | { ok: true; kind: 'redirect'; url: string }
  | { ok: true; kind: 'manual'; manual: ManualPayment }
  | { ok: false; status: number; code: string; message: string }

const FAIL = (status: number, code: string, message: string): PayFlowResult => ({ ok: false, status, code, message })

export async function runPayFlow(choice: PayChoice['id'], deps: PayFlowDeps): Promise<PayFlowResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cart = await deps.buildCart()
    if (!cart.ok) return FAIL(cart.status, cart.code ?? 'LINK_UNAVAILABLE', cart.message ?? 'No pudimos abrir este cobro.')
    const started = await deps.startCheckout(cart.cart_id)
    if (!started.ok) {
      if (attempt === 0 && shouldRebuildCart(started.status, started.code)) continue
      return FAIL(started.status >= 400 ? started.status : 502, started.code ?? 'CHECKOUT_START_FAILED', started.message ?? 'No pudimos preparar el pago. Inténtalo de nuevo.')
    }
    if (choice === 'manual') {
      if (!started.manual_payment) return FAIL(502, 'MANUAL_PAYMENT_MISSING', 'La tienda no tiene datos de transferencia.')
      if (!(await deps.completeCart(cart.cart_id))) return FAIL(503, 'COMPLETE_FAILED', 'No pudimos registrar tu pago. Inténtalo de nuevo.')
      return { ok: true, kind: 'manual', manual: started.manual_payment }
    }
    if (!started.redirect_url) return FAIL(502, 'CHECKOUT_URL_MISSING', 'No pudimos abrir el pago. Inténtalo de nuevo.')
    return { ok: true, kind: 'redirect', url: started.redirect_url }
  }
  return FAIL(409, 'CART_CHANGED', 'Este cobro cambió. Ábrelo de nuevo.')
}
