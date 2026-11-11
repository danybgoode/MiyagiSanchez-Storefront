/**
 * Medusa cart helpers for the checkout flow.
 *
 * Single-item (BuyButton/MercadoPagoButton):
 *   const { redirect_url } = await startCheckout({ productId, provider, buyerEmail })
 *
 * Multi-item (CartDrawer — items from same seller):
 *   const { redirect_url } = await startCheckout({ items: [...], sellerId, provider, buyerEmail })
 */

import { zeroTotalDecision, zeroTotalRefusal } from './checkout-zero'
import type { PersonalizationPayload } from './personalization'
import { DEFAULT_MARKET, type MarketCode } from './markets'
import { PROCESS_MARKET_ENV, resolveRegionIdForMarket } from './market-medusa'
import { isMarketUnavailable, planMarketCatalogRead } from './market-catalog'
import { isCheckoutListingAdmitted, isVariantOwnedByProduct } from './checkout-market'
import {
  buildCheckoutAdmissionPath,
  checkoutAdmissionMessage,
  classifyCheckoutAdmission,
  readAdmittedOwnerSlug,
} from './checkout-admission'
import { readEventDetails } from './event-listing'
import {
  EVENT_TICKET_METADATA_KEY,
  issueTicket,
  type EventTicket,
} from './event-ticket-state'
import { admitMarketCheckout, marketCheckoutRefusalMessage } from './checkout-market-strategy'

/**
 * The line-item body fragment that carries buyer personalization onto the Medusa
 * cart line (→ order line natively). Empty when there's nothing to attach, so a
 * non-personalized line item is byte-for-byte unchanged.
 */
export function lineItemPersonalizationMetadata(
  personalization?: PersonalizationPayload | null,
): { metadata: { personalization: PersonalizationPayload } } | Record<string, never> {
  return personalization?.fields?.length ? { metadata: { personalization } } : {}
}

function lineItemCheckoutMetadata(input: {
  personalization?: PersonalizationPayload | null
  eventTicket?: EventTicket | null
}): { metadata: Record<string, unknown> } | Record<string, never> {
  const metadata: Record<string, unknown> = {}
  if (input.personalization?.fields?.length) metadata.personalization = input.personalization
  if (input.eventTicket) metadata[EVENT_TICKET_METADATA_KEY] = input.eventTicket
  return Object.keys(metadata).length ? { metadata } : {}
}

function eventTicketForProduct(productId: string, metadata: Record<string, unknown> | null | undefined): EventTicket | null {
  const event = readEventDetails({ attrs: undefined, metadata: metadata ?? {} })
  if (!event) return null
  return issueTicket({
    source: 'paid',
    subjectId: `cart:${productId}:${Date.now()}`,
    productId,
  }).ticket
}

const MEDUSA_BASE = process.env.NEXT_PUBLIC_MEDUSA_STORE_URL
  ?? process.env.MEDUSA_STORE_URL
  ?? 'http://localhost:9000'
const PUB_KEY = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''
// (An absolute SITE_URL used to live here, for a fire-and-forget HTTP call to our own
// manual-order-email route. That call is gone — see the comment at its old site — and
// so is the constant.)

function medusaFetch(path: string, options?: RequestInit) {
  return fetch(`${MEDUSA_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-publishable-api-key': PUB_KEY,
      ...(options?.headers ?? {}),
    },
  })
}

/**
 * Read D8's kill-switch WITHOUT pulling `server-only` into this module's import
 * graph.
 *
 * `lib/flags.ts` imports `server-only`, which throws the moment it is evaluated
 * outside a server request. This module is imported for its types by client
 * components and directly by the Playwright `api` specs, so a STATIC import of the
 * flag layer here breaks both — verified, not assumed: with the static import in
 * place `e2e/personalization-checkout.spec.ts` fails to load at all. The dynamic
 * import is therefore load-bearing, not a style choice, and it is why the actual
 * `isEnabled` callsite lives in `lib/checkout-admission-flag.ts` (which is where
 * the flag-inventory derivation finds it).
 *
 * Fails to `false` — the flag's own default, i.e. today's marketplace-only
 * admission. An unreadable kill-switch must never be the thing that WIDENS an
 * authorization gate.
 */
async function readOwnedShopOnlyFlag(): Promise<boolean> {
  try {
    const { ownedShopOnlyEnabled } = await import('./checkout-admission-flag')
    return await ownedShopOnlyEnabled()
  } catch {
    return false
  }
}

type CheckoutLineInput = {
  productId: string
  variantId?: string | null
  personalization?: PersonalizationPayload | null
  quantity?: number
}

type ResolvedCheckoutLine = CheckoutLineInput & {
  resolvedVariantId: string
  productMetadata: Record<string, unknown> | null
}

/**
 * What `resolveCheckoutLines` needs from the outside world. Injected so the whole
 * admission gate — both flag branches — is drivable by the Playwright `api` project
 * with plain objects and no network.
 */
export type CheckoutAdmissionDeps = {
  /**
   * `catalog.owned_shop_only_enabled` (epic decision D8), resolved ONCE per
   * checkout rather than per line, so a flag flip cannot split a single cart
   * across two admission rules.
   */
  readonly ownedShopOnlyEnabled: boolean
  /** The Medusa store fetcher — `medusaFetch` in production. */
  readonly fetch: (path: string) => Promise<Response>
}

/**
 * Prove ONE line item may be bought in this market, before any cart exists.
 *
 * Two admission rules live here, and the flag picks between them (D8):
 *
 *  · flag OFF — the shipped rule, byte-for-byte: the market-scoped marketplace
 *    DETAIL endpoint must return this exact product. This is publication truth.
 *  · flag ON  — the operating-channel seam (D7): is this product BUYABLE in this
 *    market? A shop may sell something it never listed in the country marketplace,
 *    and under the old rule that product was refused before a cart could exist.
 *
 * The widening is exactly one fact — *buyable on its own shop*. Both branches still
 * scope to the requested market, still require the backend to echo that market
 * back, still require both identifier fields to name the requested product, and
 * still fail closed on anything they cannot prove. Neither branch admits "any
 * product id", and the variant-ownership proof below is downstream of both.
 */
async function admitCheckoutLine(
  productId: string,
  market: { code: MarketCode; query: string },
  deps: CheckoutAdmissionDeps,
): Promise<void> {
  if (!deps.ownedShopOnlyEnabled) {
    const listingRes = await deps.fetch(
      `/store/listings/${encodeURIComponent(productId)}?${market.query}`,
    )
    if (!listingRes.ok) {
      throw new Error(`Product ${productId} is not available in this marketplace`)
    }
    const listingPayload = await listingRes.json()
    if (!isCheckoutListingAdmitted(listingPayload, market.code, productId)) {
      throw new Error(`Product ${productId} could not be verified for this marketplace`)
    }
    return
  }

  // The seam answers three ways, and they are NOT interchangeable: a refusal is a
  // fact about the catalog, an outage is a fact about us. Collapsing the 503 into
  // "not available in this marketplace" would tell a buyer their product does not
  // exist because a backend hiccuped. `classifyCheckoutAdmission` keeps them apart.
  const admissionRes = await deps.fetch(buildCheckoutAdmissionPath(productId, market.query))
  const admissionPayload = await admissionRes.json().catch(() => null)
  const outcome = classifyCheckoutAdmission(
    admissionRes.status,
    admissionPayload,
    market.code,
    productId,
  )
  if (outcome.kind !== 'admitted') {
    throw new Error(checkoutAdmissionMessage(outcome, productId))
  }
}

/**
 * Which shop owns a product, as Medusa's checkout admission states it — for the
 * checkout PAGE's «Solo mi tienda» fallback (`lib/checkout-listing.ts`). It admits
 * nothing: `startCheckout` re-runs the full admission gate on every line. `null` on
 * any refusal, outage or missing field; the page then 404s, as it did before.
 */
export async function admittedOwnerShopSlug(productId: string, market: MarketCode): Promise<string | null> {
  const decision = planMarketCatalogRead(market)
  if (isMarketUnavailable(decision)) return null
  try {
    const res = await medusaFetch(buildCheckoutAdmissionPath(productId, decision.query), { cache: 'no-store' })
    const payload = await res.json().catch(() => null)
    return readAdmittedOwnerSlug(res.status, payload, decision.market.code, productId)
  } catch {
    return null
  }
}

/**
 * Admit every item through the admission gate above before creating a cart, then
 * load its variants from Medusa's product endpoint.
 *
 * The second read is intentionally ownership-neutral commerce data, but it is
 * only reachable after the first read proved this product may be bought in the
 * exact requested market. Keeping this before cart creation prevents both a
 * guessed direct product id bypass and a partly-created mixed-market cart.
 */
export async function resolveCheckoutLines(
  lineItems: CheckoutLineInput[],
  market: { code: MarketCode; query: string },
  offerId: string | undefined,
  deps: CheckoutAdmissionDeps,
): Promise<ResolvedCheckoutLine[]> {
  return Promise.all(lineItems.map(async (lineItem) => {
    await admitCheckoutLine(lineItem.productId, market, deps)

    const productRes = await deps.fetch(`/store/products/${encodeURIComponent(lineItem.productId)}?fields=variants.id,metadata`)
    if (!productRes.ok) throw new Error(`Product ${lineItem.productId} not found`)
    const { product } = await productRes.json()
    const productMetadata = (product?.metadata ?? null) as Record<string, unknown> | null
    const productVariants: Array<{ id: string }> = product?.variants ?? []
    let resolvedVariantId = lineItem.variantId ?? null
    if (resolvedVariantId) {
      // The admission proof above is keyed on productId, but the thing actually
      // BOUGHT below is the variant id. If those two are allowed to diverge, the
      // guard protects a different object than the one that ends up in the cart:
      // a caller could pair an admitted marketplace productId with a variant of a
      // product that is NOT published to this market and check it out anyway.
      // `/api/checkout/start` hands `await req.json()` straight to us, so this
      // pairing is fully caller-controlled — it must be proven, not trusted.
      //
      // This is UNCHANGED by the D7 relaxation, and deliberately sits below BOTH
      // admission branches rather than inside either one. Widening what a product
      // id may be (buyable-on-its-own-shop, not only marketplace-published) does
      // not weaken this by one step: whatever the gate admitted, the variant sold
      // must still belong to that same product. Under the operating-channel branch
      // the divergence would be a variant of a product in NO channel at all.
      if (!isVariantOwnedByProduct(resolvedVariantId, productVariants)) {
        throw new Error(
          `Variant ${resolvedVariantId} does not belong to product ${lineItem.productId}`,
        )
      }
    } else {
      if (productVariants.length > 1 && !offerId) {
        throw new Error(`Product ${lineItem.productId} has multiple variants; variantId is required`)
      }
      resolvedVariantId = productVariants[0]?.id ?? null
    }
    if (!resolvedVariantId) throw new Error(`Product ${lineItem.productId} has no variants`)
    return { ...lineItem, resolvedVariantId, productMetadata }
  }))
}

async function responseMessage(response: Response, fallback: string) {
  const payload = await response.json().catch(() => null) as {
    message?: string
    error?: string
  } | null

  return payload?.message ?? payload?.error ?? fallback
}

export type CheckoutProvider = 'stripe' | 'mercadopago' | 'spei' | 'cash' | 'manual'
/** Sub-type for the unified manual ("Pago directo") method. */
export type ManualSubType = 'clabe' | 'cash' | 'dimo'
export type CheckoutFulfillmentMethod = 'local_pickup' | 'shipping' | 'digital' | 'service' | 'rental' | 'coord' | 'manual_carrier' | 'none'

export interface CheckoutShippingAddress {
  name?: string
  phone?: string
  /** Street name only (e.g. "Av. Insurgentes Sur") */
  line1?: string
  /** Exterior number (e.g. "1234") */
  ext_number?: string
  /** Interior number, optional (e.g. "Depto 5") */
  int_number?: string
  /** Colonia / neighborhood */
  line2?: string
  /** Alcaldía or municipio (from CP lookup region_2) */
  city?: string
  state?: string
  /** Envia 2-digit state code set by CP lookup */
  state_code?: string
  postal_code?: string
  country?: string
}

export interface CheckoutShippingQuote {
  rateId: string
  carrier: string
  service: string
  amountCents: number
  currency: string
  deliveryEstimate?: number | null
  deliveryLabel?: string | null
}

export interface StartCheckoutParams {
  /** Single-item shorthand — still works for BuyButton / MercadoPagoButton */
  productId?: string
  variantId?: string | null
  /** Buyer-entered personalization for the single-item path → line-item metadata */
  personalization?: PersonalizationPayload | null
  /** Units for the single-item path (event admissions, default 1). Clamped to
   *  the listing's available_quantity upstream (lib/ticket-quantity.ts). */
  quantity?: number
  /** Multi-item bundle (CartDrawer — all items must be same seller) */
  items?: Array<{ productId: string; variantId?: string | null; personalization?: PersonalizationPayload | null; quantity?: number }>
  /** Pass seller ID to skip the expensive server-side scan */
  sellerId?: string
  provider: CheckoutProvider
  /** When provider is 'manual', which structured instruction the buyer chose. */
  manualSubType?: ManualSubType
  buyerEmail?: string
  buyerFirstName?: string
  buyerLastName?: string
  /** Accepted offer override in centavos */
  offerAmountCents?: number
  /** Seller coupon code applied at checkout */
  couponCode?: string
  /** Supabase offer ID — included in session metadata so the webhook can mark it paid */
  offerId?: string
  /** Clerk JWT — required for authenticated checkout */
  clerkJwt?: string
  /**
   * The buyer's Clerk user id, used only to address the post-order push/Telegram.
   *
   * SERVER-DERIVED ONLY. `/api/checkout/start` overwrites whatever the request body
   * carries with the id from `auth()`, because this value selects who receives a
   * notification — accepting it from the caller would let anyone notify anyone.
   */
  buyerClerkUserId?: string
  /** Buyer-selected fulfillment method from marketplace checkout */
  fulfillmentMethod?: CheckoutFulfillmentMethod
  /** Optional selected pickup spot ID/name from seller settings */
  pickupSpotId?: string
  /** Local pickup: the buyer's proposed appointment (date + time window) */
  pickupAppointment?: { date: string; window: string }
  /** Shipping address collected before redirecting to the payment rail */
  shippingAddress?: CheckoutShippingAddress
  /** Buyer-selected live Envia quote */
  shippingQuote?: CheckoutShippingQuote
  /** Buyer explicitly opts into escrow (when seller escrow_mode is 'optional') */
  escrow?: boolean
  /** Tenant custom domain the buyer came from (own-channel hop). Stored on the
   *  order so the success page can return them there + attribute the sale. */
  originDomain?: string
  /** Guest support contribution metadata for the support widget flow. */
  support?: {
    amount_cents: number
    supporter_name?: string | null
    supporter_email: string
    message?: string | null
    visibility: 'public' | 'private'
    embed_key?: string | null
    channel?: string
  }
  /** Skip the generic manual-order confirmation email (caller sends its own,
   *  e.g. the print-ad flow sends a print-specific payment-pending email). */
  suppressManualEmail?: boolean
  /** Rental listing: the buyer's chosen date range. ONLY dates — the backend
   *  server-recomputes the total (nights × rate + deposit) from these dates plus
   *  the listing's own rate/attrs; there is no amount field here to tamper with. */
  rental?: { check_in: string; check_out: string }
  /**
   * Operating market for this checkout — resolves the Medusa Region and therefore
   * the currency, payment providers and fulfillment options (epic decision D5).
   * Every caller today omits it and resolves to `DEFAULT_MARKET` (`mx`), which is
   * why this seam changes no MX behaviour; a market with no Region fails closed
   * here rather than borrowing Mexico's rails.
   */
  market?: unknown
}

export interface StartCheckoutResult {
  /** Redirect URL for Stripe/MP. Null for SPEI/cash (no external redirect). */
  redirect_url: string | null
  cart_id: string
  payment_session_id: string | null
  /** SPEI: seller's CLABE interbancaria */
  clabe?: string | null
  /** SPEI: seller's bank name */
  bank_name?: string | null
  /** SPEI: account holder name */
  account_holder?: string | null
  /** Manual: which sub-type ('clabe' | 'cash' | 'dimo') */
  sub_type?: ManualSubType | null
  /** Manual: specific method recorded ('spei' | 'cash' | 'dimo') */
  payment_method?: string | null
  /** Manual DiMo: phone to transfer to */
  dimo_phone?: string | null
  /** Escrow mode that was applied, if any */
  escrow_mode?: string | null
}

/**
 * Creates a Medusa cart, adds all items, and initiates the external
 * payment checkout session (Stripe Connect / MercadoPago).
 * Returns the redirect URL — caller navigates there.
 */
export async function startCheckout(params: StartCheckoutParams): Promise<StartCheckoutResult> {
  const {
    productId, variantId, personalization, quantity, items, sellerId,
    provider, manualSubType, buyerEmail, buyerFirstName, buyerLastName,
    offerAmountCents, couponCode, offerId, clerkJwt, buyerClerkUserId, fulfillmentMethod, pickupSpotId, pickupAppointment, shippingAddress, shippingQuote, escrow,
    originDomain,
    support,
    suppressManualEmail,
    rental,
    market,
  } = params

  // Resolve the Medusa Region and permanent market/delivery strategy BEFORE any
  // network call, so every refusal precedes customer/cart/shipping writes.
  // unsupported market fails here rather than after a cart already exists.
  // `UnknownMarketError` propagates deliberately: cart creation is a write seam and
  // an unrecognised market at a write seam is a bug, not a degraded read.
  const marketDecision = planMarketCatalogRead(market ?? DEFAULT_MARKET)
  if (isMarketUnavailable(marketDecision)) {
    throw new Error(
      `This marketplace is unavailable (${marketDecision.reason}).`,
    )
  }
  const regionId = resolveRegionIdForMarket(marketDecision.market.code, PROCESS_MARKET_ENV)
  if (regionId === null) {
    throw new Error(
      'This market has no Medusa Region, so no cart can be created in it.',
    )
  }
  const admission = admitMarketCheckout({
    market: marketDecision.market.code,
    provider,
    fulfillmentMethod,
    shippingAddress,
    hasClientShippingQuote: shippingQuote != null,
  })
  if (!admission.ok) throw new Error(marketCheckoutRefusalMessage(admission.code, admission.market))

  // Manual (incl. legacy spei/cash) completes the cart inline; gateways redirect.
  const isManual = provider === 'manual' || provider === 'spei' || provider === 'cash'

  // Normalise to array — single-item path is the same as multi-item with one entry
  const lineItems: CheckoutLineInput[] =
    items && items.length > 0
      ? items
      : productId
        ? [{ productId, variantId, personalization, quantity }]
        : []

  if (lineItems.length === 0) throw new Error('No items to checkout')

  // There is deliberately no cart/customer write before all product ids have
  // passed the admission proof above.
  const resolvedLines = await resolveCheckoutLines(
    lineItems,
    { code: marketDecision.market.code, query: marketDecision.query },
    offerId,
    { ownedShopOnlyEnabled: await readOwnedShopOnlyFlag(), fetch: medusaFetch },
  )

  const authHeaders: Record<string, string> = clerkJwt
    ? { Authorization: `Bearer ${clerkJwt}` }
    : {}

  // 1. Sync buyer as a Medusa customer (find-or-create)
  if (buyerEmail && clerkJwt) {
    try {
      await medusaFetch('/store/customers/sync', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          email: buyerEmail,
          first_name: buyerFirstName ?? '',
          last_name: buyerLastName ?? '',
        }),
      })
    } catch { /* non-fatal */ }
  }

  // 2. Create cart in the market's region. Medusa v2 Store cart creation does not
  // accept customer_id; authenticated carts are associated by token/email.
  const cartRes = await medusaFetch('/store/carts', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      region_id: regionId,
      ...(buyerEmail ? { email: buyerEmail } : {}),
    }),
  })
  if (!cartRes.ok) {
    throw new Error(await responseMessage(cartRes, 'Failed to create cart'))
  }
  const { cart } = await cartRes.json()
  const cartId = cart.id

  // 3. Add each item (resolve variant ID on-the-fly if missing)
  for (const lineItem of resolvedLines) {
    const eventTicket = eventTicketForProduct(lineItem.productId, lineItem.productMetadata)

    const itemRes = await medusaFetch(`/store/carts/${cartId}/line-items`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        variant_id: lineItem.resolvedVariantId,
        // Default 1; event admissions can buy N (clamped to available_quantity
        // upstream). The backend issuance loop mints one ticket PER UNIT.
        quantity: Math.max(1, Math.floor(Number(lineItem.quantity ?? 1)) || 1),
        // Buyer personalization + event ticket tokens ride line-item metadata →
        // order line item metadata natively (no commerce table).
        ...lineItemCheckoutMetadata({ personalization: lineItem.personalization, eventTicket }),
      }),
    })
    if (!itemRes.ok) {
      throw new Error(await responseMessage(itemRes, 'Failed to add item to cart'))
    }
  }

  // 3b. Refuse a $0 cart BEFORE start-checkout (see lib/checkout-zero.ts). The cart's own subtotal is the
  // authority — what the listing price field says does not matter, only what Medusa would charge. If the
  // read fails we FAIL CLOSED (retryable message, logged): an unreadable subtotal is not proof the cart is
  // priced, and start-checkout has no zero-total refusal of its own.
  {
    let subtotal: unknown
    let lineUnitPrices: unknown[] | undefined
    try {
      const totalsRes = await medusaFetch(`/store/carts/${cartId}?fields=subtotal,total,items.unit_price`, { headers: authHeaders })
      if (totalsRes.ok) {
        const totalsCart = ((await totalsRes.json()) as { cart?: { subtotal?: unknown; items?: Array<{ unit_price?: unknown }> } }).cart
        subtotal = totalsCart?.subtotal
        // No items array = we could not see the lines: leave it unknown rather than assume they are fine.
        lineUnitPrices = Array.isArray(totalsCart?.items) ? totalsCart.items.map((i) => i?.unit_price) : [undefined]
      }
    } catch { /* unknown, handled below */ }
    const decision = zeroTotalDecision({ subtotal, lineUnitPrices })
    if (decision === 'unknown') console.warn('[startCheckout] cart subtotal unreadable; refusing checkout', { cartId })
    const refusal = zeroTotalRefusal(decision)
    if (refusal) throw new Error(refusal)
  }

  // 4. Call start-checkout to create the external payment session + get redirect URL
  const checkoutRes = await medusaFetch(`/store/carts/${cartId}/start-checkout`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      provider,
      market: marketDecision.market.code,
      ...(manualSubType ? { manual_sub_type: manualSubType } : {}),
      buyer_email: buyerEmail,
      ...(sellerId ? { seller_id: sellerId } : {}),
      ...(offerAmountCents ? { offer_amount_cents: offerAmountCents } : {}),
      ...(couponCode ? { coupon_code: couponCode } : {}),
      ...(offerId ? { offer_id: offerId } : {}),
      ...(fulfillmentMethod ? { fulfillment_method: fulfillmentMethod } : {}),
      ...(pickupSpotId ? { pickup_spot_id: pickupSpotId } : {}),
      ...(pickupAppointment ? { pickup_appointment: pickupAppointment } : {}),
      ...(shippingAddress ? { shipping_address: shippingAddress } : {}),
      ...(escrow ? { escrow: true } : {}),
      ...(originDomain ? { origin_domain: originDomain } : {}),
      ...(support ? { support } : {}),
      ...(rental ? { rental } : {}),
      ...(marketDecision.market.code === 'mx' && shippingQuote ? {
        shipping_quote: {
          rate_id: shippingQuote.rateId,
          carrier: shippingQuote.carrier,
          service: shippingQuote.service,
          amount_cents: shippingQuote.amountCents,
          currency: shippingQuote.currency,
          delivery_estimate: shippingQuote.deliveryEstimate ?? null,
          delivery_label: shippingQuote.deliveryLabel ?? null,
        },
      } : {}),
    }),
  })
  if (!checkoutRes.ok) {
    throw new Error(await responseMessage(checkoutRes, 'Failed to start checkout'))
  }

  const result: StartCheckoutResult = await checkoutRes.json()

  // Manual: complete the cart immediately to create the Medusa order in pending
  // state. No external redirect — the frontend shows the payment instructions.
  if (isManual && result.cart_id) {
    const completeRes = await medusaFetch(`/store/carts/${result.cart_id}/complete`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({}),
    })
    if (!completeRes.ok) {
      const msg = await responseMessage(completeRes, 'Failed to complete cart')
      throw new Error(msg)
    }
    const { type, order } = await completeRes.json()
    if (type === 'order' && order?.id) {
      result.cart_id = order.id // Return order ID so caller can navigate to order page
      // Fire the buyer + seller confirmation emails (manual orders skip the
      // Stripe/MP webhooks that send them). Never blocks checkout.
      // Skipped when the caller owns its own manual email (e.g. print-ad flow).
      //
      // 🚨 This was `fetch(`${SITE_URL}/api/orders/finalize-manual`)` — an HTTP call
      // to our OWN route. Correct while `startCheckout` ran in the browser; the
      // moment PR 244 moved it behind `/api/checkout/start` it became a server-to-
      // server request with no Clerk cookie, and the route 401'd on EVERY manual
      // order for a month while `.catch(() => {})` hid it. Do not reintroduce an
      // authenticated round trip to ourselves for work we can already do in-process.
      //
      // Imported dynamically because the target is `server-only` (it sends email) and
      // four 'use client' components import types from this module — a static import
      // would drag a server-only module into a client bundle at build time.
      if (!suppressManualEmail) {
        void import('./orders/manual-order-emails')
          .then(({ sendManualOrderEmails }) => sendManualOrderEmails({
            orderId: order.id as string,
            clerkJwt,
            buyerClerkUserId,
          }))
          .then((r) => {
            if (!r.ok) console.error('[startCheckout] manual order emails NOT sent:', order.id, r.reason)
          })
          .catch((e) => console.error('[startCheckout] manual order emails threw:', e))
      }
    }
  }

  return result
}
