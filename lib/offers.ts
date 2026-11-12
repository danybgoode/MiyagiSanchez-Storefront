// ── Offer types & state machine ───────────────────────────────────────────────

export type OfferStatus =
  | 'pending'    // awaiting seller response (48h)
  | 'accepted'   // seller accepted, checkout link sent to buyer (24h to pay)
  | 'declined'   // seller declined
  | 'countered'  // seller countered (24h for buyer to respond)
  | 'expired'    // no seller response within 48h
  | 'withdrawn'  // buyer cancelled before response
  | 'paid'       // payment completed via Stripe

export interface Offer {
  id: string
  listing_id: string
  shop_id: string
  buyer_clerk_user_id: string | null
  buyer_email: string
  buyer_name: string
  offer_amount_cents: number
  message: string | null
  status: OfferStatus
  counter_amount_cents: number | null
  counter_message: string | null
  counter_expires_at: string | null
  checkout_session_id: string | null
  checkout_expires_at: string | null
  expires_at: string
  created_at: string
  updated_at: string
}

// ── State machine guards ──────────────────────────────────────────────────────

export function isExpired(offer: Pick<Offer, 'status' | 'expires_at'>): boolean {
  return offer.status === 'pending' && new Date(offer.expires_at) < new Date()
}

export function isCounterExpired(offer: Pick<Offer, 'status' | 'counter_expires_at'>): boolean {
  return (
    offer.status === 'countered' &&
    !!offer.counter_expires_at &&
    new Date(offer.counter_expires_at) < new Date()
  )
}

export function canAccept(offer: Pick<Offer, 'status' | 'expires_at'>): boolean {
  return offer.status === 'pending' && !isExpired(offer)
}

export function canCounter(offer: Pick<Offer, 'status' | 'expires_at'>): boolean {
  return offer.status === 'pending' && !isExpired(offer)
}

export function canDecline(offer: Pick<Offer, 'status'>): boolean {
  return offer.status === 'pending' || offer.status === 'countered'
}

export function canWithdraw(offer: Pick<Offer, 'status'>): boolean {
  return offer.status === 'pending' || offer.status === 'countered'
}

export function canAcceptCounter(offer: Pick<Offer, 'status' | 'counter_expires_at'>): boolean {
  return offer.status === 'countered' && !isCounterExpired(offer)
}

/**
 * Has this deal run out? Each status has ONE clock, and only its own:
 *   pending → `expires_at` (the seller's time to answer) · countered → `counter_expires_at` (the buyer's time to accept)
 *   accepted → `checkout_expires_at` (the time to pay; `null` = no deadline — a shop without Stripe sets none).
 * Reported live 2026-11-12 (miel-verduras): an ACCEPTED offer showed «Trato expirado» because the conversation also
 * checked the counter's 24h window, which had passed after the buyer accepted. The PDP (lib/active-deal.ts) already
 * read it this way; the conversation now shares this.
 */
export function isDealExpired(
  offer: { status: OfferStatus | string; expires_at: string | null; counter_expires_at: string | null; checkout_expires_at?: string | null },
  now: Date = new Date(),
): boolean {
  const past = (iso: string | null | undefined) => !!iso && new Date(iso).getTime() < now.getTime()
  switch (offer.status) {
    case 'expired': return true
    case 'pending': return past(offer.expires_at)
    case 'countered': return past(offer.counter_expires_at)
    case 'accepted': return past(offer.checkout_expires_at)
    default: return false
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────

export function formatOfferAmount(cents: number, currency = 'MXN'): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100)
}

export function offerQuality(offerCents: number, askingCents: number): {
  pct: number
  label: string
  color: 'green' | 'amber' | 'red'
} {
  const pct = Math.round((offerCents / askingCents) * 100)
  if (pct >= 85) return { pct, label: 'Oferta razonable', color: 'green' }
  if (pct >= 70) return { pct, label: 'Algo por debajo', color: 'amber' }
  return { pct, label: 'Oferta baja', color: 'red' }
}

// ── Time helpers ──────────────────────────────────────────────────────────────

export function timeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'Expirada'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m} min`
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 2) return 'ahora'
  if (mins < 60) return `hace ${mins} min`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `hace ${hrs}h`
  const days = Math.floor(hrs / 24)
  return `hace ${days}d`
}

// ── Turn-owner + deadline (negotiation "whose turn is it") ──────────────────────

export type OfferRole = 'buyer' | 'seller'

export interface OfferTurn {
  /** Whose-turn / state line (es-MX). */
  line: string
  /** The deadline ISO to count down against with {@link timeUntil}, or null when none. */
  deadlineIso: string | null
}

const OFFER_STATUS_LABEL: Record<OfferStatus, string> = {
  pending:   'Oferta enviada',
  countered: 'Contraoferta',
  accepted:  'Oferta aceptada',
  declined:  'Oferta rechazada',
  expired:   'Oferta expirada',
  withdrawn: 'Oferta retirada',
  paid:      'Compra realizada',
}

/** Short badge label for an offer status (es-MX). */
export function offerStatusLabel(status: OfferStatus): string {
  return OFFER_STATUS_LABEL[status]
}

/**
 * Derive whose turn it is in a negotiation and which deadline applies — the single
 * source of truth for the chat offer panel AND the transaction-ledger negotiation
 * row, so the UI never re-infers "te toca" from which buttons happen to render.
 *
 * Deadlines (read-time expiry; no cron): a pending offer runs against `expires_at`
 * (48h for the seller to respond); a counter against `counter_expires_at` (24h for
 * the buyer); an accepted offer against `checkout_expires_at` (24h for the buyer to pay).
 */
export function offerTurn(
  offer: {
    status: OfferStatus
    expires_at: string
    counter_expires_at?: string | null
    checkout_expires_at?: string | null
  },
  role: OfferRole,
): OfferTurn {
  const now = Date.now()
  const past = (iso: string | null | undefined) => !!iso && new Date(iso).getTime() < now

  switch (offer.status) {
    case 'pending':
      if (past(offer.expires_at)) return { line: 'Oferta expirada', deadlineIso: null }
      return role === 'seller'
        ? { line: 'Te toca responder', deadlineIso: offer.expires_at }
        : { line: 'Esperando al vendedor', deadlineIso: offer.expires_at }
    case 'countered':
      if (past(offer.counter_expires_at)) return { line: 'Contraoferta expirada', deadlineIso: null }
      return role === 'buyer'
        ? { line: 'Te toca responder', deadlineIso: offer.counter_expires_at ?? null }
        : { line: 'Esperando tu respuesta', deadlineIso: offer.counter_expires_at ?? null }
    case 'accepted':
      if (past(offer.checkout_expires_at)) return { line: 'Trato expirado', deadlineIso: null }
      return role === 'buyer'
        ? { line: 'Te toca pagar', deadlineIso: offer.checkout_expires_at ?? null }
        : { line: 'Esperando el pago del comprador', deadlineIso: offer.checkout_expires_at ?? null }
    case 'paid':      return { line: 'Compra realizada', deadlineIso: null }
    case 'declined':  return { line: 'Oferta rechazada', deadlineIso: null }
    case 'withdrawn': return { line: 'Oferta retirada', deadlineIso: null }
    case 'expired':   return { line: 'Oferta expirada', deadlineIso: null }
    default:          return { line: '', deadlineIso: null }
  }
}

// ── Anchors ───────────────────────────────────────────────────────────────────

export const OFFER_ANCHORS = [
  { pct: 10, label: '-10%' },
  { pct: 15, label: '-15%' },
  { pct: 20, label: '-20%' },
] as const

export function anchorAmount(askingCents: number, discountPct: number): number {
  return Math.round(askingCents * (1 - discountPct / 100))
}

// ── Validation ────────────────────────────────────────────────────────────────

export const OFFER_FLOOR_PCT = 30   // hard block below 30% of asking
export const OFFER_WARN_PCT  = 50   // amber warning below 50% of asking

export function validateOfferAmount(
  offerCents: number,
  askingCents: number
): { ok: boolean; level: 'ok' | 'warn' | 'block'; message?: string } {
  if (offerCents <= 0 || isNaN(offerCents)) {
    return { ok: false, level: 'block', message: 'Ingresa un monto válido.' }
  }
  if (offerCents >= askingCents) {
    return { ok: false, level: 'block', message: 'La oferta debe ser menor al precio de venta. Usa "Comprar ahora".' }
  }
  const pct = (offerCents / askingCents) * 100
  if (pct < OFFER_FLOOR_PCT) {
    return { ok: false, level: 'block', message: `Monto muy bajo. El mínimo es el ${OFFER_FLOOR_PCT}% del precio.` }
  }
  if (pct < OFFER_WARN_PCT) {
    return { ok: true, level: 'warn', message: 'Oferta muy baja — el vendedor probablemente la rechazará.' }
  }
  return { ok: true, level: 'ok' }
}
