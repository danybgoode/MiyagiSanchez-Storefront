/**
 * Shared offer operations — used by both the seller portal and the seller's MCP
 * agent so a human clicking "aceptar" and an agent calling `respond_to_offer`
 * run the exact same code path (Seller Agent Operations · Sprint 1).
 *
 * `listShopOffers` powers the `list_offers` tool. `respondToOffer` (added in
 * US-2) holds the accept/counter/decline logic extracted from the existing
 * route, parameterized by the authorized seller's Clerk user id so the ownership
 * check is identical whether the caller is a signed-in seller or a scoped agent.
 */

import { offerCanProceed, offerCollectRefusal } from './shop-collect'
import { db } from './supabase'
import { stripe } from './stripe'
import { dispatchToBuyer } from './notifications/dispatch'
import { buildBuyerMessage } from './notifications/buyer-messages'
import { offerQuality, formatOfferAmount, timeUntil, canAccept, canCounter, canDecline, type OfferStatus } from './offers'
import { listingUrlFor } from './market-url'
import {
  sendOfferDeclined, sendOfferCountered, sendOfferAccepted,
  sendBuyerCounterExpiryWarning, sendBuyerPaymentExpiryWarning, cancelScheduledEmail,
} from './email'

export interface AgentOfferView {
  id: string
  listing_id: string
  listing_title: string
  status: OfferStatus
  offer_amount: string
  list_price: string
  pct_of_asking: number
  quality: string
  buyer_name: string
  message: string | null
  expires_in: string
  counter_amount: string | null
}

interface OfferRow {
  id: string
  offer_amount_cents: number
  message: string | null
  status: OfferStatus
  expires_at: string
  counter_amount_cents: number | null
  buyer_name: string
  listing_id: string
  marketplace_listings: { id: string; title: string; price_cents: number; currency: string }
}

/**
 * List a shop's non-terminal offers (newest first, pending first). With
 * `actionableOnly`, returns just the offers the seller can act on (`pending`).
 * Scoped by `shop_id` — never returns another shop's offers.
 */
export async function listShopOffers(
  shopId: string,
  opts?: { actionableOnly?: boolean },
): Promise<AgentOfferView[]> {
  const { data } = await db
    .from('marketplace_offers')
    .select(`
      id, offer_amount_cents, message, status, expires_at, counter_amount_cents, buyer_name, listing_id,
      marketplace_listings!inner(id, title, price_cents, currency)
    `)
    .eq('shop_id', shopId)
    .not('status', 'in', '("withdrawn","expired","paid")')
    .order('status', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(50)

  const rows = (data ?? []) as unknown as OfferRow[]
  const filtered = opts?.actionableOnly ? rows.filter((r) => r.status === 'pending') : rows

  return filtered.map((r) => {
    const l = r.marketplace_listings
    const q = offerQuality(r.offer_amount_cents, l.price_cents)
    return {
      id: r.id,
      listing_id: r.listing_id,
      listing_title: l.title,
      status: r.status,
      offer_amount: formatOfferAmount(r.offer_amount_cents, l.currency),
      list_price: formatOfferAmount(l.price_cents, l.currency),
      pct_of_asking: q.pct,
      quality: q.label,
      buyer_name: r.buyer_name,
      message: r.message,
      expires_in: timeUntil(r.expires_at),
      counter_amount: r.counter_amount_cents ? formatOfferAmount(r.counter_amount_cents, l.currency) : null,
    }
  })
}

// ── Respond to an offer (accept / counter / decline) ──────────────────────────
// Extracted verbatim from app/api/offers/[id]/respond so the seller portal and
// the seller's MCP agent share ONE code path. Parameterized by the authorized
// seller's Clerk user id — the ownership check is identical for both callers.

export interface RespondParams {
  offerId: string
  /** Clerk user id authorized to act on this offer (signed-in seller, or shop owner via agent token). */
  authorizedClerkUserId: string
  origin: string
  action: 'accept' | 'counter' | 'decline'
  counterAmountCents?: number
  counterMessage?: string
}

export interface RespondResult {
  ok: boolean
  status?: 'declined' | 'countered' | 'accepted'
  error?: string
  field?: string
  httpStatus: number
}

export async function respondToOffer(p: RespondParams): Promise<RespondResult> {
  const { offerId: id, authorizedClerkUserId, origin, action, counterAmountCents, counterMessage } = p

  // ── Fetch offer + listing + shop (must belong to the authorized seller) ──────
  const { data: offer } = await db
    .from('marketplace_offers')
    .select(`
      *,
      marketplace_listings!inner(
        id, medusa_product_id, title, price_cents, currency, listing_type, images, status,
        marketplace_shops!inner(id, slug, clerk_user_id, metadata)
      )
    `)
    .eq('id', id)
    .single()

  if (!offer) return { ok: false, error: 'Oferta no encontrada.', httpStatus: 404 }

  const listing = offer.marketplace_listings as unknown as {
    id: string; medusa_product_id: string | null; title: string; price_cents: number; currency: string
    listing_type: string; images: Array<{ url: string }> | null; status: string
    marketplace_shops: { id: string; slug: string | null; clerk_user_id: string | null; metadata: Record<string, unknown> | null }
  }

  if (listing.marketplace_shops.clerk_user_id !== authorizedClerkUserId) {
    return { ok: false, error: 'No autorizado.', httpStatus: 403 }
  }

  // Buyer recipient for "Ofertas" pref gating (guest → email as today). Email +
  // push + Telegram all fan out through dispatchToBuyer below (one gated place).
  const offerBuyer = {
    clerkUserId: (offer.buyer_clerk_user_id as string | null) ?? null,
    email: offer.buyer_email as string,
  }

  async function getConversationUrl() {
    const { data: conv } = await db
      .from('marketplace_conversations')
      .select('id')
      .eq('offer_id', id)
      .maybeSingle()
    return conv?.id ? `${origin}/messages/${conv.id}` : null
  }

  // ── Cancel any pending seller reminder emails (before any state change) ───────
  const scheduledIds = (offer.scheduled_reminder_ids ?? {}) as Record<string, string>
  const cancelSellerReminders = () => {
    if (scheduledIds.seller_24h) cancelScheduledEmail(scheduledIds.seller_24h).catch(() => {})
    if (scheduledIds.seller_expiry) cancelScheduledEmail(scheduledIds.seller_expiry).catch(() => {})
  }

  // ── Validate action against current state ─────────────────────────────────────
  if (action === 'accept' && !canAccept(offer)) {
    return { ok: false, error: 'Esta oferta no puede ser aceptada en su estado actual.', httpStatus: 409 }
  }
  if (action === 'counter' && !canCounter(offer)) {
    return { ok: false, error: 'Esta oferta no puede recibir contraoferta.', httpStatus: 409 }
  }
  if (action === 'decline' && !canDecline(offer)) {
    return { ok: false, error: 'Esta oferta no puede ser rechazada.', httpStatus: 409 }
  }

  // ── Can the shop collect? (listing-readiness S1.3) ───────────────────────────
  // Accepting or countering promises the buyer a payable price; on a shop that cannot take payment that promise
  // dead-ends (miel-verduras, 2026-11-11). Declining is always allowed. Shared by the web route and MCP. Medusa read;
  // fails CLOSED on an outage.
  if (action === 'accept' || action === 'counter') {
    const refusal = offerCollectRefusal(await offerCanProceed({
      slug: listing.marketplace_shops.slug,
      productId: listing.medusa_product_id,
      listingType: listing.listing_type,
    }), 'seller')
    if (refusal) return { ok: false, error: refusal.error, httpStatus: refusal.status }
  }

  async function emitConvEvent(eventType: string, actor: string, metadata: Record<string, unknown>, incBuyerUnread = false) {
    const { data: conv } = await db
      .from('marketplace_conversations')
      .select('id, buyer_unread')
      .eq('offer_id', id)
      .maybeSingle()
    if (!conv) return
    await Promise.all([
      db.from('marketplace_conversation_events').insert({ conversation_id: conv.id, event_type: eventType, actor, metadata }),
      incBuyerUnread
        ? db.from('marketplace_conversations').update({ last_event_at: new Date().toISOString(), updated_at: new Date().toISOString(), buyer_unread: (conv.buyer_unread ?? 0) + 1 }).eq('id', conv.id)
        : db.from('marketplace_conversations').update({ last_event_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', conv.id),
    ])
  }

  // ── Claim the transition (validate → CLAIM → apply) ──────────────────────────
  // The status checks above only READ. Two concurrent seller actions (accept + counter) both passed them and both wrote,
  // leaving an offer accepted after a counter was sent (security lens on PR 497 — the readiness await widened the
  // window). Each transition is now a conditional write on the status it was validated against, read back: the loser
  // gets a 409 and runs no side effects.
  const fromStatus = offer.status as string
  async function claim(patch: Record<string, unknown>): Promise<boolean> {
    const { data, error } = await db.from('marketplace_offers').update(patch).eq('id', id).eq('status', fromStatus).select('id')
    return !error && Array.isArray(data) && data.length > 0
  }
  const lostRace: RespondResult = { ok: false, error: 'Esta oferta acaba de cambiar. Actualiza la página.', httpStatus: 409 }

  // ── Decline ───────────────────────────────────────────────────────────────────
  if (action === 'decline') {
    if (!(await claim({ status: 'declined' }))) return lostRace
    cancelSellerReminders()
    emitConvEvent('offer_declined', 'system', {}, true).catch(e => console.error('[conv] decline event:', e))
    // Buyer "Ofertas" event — email + push + Telegram, all gated by the buyer's
    // prefs in one place (the standalone notify() push is folded into the seam).
    const declinedMsg = buildBuyerMessage('offer_declined', {
      listingTitle: listing.title,
      url: `https://miyagisanchez.com/mx/l/${listing.id}`,
    })
    void dispatchToBuyer(offerBuyer, {
      group: 'buyer.ofertas',
      email: to =>
        sendOfferDeclined({
          listingTitle: listing.title, listingUrl: `https://miyagisanchez.com/mx/l/${listing.id}`,
          askingPrice: formatOfferAmount(listing.price_cents, listing.currency),
          offerAmount: formatOfferAmount(offer.offer_amount_cents, listing.currency),
          buyerEmail: to, buyerName: offer.buyer_name,
        }),
      push: declinedMsg.push,
      telegram: declinedMsg.telegram,
    })
    return { ok: true, status: 'declined', httpStatus: 200 }
  }

  // ── Counter ─────────────────────────────────────────────────────────────────
  if (action === 'counter') {
    cancelSellerReminders()
    if (!counterAmountCents || !Number.isInteger(counterAmountCents)) {
      return { ok: false, error: 'Monto de contraoferta inválido.', field: 'counterAmount', httpStatus: 422 }
    }
    if (counterAmountCents <= offer.offer_amount_cents) {
      return { ok: false, error: 'La contraoferta debe ser mayor a la oferta del comprador.', field: 'counterAmount', httpStatus: 422 }
    }
    if (counterAmountCents >= listing.price_cents) {
      return { ok: false, error: 'La contraoferta debe ser menor al precio de lista.', field: 'counterAmount', httpStatus: 422 }
    }

    const counterExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    if (!(await claim({
      status: 'countered',
      counter_amount_cents: counterAmountCents,
      counter_message: counterMessage?.trim() ?? null,
      counter_expires_at: counterExpiresAt,
    }))) return lostRace

    const conversationUrl = await getConversationUrl()
    const counteredMsg = buildBuyerMessage('offer_countered', {
      listingTitle: listing.title,
      url: conversationUrl ?? `https://miyagisanchez.com/mx/l/${listing.id}`,
    })
    void dispatchToBuyer(offerBuyer, {
      group: 'buyer.ofertas',
      email: to =>
        sendOfferCountered({
          listingTitle: listing.title, listingId: listing.id,
          listingUrl: `https://miyagisanchez.com/mx/l/${listing.id}`,
          askingPrice: formatOfferAmount(listing.price_cents, listing.currency),
          offerAmount: formatOfferAmount(offer.offer_amount_cents, listing.currency),
          offerPct: Math.round((offer.offer_amount_cents / listing.price_cents) * 100),
          buyerName: offer.buyer_name, buyerEmail: to, buyerMessage: offer.message,
          currency: listing.currency, offerId: id,
          expiresAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
          counterAmount: formatOfferAmount(counterAmountCents, listing.currency),
          counterPct: Math.round((counterAmountCents / listing.price_cents) * 100),
          counterMessage: counterMessage ?? null,
          counterExpiresAt,
          conversationUrl,
        }),
      push: counteredMsg.push,
      telegram: counteredMsg.telegram,
    })

    sendBuyerCounterExpiryWarning({
      buyerEmail: offer.buyer_email,
      listingTitle: listing.title,
      listingUrl: `https://miyagisanchez.com/mx/l/${listing.id}`,
      counterAmount: formatOfferAmount(counterAmountCents, listing.currency),
      expiresAt: counterExpiresAt,
      conversationUrl,
    }, new Date(new Date(counterExpiresAt).getTime() - 4 * 3600 * 1000))
      .then(async counterExpiryId => {
        if (!counterExpiryId) return
        const newIds = { ...scheduledIds, buyer_counter_expiry: counterExpiryId }
        await db.from('marketplace_offers').update({ scheduled_reminder_ids: newIds }).eq('id', id)
      })
      .catch(e => console.error('[reminders] buyer counter expiry:', e))

    emitConvEvent('offer_countered', 'seller', { counter_amount_cents: counterAmountCents, currency: listing.currency, message: counterMessage ?? null }, true).catch(e => console.error('[conv] counter event:', e))
    // (buyer push folded into the dispatchToBuyer call above, gated by buyer.ofertas)
    return { ok: true, status: 'countered', httpStatus: 200 }
  }

  // ── Accept ────────────────────────────────────────────────────────────────────
  if (action === 'accept') {
    // Claim FIRST, so a losing concurrent request never creates a Stripe session; the session is attached below.
    if (!(await claim({ status: 'accepted' }))) return lostRace
    cancelSellerReminders()
    const acceptedCents = offer.offer_amount_cents
    const listingUrl = listingUrlFor(origin, listing.id)
    const shopMeta = listing.marketplace_shops.metadata as Record<string, unknown> | null
    const stripeSettings = (shopMeta?.settings as Record<string, unknown> | undefined)?.stripe as
      { enabled?: boolean; account_id?: string; charges_enabled?: boolean } | undefined

    let checkoutSessionId: string | null = null
    let checkoutExpires: string | null = null

    if (stripeSettings?.enabled !== false && stripeSettings?.charges_enabled && stripeSettings?.account_id) {
      try {
        const expiresAt = Math.floor(Date.now() / 1000) + 24 * 3600
        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          customer_email: offer.buyer_email,
          expires_at: expiresAt,
          line_items: [{
            price_data: {
              currency: listing.currency.toLowerCase(),
              unit_amount: acceptedCents,
              product_data: {
                name: `${listing.title} (oferta aceptada)`,
                images: listing.images?.[0]?.url ? [listing.images[0].url] : [],
              },
            },
            quantity: 1,
          }],
          payment_intent_data: {
            transfer_data: { destination: stripeSettings.account_id },
            application_fee_amount: 0,
            metadata: { listing_id: listing.id, shop_id: listing.marketplace_shops.id, listing_type: listing.listing_type, offer_id: id },
          },
          metadata: { listing_id: listing.id, shop_id: listing.marketplace_shops.id, listing_type: listing.listing_type, offer_id: id },
          success_url: `${origin}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${listingUrl}?offer=cancelled`,
        })
        checkoutSessionId = session.id
        checkoutExpires = new Date(expiresAt * 1000).toISOString()
      } catch (err) {
        console.error('Failed to create offer checkout session:', err)
      }
    }

    await db.from('marketplace_offers').update({
      checkout_session_id: checkoutSessionId,
      checkout_expires_at: checkoutExpires,
    }).eq('id', id).eq('status', 'accepted')

    emitConvEvent('offer_accepted', 'system', { amount_cents: offer.offer_amount_cents, currency: listing.currency }, true).catch(e => console.error('[conv] accept event:', e))
    const conversationUrl = await getConversationUrl()
    // Buyer "Ofertas" event — email + push + Telegram gated in one place (the
    // standalone notify() push is folded into the seam).
    const acceptedMsg = buildBuyerMessage('offer_accepted', {
      listingTitle: listing.title,
      url: conversationUrl ?? listingUrl,
    })
    void dispatchToBuyer(offerBuyer, {
      group: 'buyer.ofertas',
      email: to =>
        sendOfferAccepted({
          listingTitle: listing.title, listingId: listing.id,
          listingUrl,
          askingPrice: formatOfferAmount(listing.price_cents, listing.currency),
          offerAmount: formatOfferAmount(offer.offer_amount_cents, listing.currency),
          offerPct: Math.round((offer.offer_amount_cents / listing.price_cents) * 100),
          buyerName: offer.buyer_name, buyerEmail: to,
          currency: listing.currency, offerId: id,
          expiresAt: checkoutExpires ?? new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
          checkoutUrl: conversationUrl ?? listingUrl,
          checkoutExpiresAt: checkoutExpires,
          conversationUrl,
        }),
      push: acceptedMsg.push,
      telegram: acceptedMsg.telegram,
    })

    if (checkoutExpires) {
      sendBuyerPaymentExpiryWarning({
        buyerEmail: offer.buyer_email,
        listingTitle: listing.title,
        checkoutUrl: conversationUrl ?? listingUrl,
        agreedAmount: formatOfferAmount(acceptedCents, listing.currency),
        expiresAt: checkoutExpires,
      }, new Date(new Date(checkoutExpires).getTime() - 4 * 3600 * 1000))
        .then(async paymentExpiryId => {
          if (!paymentExpiryId) return
          const newIds = { ...scheduledIds, buyer_payment_expiry: paymentExpiryId }
          await db.from('marketplace_offers').update({ scheduled_reminder_ids: newIds }).eq('id', id)
        })
        .catch(e => console.error('[reminders] buyer payment expiry:', e))
    }

    return { ok: true, status: 'accepted', httpStatus: 200 }
  }

  return { ok: false, error: 'Acción desconocida.', httpStatus: 400 }
}
