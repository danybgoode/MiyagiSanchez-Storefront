/**
 * Who gets told about a sale — the in-person rules (in-person-sales D7).
 *
 * A counter sale is rung up BY the merchant, so an email or push saying «nueva venta» is noise
 * about something they just did. The Medusa orders a counter sale produces come from the
 * backend (or, for a card QR, from the provider webhook): the webhook is the only place that
 * emails a seller, so it is the place to switch that off. ONLY the seller's self-notification
 * is suppressed: order completion, the order mirror and the profit ledger run unchanged.
 *
 * The source is read from the PROVIDER metadata that start-checkout stamped on a cart our own
 * server built (the backend refuses to honour a client-labelled cart), never from a browser.
 */

/** The constant buyer address on a counter order whose buyer gave none (D6). Nothing is ever sent to it. */
export const COUNTER_PLACEHOLDER_EMAIL = 'mostrador@sin-correo.miyagisanchez.com'

type Meta = Record<string, unknown> | null | undefined

export function isInPersonSource(meta: Meta): boolean {
  return meta?.source === 'in_person'
}

/** False for an in-person sale: the merchant rang it up themselves. */
export function shouldNotifySellerOfSale(meta: Meta): boolean {
  return !isInPersonSource(meta)
}

/** An address a buyer actually gave: present and not the counter placeholder. */
export function isRealBuyerEmail(email: string | null | undefined): email is string {
  return typeof email === 'string' && email.trim() !== '' && email.trim().toLowerCase() !== COUNTER_PLACEHOLDER_EMAIL
}

/**
 * Buyer confirmation email. Unchanged for every non-counter order (any present address); for an
 * in-person order, only to an address that is not the placeholder.
 */
export function shouldEmailBuyer(meta: Meta, email: string | null | undefined): email is string {
  if (typeof email !== 'string' || email.trim() === '') return false
  return isInPersonSource(meta) ? isRealBuyerEmail(email) : true
}

/**
 * The buyer label the admin Telegram sale notice gets. For a counter sale it is neutral: the
 * buyer's address is personal data about someone standing at a stall, and the notice does not
 * need it. Every other order keeps today's label.
 */
export function telegramBuyerLabel(meta: Meta, email: string | null | undefined, fallback = 'comprador'): string {
  return isInPersonSource(meta) ? 'comprador en mostrador' : email ?? fallback
}
