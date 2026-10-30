import 'server-only'
/**
 * The I/O shell for the counter's card / transfer sales (in-person-sales S2). Every call goes
 * to the BACKEND with the seller's Clerk JWT and the publishable key — never to one of our own
 * authed Next routes, which would lose the cookie (a documented learning). The decisions live
 * in `counter-checkout.ts`; this file only moves bytes.
 */
import type { OrchestrateDeps, ManualPayment, SaleStatus } from './counter-checkout'
import { manualFromSellerMetadata, startCheckoutBody, type CardProvider } from './counter-checkout'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const PUB_KEY = process.env.MEDUSA_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''
export const BACKEND_TIMEOUT_MS = 25_000

export const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function backendFetch(path: string, init: RequestInit & { jwt?: string } = {}): Promise<Response> {
  const { jwt, headers, ...rest } = init
  return fetch(`${MEDUSA_BASE}${path}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      'x-publishable-api-key': PUB_KEY,
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      ...(headers as Record<string, string> | undefined),
    },
  })
}

export async function readSaleStatus(jwt: string, clientId: string): Promise<SaleStatus | null> {
  const res = await backendFetch(`/store/sellers/me/in-person-orders/${clientId}`, { jwt })
  if (!res.ok) return null
  return (await res.json()) as SaleStatus
}

/** The shop's payment methods as the buyer checkout sees them (public, by slug). */
export async function readCheckoutMethods(slug: string): Promise<Array<{ id?: string; sub_options?: Array<{ type?: string }> }>> {
  const res = await backendFetch(`/store/sellers/${encodeURIComponent(slug)}/checkout-options?listing_type=product`)
  if (!res.ok) throw new Error(`checkout-options ${res.status}`)
  const json = (await res.json()) as { payment_methods?: Array<{ id?: string; sub_options?: Array<{ type?: string }> }> }
  return json.payment_methods ?? []
}

export function buildOrchestrateDeps(args: {
  jwt: string
  clientId: string
  cartId: string
  kind: 'card' | 'transfer'
  sellerId: string
  provider: CardProvider | null
  subType: 'clabe' | 'dimo' | null
}): OrchestrateDeps {
  const { jwt, clientId, cartId, kind, sellerId, provider, subType } = args
  return {
    getStatus: () => readSaleStatus(jwt, clientId),
    async startCheckout() {
      try {
        const res = await backendFetch(`/store/carts/${encodeURIComponent(cartId)}/start-checkout`, {
          method: 'POST',
          body: JSON.stringify(startCheckoutBody(kind, sellerId, provider, subType)),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          console.error('[en-persona] start-checkout refused', res.status, text)
          let code: string | undefined
          let message: string | undefined
          try {
            const parsed = JSON.parse(text) as { code?: string; message?: string }
            code = parsed.code
            message = typeof parsed.message === 'string' ? parsed.message : undefined
          } catch { /* not JSON */ }
          if (res.status === 409 && code === 'CHECKOUT_EXISTS') return { ok: false as const, reason: 'exists' as const }
          if (res.status === 409 && (code === 'SALE_CLOSED' || code === 'CART_CHANGED')) return { ok: false as const, reason: 'closed' as const, code, message }
          return { ok: false as const, reason: 'failed' as const, code, message }
        }
        const json = (await res.json()) as { manual_payment?: ManualPayment | null }
        return { ok: true as const, manual_payment: json.manual_payment ?? null }
      } catch (err) {
        console.error('[en-persona] start-checkout failed:', err instanceof Error ? err.message : String(err))
        return { ok: false as const, reason: 'failed' as const }
      }
    },
    async completeCart() {
      try {
        const res = await backendFetch(`/store/carts/${encodeURIComponent(cartId)}/complete`, { method: 'POST', body: '{}' })
        return res.ok
      } catch {
        return false
      }
    },
    async manualFallback() {
      try {
        const res = await backendFetch('/store/sellers/me', { jwt })
        if (!res.ok) return null
        const json = (await res.json()) as { seller?: { metadata?: unknown } }
        return manualFromSellerMetadata(json.seller?.metadata)
      } catch {
        return null
      }
    },
    async cancelSale() {
      try {
        const res = await backendFetch(`/store/sellers/me/in-person-orders/${clientId}/cancel`, { method: 'POST', jwt, body: '{}' })
        return res.ok
      } catch {
        return false
      }
    },
  }
}
