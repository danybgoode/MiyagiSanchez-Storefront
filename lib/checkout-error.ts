/**
 * A failed checkout start that keeps the backend's machine-readable `code` next to its message.
 * The message alone cannot drive recovery: the buyer-facing text is Spanish prose that callers
 * must not substring-match. Client-safe (no imports) so lib/cart-client.ts can use it.
 */
export const SHIPPING_QUOTE_INVALID = 'SHIPPING_QUOTE_INVALID'

export class CheckoutStartError extends Error {
  code: string | null
  constructor(message: string, code: string | null = null) {
    super(message)
    this.name = 'CheckoutStartError'
    this.code = code
  }
}

/** True when the backend refused the shipping quote (stale, expired or forged): pick the rate again. */
export function isShippingQuoteInvalid(err: unknown): boolean {
  return err instanceof CheckoutStartError && err.code === SHIPPING_QUOTE_INVALID
}
