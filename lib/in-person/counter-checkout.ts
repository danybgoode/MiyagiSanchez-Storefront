/**
 * Card-by-QR and transfer sales at the counter — the storefront-server half of
 * in-person-sales S2 (D9, D10). PURE planning plus an orchestrator whose I/O is injected,
 * so the rules that matter are testable without a network:
 *
 *  - start-checkout is called AT MOST ONCE per sale: a second call opens a second payable
 *    checkout. The guard is the server's own status (a `checkout_url` already on the cart's
 *    payment session means one was opened), never anything the browser sent.
 *  - `checkout_url` is READ BACK from the backend status, never taken from the client or
 *    from the start-checkout body we sent.
 *  - "paid" is never decided here: it is whatever the backend status says, which in turn is
 *    the provider webhook's doing.
 *  - Every call goes to the BACKEND (injected), never to one of our own authed Next routes.
 */

export type CounterKind = 'cash' | 'card' | 'transfer'
export type CardProvider = 'mercadopago' | 'stripe'

export type SaleState = 'awaiting_payment' | 'pending_confirmation' | 'paid' | 'cancelled' | 'failed' | 'unverified'

export interface SaleStatus {
  client_id?: string
  kind?: string
  state: SaleState
  order_id: string | null
  cart_id: string | null
  checkout_url: string | null
  total_cents: number
}

export interface ManualPayment {
  spei: { clabe: string; bank_name: string | null; account_holder: string | null } | null
  dimo: { phone: string } | null
}

interface PaymentMethodLike { id?: string; sub_options?: Array<{ type?: string }> }

/** Mercado Pago first, then Stripe: the same preference order as the buyer checkout default. */
export function pickCardProvider(methods: PaymentMethodLike[]): CardProvider | null {
  const ids = new Set(methods.map((m) => m.id))
  if (ids.has('mercadopago')) return 'mercadopago'
  if (ids.has('stripe')) return 'stripe'
  return null
}

/** 'clabe' when the shop takes SPEI, else 'dimo', else null (nothing to show for a transfer). */
export function pickTransferSubType(methods: PaymentMethodLike[]): 'clabe' | 'dimo' | null {
  const manual = methods.find((m) => m.id === 'manual')
  const types = new Set((manual?.sub_options ?? []).map((o) => o.type))
  if (types.has('clabe')) return 'clabe'
  if (types.has('dimo')) return 'dimo'
  return null
}

/** The body for the backend's public start-checkout. `seller_id` skips its expensive seller scan. */
export function startCheckoutBody(kind: 'card' | 'transfer', sellerId: string, provider: CardProvider | null, subType: 'clabe' | 'dimo' | null) {
  if (kind === 'card') {
    if (!provider) throw new Error('card sale needs a provider')
    return { provider, seller_id: sellerId, fulfillment_method: 'local_pickup' as const }
  }
  return { provider: 'manual' as const, manual_sub_type: subType ?? 'clabe', seller_id: sellerId, fulfillment_method: 'local_pickup' as const }
}

/**
 * Derive the CLABE / DiMo the backend would snapshot, from the seller's settings, with the
 * SAME acceptance rules (18-digit CLABE, enabled; DiMo enabled with 10+ digits). Used only
 * when start-checkout was not called on this request (a replay) and so returned no snapshot.
 */
export function manualFromSellerMetadata(metadata: unknown): ManualPayment {
  const settings = (((metadata ?? {}) as { settings?: Record<string, unknown> }).settings ?? {}) as Record<string, unknown>
  const checkout = (settings.checkout ?? {}) as Record<string, unknown>
  const bt = (checkout.bank_transfer ?? {}) as Record<string, unknown>
  const clabe = typeof bt.clabe === 'string' ? bt.clabe.replace(/\D/g, '') : ''
  const dimoCfg = (checkout.dimo ?? {}) as Record<string, unknown>
  const phone = typeof dimoCfg.phone === 'string' ? dimoCfg.phone.replace(/\D/g, '') : ''
  return {
    spei: bt.enabled !== false && clabe.length === 18
      ? { clabe, bank_name: (bt.bank_name as string | undefined) ?? null, account_holder: (bt.account_holder as string | undefined) ?? null }
      : null,
    dimo: dimoCfg.enabled === true && phone.length >= 10 ? { phone } : null,
  }
}

export interface OrchestrateDeps {
  getStatus(): Promise<SaleStatus | null>
  /**
   * `exists`: the backend says a checkout is already open (409 CHECKOUT_EXISTS) — fine, use it.
   * `closed`: the claim is no longer awaiting payment (409 SALE_CLOSED) — the cancelled path.
   */
  startCheckout(): Promise<{ ok: true; manual_payment: ManualPayment | null } | { ok: false; reason: 'exists' | 'closed' | 'failed'; code?: string; message?: string }>
  completeCart(): Promise<boolean>
  manualFallback(): Promise<ManualPayment | null>
  /** Best effort: close a sale we could not make payable. True when the backend confirmed it. */
  cancelSale(): Promise<boolean>
}

export type OrchestrateResult =
  | { ok: true; status: SaleStatus; manual_payment: ManualPayment | null }
  | { ok: false; httpStatus: number; code: string; message: string }

const START_FAILED = { ok: false as const, httpStatus: 502, code: 'CHECKOUT_START_FAILED', message: 'No pudimos preparar el cobro. Toca «Reintentar».' }

/** Make a freshly claimed card / transfer sale payable, exactly once. */
export async function makeSalePayable(kind: 'card' | 'transfer', deps: OrchestrateDeps): Promise<OrchestrateResult> {
  let status = await deps.getStatus()
  if (!status) return { ...START_FAILED, code: 'STATUS_UNAVAILABLE' }

  // Not payable any more (cancelled / failed) or already settled: report, do nothing.
  if (status.state !== 'awaiting_payment') {
    const manual = kind === 'transfer' ? await deps.manualFallback() : null
    return { ok: true, status, manual_payment: manual }
  }

  let manual: ManualPayment | null = null
  const alreadyStarted = status.checkout_url !== null
  if (!alreadyStarted) {
    const started = await deps.startCheckout()
    if (!started.ok && started.reason === 'closed') {
      // SALE_CLOSED (claim no longer awaiting payment) or CART_CHANGED (the cart no longer matches
      // what was rung up): a definite refusal for THIS sale, the id is released.
      const changed = started.code === 'CART_CHANGED'
      return {
        ok: false, httpStatus: 409, code: changed ? 'CART_CHANGED' : 'SALE_CLOSED',
        message: started.message ?? (changed ? 'Esta venta cambió. Vuelve a cobrarla desde el mostrador.' : 'Esta venta ya no se puede cobrar. Puedes volver a cobrarla.'),
      }
    }
    if (!started.ok && started.reason === 'exists') {
      // A checkout is already open (a racing retry): do NOT open another, just use it.
      manual = null
      status = (await deps.getStatus()) ?? status
    } else if (!started.ok) {
      // The backend releases its open mark when the provider checkout fails, so the SAME id can
      // retry. Surface its own reason (PAYMENT_METHOD_DISABLED, SELLER_MP_NOT_CONNECTED,
      // MP_TOKEN_EXPIRED, PAYMENT_SESSION_FAILED...) instead of a generic error, and do NOT
      // cancel: the sale stays retryable.
      return {
        ok: false, httpStatus: 502, code: 'CHECKOUT_START_FAILED',
        message: started.message ? `${started.message} Toca «Reintentar».` : START_FAILED.message,
      }
    }
    else {
      manual = started.manual_payment
      status = (await deps.getStatus()) ?? status
    }
  }

  if (kind === 'card') {
    // The QR is whatever the backend read back from the payment session.
    if (status.state === 'awaiting_payment' && !status.checkout_url) return { ...START_FAILED, code: 'CHECKOUT_URL_MISSING' }
    return { ok: true, status, manual_payment: null }
  }

  // Transfer: complete the cart so the order exists in pending_payment. Nothing is confirmed.
  if (status.state === 'awaiting_payment') {
    if (!(await deps.completeCart())) {
      return { ok: false, httpStatus: 503, code: 'TRANSFER_COMPLETE_FAILED', message: 'No pudimos terminar de registrar la transferencia. Toca «Reintentar»: no se cobra doble.' }
    }
    status = (await deps.getStatus()) ?? status
  }
  return { ok: true, status, manual_payment: manual ?? (await deps.manualFallback()) }
}
