/**
 * lib/checkout-options.ts — what checkout offers a buyer, and the merchant's preview of it (prompt-to-shop S5.1).
 *
 * WHERE THE RULE LIVES. Which payment and delivery methods a buyer sees is decided by ONE function, in the Medusa
 * backend: `GET /store/sellers/:slug/checkout-options` (`resolveSellerPaymentMethods` + `buildDeliveryCatalog`, with
 * the coordinated-only, digital and cash-needs-pickup cross-rules). The storefront proxies it through
 * `GET /api/checkout/options` (which adds the platform payment kill-switches) and `CheckoutExperience` renders the
 * answer. That rule is in another repository and cannot be imported here, and re-deriving it from the shop's
 * settings would be a second rule that drifts the first time the backend changes one condition.
 *
 * So the preview does not re-derive anything. It asks the SAME endpoint, with the SAME query checkout sends for a
 * plain product (`checkoutOptionsQuery`), and `checkoutPreview` turns that answer into the buyer-visible list the way
 * `CheckoutExperience` draws it: every online method by its label, the one «Pago directo» method expanded into its
 * sub-options, every delivery method by its label. What the merchant previews is what a buyer is offered, by
 * construction — including a saved setting that never reached the Medusa seller, which checkout would not see either.
 *
 * The response types below are checkout's own; `CheckoutExperience` imports them from here so the two cannot read
 * different shapes. Pure and next-free.
 */

import type { CheckoutFulfillmentMethod, CheckoutProvider, ManualSubType } from './cart'

// ── Shapes returned by /api/checkout/options (Medusa source of truth) ────────
export type PickupSpot = { id: string; name?: string; address?: string; hours?: string; scheduling_url?: string; notes?: string }
export type DeliveryMethod = {
  id: CheckoutFulfillmentMethod
  label: string
  note: string
  requires_address?: boolean
  requires_pickup_spot?: boolean
  pickup_spots?: PickupSpot[]
}
export type ManualSubOption = { type: ManualSubType; label: string; note: string; requires_pickup?: boolean }
export type PaymentMethod = { id: CheckoutProvider; kind: 'online' | 'manual'; label: string; note: string; instant: boolean; protected?: boolean; sub_options?: ManualSubOption[] }
export type CheckoutOptions = {
  payment_methods: PaymentMethod[]
  payment_default: CheckoutProvider | null
  delivery_methods: DeliveryMethod[]
  delivery_default: CheckoutFulfillmentMethod | null
  only_coordinated: boolean
  preparation: string | null
}

/**
 * The query `CheckoutExperience` sends for a buyer checking out one plain product from this shop — the listing a
 * new shop's first products are. `deliveryMode: 'carrier'` is checkout's own default for a listing that declares
 * none (`app/(shell)/checkout/page.tsx`).
 */
export function checkoutOptionsQuery(sellerSlug: string, market: string = 'mx'): string {
  return new URLSearchParams({ sellerId: sellerSlug, listingType: 'product', isDigital: 'false', deliveryMode: 'carrier', market }).toString()
}

export interface PreviewItem {
  /** Stable for a list key and a spec: the method id, or `manual:<sub-type>` for a «Pago directo» sub-option. */
  key: string
  label: string
  note: string
}

export type CheckoutPreview =
  | { kind: 'ready'; payments: PreviewItem[]; delivery: PreviewItem[] }
  /** The endpoint answered with an error, or something that is not checkout's shape: we could not tell. */
  | { kind: 'unavailable' }

function isOptions(value: unknown): value is CheckoutOptions {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return Array.isArray(v.payment_methods) && Array.isArray(v.delivery_methods)
}

/**
 * Checkout's answer → the list a buyer sees. A body that is not checkout's shape (an `{ error }`, a 5xx page) is
 * `unavailable` — never an empty list, which would read as "your buyer sees nothing".
 */
export function checkoutPreview(response: unknown): CheckoutPreview {
  if (!isOptions(response)) return { kind: 'unavailable' }
  const payments: PreviewItem[] = []
  for (const method of response.payment_methods) {
    if (method.kind === 'manual' && Array.isArray(method.sub_options)) {
      // CheckoutExperience shows «Pago directo» and, under it, one choice per sub-option: those are the methods.
      for (const sub of method.sub_options) payments.push({ key: `manual:${sub.type}`, label: sub.label, note: sub.note })
    } else {
      payments.push({ key: method.id, label: method.label, note: method.note })
    }
  }
  const delivery = response.delivery_methods.map((d) => ({ key: d.id, label: d.label, note: d.note }))
  return { kind: 'ready', payments, delivery }
}
