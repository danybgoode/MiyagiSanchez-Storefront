/**
 * How a buyer pays an accepted offer from a conversation — the ONE derivation both
 * producers of a conversation payload use: the first render (`app/(shell)/messages/
 * [id]/page.tsx`) and the refresh endpoint (`app/api/conversations/[id]/route.ts`).
 *
 * Two facts, not one:
 *  - `checkout_provider` — a card rail to pre-select (Mercado Pago, else Stripe),
 *    read from the conversation's shop mirror as before.
 *  - `checkout_available` — the shop accepts ANY checkout payment method (card, MP,
 *    bank transfer, DiMo), read from the MEDUSA seller, the store the PDP and
 *    checkout trust (shop settings live in two stores; the mirror can lag).
 *
 * Reported live 2026-11-11 (miel-verduras): a transfer-only shop's accepted offer
 * said «sin pagos en línea» with no way to pay. The first fix set
 * `checkout_available` on the first render only; the client re-fetches the
 * conversation right after mount and REPLACES it, so the button vanished
 * (fresh-review catch on PR 496). Hence one helper, imported by both producers.
 *
 * Fails closed: an unreadable Medusa shop is `checkout_available: false` (no
 * button, as before). Display only — checkout and the backend re-prove everything.
 */

import { getShopStripe } from '@/lib/stripe'
import { sellerHasMpConnected } from '@/lib/mercadopago-connect'
import { publicShopPaymentAvailability, shopAcceptsAnyPayment } from '@/lib/public-shop-commerce'
import type { CheckoutProvider } from '@/lib/cart'

export type ConversationShopRow = {
  slug?: string | null
  metadata?: Record<string, unknown> | null
} | null

export type ConversationCheckout = {
  checkout_provider: Extract<CheckoutProvider, 'mercadopago' | 'stripe'> | null
  checkout_available: boolean
}

export type ConversationCheckoutDeps = {
  /** The Medusa seller's metadata by slug, or `null` when absent/unreadable. */
  readonly sellerMetadata: (slug: string) => Promise<Record<string, unknown> | null>
}

// Lazy: `lib/listings` pulls in `next/cache`, which keeps this module's pure half
// out of the node test runner if imported at the top.
const defaultDeps: ConversationCheckoutDeps = {
  sellerMetadata: async (slug) => {
    const { getShop } = await import('@/lib/listings')
    return (await getShop(slug))?.metadata ?? null
  },
}

/** The card rail to pre-select, from the mirror row (unchanged rule). */
export function conversationCheckoutProvider(shop: ConversationShopRow): ConversationCheckout['checkout_provider'] {
  const metadata = shop?.metadata ?? null
  const stripe = getShopStripe(metadata)
  const sellerHasStripe = !!(stripe.charges_enabled && stripe.account_id && stripe.enabled !== false)
  const sellerHasMp = sellerHasMpConnected(metadata)
  return sellerHasMp ? 'mercadopago' : sellerHasStripe ? 'stripe' : null
}

export async function resolveConversationCheckout(
  shop: ConversationShopRow,
  deps: ConversationCheckoutDeps = defaultDeps,
): Promise<ConversationCheckout> {
  const provider = conversationCheckoutProvider(shop)
  if (provider) return { checkout_provider: provider, checkout_available: true }
  const slug = shop?.slug
  if (!slug) return { checkout_provider: null, checkout_available: false }
  try {
    const metadata = await deps.sellerMetadata(slug)
    return {
      checkout_provider: null,
      checkout_available: metadata ? shopAcceptsAnyPayment(publicShopPaymentAvailability(metadata)) : false,
    }
  } catch {
    return { checkout_provider: null, checkout_available: false }
  }
}
