import { getLanguagePreference } from '@/lib/site-language-server'
import { BuyerCopyText } from '@/app/components/BuyerPresentationContext'
/* eslint-disable @next/next/no-img-element -- conversation thumbnails preserve arbitrary seller-hosted image URLs */
import { redirect } from 'next/navigation'
import { currentUser } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import Link from 'next/link'
import type { Metadata } from 'next'
import { browseUrlFor } from '@/lib/market-url'
import { SITE_ORIGIN } from '@/lib/market-seo'
import { formatPresentationCurrency, formatPresentationDate, marketCodeForCurrency, resolveMarketPresentation, type MarketPresentation } from '@/lib/market-presentation'

export const metadata: Metadata = { title: { absolute: 'Mensajes — Miyagi Sánchez' } }

function timeAgo(iso: string, presentation: MarketPresentation) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 2)  return 'ahora'
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h`
  const d = Math.floor(h / 24)
  if (d < 7)  return `${d} d`
  return formatPresentationDate(presentation, iso, { day: 'numeric', month: 'short' })
}

function lastEventSummary(eventType: string, actor: string, metadata: Record<string, unknown>, presentation: MarketPresentation) {
  const amt = metadata?.amount_cents
    ? formatPresentationCurrency(presentation, metadata.amount_cents as number, (metadata.currency as string) ?? presentation.currency, { maximumFractionDigits: 0 })
    : ''
  switch (eventType) {
    case 'offer_sent':      return `Oferta enviada: ${amt}`
    case 'offer_countered': return `Contraoferta: ${amt}`
    case 'offer_accepted':  return '¡Oferta aceptada!'
    case 'offer_declined':  return 'Oferta rechazada'
    case 'offer_withdrawn': return 'Oferta retirada'
    case 'offer_expired':   return 'Oferta expirada'
    case 'purchase_complete': return '✓ Compra realizada'
    case 'shipped':         return '📦 Pedido enviado'
    case 'delivered':       return '✓ Entregado'
    case 'stamp_sent':      return (metadata?.text as string) ?? 'Mensaje'
    default:                return eventType
  }
}

export default async function MessagesPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in?redirect_url=/messages')
  const language = await getLanguagePreference()

  // NOTE the absent `marketplace_shops.market_code`. That column has never existed
  // on the mirror — the operating market is a fact of the Medusa seller — and asking
  // for it made PostgREST answer 400 for every user for four days (PR 351 → 2026-08-15).
  // Presentation is derived from the listing's OWN currency below instead.
  const { data: convs, error: convsError } = await db
    .from('marketplace_conversations')
    .select(`
      id, status, last_event_at, buyer_unread, seller_unread,
      buyer_clerk_user_id, seller_clerk_user_id,
      marketplace_listings ( id, title, price_cents, currency, images ),
      marketplace_shops ( id, name, slug )
    `)
    .or(`buyer_clerk_user_id.eq.${user.id},seller_clerk_user_id.eq.${user.id}`)
    .in('status', ['active', 'completed'])
    .order('last_event_at', { ascending: false })
    .limit(100)

  // Three states, never two. A failed read is NOT an empty inbox: rendering "no
  // tienes mensajes" over a 400 is exactly how this bug survived — the page looked
  // healthy, and a seller with a waiting buyer saw the same screen as one with none.
  if (convsError) {
    console.error('[messages] conversation list read failed:', convsError)
  }

  const conversations = convs ?? []

  // Fetch last event for each conversation
  const convIds = conversations.map(c => c.id)
  type LastEventRow = { conversation_id: string; event_type: string; actor: string; metadata: unknown; created_at: string }
  const lastEvents: LastEventRow[] = []
  if (convIds.length > 0) {
    const { data } = await db
      .from('marketplace_conversation_events')
      .select('conversation_id, event_type, actor, metadata, created_at')
      .in('conversation_id', convIds)
      .order('created_at', { ascending: false })
    if (data) lastEvents.push(...(data as LastEventRow[]))
  }

  const lastEventMap = new Map<string, LastEventRow>()
  for (const ev of lastEvents ?? []) {
    if (!lastEventMap.has(ev.conversation_id)) lastEventMap.set(ev.conversation_id, ev)
  }

  const buying  = conversations.filter(c => c.buyer_clerk_user_id === user.id)
  const selling = conversations.filter(c => c.seller_clerk_user_id === user.id)
  const totalUnread = conversations.reduce((sum, c) => {
    const isBuyer = c.buyer_clerk_user_id === user.id
    return sum + (isBuyer ? c.buyer_unread : c.seller_unread)
  }, 0)

  function ConversationRow({ conv, role }: { conv: typeof conversations[0]; role: 'buyer' | 'seller' }) {
    const listing = conv.marketplace_listings as unknown as { id: string; title: string; price_cents: number | null; currency: string; images: Array<{ url: string }> | null } | null
    const shop    = conv.marketplace_shops as unknown as { name: string; slug: string } | null
    const presentation = resolveMarketPresentation(marketCodeForCurrency(listing?.currency) ?? 'mx', language)
    const lastEv  = lastEventMap.get(conv.id)
    const unread  = role === 'buyer' ? conv.buyer_unread : conv.seller_unread
    const otherParty = role === 'buyer'
      ? (shop?.name ?? <BuyerCopyText copyKey="messages.seller" />)
      : <BuyerCopyText copyKey="messages.buyer" />

    return (
      <Link href={`/messages/${conv.id}`} className="no-underline block" style={{ borderRadius: 'var(--r-md)', overflow: 'hidden' }}>
        <div
          className="flex items-center gap-3 transition-colors"
          style={{
            padding: '14px 16px',
            background: unread > 0 ? 'var(--accent-soft)' : 'transparent',
            borderBottom: '1px solid var(--border)',
          }}
        >
          {/* Listing thumbnail */}
          <div style={{ width: 52, height: 52, borderRadius: 'var(--r-md)', overflow: 'hidden', flexShrink: 0, background: 'var(--bg-sunk)' }}>
            {listing?.images?.[0] ? (
              <img src={listing.images[0].url} alt={listing.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <i className="iconoir-package" style={{ fontSize: 24, color: 'var(--fg-subtle)' }} />
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span style={{ fontSize: 14, fontWeight: unread > 0 ? 700 : 500, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {otherParty}
              </span>
              <span style={{ fontSize: 11, color: 'var(--fg-muted)', flexShrink: 0 }}>{timeAgo(conv.last_event_at, presentation)}</span>
            </div>
            <p style={{ fontSize: 13, color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
              {listing?.title}
            </p>
            {lastEv && (
              <p style={{ fontSize: 12, color: unread > 0 ? 'var(--accent)' : 'var(--fg-subtle)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2, fontWeight: unread > 0 ? 600 : 400 }}>
                {lastEventSummary(lastEv.event_type, lastEv.actor, lastEv.metadata as Record<string, unknown>, presentation)}
              </p>
            )}
          </div>

          {unread > 0 && (
            <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--fg-inverse)' }}>{unread}</span>
            </div>
          )}
        </div>
      </Link>
    )
  }

  return (
    <div className="max-w-2xl mx-auto" style={{ paddingBottom: 100 }}>
      {/* Header */}
      <div style={{ padding: '24px 20px 16px', borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-3">
          <h1 style={{ fontWeight: 700, fontSize: 22 }}><BuyerCopyText copyKey="messages.page.9ac46f17" /></h1>
          {totalUnread > 0 && (
            <span style={{ background: 'var(--accent)', color: 'var(--fg-inverse)', borderRadius: 'var(--r-pill)', padding: '2px 8px', fontSize: 12, fontWeight: 700 }}>
              {totalUnread}
            </span>
          )}
        </div>
      </div>

      {convsError ? (
        // The failure state the four-day outage did not have. It must never be
        // mistaken for an empty inbox, so it says what happened and offers a retry
        // rather than inviting the user to go shopping.
        <div style={{ textAlign: 'center', padding: '80px 24px' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'var(--bg-sunk)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
            <i className="iconoir-warning-triangle" style={{ fontSize: 28, color: 'var(--fg-subtle)' }} />
          </div>
          <p style={{ fontWeight: 600, fontSize: 17, marginBottom: 6 }}>
            <BuyerCopyText copyKey="messages.loadFailed.title" /></p>
          <p style={{ fontSize: 14, color: 'var(--fg-muted)', marginBottom: 24 }}>
            <BuyerCopyText copyKey="messages.loadFailed.body" /></p>
          <Link href="/messages" className="btn btn-primary no-underline" style={{ display: 'inline-flex' }}>
            <i className="iconoir-refresh" style={{ fontSize: 16 }} />
            <BuyerCopyText copyKey="messages.loadFailed.retry" /></Link>
        </div>
      ) : conversations.length === 0 ? (
        <div style={{ paddingTop: 80, textAlign: 'center', padding: '80px 24px' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'var(--bg-sunk)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
            <i className="iconoir-chat-bubble" style={{ fontSize: 28, color: 'var(--fg-subtle)' }} />
          </div>
          <p style={{ fontWeight: 600, fontSize: 17, marginBottom: 6 }}><BuyerCopyText copyKey="messages.page.8e777de8" /></p>
          <p style={{ fontSize: 14, color: 'var(--fg-muted)', marginBottom: 24 }}>
            <BuyerCopyText copyKey="messages.page.7641a7f4" /></p>
          <Link href={browseUrlFor(SITE_ORIGIN)} className="btn btn-primary no-underline" style={{ display: 'inline-flex' }}>
            <i className="iconoir-search" style={{ fontSize: 16 }} />
            <BuyerCopyText copyKey="messages.page.5e800fd1" /></Link>
        </div>
      ) : (
        <div>
          {/* Comprando section */}
          {buying.length > 0 && (
            <div>
              {selling.length > 0 && (
                <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '12px 16px 4px' }}>
                  <BuyerCopyText copyKey="messages.page.bdda231f" /></p>
              )}
              {buying.map(conv => <ConversationRow key={conv.id} conv={conv} role="buyer" />)}
            </div>
          )}

          {/* Vendiendo section */}
          {selling.length > 0 && (
            <div>
              {buying.length > 0 && (
                <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '16px 16px 4px' }}>
                  <BuyerCopyText copyKey="messages.page.f647ffca" /></p>
              )}
              {selling.map(conv => <ConversationRow key={conv.id} conv={conv} role="seller" />)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
