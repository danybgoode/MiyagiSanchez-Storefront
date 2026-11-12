/**
 * lib/checkout-viability.ts
 *
 * Pure decision seam for the listing activation "can this actually be
 * checked out?" gate (extracted from `lib/listing-status.ts`'s
 * `checkCheckoutViability`, arranged-only-delivery epic, Sprint 1 · S1.2, so
 * the rule is unit-testable without a Medusa fetch — mirrors the
 * `lib/inventory-mode.ts` deriveInventoryMode pattern).
 *
 * Two paths to viable:
 *  - traditional: hasDelivery (carrier or local pickup) && hasPayment (any
 *    online rail or a manual one).
 *  - arranged (epic S1.2): delivery_mode === 'arranged' && a manual payment
 *    method (SPEI or cash) — no carrier/pickup required, since checkout
 *    strips card/instant rails for a coordinated sale (start-checkout's 422
 *    guard already enforces manual-only).
 * The 2026-07-11 "coexist-permissive" reading (an arranged listing with
 * shipping + card stays viable) was retired in epic listing-readiness: with
 * `shipping.arranged_only_enabled` ON in production, checkout only takes a
 * manual method for an arranged product, so that listing was unbuyable. The rule
 * now lives in lib/listing-readiness.ts.
 */

import { listingReadiness, readinessMessage } from './listing-readiness'

export interface CheckoutViabilityInput {
  listingType: string
  deliveryMode: 'carrier' | 'arranged' | null | undefined
  hasLiveShipping: boolean
  hasLocalPickup: boolean
  hasStripe: boolean
  hasMp: boolean
  hasSpei: boolean
  hasDimo: boolean
  hasCash: boolean
}

/**
 * Returns `null` when viable, or the es-MX error message to show the seller. A thin adapter over the ONE rule in
 * `lib/listing-readiness.ts` (epic listing-readiness S1.1) — kept for its callers and its spec; the rule lives there.
 */
export function deriveCheckoutViability(input: CheckoutViabilityInput): string | null {
  return readinessMessage(listingReadiness({
    listingType: input.listingType,
    deliveryMode: input.deliveryMode,
    shop: {
      payments: {
        stripe: input.hasStripe,
        mercadopago: input.hasMp,
        bankTransfer: input.hasSpei,
        dimo: input.hasDimo,
        cash: input.hasCash,
      },
      delivery: { liveShipping: input.hasLiveShipping, localPickup: input.hasLocalPickup },
    },
  }))
}
