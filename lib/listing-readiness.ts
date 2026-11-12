/**
 * lib/listing-readiness.ts — THE answer to "can a buyer pay for this listing online?"
 *
 * Every product is either buyable online or «Solo catálogo» (buyers write to the merchant). Reported live
 * 2026-11-11 (miel-verduras, a promoter training): a product went live on a shop with no payment method, a buyer made
 * an offer, the seller accepted it, and nobody could pay. The rule existed — four times, and they had drifted:
 *   - `lib/checkout-viability.ts` `deriveCheckoutViability` (activation; knew about arranged delivery)
 *   - `lib/listing-status.ts` `checkCheckoutViability` (its owner-facts reader; v1-only Stripe)
 *   - `lib/seller-products.ts` `listingActivationBlock` (MCP; ignored arranged delivery and cash)
 *   - `lib/public-shop-commerce.ts` `shopAcceptsAnyPayment` (buyer surfaces; `configured` flags)
 * and `POST /api/sell/create` — the new-listing form — asked none of them. All of them now delegate here.
 *
 * Two fact readers, ONE rule (epic listing-readiness D2):
 *   - `ownerShopFacts` reads the seller's PRIVATE settings (a real 18-digit CLABE, a DiMo phone, cash at pickup) —
 *     for owner doors (create, activate, MCP, the readiness panel).
 *   - `publicShopFacts` reads the privacy-safe PUBLIC projection (`configured` flags, no coordinates) — for buyer
 *     surfaces. It cannot see delivery, so delivery is `unknown` there and does not block (price/market/claim are
 *     still decided by `resolveCommerceReadiness` and the claim checks).
 * Never read either from the Supabase mirror: it lags the Medusa seller (it has no bank-transfer config at all).
 *
 * Pure, next-free and SDK-free (client-importable) — unit-tested in `e2e/listing-readiness.spec.ts`.
 */

import { publicShopPaymentAvailability, stripeIsAvailable } from './public-shop-commerce'

/** Rails a buyer can pay on. `cash` counts ONLY for arranged delivery (cash at the meetup), like checkout. */
export interface PaymentFacts {
  readonly stripe: boolean
  readonly mercadopago: boolean
  readonly bankTransfer: boolean
  readonly dimo: boolean
  readonly cash: boolean
}

export interface DeliveryFacts {
  readonly liveShipping: boolean
  readonly localPickup: boolean
}

export interface ShopFacts {
  readonly payments: PaymentFacts
  /** `null` = not knowable from this view (the public projection carries no shipping). Never "none". */
  readonly delivery: DeliveryFacts | null
}

export type ReadinessMissing = 'payment' | 'delivery' | 'manual_payment'

export type ListingReadiness =
  | { readonly mode: 'online' }
  | { readonly mode: 'catalog'; readonly missing: readonly ReadinessMissing[] }

export type DeliveryMode = 'carrier' | 'arranged' | null | undefined

/** SPEI or cash at pickup — the only rails a COORDINATED sale (arranged product, service, rental) can be paid on. */
export function hasManualPayment(payments: PaymentFacts): boolean {
  return payments.bankTransfer || payments.cash
}

/** Listing types checkout always treats as coordinated (backend `isCoordinatedListing`): manual payment only. */
export const COORDINATED_TYPES: ReadonlySet<string> = new Set(['service', 'rental'])

/** The shop can take a payment for an ordinary checkout (card, Mercado Pago, transfer or DiMo). Offers need this. */
export function canCollect(payments: PaymentFacts): boolean {
  return payments.stripe || payments.mercadopago || payments.bankTransfer || payments.dimo
}

/**
 * D1. A `product` sells online iff the shop can collect AND has a delivery path — or its delivery is arranged and the
 * shop takes a manual method (SPEI or cash). Every other listing type (service, inmueble, auto, event, digital…) is
 * contact- or flow-capable by design and is never «Solo catálogo» here.
 */
export function listingReadiness(input: {
  listingType: string | null | undefined
  deliveryMode: DeliveryMode
  shop: ShopFacts
}): ListingReadiness {
  if ((input.listingType ?? 'product') !== 'product') return { mode: 'online' }
  const { payments, delivery } = input.shop
  // An arranged product is a COORDINATED sale: with `shipping.arranged_only_enabled` on (production since 2026-09-22)
  // checkout drops carrier shipping and `start-checkout` refuses every non-manual rail (backend delivery-catalog.ts
  // `isCoordinatedListing`, start-checkout COORD_MESSAGE). So it sells ONLY on SPEI or cash — no fallthrough to the card
  // path. The 2026-07-11 "coexist" reading predates the flag; the fresh review + cross-family pass on PR 497 caught it.
  if (input.deliveryMode === 'arranged') {
    return hasManualPayment(payments) ? { mode: 'online' } : { mode: 'catalog', missing: ['manual_payment'] }
  }
  const hasDelivery = delivery === null || delivery.liveShipping || delivery.localPickup
  if (hasDelivery && canCollect(payments)) return { mode: 'online' }
  const missing: ReadinessMissing[] = []
  if (!hasDelivery) missing.push('delivery')
  if (!canCollect(payments)) missing.push('payment')
  return { mode: 'catalog', missing }
}

/** The es-MX sentence a merchant sees for a catalog result; `null` when the listing sells online. */
export function readinessMessage(readiness: ListingReadiness): string | null {
  if (readiness.mode === 'online') return null
  if (readiness.missing.includes('manual_payment')) {
    return 'Para activar este anuncio con entrega acordada, configura al menos un método de pago ' +
      'manual (SPEI o recolección con efectivo). Ve a Mi tienda → Configuración → Pagos.'
  }
  const parts: string[] = []
  if (readiness.missing.includes('delivery')) parts.push('una forma de entrega (envío a domicilio o recolección en mano)')
  if (readiness.missing.includes('payment')) parts.push('un método de pago (MercadoPago, Stripe, SPEI o DiMo)')
  return `Para activar este anuncio configura ${parts.join(' y ')}. Ve a Mi tienda → Configuración → Pagos y Envíos.`
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function digits(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\D/g, '') : ''
}

/** Facts from the seller's PRIVATE metadata (owner-authenticated reads only). */
export function ownerShopFacts(metadata: Record<string, unknown> | null | undefined): ShopFacts {
  const meta = objectValue(metadata)
  const settings = objectValue(meta.settings)
  const shipping = objectValue(settings.shipping)
  const checkout = objectValue(settings.checkout)

  const origin = objectValue(shipping.origin_address)
  const liveShipping = shipping.envia_enabled !== false &&
    !!(origin.street && origin.city && origin.postal_code && (origin.state_code || origin.state))
  const localPickup = !!shipping.local_pickup

  // Inline (not lib/stripe's getShopStripe): that module loads the Stripe SDK, and this seam is client-importable.
  const stripe = objectValue(settings.stripe)
  // Either generation: the v1 owner keys (charges_enabled + account_id) OR the public rule, which also understands
  // US Accounts v2 — the owner copy used to know only v1, so a ready US seller read as "no payment".
  const stripeOk = stripe.enabled !== false && (
    !!(stripe.charges_enabled && stripe.account_id) || stripeIsAvailable(stripe)
  )
  const mp = objectValue(settings.mercadopago)
  const mercadopago = meta.mp_enabled !== false && mp.connected === true
  const bank = objectValue(checkout.bank_transfer)
  const bankTransfer = bank.enabled !== false && digits(bank.clabe).length === 18
  const dimoCfg = objectValue(checkout.dimo)
  const dimo = dimoCfg.enabled === true && digits(dimoCfg.phone).length >= 10
  // Mirrors the backend's sellerHasCash(): cash is paid at the pickup, so it needs pickup.
  const cash = localPickup && objectValue(checkout.cash_pickup).enabled !== false

  return {
    payments: { stripe: stripeOk, mercadopago, bankTransfer, dimo, cash },
    delivery: { liveShipping, localPickup },
  }
}

/** Facts from the privacy-safe PUBLIC projection (buyer surfaces). Delivery is unknown here, never "none". */
export function publicShopFacts(metadata: Record<string, unknown> | null | undefined): ShopFacts {
  const p = publicShopPaymentAvailability(metadata)
  // The public projection carries `shipping` and `checkout.cash_pickup` (backend toSellerShape), so cash-at-pickup is
  // knowable here — needed for an arranged-delivery listing, which sells on SPEI OR cash. Same rule as the owner side.
  const settings = objectValue(objectValue(metadata).settings)
  const cash = !!objectValue(settings.shipping).local_pickup &&
    objectValue(objectValue(settings.checkout).cash_pickup).enabled !== false
  return {
    payments: { stripe: p.stripe, mercadopago: p.mercadopago, bankTransfer: p.bankTransfer, dimo: p.dimo, cash },
    delivery: null,
  }
}

/** Machine code every owner door answers with, so the form can open the readiness panel (S2.1). */
export const LISTING_NOT_READY = 'LISTING_NOT_READY' as const

/**
 * The publish/activate decision (S1.2, D4): a listing that sells online goes live; a catalog one goes live only when
 * the merchant explicitly chose «Publicar como catálogo»; otherwise the refusal names what is missing.
 */
export function listingNotReadyRefusal(
  readiness: ListingReadiness,
  publishAsCatalog: boolean,
): { code: typeof LISTING_NOT_READY; error: string; missing: readonly ReadinessMissing[] } | null {
  if (readiness.mode === 'online' || publishAsCatalog) return null
  return { code: LISTING_NOT_READY, error: readinessMessage(readiness) ?? '', missing: readiness.missing }
}

/** Every surface's words for readiness, in one place (es-MX, polished — Daniel 2026-11-03). */
export const READINESS_COPY = {
  panelTitle: 'Antes de publicar',
  notReadyTitle: 'Tus clientes aún no podrán pagar en línea',
  missing: {
    payment: 'Cobro: activa al menos una forma de cobro',
    delivery: 'Entrega: activa envíos o recolección',
    manual_payment: 'Cobro manual: activa SPEI o efectivo para la entrega acordada',
  } satisfies Record<ReadinessMissing, string>,
  ready: { payment: 'Cobro', delivery: 'Entrega' },
  fixPayments: 'Activar cobros',
  publishAsCatalog: 'Publicar como catálogo',
  catalogHint: 'Tus clientes verán el producto y te escribirán para comprarlo. Cuando actives un cobro, se podrá pagar en línea sin que hagas nada más.',
  bannerTitle: 'Tu tienda aún no puede cobrar',
  bannerBody: 'Tus productos se ven, pero nadie puede pagarlos en línea. Activa una forma de cobro: con tu CLABE toma 2 minutos.',
  catalogBadge: 'Solo catálogo',
  catalogBadgeHint: 'Se ve en tu tienda; tus clientes te escriben para comprar.',
  sellerOffersBlocked: 'Activa cómo cobrar para aceptar ofertas: hoy nadie podría pagarte el precio acordado.',
  buyerOffersUnavailable: 'Esta tienda todavía no acepta pagos en línea. Escríbele para comprar.',
  offerCheckFailed: 'No pudimos revisar los pagos de esta tienda. Inténtalo en un momento.',
  guideLocked: 'Termina «Activa cómo cobrar» para ocultar esta guía: tus productos ya están a la vista.',
} as const

/** Where a merchant turns payments on. */
export const PAYMENTS_SETTINGS_PATH = '/shop/manage/settings/pagos'

/**
 * The seller panel's state (S2.2): a shop with LIVE products and no way to collect is shown the banner, its product
 * listings carry «Solo catálogo», and the setup guide's payments step cannot be hidden. A shop with nothing live is
 * just early — no alarm.
 */
export function shopCatalogOnly(input: {
  shop: ShopFacts
  listings: ReadonlyArray<{ listing_type?: string | null; status?: string | null; delivery_mode?: DeliveryMode }>
}): boolean {
  // Per LISTING with the one rule (review on PR 497): a cash-at-pickup shop selling an arranged product CAN collect for
  // it, and a card shop's arranged product cannot — a shop-wide "can collect?" got both wrong.
  return input.listings.some((l) => l.status === 'active' &&
    listingReadiness({ listingType: l.listing_type, deliveryMode: l.delivery_mode, shop: input.shop }).mode === 'catalog')
}

/** Read a listing's delivery mode from its product metadata (`carrier` | `arranged`, anything else = unset). */
export function deliveryModeOf(metadata: unknown): DeliveryMode {
  const mode = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).delivery_mode : null
  return mode === 'arranged' || mode === 'carrier' ? mode : null
}

/**
 * Can a checkout for THIS listing finish on this shop? — the offer decision (D5), shared by the server gate
 * (`lib/shop-collect.ts`) and the PDP's «Hacer oferta», so the button never promises what the server refuses.
 * Products: the one rule. Services/rentals: coordinated, manual only. Other types: any rail.
 */
export function listingCanBePaid(input: { listingType: string | null | undefined; deliveryMode: DeliveryMode; shop: ShopFacts }): boolean {
  const type = input.listingType ?? 'product'
  if (COORDINATED_TYPES.has(type)) return hasManualPayment(input.shop.payments)
  if (type !== 'product') return canCollect(input.shop.payments)
  return listingReadiness({ listingType: 'product', deliveryMode: input.deliveryMode, shop: input.shop }).mode === 'online'
}
