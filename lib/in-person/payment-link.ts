/**
 * Payment links — the storefront's PURE half (in-person-sales S4.2 to S4.4, D13 to D16).
 *
 * Form to request body, link URLs, state labels, and the pay page's state to screen. The backend
 * validates everything again (it is the authority and the MCP tools go through it too); this file
 * exists so a screen never sends a body it could have known was wrong, and so the words are tested.
 * Integer centavos only; a client price is never sent for a products link (the server prices it).
 */
import { SITE_ORIGIN } from '@/lib/market-seo'
import { SHORTLINK_ORIGIN } from '@/lib/shortlink'
import { buildWhatsAppShareLink } from '@/lib/share-link'
import { parsePesosToCents, type SaleLine } from './counter-cart'

export type LinkState = 'pending' | 'paid' | 'expired' | 'cancelled'

export const LINK_MIN_AMOUNT_CENTS = 1_000
export const LINK_MAX_AMOUNT_CENTS = 5_000_000
export const LINK_DEFAULT_DAYS = 7
export const LINK_MAX_DAYS = 30

export interface LinkForm {
  mode: 'products' | 'amount'
  lines: SaleLine[]
  uses: 'single' | 'multi'
  days: number
  concept: string
  amountText: string
}

export type LinkBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string }

export function buildLinkBody(form: LinkForm): LinkBodyResult {
  if (!Number.isInteger(form.days) || form.days < 1 || form.days > LINK_MAX_DAYS) {
    return { ok: false, message: `El link puede durar de 1 a ${LINK_MAX_DAYS} días.` }
  }
  if (form.mode === 'products') {
    if (form.lines.length === 0) return { ok: false, message: 'Elige al menos un producto.' }
    return { ok: true, body: { kind: 'products', lines: form.lines, uses: form.uses, expires_in_days: form.days } }
  }
  const concept = form.concept.trim().replace(/\s+/g, ' ')
  if (concept.length < 3 || concept.length > 80) return { ok: false, message: 'El concepto debe tener de 3 a 80 letras.' }
  const cents = parsePesosToCents(form.amountText)
  if (cents === null || cents < LINK_MIN_AMOUNT_CENTS || cents > LINK_MAX_AMOUNT_CENTS) {
    return { ok: false, message: 'El monto debe ser de $10 a $50,000.' }
  }
  // A free amount is one charge: "varios pagos" is not offered, and is never sent.
  return { ok: true, body: { kind: 'amount', concept, amount_cents: cents, uses: 'single', expires_in_days: form.days } }
}

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/

export function isLinkToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value)
}

/** The long link a buyer opens. `null` for something that is not a token (never a URL built from junk). */
export function linkUrl(token: string): string | null {
  return isLinkToken(token) ? `${SITE_ORIGIN}/pagar/${token}` : null
}

/** The `mschz.org` short form; the short host forwards the `pagar` family to the same path (lib/shortlink.ts). */
export function linkShortUrl(token: string): string | null {
  return isLinkToken(token) ? `${SHORTLINK_ORIGIN}/pagar/${token}` : null
}

export function linkWhatsAppUrl(token: string, shopName: string, what: string): string | null {
  const short = linkShortUrl(token)
  return short ? buildWhatsAppShareLink(`Paga ${what} en ${shopName}`, short) : null
}

export const LINK_STATE_LABEL: Record<LinkState, string> = {
  pending: 'Esperando pago',
  paid: 'Pagado',
  expired: 'Vencido',
  cancelled: 'Cancelado',
}

export function linkStateLabel(state: string): string {
  return LINK_STATE_LABEL[state as LinkState] ?? state
}

/** Only a link that can still be paid can be cancelled. */
export function isLinkCancellable(state: string): boolean {
  return state === 'pending'
}

export interface LinkView {
  id: string
  token: string
  kind: string
  concept: string | null
  amount_cents: number | null
  uses: string
  expires_at: string
  state: string
  paid_order_ids: string[]
  lines: Array<{ variant_id: string; quantity: number }> | null
}

/** One row's title: the concept, or the number of products. */
export function linkTitle(link: Pick<LinkView, 'kind' | 'concept' | 'lines'>): string {
  if (link.kind === 'amount') return link.concept ?? 'Cobro libre'
  const units = (link.lines ?? []).reduce((n, l) => n + l.quantity, 0)
  return `${units} ${units === 1 ? 'producto' : 'productos'}`
}

/** Single-use links that were paid more than once (two buyers raced): shown, never hidden. */
export function extraPayments(link: Pick<LinkView, 'uses' | 'paid_order_ids'>): number {
  return link.uses === 'single' ? Math.max(0, link.paid_order_ids.length - 1) : 0
}

// ── The pay page ────────────────────────────────────────────────────────────────────────────

export type PayScreen =
  | { screen: 'ready' }
  | { screen: 'paid' | 'expired' | 'cancelled' | 'not_found' | 'unavailable'; message: string }

const PAY_MESSAGES = {
  paid: 'Este cobro ya se pagó.',
  expired: 'Este link ya venció. Pídele uno nuevo a la tienda.',
  cancelled: 'La tienda canceló este cobro. Pídele uno nuevo.',
  not_found: 'No encontramos este cobro. Revisa el link con la tienda.',
  unavailable: 'No pudimos abrir este cobro. Inténtalo de nuevo en un momento.',
} as const

/**
 * The page's state from the backend. Only an explicit `pending` link (or a multi-use one still
 * open) is payable; an unknown or missing state is NEVER treated as payable.
 */
export function payScreen(input: { httpStatus: number; state?: string | null; code?: string | null }): PayScreen {
  const { httpStatus, state, code } = input
  if (code === 'LINK_PAID') return { screen: 'paid', message: PAY_MESSAGES.paid }
  if (code === 'LINK_EXPIRED') return { screen: 'expired', message: PAY_MESSAGES.expired }
  if (code === 'LINK_CANCELLED') return { screen: 'cancelled', message: PAY_MESSAGES.cancelled }
  if (httpStatus === 404 || code === 'LINK_NOT_FOUND') return { screen: 'not_found', message: PAY_MESSAGES.not_found }
  if (httpStatus >= 200 && httpStatus < 300) {
    if (state === 'pending') return { screen: 'ready' }
    if (state === 'paid') return { screen: 'paid', message: PAY_MESSAGES.paid }
    if (state === 'expired') return { screen: 'expired', message: PAY_MESSAGES.expired }
    if (state === 'cancelled') return { screen: 'cancelled', message: PAY_MESSAGES.cancelled }
  }
  return { screen: 'unavailable', message: PAY_MESSAGES.unavailable }
}

/** Which payment choices the page offers, from the shop's checkout-options (online first). */
export interface PayChoice { id: 'mercadopago' | 'stripe' | 'manual'; label: string }

export function payChoices(methods: Array<{ id?: string; sub_options?: Array<{ type?: string }> }>): PayChoice[] {
  const out: PayChoice[] = []
  const ids = new Set(methods.map((m) => m.id))
  if (ids.has('mercadopago')) out.push({ id: 'mercadopago', label: 'tarjeta o Mercado Pago' })
  if (ids.has('stripe')) out.push({ id: 'stripe', label: 'tarjeta' })
  const manual = methods.find((m) => m.id === 'manual')
  const transfer = (manual?.sub_options ?? []).some((o) => o.type === 'clabe' || o.type === 'dimo')
  if (transfer) out.push({ id: 'manual', label: 'transferencia' })
  return out
}

/** The start-checkout body. The server forces seller, fulfilment and price; these are only the buyer's choice. */
export function payStartBody(choice: PayChoice['id'], manualSubType: 'clabe' | 'dimo' | null) {
  return choice === 'manual'
    ? { provider: 'manual' as const, manual_sub_type: manualSubType ?? 'clabe', fulfillment_method: 'digital' as const }
    : { provider: choice, fulfillment_method: 'digital' as const }
}

/** After start-checkout refuses with these, build a fresh cart instead of reusing the old one. */
export function shouldRebuildCart(status: number, code: string | undefined): boolean {
  return status === 409 && (code === 'CHECKOUT_EXISTS' || code === 'CART_CHANGED')
}
