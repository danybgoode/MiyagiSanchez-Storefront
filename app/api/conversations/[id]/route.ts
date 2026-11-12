import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { resolveConversationCheckout } from '@/lib/conversation-checkout'
import { resolveConversationLedger } from '@/lib/conversation-ledger'
import type { LedgerOffer } from '@/lib/transaction-ledger'

// ── GET — full conversation thread ────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'No autenticado.' }, { status: 401 })

  // Fetch conversation without offers embed (offers table has no currency column)
  // `medusa_product_id` below: the header link and the pay button need the PRODUCT id. Without it this refresh fell back
  // to the mirror's own id and the link 404'd (reported live 2026-11-12) — the first render already selected it.
  const { data: conv } = await db
    .from('marketplace_conversations')
    .select(`
      id, status, buyer_clerk_user_id, seller_clerk_user_id, last_event_at,
      buyer_unread, seller_unread, offer_id, medusa_order_id,
      marketplace_listings ( id, medusa_product_id, title, price_cents, currency, images, status, condition, location, listing_type ),
      marketplace_shops ( id, name, slug, logo_url, metadata, mp_enabled )
    `)
    .eq('id', id)
    .maybeSingle()

  if (!conv) return NextResponse.json({ error: 'Conversación no encontrada.' }, { status: 404 })

  const isBuyer  = conv.buyer_clerk_user_id === user.id
  const isSeller = conv.seller_clerk_user_id === user.id
  if (!isBuyer && !isSeller) return NextResponse.json({ error: 'Sin acceso.' }, { status: 403 })

  // Derive currency from listing
  const listingRaw = conv.marketplace_listings as unknown as Array<{ currency: string }> | { currency: string } | null
  const listingCurrency: string = Array.isArray(listingRaw)
    ? (listingRaw[0]?.currency ?? 'MXN')
    : (listingRaw?.currency ?? 'MXN')

  // Fetch offer + events in parallel
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

  const offerWithCurrency = offerResult.data
    ? { ...offerResult.data, currency: listingCurrency }
    : null

  const shopRaw = conv.marketplace_shops as unknown as {
    slug?: string | null
    metadata?: Record<string, unknown> | null
  } | null
  // The SAME derivation as the first render — this payload replaces it on every
  // refresh, so a field set in only one place disappears (lib/conversation-checkout.ts).
  const checkout = await resolveConversationCheckout(shopRaw)

  // Read-marking is now explicit via POST .../read (decoupled from polling).

  // ── Transaction ledger (C.1) — read-only projection of the linked order's state ──
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
  const { ledger, orderId } = await resolveConversationLedger(ledgerOffer, offerId, role, medusaOrderIdHint)

  return NextResponse.json({
    conversation: { ...conv, marketplace_offers: offerWithCurrency, ...checkout },
    events: eventsResult.data ?? [],
    role,
    transaction: { ledger, orderId },
  })
}
