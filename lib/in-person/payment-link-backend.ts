import 'server-only'
/**
 * Backend I/O for payment links (in-person-sales S4). Every call goes to the BACKEND directly —
 * seller calls with the Clerk JWT, public calls with the publishable key, agent calls with the
 * internal secret — never through one of our own Next routes (a server-side fetch to our own
 * authed route loses the cookie).
 */
import { backendFetch } from './counter-backend'
import type { PayFlowDeps } from './payment-link-flow'
import { payStartBody, type PayChoice } from './payment-link'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const INTERNAL_SECRET = process.env.MEDUSA_INTERNAL_SECRET ?? ''

import type { ManualPayment } from './counter-checkout'
import type { AgentLinkView } from './payment-link-mcp'

/** The union of fields the payment-link backend routes answer with; every one optional. */
export interface LinkJson {
  code?: string
  message?: string
  cart_id?: string
  redirect_url?: string
  manual_payment?: ManualPayment | null
  payment_link?: AgentLinkView & { state?: string; shop?: { slug?: string; name?: string; logo_url?: string | null }; [k: string]: unknown }
  payment_links?: AgentLinkView[]
}

export interface LinkError { code?: string; message?: string }

export async function readJson(res: Response): Promise<LinkJson> {
  return ((await res.json().catch(() => ({}))) ?? {}) as LinkJson
}

/** The public link for the pay page. */
export async function getPublicLink(token: string): Promise<{ status: number; body: LinkJson }> {
  try {
    const res = await backendFetch(`/store/payment-links/${encodeURIComponent(token)}`)
    return { status: res.status, body: await readJson(res) }
  } catch {
    return { status: 502, body: {} }
  }
}

export function buildPayFlowDeps(token: string, choice: PayChoice['id'], manualSubType: 'clabe' | 'dimo' | null): PayFlowDeps {
  return {
    async buildCart() {
      try {
        const res = await backendFetch(`/store/payment-links/${encodeURIComponent(token)}/cart`, { method: 'POST', body: '{}' })
        const j = await readJson(res)
        if (res.ok && typeof j.cart_id === 'string') return { ok: true as const, cart_id: j.cart_id }
        return { ok: false as const, status: res.status, code: j.code, message: j.message }
      } catch {
        return { ok: false as const, status: 502, code: 'BACKEND_UNREACHABLE', message: 'No hay conexión con la tienda. Inténtalo de nuevo.' }
      }
    },
    async startCheckout(cartId) {
      try {
        const res = await backendFetch(`/store/carts/${encodeURIComponent(cartId)}/start-checkout`, {
          method: 'POST',
          body: JSON.stringify(payStartBody(choice, manualSubType)),
        })
        const j = await readJson(res)
        if (!res.ok) return { ok: false as const, status: res.status, code: j.code, message: j.message }
        return { ok: true as const, redirect_url: typeof j.redirect_url === 'string' ? j.redirect_url : null, manual_payment: j.manual_payment ?? null }
      } catch {
        return { ok: false as const, status: 502, code: 'BACKEND_UNREACHABLE', message: 'No hay conexión con la tienda. Inténtalo de nuevo.' }
      }
    },
    async completeCart(cartId) {
      try {
        const res = await backendFetch(`/store/carts/${encodeURIComponent(cartId)}/complete`, { method: 'POST', body: '{}' })
        return res.ok
      } catch {
        return false
      }
    },
  }
}

/** Agent (MCP) calls: the shop is a slug the storefront resolved from the token, never from the args. */
export async function internalLinkCall(
  method: 'GET' | 'POST',
  path: string,
  slug: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; body: LinkJson }> {
  if (!INTERNAL_SECRET) return { ok: false, status: 503, body: { message: 'Internal secret not configured.' } }
  try {
    const res = await fetch(`${MEDUSA_BASE}${path}?seller_slug=${encodeURIComponent(slug)}`, {
      method,
      headers: { 'x-internal-secret': INTERNAL_SECRET, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(25_000),
    })
    return { ok: res.ok, status: res.status, body: await readJson(res) }
  } catch (e) {
    return { ok: false, status: 502, body: { message: String(e) } }
  }
}
