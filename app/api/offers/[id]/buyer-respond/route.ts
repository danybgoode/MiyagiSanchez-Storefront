import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { canAcceptCounter, canWithdraw, formatOfferAmount } from '@/lib/offers'
import { stripe } from '@/lib/stripe'
import { sendOfferAccepted, sendCounterAccepted, sendOfferWithdrawn, sendBuyerPaymentExpiryWarning, cancelScheduledEmail, getSellerEmail } from '@/lib/email'
import { notify } from '@/lib/notify'
import { dispatchToBuyer } from '@/lib/notifications/dispatch'
import { buildBuyerMessage } from '@/lib/notifications/buyer-messages'
import { listingUrlFor } from '@/lib/market-url'
import { offerCanProceed, offerCollectRefusal } from '@/lib/shop-collect'

interface BuyerRespondBody {
  action: 'accept-counter' | 'withdraw'
  buyerEmail?: string
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })

  let body: BuyerRespondBody
  try {
    body = await req.json() as BuyerRespondBody
  } catch {
    return NextResponse.json({ error: 'Payload inválido.' }, { status: 400 })
  }

  const { action } = body

  // ── Fetch offer ───────────────────────────────────────────────────────────
  const { data: offer } = await db
    .from('marketplace_offers')
    .select(`
      *,
      marketplace_listings!inner(
        id, medusa_product_id, title, price_cents, currency, listing_type, images,
        marketplace_shops!inner(id, slug, metadata, clerk_user_id)
      )
    `)
    .eq('id', id)
    .eq('buyer_clerk_user_id', user.id)
    .single()

  if (!offer) {
    return NextResponse.json({ error: 'Oferta no encontrada.' }, { status: 404 })
  }

  const scheduledIds = (offer.scheduled_reminder_ids ?? {}) as Record<string, string>
  const origin = req.headers.get('origin') ?? 'https://miyagisanchez.com'

  async function getConversationUrl() {
    const { data: conv } = await db
      .from('marketplace_conversations')
      .select('id')
      .eq('offer_id', id)
      .maybeSingle()
    return conv?.id ? `${origin}/messages/${conv.id}` : null
  }

  async function emitConvEvent(eventType: string, actor: string, metadata: Record<string, unknown>, incSellerUnread = false) {
    const { data: conv } = await db
      .from('marketplace_conversations')
      .select('id, seller_unread')
      .eq('offer_id', id)
      .maybeSingle()
    if (!conv) return
    await Promise.all([
      db.from('marketplace_conversation_events').insert({ conversation_id: conv.id, event_type: eventType, actor, metadata }),
      incSellerUnread
        ? db.from('marketplace_conversations').update({ last_event_at: new Date().toISOString(), updated_at: new Date().toISOString(), seller_unread: (conv.seller_unread ?? 0) + 1 }).eq('id', conv.id)
        : db.from('marketplace_conversations').update({ last_event_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', conv.id),
    ])
  }

  const listing = offer.marketplace_listings as unknown as {
    id: string; title: string; price_cents: number; currency: string
    listing_type: string; images: Array<{ url: string }> | null
    marketplace_shops: { id: string; slug: string | null; metadata: Record<string, unknown> | null; clerk_user_id: string | null }
  }

  // ── Withdraw ──────────────────────────────────────────────────────────────
  if (action === 'withdraw') {
    if (!canWithdraw(offer)) {
      return NextResponse.json({ error: 'Esta oferta no puede retirarse.' }, { status: 409 })
    }
    // Cancel ALL pending reminders — offer is dead
    for (const emailId of Object.values(scheduledIds)) {
      cancelScheduledEmail(emailId).catch(() => {})
    }
    await db.from('marketplace_offers').update({ status: 'withdrawn' }).eq('id', id)
    emitConvEvent('offer_withdrawn', 'buyer', {}, true).catch(e => console.error('[conv] withdraw event:', e))

    // Tell the seller the buyer walked away. Until now this branch emitted only the
    // in-conversation event, so a seller who was not watching the thread kept an
    // offer open in their head — and `sendOfferWithdrawn` sat in lib/email.ts with
    // no call site, written for exactly this moment. Fire-and-forget, like every
    // other notification here: a mail failure must never fail the withdrawal.
    if (listing.marketplace_shops.clerk_user_id) {
      const clerkUserId = listing.marketplace_shops.clerk_user_id
      getSellerEmail(clerkUserId).then(sellerEmail => {
        if (!sellerEmail) return
        return sendOfferWithdrawn({
          sellerEmail,
          listingTitle: listing.title,
          listingUrl: listingUrlFor(origin, listing.id),
          offerAmount: formatOfferAmount(offer.offer_amount_cents, listing.currency),
          buyerName: offer.buyer_name,
        })
      }).catch(e => console.error('[email] offer-withdrawn seller:', e))
    }

    return NextResponse.json({ status: 'withdrawn' })
  }

  // ── Accept counter ────────────────────────────────────────────────────────
  if (action === 'accept-counter') {
    if (!canAcceptCounter(offer)) {
      return NextResponse.json({ error: 'La contraoferta ya no está disponible.' }, { status: 409 })
    }

    // listing-readiness D5: accepting the seller's counter is an ACCEPT — the agreed price must be payable. Covers a
    // counter made before this gate shipped, and a shop that turned its only payment method off after countering
    // (fresh-review catch on PR 497). Fails closed; withdraw above is never gated.
    const collectRefusal = offerCollectRefusal(await offerCanProceed({
      slug: listing.marketplace_shops.slug,
      productId: (listing as unknown as { medusa_product_id: string | null }).medusa_product_id,
      listingType: listing.listing_type,
    }), 'buyer')
    if (collectRefusal) {
      return NextResponse.json({ error: collectRefusal.error, code: collectRefusal.code }, { status: collectRefusal.status })
    }

    const acceptedCents = offer.counter_amount_cents!
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
                name: `${listing.title} (contraoferta aceptada)`,
                images: listing.images?.[0]?.url ? [listing.images[0].url] : [],
              },
            },
            quantity: 1,
          }],
          payment_intent_data: {
            transfer_data: { destination: stripeSettings.account_id },
            application_fee_amount: 0,
            metadata: {
              listing_id: listing.id,
              shop_id: listing.marketplace_shops.id,
              listing_type: listing.listing_type,
              offer_id: id,
            },
          },
          metadata: {
            listing_id: listing.id,
            shop_id: listing.marketplace_shops.id,
            listing_type: listing.listing_type,
            offer_id: id,
          },
          success_url: `${origin}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${listingUrl}?offer=cancelled`,
        })
        checkoutSessionId = session.id
        checkoutExpires = new Date(expiresAt * 1000).toISOString()
      } catch (err) {
        console.error('Checkout session error on counter-accept:', err)
      }
    }

    // Cancel counter-expiry reminder — buyer has responded
    if (scheduledIds.buyer_counter_expiry) {
      cancelScheduledEmail(scheduledIds.buyer_counter_expiry).catch(() => {})
    }

    await db.from('marketplace_offers').update({
      status: 'accepted',
      checkout_session_id: checkoutSessionId,
      checkout_expires_at: checkoutExpires,
    }).eq('id', id)

    const conversationUrl = await getConversationUrl()

    emitConvEvent('offer_accepted', 'system', { amount_cents: acceptedCents, currency: listing.currency }, true).catch(e => console.error('[conv] accept-counter event:', e))
    // Push seller: buyer accepted their counter
    const sellerClerkId = listing.marketplace_shops.clerk_user_id
    if (sellerClerkId) {
      db.from('marketplace_conversations').select('id').eq('offer_id', id).maybeSingle()
        .then(({ data: c }) => notify(sellerClerkId, {
          kind: 'offer', title: 'Contraoferta aceptada',
          body: `El comprador aceptó tu contraoferta por "${listing.title}"`,
          url: c?.id ? `/messages/${c.id}` : '/messages', tag: `offer:${id}`,
        }).catch(() => {}))
    }
    // Buyer: accepted — with payment link. "Ofertas" pref-gated (the buyer is
    // signed in here — offer.buyer_clerk_user_id === user.id).
    const acceptedMsg = buildBuyerMessage('offer_accepted', {
      listingTitle: listing.title,
      url: conversationUrl ?? listingUrl,
    })
    void dispatchToBuyer(
      { clerkUserId: user.id, email: offer.buyer_email },
      {
        group: 'buyer.ofertas',
        email: to =>
          sendOfferAccepted({
            listingTitle: listing.title, listingId: listing.id, listingUrl,
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
      },
    )

    // Seller: counter was accepted — notify them
    if (listing.marketplace_shops.clerk_user_id) {
      getSellerEmail(listing.marketplace_shops.clerk_user_id).then(sellerEmail => {
        if (sellerEmail) {
          return sendCounterAccepted({
            sellerEmail, listingTitle: listing.title, listingUrl,
            counterAmount: formatOfferAmount(acceptedCents, listing.currency),
            buyerName: offer.buyer_name, buyerEmail: offer.buyer_email,
            conversationUrl,
          })
        }
      }).catch(e => console.error('[email] counter-accept seller:', e))
    }

    // Schedule buyer payment-expiry reminder at checkoutExpires − 4h (Stripe flow only)
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
        .catch(e => console.error('[reminders] buyer payment expiry (counter):', e))
    }

    return NextResponse.json({ status: 'accepted' })
  }

  return NextResponse.json({ error: 'Acción desconocida.' }, { status: 400 })
}
