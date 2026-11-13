import { getLanguagePreference } from '@/lib/site-language-server'
import { BuyerCopyText, BuyerPresentationProvider } from '@/app/components/BuyerPresentationContext'
import { redirect, notFound } from 'next/navigation'
import { currentUser } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import ConversationClient from './ConversationClient'
import Link from 'next/link'
import type { Metadata } from 'next'
import { getShopStripe } from '@/lib/stripe'
import { sellerHasMpConnected } from '@/lib/mercadopago-connect'
import { resolveConversationLedger } from '@/lib/conversation-ledger'
import type { LedgerOffer } from '@/lib/transaction-ledger'
import { returnsWindowLabel } from '@/lib/trust-signals'
import { marketCodeForCurrency, resolveMarketPresentation } from '@/lib/market-presentation'
import { getDictionary } from '@/lib/dictionary'
import { resolveConversationCheckout } from '@/lib/conversation-checkout'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const { data: conv } = await db
    .from('marketplace_conversations')
    .select('marketplace_listings ( title )')
    .eq('id', id)
    .maybeSingle()
  const listing = (conv?.marketplace_listings as unknown as { title?: string } | null)
  return { title: listing?.title ? `${listing.title} — Mensajes` : 'Conversación — Miyagi Sánchez' }
}

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await currentUser()
  if (!user) redirect(`/sign-in?redirect_url=/messages/${id}`)

  // ── Fetch conversation (no offers embed — offers table has no currency column) ──
  // `marketplace_shops.market_code` is deliberately ABSENT: it has never been a
  // column on the mirror (the operating market is a fact of the Medusa seller), and
  // selecting it made PostgREST answer 400 — which this page turned into a 404. Every
  // buyer who pressed "Preguntar" got the conversation created and then a not-found
  // page (PR 351 → 2026-08-15). Presentation comes from the listing's own currency.
  const { data: conv, error: convError } = await db
    .from('marketplace_conversations')
    .select(`
      id, status, buyer_clerk_user_id, seller_clerk_user_id, last_event_at,
      buyer_unread, seller_unread, offer_id, medusa_order_id,
      marketplace_listings ( id, medusa_product_id, title, price_cents, currency, images, status, condition, location, listing_type ),
      marketplace_shops ( id, name, slug, logo_url, verified, metadata, mp_enabled )
    `)
    .eq('id', id)
    .maybeSingle()

  // A read that FAILED is not a conversation that does not exist. Collapsing the two
  // is what made a live outage indistinguishable from a bad link — 404 tells the user
  // the thing is gone, which was false and unactionable. Throw instead, so the error
  // boundary offers a retry and the failure is visible in logs and Sentry.
  if (convError) {
    console.error('[messages/:id] conversation read failed:', convError)
    throw new Error(`No se pudo leer la conversación: ${convError.message}`)
  }
  if (!conv) notFound()

  const isBuyer  = conv.buyer_clerk_user_id === user.id
  const isSeller = conv.seller_clerk_user_id === user.id
  if (!isBuyer && !isSeller) notFound()

  // ── Derive currency from listing (offers table has no currency column) ──────
  const listingRaw = conv.marketplace_listings as unknown as Array<{ currency: string }> | { currency: string } | null
  const listingCurrency: string = Array.isArray(listingRaw)
    ? (listingRaw[0]?.currency ?? 'MXN')
    : (listingRaw?.currency ?? 'MXN')

  // ── Fetch offer + events in parallel ─────────────────────────────────────────
  const offerId = (conv as unknown as { offer_id: string | null }).offer_id

  const [eventsResult, offerResult] = await Promise.all([
    db.from('marketplace_conversation_events')
      .select('id, event_type, actor, metadata, created_at')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true }),
    offerId
      ? db.from('marketplace_offers')
          .select('id, status, offer_amount_cents, counter_amount_cents, counter_message, expires_at, counter_expires_at, checkout_expires_at')
          .eq('id', offerId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  // Attach currency (from listing) to the offer object for the client
  const offerWithCurrency = offerResult.data
    ? { ...offerResult.data, currency: listingCurrency }
    : null

  const shopRaw = conv.marketplace_shops as unknown as {
    slug?: string | null
    verified?: boolean | null
    metadata?: Record<string, unknown> | null
    mp_enabled?: boolean | null
  } | null
  const presentation = resolveMarketPresentation(marketCodeForCurrency(listingCurrency) ?? 'mx', await getLanguagePreference())
  const buyerCopy = (await getDictionary(presentation.language)).buyerCopy
  const stripeSettings = getShopStripe(shopRaw?.metadata ?? null)
  const sellerHasStripe = !!(stripeSettings.charges_enabled && stripeSettings.account_id && stripeSettings.enabled !== false)
  const sellerHasMp = sellerHasMpConnected(shopRaw?.metadata ?? null)
  // How the buyer pays an accepted offer — shared with the refresh endpoint, which
  // REPLACES this payload moments after mount (see lib/conversation-checkout.ts).
  const checkout = await resolveConversationCheckout(shopRaw)

  // ── Trust capsule (C.5) — the slim <TrustSignals> shown at the negotiation entry.
  // Derived server-side from the shop the page already loaded: verification, an online
  // card rail (⇒ payment protection), and a positive return window. Null-safe — a missing
  // field simply drops its chip (the capsule renders nothing when all three are absent). ──
  const shopSettings = (shopRaw?.metadata?.settings ?? {}) as Record<string, unknown>
  const returnsPolicy = shopSettings.returns_policy as { window?: string } | undefined
  const trustCapsule = {
    verified: !!shopRaw?.verified,
    paymentProtected: sellerHasStripe || sellerHasMp,
    returnsLabel: returnsWindowLabel(returnsPolicy?.window),
  }

  // Mark as read (fire-and-forget, non-blocking)
  const unreadField = isBuyer ? 'buyer_unread' : 'seller_unread'
  db.from('marketplace_conversations').update({ [unreadField]: 0 }).eq('id', id).then(() => {})

  type ConvParam = Parameters<typeof ConversationClient>[0]['initialConversation']
  const initialConversation: ConvParam = {
    ...(conv as unknown as ConvParam),
    marketplace_offers: offerWithCurrency as ConvParam['marketplace_offers'],
    ...checkout,
  }

  // ── Transaction ledger (C.1/C.2) — seed the durable card for the first render ──
  const role = isBuyer ? 'buyer' : 'seller'
  const ledgerOffer: LedgerOffer | null = offerWithCurrency
    ? {
        status: offerWithCurrency.status as LedgerOffer['status'],
        offer_amount_cents: offerWithCurrency.offer_amount_cents,
        counter_amount_cents: offerWithCurrency.counter_amount_cents,
        expires_at: offerWithCurrency.expires_at,
        counter_expires_at: offerWithCurrency.counter_expires_at,
        checkout_expires_at: offerWithCurrency.checkout_expires_at,
        currency: offerWithCurrency.currency,
      }
    : null
  const medusaOrderIdHint = (conv as unknown as { medusa_order_id: string | null }).medusa_order_id
  const initialTransaction = await resolveConversationLedger(ledgerOffer, offerId, role, medusaOrderIdHint)

  return (
    <BuyerPresentationProvider presentation={presentation} copy={buyerCopy}>
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 72px)' }}>
      {/* Back nav */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-elevated)', flexShrink: 0 }}>
        <Link href="/messages" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--fg-muted)', textDecoration: 'none' }} className="hover:text-[var(--fg)]">
          <i className="iconoir-arrow-left" style={{ fontSize: 18 }} />
          <BuyerCopyText copyKey="messages.id.page.a13f054b" /></Link>
      </div>

      <ConversationClient
        conversationId={id}
        initialConversation={initialConversation}
        initialEvents={(eventsResult.data ?? []) as Parameters<typeof ConversationClient>[0]['initialEvents']}
        role={isBuyer ? 'buyer' : 'seller'}
        currentUserId={user.id}
        currentUserEmail={user.emailAddresses[0]?.emailAddress ?? ''}
        initialTransaction={initialTransaction}
        trustCapsule={trustCapsule}
      />
    </div>
    </BuyerPresentationProvider>
  )
}
