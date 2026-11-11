/**
 * lib/checkout-admission.ts — the PURE decision seam for the operating-channel
 * checkout admission read (epic 07 · owned-shop-operating-channel, decision D7).
 *
 * ── What question this answers, and why it is a DIFFERENT question ──────────────
 * `lib/checkout-market.ts` proves *published to this country marketplace*. That is
 * the right proof for a marketplace listing and the wrong one for the money path:
 * a product a shop sells on its own storefront but deliberately never listed in the
 * marketplace is refused before a cart can exist. The backend seam this module
 * reads — `GET /store/checkout-admission/:id?market=mx` — proves the one fact a
 * cart actually consumes: *this product is a member of this market's OPERATING
 * sales channel*, i.e. it is buyable.
 *
 * Admission is widened by exactly that one fact. It is NEVER widened to "any
 * product id": the same market echo must be confirmed, the same two identifier
 * fields must both equal the requested product, and the variant-ownership proof
 * below the gate in `lib/cart.ts` is untouched.
 *
 * PURE. No `fetch`, no env, no `next/*` — the Playwright `api` project drives every
 * branch here with plain objects.
 *
 * ── Three states, never two ─────────────────────────────────────────────────────
 * The backend deliberately distinguishes a REFUSAL from an OUTAGE, so this module
 * must not collapse them (`LEARNINGS.md`: known-absent and "I could not check" are
 * different facts). A 503 rendered to a buyer as "not for sale here" is a lie about
 * the catalog and sends them away from a product they could have bought a minute
 * later.
 *
 *   admitted    — proven buyable in this market.
 *   refused     — the backend answered, and the answer is no. Every product-level
 *                 refusal is one indistinguishable 404 on purpose, so this carries
 *                 no IDOR oracle: not-found, wrong-market and not-in-channel are
 *                 the same response.
 *   unproven    — a 2xx we could not verify (missing/other market echo, or the
 *                 identifiers disagree). Fails closed like its marketplace sibling.
 *   unavailable — the seam could not answer: market-level refusal or an outage.
 */
import { readMarketFilterState } from './market-catalog'
import type { MarketCode } from './markets'
import { isLikelyShopSlug } from './route-shape'

/** The backend route. Named once here so no call site hand-builds the path. */
export const CHECKOUT_ADMISSION_PATH = '/store/checkout-admission'

export function buildCheckoutAdmissionPath(productId: string, marketQuery: string): string {
  return `${CHECKOUT_ADMISSION_PATH}/${encodeURIComponent(productId)}?${marketQuery}`
}

/**
 * The backend's structured MARKET-level refusal reasons, quoted rather than
 * paraphrased — a restated contract drifts permissive (`LEARNINGS.md`). Anything
 * outside this set is not treated as a recognised structured body.
 */
export const CHECKOUT_ADMISSION_UNAVAILABLE_REASONS = [
  /** 400 — the caller named something that is not a supported market. */
  'unknown_market',
  /** 404 — a real market with no operating channel provisioned yet. */
  'market_has_no_operating_channel',
  /** 404 — a real market whose marketplace is not open. */
  'marketplace_not_open',
  /** 503 — the operating channel could not be resolved. */
  'operating_channel_unavailable',
  /** 503 — the membership read itself failed. */
  'admission_read_failed',
] as const

export type CheckoutAdmissionUnavailableReason =
  (typeof CHECKOUT_ADMISSION_UNAVAILABLE_REASONS)[number]

const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set(CHECKOUT_ADMISSION_UNAVAILABLE_REASONS)

export type CheckoutAdmissionOutcome =
  | { readonly kind: 'admitted' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'unproven' }
  | { readonly kind: 'unavailable'; readonly reason: CheckoutAdmissionUnavailableReason }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Is this 2xx payload a proof that `productId` is buyable in `market`?
 *
 * Deliberately the same shape as `isCheckoutListingAdmitted`: confirm the market
 * echo first (a money path cannot use the legacy missing-echo compatibility
 * window), then require BOTH identifier fields to equal the requested product. The
 * two-field check is what stops a response for one product admitting another.
 */
export function isOperatingChannelAdmitted(
  payload: unknown,
  market: MarketCode,
  productId: string,
): boolean {
  if (readMarketFilterState(payload, market) !== 'confirmed') return false
  const body = record(payload)
  if (!body || body.admitted !== true) return false
  const product = record(body.product)
  return product?.id === productId && product.medusa_product_id === productId
}

/**
 * Recognise the backend's structured market-level refusal body. Narrow on purpose:
 * an arbitrary or malformed error body is NOT laundered into a named reason, it
 * falls through to the status-based classification below.
 */
function structuredUnavailableReason(
  payload: unknown,
): CheckoutAdmissionUnavailableReason | null {
  const body = record(payload)
  if (!body || body.unavailable !== true) return null
  const reason = body.reason
  return typeof reason === 'string' && UNAVAILABLE_REASONS.has(reason)
    ? (reason as CheckoutAdmissionUnavailableReason)
    : null
}

/**
 * Classify one admission response. This is the whole decision — the I/O shell in
 * `lib/cart.ts` only performs the request and throws on anything but `admitted`.
 *
 * A non-2xx that is neither a recognised structured body nor a 404 is an OUTAGE,
 * never a refusal: an unclassifiable 500 means the seam did not answer the
 * question, and answering "not for sale" on its behalf would be the exact
 * collapse of "unknown" into "none" this module exists to prevent.
 */
export function classifyCheckoutAdmission(
  status: number,
  payload: unknown,
  market: MarketCode,
  productId: string,
): CheckoutAdmissionOutcome {
  if (status >= 200 && status < 300) {
    return isOperatingChannelAdmitted(payload, market, productId)
      ? { kind: 'admitted' }
      : { kind: 'unproven' }
  }
  const reason = structuredUnavailableReason(payload)
  if (reason) return { kind: 'unavailable', reason }
  // The backend answers every PRODUCT-level refusal with one indistinguishable
  // 404 body, so an unstructured 404 is the refusal — and only that.
  if (status === 404) return { kind: 'refused' }
  return { kind: 'unavailable', reason: 'admission_read_failed' }
}

/**
 * es-MX copy for a non-admitted outcome.
 *
 * The three messages are deliberately distinguishable to a buyer. Telling someone a
 * product is "not for sale here" when the truth is "our availability service is
 * down for 30 seconds" loses a sale AND teaches the buyer something false about the
 * catalog; the product id rides along because these strings are surfaced verbatim
 * by `/api/checkout/start` and are the only diagnostic a support conversation gets.
 */
export function checkoutAdmissionMessage(
  outcome: CheckoutAdmissionOutcome,
  productId: string,
): string {
  switch (outcome.kind) {
    case 'admitted':
      return ''
    case 'refused':
      return `El producto ${productId} no está a la venta en este mercado.`
    case 'unproven':
      return `No se pudo comprobar que el producto ${productId} sea vendible en este mercado.`
    case 'unavailable':
      return (
        `El servicio de disponibilidad no respondió (${outcome.reason}). ` +
        'Vuelve a intentarlo en unos minutos.'
      )
  }
}

/**
 * The OWNING shop's slug from an admission answer — or `null`.
 *
 * The checkout page renders a «Solo mi tienda» product through its shop's own
 * channel, so it needs the owner. Medusa owns the seller ↔ product edge, and the
 * admission route echoes it (`seller.slug`) ONLY alongside an admission. Trusted
 * only when the same payload is a full admission proof for this exact product and
 * market (`classifyCheckoutAdmission` → `admitted`); anything else — a refusal, an
 * outage, an older backend that does not send the field, a malformed slug — is
 * `null`, and the page 404s exactly as it did before (reported live 2026-11-11).
 */
export function readAdmittedOwnerSlug(
  status: number,
  payload: unknown,
  market: MarketCode,
  productId: string,
): string | null {
  if (classifyCheckoutAdmission(status, payload, market, productId).kind !== 'admitted') return null
  const slug = record(record(payload)?.seller)?.slug
  return typeof slug === 'string' && isLikelyShopSlug(slug) ? slug : null
}
