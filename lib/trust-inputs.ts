/**
 * lib/trust-inputs.ts
 *
 * Cross-channel Storefront Trust Parity (#3c · Epic D) — Sprint 1, D.0.
 *
 * The pure, next-free **deriver** that turns a shop's stored settings
 * (`shop.metadata` / `…metadata.settings` + `shop.verified`) into the props the
 * presentational `<TrustSignals>` component (Epic C / C.4) expects.
 *
 * C.4 deliberately kept `<TrustSignals>` presentational — the marketplace PDP
 * (`app/l/[id]/page.tsx`) and shop page (`app/s/[slug]/page.tsx`) each derive the
 * inputs inline. Epic D wires the SAME component into two more surfaces (the embed
 * shop grid + the white-label shell), and both need the same SHOP-LEVEL derivation,
 * so it lives here once — a single seam D.1 + D.2 share, unit-tested in the `api` gate.
 *
 * This mirrors the **shop-level** signals of `app/s/[slug]/page.tsx` (the parity
 * reference) — NOT the listing-type-specific PDP derivation (no digital / service /
 * rental at shop scope). No JSX, no network, no `next/*` import.
 */

import { returnsWindowLabel, type TrustMethod } from '@/lib/trust-signals'
import { publicShopPaymentAvailability } from '@/lib/public-shop-commerce'
import { shopWhatsAppNumber } from '@/lib/share-kit/whatsapp'

export interface ShopTrustInputs {
  paymentMethods: TrustMethod[]
  fulfillmentMethods: TrustMethod[]
  processingLabel: string | null
  returnsLabel: string | null
  verified: boolean
  /** Any online card rail (Stripe / Mercado Pago) ⇒ buyer payment protection. */
  paymentProtected: boolean
}

/**
 * Order-processing windows → positive es-MX labels. Mirrors the PDP/shop page.
 * Exported so the catalog-management epic's per-listing "sobre pedido —
 * envío estimado" note (Sprint 2 · Story 2.1) can reuse the same vocabulary
 * as this shop-wide setting without a second, drifting copy of the map.
 */
export const PROCESSING_LABELS: Record<string, string> = {
  '1d': '1 día hábil',
  '1-3d': '1–3 días hábiles',
  '3-5d': '3–5 días hábiles',
  '1-2w': '1–2 semanas',
}

/**
 * Derive the `<TrustSignals>` inputs from a shop's Medusa `metadata`.
 *
 * @param metadata `shop.metadata` (the whole object — `mp_enabled` lives at the top
 *   level; everything else under `metadata.settings`). Tolerant of `null`/`undefined`.
 * @param verified `shop.verified`.
 */
export function deriveShopTrustInputs(
  metadata: Record<string, unknown> | null | undefined,
  verified?: boolean,
): ShopTrustInputs {
  const meta = (metadata ?? {}) as Record<string, unknown>
  const settings = (meta.settings ?? {}) as Record<string, unknown>

  const theme = (settings.theme ?? {}) as { social?: { whatsapp?: string | null } }
  const checkout = (settings.checkout ?? {}) as {
    phone?: string | null
    whatsapp_cta?: boolean
  }
  const shipping = (settings.shipping ?? {}) as {
    local_pickup?: boolean
    pickup_spots?: Array<{ name?: string; address?: string }>
  }
  const scheduling = (settings.scheduling ?? {}) as { links?: Array<{ label?: string; url?: string }> }
  const calcom = (settings.calcom ?? {}) as { connected?: boolean; booking_url?: string; event_type_title?: string }
  const orders = (settings.orders ?? {}) as { processing_time?: string }
  const returnsPolicy = settings.returns_policy as { window?: string } | null | undefined
  const paymentAvailability = publicShopPaymentAvailability(meta)
  const whatsapp = shopWhatsAppNumber({ checkout, theme })

  const localPickup = !!shipping.local_pickup
  const pickupSpots = localPickup ? (shipping.pickup_spots ?? []) : []
  const hasScheduling = !!(calcom.connected && calcom.booking_url) || !!scheduling.links?.some(l => l.url)
  const bookingLabel = calcom.event_type_title ?? scheduling.links?.find(l => l.url)?.label ?? 'Agenda disponible'

  const processingLabel = orders.processing_time
    ? PROCESSING_LABELS[orders.processing_time] ?? orders.processing_time
    : null
  const returnsLabel = returnsWindowLabel(returnsPolicy?.window)

  const paymentMethods = [
    paymentAvailability.mercadopago && { icon: 'iconoir-credit-card', label: 'Mercado Pago', note: 'Tarjeta, wallet, OXXO' },
    paymentAvailability.stripe && { icon: 'iconoir-credit-card', label: 'Tarjeta', note: 'Stripe Connect' },
    paymentAvailability.bankTransfer && { icon: 'iconoir-bank', label: 'SPEI', note: 'Transferencia bancaria' },
    paymentAvailability.dimo && { icon: 'iconoir-smartphone-device', label: 'DiMo', note: 'Transferencia por teléfono' },
    whatsapp && { icon: 'iconoir-chat-bubble', label: 'WhatsApp', note: 'Acordar directo' },
  ].filter(Boolean) as TrustMethod[]

  // Shop-level fulfillment: pickup + scheduling. Processing surfaces as the "Lista en …"
  // pill (`processingLabel`), so it is not duplicated as a chip here.
  const fulfillmentMethods = [
    localPickup && {
      icon: 'iconoir-shop',
      label: 'Recolección local',
      note: pickupSpots.length > 1
        ? `${pickupSpots.length} puntos de entrega`
        : pickupSpots[0]?.name
          ? `${pickupSpots[0].name}${pickupSpots[0].address ? ` · ${pickupSpots[0].address}` : ''}`
          : 'Punto de entrega — coordina con la tienda',
    },
    hasScheduling && { icon: 'iconoir-calendar', label: 'Agenda', note: bookingLabel },
  ].filter(Boolean) as TrustMethod[]

  return {
    paymentMethods,
    fulfillmentMethods,
    processingLabel,
    returnsLabel,
    verified: !!verified,
    paymentProtected: paymentAvailability.stripe || paymentAvailability.mercadopago,
  }
}
