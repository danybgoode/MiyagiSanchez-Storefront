/**
 * Classify one response to «Listo» (in-person-sales S1.3, exactly-once handling).
 *
 * PURE. The question this answers is not "did it fail" but "may the client_id be RELEASED":
 * releasing an id whose sale might exist makes the next «Listo» a second, real order.
 *
 * So the default is the SAFE side. The id is released only for an explicit allow-list of
 * definitive backend codes (never by HTTP status: Medusa's error mapper can turn a post-claim
 * failure into a 400/404/409). Anything else — no code, a proxy failure, any 5xx, the
 * backend's RETRY_SAME_ID — is 'uncertain' and keeps the frozen sale.
 *
 * STICKY RULE: once ANY attempt of this frozen sale was uncertain, the order may already
 * exist, so a later PRE-claim refusal (a lapsed session, 409 seller_not_active, 422
 * VARIANT_NOT_OWNED...) proves nothing about the first attempt and must not release the id.
 * Only the codes the backend raises AFTER the claim (stock, closed sale, short tender)
 * state the sale was not recorded.
 */

export type SaleVerdict = 'recorded' | 'refused' | 'uncertain' | 'retry_in_progress'

/** Refused before anything is recorded: safe to release ONLY if no earlier attempt was uncertain. */
export const PRE_CLAIM_REFUSALS: ReadonlySet<string> = new Set([
  'INVALID_BODY', 'INVALID_CLIENT_ID', 'INVALID_KIND', 'EMPTY_SALE', 'INVALID_LINE', 'INVALID_QUANTITY',
  'TOO_MANY_LINES', 'INVALID_TENDERED', 'TENDERED_NOT_CASH', 'OFFLINE_NOT_CASH', 'INVALID_SOLD_AT',
  'INVALID_EMAIL', 'VARIANT_NOT_OWNED', 'KIND_NOT_AVAILABLE', 'IN_PERSON_MX_ONLY', 'SELLER_NOT_FOUND',
  'seller_not_active', 'MX_COMMERCE_UNCONFIGURED', 'UNAUTHENTICATED',
  // Card / transfer: checked by the proxy BEFORE the claim (the shop cannot take that payment).
  'NO_CARD_PROVIDER', 'SELLER_MANUAL_MISSING',
])

/** Raised after the claim: they say the sale was NOT recorded even following an uncertain attempt. */
export const POST_CLAIM_REFUSALS: ReadonlySet<string> = new Set(['OUT_OF_STOCK', 'SALE_CLOSED', 'TENDERED_SHORT'])

export function classifySaleResponse(input: {
  status: number | null
  code?: string | null
  /** The response carried an order id and a readable total. */
  hasOrder?: boolean
  hadUncertainAttempt: boolean
}): SaleVerdict {
  const { status, code, hasOrder, hadUncertainAttempt } = input
  if (status !== null && status >= 200 && status < 300 && hasOrder) return 'recorded'
  if (status === 409 && code === 'IN_PROGRESS') return 'retry_in_progress'
  if (status === null || !code) return 'uncertain'
  if (POST_CLAIM_REFUSALS.has(code)) return 'refused'
  if (PRE_CLAIM_REFUSALS.has(code)) return hadUncertainAttempt ? 'uncertain' : 'refused'
  return 'uncertain'
}
