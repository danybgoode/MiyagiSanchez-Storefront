/**
 * Payment-link MCP tools — the PURE half (in-person-sales S4.4, D16). Maps tool arguments to the
 * backend body and a backend link to what an agent is shown. The shop is NEVER an argument: the
 * handler takes it from the `ms_agent_` token alone, and the backend validates the body with the
 * same core as the web routes, so an agent reaches no laxer rule than a person.
 */
import { linkShortUrl, linkUrl } from './payment-link'

export type ArgsResult = { ok: true; body: Record<string, unknown> } | { ok: false; message: string }

/** Pesos (what an agent says) to integer centavos; anything not a positive finite amount is refused. */
export function pesosToCents(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  const cents = Math.round(value * 100)
  return Number.isSafeInteger(cents) ? cents : null
}

export function mapCreateLinkArgs(args: Record<string, unknown>): ArgsResult {
  const kind = args.kind
  if (kind !== 'products' && kind !== 'amount') return { ok: false, message: 'kind debe ser "products" o "amount".' }
  const body: Record<string, unknown> = { kind }
  if (args.expires_in_days !== undefined) body.expires_in_days = args.expires_in_days
  if (kind === 'products') {
    if (!Array.isArray(args.lines) || args.lines.length === 0) return { ok: false, message: 'lines debe traer al menos un producto: [{ variant_id, quantity }].' }
    body.lines = args.lines.map((l) => {
      const o = (l ?? {}) as Record<string, unknown>
      return { variant_id: o.variant_id, quantity: o.quantity }
    })
    if (args.uses !== undefined) body.uses = args.uses
    return { ok: true, body }
  }
  // Free amount: the agent speaks pesos, the backend centavos. A shop-chosen price is the point here.
  const cents = pesosToCents(args.amount_mxn)
  if (cents === null) return { ok: false, message: 'amount_mxn debe ser un monto en pesos mayor a cero.' }
  body.concept = args.concept
  body.amount_cents = cents
  body.uses = 'single'
  return { ok: true, body }
}

export interface AgentLinkView {
  id: string
  token: string
  kind: string
  concept: string | null
  amount_cents: number | null
  uses: string
  expires_at: string
  state: string
  paid_order_ids: string[]
  pending_order_ids?: string[]
}

/** The link as an agent hands it to a person: the id, state, and both URLs. The token itself stays inside the URL. */
export function formatLinkForAgent(link: AgentLinkView) {
  return {
    id: link.id,
    state: link.state,
    kind: link.kind,
    concept: link.concept,
    amount_mxn: link.amount_cents === null ? null : link.amount_cents / 100,
    uses: link.uses,
    expires_at: link.expires_at,
    paid_orders: link.paid_order_ids.length,
    pending_confirmation: (link.pending_order_ids ?? []).length,
    url: linkUrl(link.token),
    short_url: linkShortUrl(link.token),
  }
}

export function mapCancelLinkArgs(args: Record<string, unknown>): { ok: true; id: string } | { ok: false; message: string } {
  const id = args.link_id
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? { ok: true, id } : { ok: false, message: 'link_id no es válido. Usa el id de list_payment_links.' }
}

export function filterLinksByState<T extends { state: string }>(links: T[], state: unknown): T[] {
  return typeof state === 'string' && state ? links.filter((l) => l.state === state) : links
}
