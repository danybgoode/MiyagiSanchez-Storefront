import type { Listing } from './types'

/**
 * A listing's price as a buyer reads it. Lives apart from `lib/listings.ts` (which re-exports it) so pure seams —
 * the share kit's catalog model, its specs — can use the one formatter without importing `next/cache` and the Medusa
 * client along with it.
 */
export function formatPrice(listing: Pick<Listing, 'price_cents' | 'currency'>, locale = 'es-MX'): string {
  if (listing.price_cents == null) return locale === 'en-US' ? 'Ask for price' : 'Precio a consultar'
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: listing.currency ?? 'MXN',
  }).format(listing.price_cents / 100)
}
