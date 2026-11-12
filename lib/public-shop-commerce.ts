/**
 * Payment availability from the privacy-safe PUBLIC seller projection.
 *
 * Catalog/shop surfaces need only "can the buyer choose this rail?". Credentials
 * and transfer coordinates stay behind checkout and seller-authenticated seams.
 * Keeping this parser next-free lets every public renderer and agent schema share
 * the exact same boolean contract.
 */

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export interface PublicStripeProjection {
  readonly connected?: boolean
  readonly enabled?: boolean
  readonly charges_enabled?: boolean
  readonly details_submitted?: boolean
  readonly onboarding_complete?: boolean
}

export interface PublicTransferProjection {
  readonly enabled?: boolean
  readonly configured?: boolean
}

export interface PublicMercadoPagoProjection {
  readonly connected?: boolean
  readonly enabled?: boolean
  readonly live_mode?: boolean
}

export interface PublicShopMetadata {
  readonly mp_enabled?: boolean
  readonly settings?: {
    readonly stripe?: PublicStripeProjection
    readonly mercadopago?: PublicMercadoPagoProjection
    readonly checkout?: {
      readonly bank_transfer?: PublicTransferProjection
      readonly dimo?: PublicTransferProjection
      readonly [key: string]: unknown
    }
    readonly [key: string]: unknown
  }
  readonly [key: string]: unknown
}

export interface PublicShopPaymentAvailability {
  readonly stripe: boolean
  readonly mercadopago: boolean
  readonly bankTransfer: boolean
  readonly dimo: boolean
}

/**
 * Is this shop's Stripe connection able to take a charge?
 *
 * TWO ACCOUNT GENERATIONS, and they describe the same fact with different keys.
 *
 * MX shops are Stripe v1 Express accounts and persist `connected` + `charges_enabled`.
 * US shops are Accounts v2 `merchant` accounts (D14) and persist what
 * `projectStripeV2Account` reads from `/v2/core/accounts`: `api_generation`,
 * `merchant_configuration`, `card_payments_status` and the requirement lists. A v2
 * account has NO `connected` and NO `charges_enabled` key at all.
 *
 * Checking only the v1 keys — which is what this did — meant a fully onboarded US
 * seller with `card_payments: active` read as "no payment method", so
 * `resolveCommerceReadiness` returned `seller_payment_unavailable` and the storefront
 * and every agent surface suppressed `buy_now` permanently. The shop would have been
 * browsable and unbuyable, with no error anywhere: the backend was ready to charge and
 * the storefront never offered the button.
 *
 * The v2 branch mirrors the backend's `resolveStripeReadiness` — country and
 * capability, not merely "an account exists" — so the two halves agree about what
 * "connected" means.
 */
export function stripeIsAvailable(stripe: Record<string, unknown>): boolean {
  // The seller's own opt-out is authoritative in BOTH generations.
  if (stripe.enabled === false) return false

  if (stripe.api_generation === 'v2') {
    // Deliberately NOT "an account id exists". The population guard in
    // `public-shop-commerce.spec.ts` bans inferring availability from a private
    // coordinate, and it is right on the merits too: an account id proves an account
    // was created, not that Stripe will accept a charge. `card_payments_status`
    // proves that, and it cannot be `active` without an account.
    return (
      stripe.merchant_configuration === 'active' &&
      stripe.card_payments_status === 'active' &&
      // A blocking requirement is exactly the state where Stripe will refuse the
      // charge. Offering buy_now here would send the buyer into a failure.
      (!Array.isArray(stripe.blocking_requirements) || stripe.blocking_requirements.length === 0)
    )
  }

  return stripe.connected === true && stripe.charges_enabled === true
}

export function publicShopPaymentAvailability(
  metadata: PublicShopMetadata | Record<string, unknown> | null | undefined,
): PublicShopPaymentAvailability {
  const meta = objectValue(metadata)
  const settings = objectValue(meta.settings)
  const stripe = objectValue(settings.stripe)
  const mercadoPago = objectValue(settings.mercadopago)
  const checkout = objectValue(settings.checkout)
  const bankTransfer = objectValue(checkout.bank_transfer)
  const dimo = objectValue(checkout.dimo)

  return Object.freeze({
    stripe: stripeIsAvailable(stripe),
    // Mirrors backend sellerMpConnected: `connected` is the safe public proxy
    // for connected+token, while the stale nested `enabled` flag is ignored.
    // The top-level platform opt-out remains authoritative because /api/mp/checkout
    // refuses `mp_enabled === false` and the settings sync mirrors it to Medusa.
    mercadopago:
      meta.mp_enabled !== false &&
      mercadoPago.connected === true,
    bankTransfer:
      bankTransfer.configured === true &&
      bankTransfer.enabled !== false,
    dimo:
      dimo.configured === true &&
      dimo.enabled === true,
  })
}

/**
 * Does the shop accept ANY checkout payment method? The same four paths the PDP's
 * commerce readiness counts (`sellerHasMp || sellerHasStripe || hasBankTransfer ||
 * hasDimo`), so a surface that offers «Comprar» agrees with the product page.
 */
export function shopAcceptsAnyPayment(availability: PublicShopPaymentAvailability): boolean {
  // The same predicate as `canCollect` in lib/listing-readiness.ts (which imports THIS module, so it is restated
  // here as the four fields rather than imported back — a cycle). `listing-readiness.spec` pins that they agree.
  return availability.stripe || availability.mercadopago || availability.bankTransfer || availability.dimo
}
