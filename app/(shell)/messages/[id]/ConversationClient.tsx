'use client'

import { BuyerCopyText, useBuyerCopy, useBuyerFormatters } from '@/app/components/BuyerPresentationContext'
/* eslint-disable @next/next/no-img-element -- conversation attachments preserve arbitrary participant-hosted image URLs */

import { useState, useRef, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { BUYER_STAMPS, SELLER_STAMPS, type StampKey } from '@/lib/stamps'
import { isDealExpired, timeUntil, offerTurn, type OfferStatus } from '@/lib/offers'
import OfferCheckoutButton from '@/app/components/OfferCheckoutButton'
import TrustSignals from '@/app/components/TrustSignals'
import type { CheckoutProvider } from '@/lib/cart'
import type { LedgerView } from '@/lib/transaction-ledger'
import { useConversationStream } from '@/lib/messaging/stream'
import { ensurePushSubscription } from '@/lib/push-client'
import { browseUrlFor, listingUrlFor } from '@/lib/market-url'
import { SITE_ORIGIN } from '@/lib/market-seo'
import { presentationCalendarDate } from '@/lib/market-presentation'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ConvListing {
  id: string; medusa_product_id?: string | null; title: string; price_cents: number | null; currency: string
  images: Array<{ url: string }> | null; status: string; condition: string | null; location: string | null
  listing_type?: string | null
}
interface ConvShop { id: string; name: string; slug: string; logo_url?: string | null }
interface ConvOffer {
  id: string; status: string; offer_amount_cents: number; counter_amount_cents: number | null
  counter_message: string | null; expires_at: string; counter_expires_at: string | null
  checkout_expires_at: string | null; currency: string
}
interface ConvEvent {
  id: string; event_type: string; actor: string
  metadata: Record<string, unknown>; created_at: string
}
interface Conversation {
  id: string; status: string; buyer_clerk_user_id: string; seller_clerk_user_id: string
  last_event_at: string; buyer_unread: number; seller_unread: number
  marketplace_listings: ConvListing | null
  marketplace_shops: ConvShop | null
  marketplace_offers: ConvOffer | null
  checkout_provider?: CheckoutProvider | null
  /** The shop accepts SOME payment method (card, MP, transfer, DiMo) — see page.tsx. */
  checkout_available?: boolean
}

interface ConvTransaction { ledger: LedgerView; orderId: string | null }

interface Props {
  conversationId: string
  initialConversation: Conversation
  initialEvents: ConvEvent[]
  role: 'buyer' | 'seller'
  currentUserId: string
  currentUserEmail?: string
  initialTransaction: ConvTransaction
  /** Slim trust capsule shown at the negotiation entry (C.5), derived server-side. */
  trustCapsule: { verified: boolean; paymentProtected: boolean; returnsLabel: string | null }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)'

function listingTypeLabel(type?: string | null) {
  switch (type) {
    case 'digital': return 'Digital'
    case 'service': return 'Servicio'
    case 'rental': return 'Renta'
    case 'subscription': return 'Suscripción'
    default: return 'Producto'
  }
}

function listingStatusLabel(status?: string | null) {
  switch (status) {
    case 'sold': return 'Vendido'
    case 'paused': return 'Pausado'
    case 'draft': return 'Borrador'
    case 'active': return 'Activo'
    default: return status ?? 'Anuncio'
  }
}

// ── Event renderer ────────────────────────────────────────────────────────────

function EventBubble({ event, role, conversationId, onRefresh, proofApproved }: {
  event: ConvEvent
  role: 'buyer' | 'seller'
  conversationId: string
  onRefresh: () => void | Promise<void>
  /** Whether ANY proof_approved event already exists in this thread — hides
   *  the "Aprobar prueba" CTA on every proof_sent bubble once approved. */
  proofApproved: boolean
}) {
  const formatters = useBuyerFormatters()
  const fmt = (cents: number, currencyCode = 'MXN') =>
    formatters.currency(cents, currencyCode, { maximumFractionDigits: 0 })
  const formatTime = (iso: string) =>
    formatters.date(iso, { hour: '2-digit', minute: '2-digit' })
  const meta = event.metadata
  const isMine = event.actor === role || (event.actor === `${role}_agent`)
  const isSystem = event.actor === 'system'
  const currency = (meta.currency as string) ?? 'MXN'

  if (isSystem) {
    return (
      <div style={{ textAlign: 'center', padding: '6px 16px' }}>
        <span style={{ fontSize: 12, color: 'var(--fg-muted)', background: 'var(--bg-sunk)', borderRadius: 'var(--r-pill)', padding: '4px 12px', display: 'inline-block' }}>
          {renderSystemText(event.event_type, meta, currency, fmt)}
        </span>
      </div>
    )
  }

  // Offer events get special treatment
  if (event.event_type === 'offer_sent') {
    return (
      <div style={{ display: 'flex', justifyContent: isMine ? 'flex-end' : 'flex-start', padding: '4px 16px' }}>
        <div style={{
          maxWidth: '75%', borderRadius: isMine ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
          padding: '12px 16px',
          background: isMine ? 'var(--accent)' : 'var(--bg-elevated)',
          border: isMine ? 'none' : '1px solid var(--border)',
          boxShadow: 'var(--shadow-1)',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: isMine ? 'rgba(255,255,255,0.7)' : 'var(--fg-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}><BuyerCopyText copyKey="messages.id.ConversationClient.c0f8fdb9" /></div>
          <div style={{ fontSize: 22, fontWeight: 700, color: isMine ? 'var(--fg-inverse)' : 'var(--fg)' }}>
            {fmt(meta.amount_cents as number, currency)}
          </div>
          <div style={{ fontSize: 11, color: isMine ? 'rgba(255,255,255,0.6)' : 'var(--fg-subtle)', marginTop: 2 }}>{formatTime(event.created_at)}</div>
        </div>
      </div>
    )
  }

  if (event.event_type === 'offer_countered') {
    return (
      <div style={{ display: 'flex', justifyContent: isMine ? 'flex-end' : 'flex-start', padding: '4px 16px' }}>
        <div style={{
          maxWidth: '75%', borderRadius: isMine ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
          padding: '12px 16px',
          background: isMine ? 'var(--info)' : 'var(--info-soft)',
          border: isMine ? 'none' : '1.5px solid var(--info)',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: isMine ? 'rgba(255,255,255,0.7)' : 'var(--info)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}><BuyerCopyText copyKey="messages.id.ConversationClient.f51328ca" /></div>
          <div style={{ fontSize: 22, fontWeight: 700, color: isMine ? 'var(--fg-inverse)' : 'var(--info)' }}>
            {fmt(meta.counter_amount_cents as number ?? meta.amount_cents as number, currency)}
          </div>
          {typeof meta.message === 'string' && meta.message && <div style={{ fontSize: 13, color: isMine ? 'rgba(255,255,255,0.85)' : 'var(--info)', marginTop: 6, fontStyle: 'italic' }}>&ldquo;{meta.message}&rdquo;</div>}
          <div style={{ fontSize: 11, color: isMine ? 'rgba(255,255,255,0.6)' : 'var(--fg-subtle)', marginTop: 4 }}>{formatTime(event.created_at)}</div>
        </div>
      </div>
    )
  }

  if (event.event_type === 'stamp_sent') {
    return (
      <div style={{ display: 'flex', justifyContent: isMine ? 'flex-end' : 'flex-start', padding: '3px 16px' }}>
        <div style={{
          maxWidth: '80%', borderRadius: isMine ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
          padding: '9px 14px',
          background: isMine ? 'var(--fg)' : 'var(--bg-elevated)',
          border: isMine ? 'none' : '1px solid var(--border)',
        }}>
          <span style={{ fontSize: 14, color: isMine ? 'var(--fg-inverse)' : 'var(--fg)', lineHeight: 1.4 }}>{meta.text as string}</span>
          <div style={{ fontSize: 10, color: isMine ? 'rgba(255,255,255,0.5)' : 'var(--fg-subtle)', marginTop: 3, textAlign: 'right' }}>{formatTime(event.created_at)}</div>
        </div>
      </div>
    )
  }

  // Print proof (custom-print-products S4 · 4.1): the restatement (size/qty/
  // price) is ALWAYS what the server derived from the real order at send
  // time — this bubble only ever displays event metadata, never re-derives
  // or lets the viewer edit it (the StickerJunkie-pitfall guard).
  if (event.event_type === 'proof_sent') {
    const imageUrl = typeof meta.image_url === 'string' ? meta.image_url : null
    const size = typeof meta.size === 'string' ? meta.size : null
    const quantity = typeof meta.quantity === 'number' ? meta.quantity : null
    const priceCents = typeof meta.price_cents === 'number' ? meta.price_cents : null
    return (
      <div style={{ display: 'flex', justifyContent: isMine ? 'flex-end' : 'flex-start', padding: '4px 16px' }}>
        <div style={{
          maxWidth: '80%', borderRadius: isMine ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
          padding: 12,
          background: isMine ? 'var(--accent)' : 'var(--bg-elevated)',
          border: isMine ? 'none' : '1px solid var(--border)',
          boxShadow: 'var(--shadow-1)',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: isMine ? 'rgba(255,255,255,0.7)' : 'var(--fg-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            <BuyerCopyText copyKey="messages.id.ConversationClient.0b6dd4dd" /></div>
          {imageUrl && (
            <img src={imageUrl} alt="Prueba de impresión" style={{ width: '100%', maxWidth: 240, borderRadius: 10, display: 'block', marginBottom: 8 }} />
          )}
          <div style={{ fontSize: 13, color: isMine ? 'var(--fg-inverse)' : 'var(--fg)', lineHeight: 1.5 }}>
            {size && <div><BuyerCopyText copyKey="messages.id.ConversationClient.f089f82b" />{' '}{size}</div>}
            {quantity != null && <div><BuyerCopyText copyKey="messages.id.ConversationClient.8a333b9e" />{' '}{quantity}</div>}
            {priceCents != null && <div><BuyerCopyText copyKey="messages.id.ConversationClient.745c0c5f" />{' '}{fmt(priceCents, currency)}</div>}
          </div>
          {role === 'buyer' && (
            proofApproved
              ? <div style={{ marginTop: 8, fontSize: 12, fontWeight: 600, color: isMine ? 'var(--fg-inverse)' : 'var(--success)' }}><i className="iconoir-check" aria-hidden /> <BuyerCopyText copyKey="messages.id.ConversationClient.6dbe35cb" /></div>
              : <ProofApproveButton conversationId={conversationId} onApproved={onRefresh} />
          )}
          <div style={{ fontSize: 10, color: isMine ? 'rgba(255,255,255,0.6)' : 'var(--fg-subtle)', marginTop: 6 }}>{formatTime(event.created_at)}</div>
        </div>
      </div>
    )
  }

  if (event.event_type === 'proof_approved') {
    return (
      <div style={{ textAlign: 'center', padding: '6px 16px' }}>
        <span style={{ fontSize: 12, color: 'var(--fg-muted)', background: 'var(--bg-sunk)', borderRadius: 'var(--r-pill)', padding: '4px 12px', display: 'inline-block' }}>
          <i className="iconoir-check" aria-hidden /> <BuyerCopyText copyKey="messages.id.ConversationClient.b62363d1" /></span>
      </div>
    )
  }

  return null
}

function ProofApproveButton({ conversationId, onApproved }: { conversationId: string; onApproved: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function approve() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/conversations/${conversationId}/proof/approve`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => null) as { error?: string } | null
        setError(data?.error ?? 'No se pudo aprobar. Inténtalo de nuevo.')
        return
      }
      await onApproved()
    } catch {
      setError('Sin conexión. Inténtalo de nuevo.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={approve}
        disabled={busy}
        style={{
          marginTop: 8, width: '100%', padding: '8px 12px', borderRadius: 10,
          border: 'none', background: 'var(--fg)', color: 'var(--fg-inverse)',
          fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? '…' : <BuyerCopyText copyKey="messages.id.ConversationClient.edc5e014" />}
      </button>
      {error && <div style={{ marginTop: 4, fontSize: 11, color: 'var(--danger)' }}>{error}</div>}
    </>
  )
}

function renderSystemText(type: string, meta: Record<string, unknown>, currency: string, fmt: (cents: number, currency: string) => string): string {
  const amt = meta.amount_cents ? fmt(meta.amount_cents as number, currency) : ''
  switch (type) {
    case 'offer_accepted':   return `✓ Oferta aceptada — ${amt}`
    case 'offer_declined':   return 'Oferta rechazada'
    case 'offer_withdrawn':  return 'Oferta retirada'
    case 'offer_expired':    return 'Oferta expirada sin respuesta'
    case 'purchase_complete':return '✓ Compra realizada'
    case 'shipped':          return `📦 Pedido enviado${meta.tracking ? ` · ${meta.tracking}` : ''}`
    case 'delivered':        return '✓ Entregado'
    case 'feedback_left':    return '⭐ Calificación enviada'
    default:                 return type
  }
}

// ── Transaction ledger card (C.2) ───────────────────────────────────────────────
// Read-only durable card: shows the ONE shared order/payment/refund state behind the
// conversation. Actions are DEEP-LINKS to the existing order page — no payment/refund
// mutation happens in chat (the in-chat read-only invariant). Updates over the existing
// Realtime refresh (the GET re-projects the ledger).

const ROW_DOT_COLOR: Record<'done' | 'current' | 'pending', string> = {
  done:    'var(--success)',
  current: 'var(--accent)',
  pending: 'var(--fg-subtle)',
}

function TransactionLedgerCard({ ledger, orderId, role }: {
  ledger: LedgerView
  orderId: string | null
  role: 'buyer' | 'seller'
}) {
  if (ledger.isEmpty) return null

  const orderHref = orderId
    ? role === 'seller' ? `/shop/manage/orders/${orderId}` : `/account/orders/${orderId}`
    : null
  const showAction = !!ledger.action && !!orderHref

  return (
    <div style={{ flexShrink: 0, padding: '12px 16px', background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border)' }}>
      {/* Headline: badge + who-acts-next */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--fg)', background: 'var(--bg-sunk)', borderRadius: 'var(--r-pill)', padding: '3px 10px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {ledger.badge}
        </span>
        {ledger.whoActsNext && (
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-muted)' }}>
            {ledger.whoActsNext}
            {ledger.deadlineIso && (
              <span style={{ color: 'var(--fg-subtle)', fontWeight: 400 }}> <BuyerCopyText copyKey="messages.id.ConversationClient.7d24f9b6" />{' '}{timeUntil(ledger.deadlineIso)}</span>
            )}
          </span>
        )}
      </div>

      {ledger.detail && (
        <p style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 6 }}>{ledger.detail}</p>
      )}

      {/* Timeline */}
      {ledger.timeline.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 10, flexWrap: 'wrap' }}>
          {ledger.timeline.map((row, i) => (
            <div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: ROW_DOT_COLOR[row.status], flexShrink: 0 }} />
              <span style={{ fontSize: 11, fontWeight: row.status === 'current' ? 700 : 500, color: row.status === 'pending' ? 'var(--fg-subtle)' : 'var(--fg-muted)' }}>
                {row.label}
              </span>
              {i < ledger.timeline.length - 1 && (
                <span style={{ width: 14, height: 1, background: 'var(--border)', margin: '0 2px' }} />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Read-only action — deep-links to the order page */}
      {showAction && (
        <Link
          href={orderHref!}
          className="no-underline"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}
        >
          {ledger.action!.label}
          <i className="iconoir-arrow-up-right" style={{ fontSize: 14 }} />
        </Link>
      )}
    </div>
  )
}

// ── Offer action bar ──────────────────────────────────────────────────────────

/**
 * Explicit "whose turn is it" line + live countdown to the CORRECT deadline (C.3) —
 * derived once from offer status + role via the shared {@link offerTurn} so the panel
 * never re-infers turn from which buttons render. Pending → expires_at (48h); counter →
 * counter_expires_at (24h); accepted → checkout_expires_at (24h).
 */
function OfferTurnLine({ offer, role }: { offer: ConvOffer; role: 'buyer' | 'seller' }) {
  const turn = offerTurn({ ...offer, status: offer.status as OfferStatus }, role)
  if (!turn.line) return null
  return (
    <p style={{ fontSize: 12, fontWeight: 700, color: 'var(--fg)', marginBottom: 8 }}>
      {turn.line}
      {turn.deadlineIso && (
        <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}> <BuyerCopyText copyKey="messages.id.ConversationClient.7d24f9b6" />{' '}{timeUntil(turn.deadlineIso)}</span>
      )}
    </p>
  )
}

function OfferActionBar({
  offer, role, listing, checkoutProvider, checkoutAvailable, isSignedIn, onRefresh,
}: {
  offer: ConvOffer
  role: 'buyer' | 'seller'
  listing: ConvListing | null
  checkoutProvider?: CheckoutProvider | null
  checkoutAvailable?: boolean
  isSignedIn: boolean
  onRefresh: () => void
}) {
  const copy = useBuyerCopy()
  const { currency: formatCurrency } = useBuyerFormatters()
  const fmt = (cents: number, currency: string) => formatCurrency(cents, currency, { maximumFractionDigits: 0 })
  const [busy, setBusy] = useState(false)

  async function sellerAction(action: 'accept' | 'decline' | 'counter', counterCents?: number, msg?: string) {
    setBusy(true)
    try {
      await fetch(`/api/offers/${offer.id}/respond`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, counterAmountCents: counterCents, counterMessage: msg }),
      })
      onRefresh()
    } finally {
      setBusy(false)
    }
  }

  async function buyerAction(action: 'accept-counter' | 'withdraw') {
    setBusy(true)
    try {
      await fetch(`/api/offers/${offer.id}/buyer-respond`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      onRefresh()
    } finally {
      setBusy(false)
    }
  }

  const isExpiredOffer = new Date(offer.expires_at) < new Date()
  const isExpiredCounter = offer.counter_expires_at && new Date(offer.counter_expires_at) < new Date()
  const agreedCents = offer.counter_amount_cents ?? offer.offer_amount_cents

  if (offer.status === 'paid') {
    return (
      <DealStatusBar
        tone="success"
        title={copy('messages.id.ConversationClient.ac030cd8')}
        body={`El pedido quedó confirmado por ${fmt(agreedCents, offer.currency)}.`}
      />
    )
  }

  if (offer.status === 'declined') {
    return <DealStatusBar tone="neutral" title={copy('messages.id.ConversationClient.96a212da')} body="El artículo sigue disponible si quieres iniciar una nueva conversación u oferta." />
  }

  if (offer.status === 'withdrawn') {
    return <DealStatusBar tone="neutral" title={copy('messages.id.ConversationClient.dd9579c0')} body="Esta negociación ya no está activa." />
  }

  // One clock per status (lib/offers.ts isDealExpired) — an ACCEPTED deal never expires by its old counter window.
  if (isDealExpired(offer)) {
    return <DealStatusBar tone="danger" title={copy('messages.id.ConversationClient.c06b8c1a')} body="El precio acordado ya no está disponible. Puedes volver al anuncio para iniciar una nueva oferta." />
  }

  if (role === 'seller' && offer.status === 'pending' && !isExpiredOffer) {
    return <SellerActionBar offer={offer} onAction={sellerAction} busy={busy} />
  }

  if (role === 'buyer' && offer.status === 'pending' && !isExpiredOffer) {
    return (
      <div style={{ padding: '8px 16px', background: 'var(--bg-elevated)', borderTop: '1px solid var(--border)' }}>
        <OfferTurnLine offer={offer} role={role} />
        <button
          type="button"
          onClick={() => buyerAction('withdraw')}
          disabled={busy}
          style={{ fontSize: 13, color: 'var(--fg-muted)', textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          <BuyerCopyText copyKey="messages.id.ConversationClient.8d534684" /></button>
      </div>
    )
  }

  if (role === 'buyer' && offer.status === 'countered' && !isExpiredCounter) {
    return (
      <div style={{ padding: '12px 16px', background: 'var(--bg-elevated)', borderTop: '1px solid var(--border)' }}>
        <OfferTurnLine offer={offer} role={role} />
        <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={() => buyerAction('accept-counter')}
          disabled={busy}
          className="flex-1 font-semibold rounded-xl py-3 text-sm disabled:opacity-50"
          style={{ background: 'var(--accent)', color: 'var(--fg-inverse)', border: 'none', cursor: 'pointer' }}
        >
          <i className="iconoir-check" aria-hidden /> <BuyerCopyText copyKey="messages.id.ConversationClient.62143c02" /></button>
        <button
          type="button"
          onClick={() => buyerAction('withdraw')}
          disabled={busy}
          className="flex-1 font-medium rounded-xl py-3 text-sm disabled:opacity-50"
          style={{ background: 'var(--bg-sunk)', color: 'var(--fg)', border: '1px solid var(--border)', cursor: 'pointer' }}
        >
          <BuyerCopyText copyKey="messages.id.ConversationClient.f6e4b918" /></button>
        </div>
      </div>
    )
  }

  if (role === 'buyer' && offer.status === 'accepted') {
    return (
      <div style={{ padding: '12px 16px', background: 'var(--success-soft)', borderTop: '1.5px solid var(--success)' }}>
        <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--success)', marginBottom: 4 }}><BuyerCopyText copyKey="messages.id.ConversationClient.877119b5" /></p>
        <p style={{ fontSize: 22, fontWeight: 800, color: 'var(--fg)', marginBottom: 8 }}>{fmt(agreedCents, offer.currency)}</p>
        {offer.checkout_expires_at && (
          <p style={{ fontSize: 11, color: 'var(--danger)', marginBottom: 8 }}><BuyerCopyText copyKey="messages.id.ConversationClient.f8aac9a2" />{' '}{timeUntil(offer.checkout_expires_at)}</p>
        )}
        {listing && (checkoutProvider || checkoutAvailable) ? (
          <OfferCheckoutButton
            listingId={listing.medusa_product_id ?? listing.id}
            offerId={offer.id}
            amountCents={agreedCents}
            currency={offer.currency}
            provider={checkoutProvider ?? undefined}
            isSignedIn={isSignedIn}
            label="Comprar ahora"
            variant="accent"
          />
        ) : (
          <p style={{ fontSize: 12, color: 'var(--fg-muted)' }}><BuyerCopyText copyKey="messages.id.ConversationClient.923ac08f" /></p>
        )}
      </div>
    )
  }

  if (role === 'seller' && offer.status === 'accepted') {
    return (
      <DealStatusBar
        tone="success"
        title={copy('messages.id.ConversationClient.5bd1ad33')}
        body={`Esperando pago del comprador por ${fmt(agreedCents, offer.currency)}.`}
      />
    )
  }

  return null
}

function DealStatusBar({ tone, title, body }: {
  tone: 'success' | 'danger' | 'neutral'
  title: string
  body: string
}) {
  const styles = {
    success: { bg: 'var(--success-soft)', border: 'var(--success)', color: 'var(--success)' },
    danger: { bg: 'var(--danger-soft)', border: 'var(--danger)', color: 'var(--danger)' },
    neutral: { bg: 'var(--bg-elevated)', border: 'var(--border)', color: 'var(--fg)' },
  }[tone]

  return (
    <div style={{ padding: '12px 16px', background: styles.bg, borderTop: `1.5px solid ${styles.border}` }}>
      <p style={{ fontSize: 13, fontWeight: 800, color: styles.color, marginBottom: 3 }}>{title}</p>
      <p style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{body}</p>
    </div>
  )
}

function SellerActionBar({ offer, onAction, busy }: {
  offer: ConvOffer
  onAction: (action: 'accept' | 'decline' | 'counter', cents?: number, msg?: string) => void
  busy: boolean
}) {
  const copy = useBuyerCopy()
  const { currency: formatCurrency } = useBuyerFormatters()
  const fmt = (cents: number, currency: string) => formatCurrency(cents, currency, { maximumFractionDigits: 0 })
  const [showCounter, setShowCounter] = useState(false)
  const [counterVal, setCounterVal] = useState('')
  const [counterMsg, setCounterMsg] = useState('')
  const asking = offer.offer_amount_cents
  const suggested = Math.round((asking + (offer.offer_amount_cents * 100 / 85)) / 2) // midpoint suggestion

  if (showCounter) {
    const cents = Math.round(parseFloat(counterVal) * 100) || 0
    return (
      <div style={{ padding: '12px 16px', background: 'var(--bg-elevated)', borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}><BuyerCopyText copyKey="messages.id.ConversationClient.a4a35822" /></span>
          <button type="button" onClick={() => setShowCounter(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-muted)', fontSize: 18 }}>×</button>
        </div>
        <div style={{ position: 'relative', marginBottom: 8 }}>
          <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 14, color: 'var(--fg-muted)' }}>$</span>
          <input
            type="number"
            inputMode="numeric"
            value={counterVal}
            onChange={e => setCounterVal(e.target.value)}
            placeholder={String(suggested / 100)}
            style={{ width: '100%', border: '1.5px solid var(--border)', borderRadius: 'var(--r-md)', paddingLeft: 28, paddingRight: 12, paddingTop: 10, paddingBottom: 10, fontSize: 16, fontFamily: 'var(--font-sans)', background: 'var(--bg-elevated)', outline: 'none', boxSizing: 'border-box' }}
            className="[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
        </div>
        <input
          type="text"
          value={counterMsg}
          onChange={e => setCounterMsg(e.target.value)}
          placeholder={copy('messages.id.ConversationClient.979befbf')}
          style={{ width: '100%', border: '1.5px solid var(--border)', borderRadius: 'var(--r-md)', padding: '9px 12px', fontSize: 13, fontFamily: 'var(--font-sans)', background: 'var(--bg-elevated)', outline: 'none', boxSizing: 'border-box', marginBottom: 10 }}
        />
        <button
          type="button"
          onClick={() => onAction('counter', cents, counterMsg || undefined)}
          disabled={busy || cents <= 0}
          className="w-full font-semibold rounded-xl py-3 text-sm disabled:opacity-50"
          style={{ background: 'var(--info)', color: 'var(--fg-inverse)', border: 'none', cursor: 'pointer', fontSize: 14 }}
        >
          <BuyerCopyText copyKey="messages.id.ConversationClient.ba0dd174" />{' '}{cents > 0 ? fmt(cents, offer.currency) : '…'}
        </button>
      </div>
    )
  }

  return (
    <div style={{ padding: '12px 16px', background: 'var(--bg-elevated)', borderTop: '1px solid var(--border)' }}>
      <OfferTurnLine offer={offer} role="seller" />
      <p style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 10 }}>
        <BuyerCopyText copyKey="messages.id.ConversationClient.2f225435" />{' '}<strong>{fmt(offer.offer_amount_cents, offer.currency)}</strong>
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={() => onAction('accept')}
          disabled={busy}
          className="flex-1 font-semibold rounded-xl py-3 text-sm disabled:opacity-50"
          style={{ background: 'var(--accent)', color: 'var(--fg-inverse)', border: 'none', cursor: 'pointer' }}
        >
          <i className="iconoir-check" aria-hidden /> <BuyerCopyText copyKey="messages.id.ConversationClient.56561b70" /></button>
        <button
          type="button"
          onClick={() => setShowCounter(true)}
          disabled={busy}
          className="font-medium rounded-xl py-3 text-sm disabled:opacity-50"
          style={{ background: 'var(--info-soft)', color: 'var(--info)', border: '1.5px solid var(--info)', cursor: 'pointer', padding: '12px 16px' }}
        >
          <i className="iconoir-undo" aria-hidden /> <BuyerCopyText copyKey="messages.id.ConversationClient.cb9182ae" /></button>
        <button
          type="button"
          onClick={() => onAction('decline')}
          disabled={busy}
          className="font-medium rounded-xl py-3 text-sm disabled:opacity-50"
          style={{ background: 'var(--bg-sunk)', color: 'var(--fg-muted)', border: '1px solid var(--border)', cursor: 'pointer', padding: '12px 16px' }}
        >
          <i className="iconoir-xmark" aria-hidden />
        </button>
      </div>
    </div>
  )
}

// ── Stamp chooser ─────────────────────────────────────────────────────────────

function StampChooser({ role, conversationId, onStampSent }: {
  role: 'buyer' | 'seller'; conversationId: string; onStampSent: () => void
}) {
  const stamps = role === 'buyer' ? BUYER_STAMPS : SELLER_STAMPS
  const [open, setOpen] = useState(false)
  const [sending, setSending] = useState<StampKey | null>(null)

  async function sendStamp(key: StampKey) {
    setSending(key)
    try {
      await fetch(`/api/conversations/${conversationId}/stamp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stampKey: key }),
      })
      onStampSent()
      setOpen(false)
      // Good UX moment (user gesture) to ask for push permission. Idempotent;
      // only prompts the first time, no-ops thereafter.
      void ensurePushSubscription()
    } finally {
      setSending(null)
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          height: 40, padding: '0 14px', borderRadius: 'var(--r-pill)',
          background: open ? 'var(--bg-sunk)' : 'var(--bg-elevated)',
          border: '1.5px solid var(--border)',
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 13, fontWeight: 500, color: 'var(--fg)',
          transition: 'all 150ms',
        }}
      >
        <i className="iconoir-chat-bubble" style={{ fontSize: 16 }} />
        <BuyerCopyText copyKey="messages.id.ConversationClient.0c937c2e" /><i className={`iconoir-nav-arrow-${open ? 'down' : 'up'}`} style={{ fontSize: 12, color: 'var(--fg-muted)' }} />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute', bottom: 52, left: 0, zIndex: 40,
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-3)',
            minWidth: 280, maxWidth: 340, overflow: 'hidden',
            animation: `slide-up 200ms ${SPRING}`,
          }}
        >
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
            <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}><BuyerCopyText copyKey="messages.id.ConversationClient.339ec659" /></p>
          </div>
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            {stamps.map(({ key, text }) => (
              <button
                key={key}
                type="button"
                onClick={() => sendStamp(key)}
                disabled={sending === key}
                style={{
                  width: '100%', padding: '11px 14px', textAlign: 'left', background: 'none',
                  border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer',
                  fontSize: 14, color: 'var(--fg)', lineHeight: 1.4,
                  opacity: sending === key ? 0.5 : 1,
                }}
                className="hover:bg-[var(--bg-sunk)]"
              >
                {sending === key ? '…' : text}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ConversationClient({ conversationId, initialConversation, initialEvents, role, initialTransaction, trustCapsule }: Props) {
  const buyerCopy = useBuyerCopy()
  const formatters = useBuyerFormatters()
  const fmt = (cents: number, currency: string) => formatters.currency(cents, currency, { maximumFractionDigits: 0 })
  const [conv, setConv] = useState(initialConversation)
  const [events, setEvents] = useState(initialEvents)
  const [transaction, setTransaction] = useState(initialTransaction)
  // Re-render once a minute so the deadline countdowns (ledger card + offer panel) stay live.
  const [, setCountdownTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setCountdownTick(t => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Pull-to-refresh state
  const [pullY, setPullY] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const touchStartY = useRef(0)
  const PULL_THRESHOLD = 64

  const listing = conv.marketplace_listings
  const shop    = conv.marketplace_shops
  const offer   = conv.marketplace_offers
  const agreedCents = offer?.status === 'accepted' || offer?.status === 'paid'
    ? offer.counter_amount_cents ?? offer.offer_amount_cents
    : null
  const headerPrice = agreedCents
    ? fmt(agreedCents, offer?.currency ?? listing?.currency ?? 'MXN')
    : listing?.price_cents
      ? fmt(listing.price_cents, listing.currency)
      : buyerCopy('messages.contactForPrice')

  // Scroll to bottom on load and new events
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events.length])

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/conversations/${conversationId}`)
      const data = await res.json() as { conversation: typeof conv; events: typeof events; transaction?: ConvTransaction }
      setConv(data.conversation)
      setEvents(data.events)
      if (data.transaction) setTransaction(data.transaction)
    } catch {
      // silent
    }
  }, [conversationId])

  // Pull-to-refresh gesture handlers
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (scrollRef.current && scrollRef.current.scrollTop === 0) {
      touchStartY.current = e.touches[0].clientY
    } else {
      touchStartY.current = 0
    }
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartY.current) return
    const dy = e.touches[0].clientY - touchStartY.current
    if (dy > 0) {
      e.preventDefault()
      setPullY(Math.min(dy * 0.4, PULL_THRESHOLD + 20))
    }
  }, [])

  const handleTouchEnd = useCallback(async () => {
    if (pullY >= PULL_THRESHOLD) {
      setIsRefreshing(true)
      setPullY(0)
      await refresh()
      setIsRefreshing(false)
    } else {
      setPullY(0)
    }
    touchStartY.current = 0
  }, [pullY, refresh])

  // Realtime delivery via Supabase Realtime (RLS-scoped by the Clerk JWT).
  // Replaces the old 5s full-thread poll. Stamps arrive instantly with no fetch;
  // offer-related events trigger a one-shot refresh to pull updated offer state.
  const { connected } = useConversationStream(conversationId, {
    onEvent: (row) => {
      const e = row as unknown as ConvEvent
      setEvents((prev) =>
        prev.some((x) => x.id === e.id)
          ? prev
          : [...prev, e].sort((a, b) => a.created_at.localeCompare(b.created_at)),
      )
      if (typeof e.event_type === 'string' && e.event_type.startsWith('offer')) refresh()
    },
    onConversation: (row) => {
      const c = row as Partial<Conversation>
      setConv((prev) => ({
        ...prev,
        ...(c.status !== undefined ? { status: c.status } : {}),
        ...(c.buyer_unread !== undefined ? { buyer_unread: c.buyer_unread } : {}),
        ...(c.seller_unread !== undefined ? { seller_unread: c.seller_unread } : {}),
        ...(c.last_event_at !== undefined ? { last_event_at: c.last_event_at } : {}),
      }))
    },
  })

  // Backfill once on (re)connect, and when the tab regains focus — covers any
  // events missed while disconnected and refreshes joined offer/checkout data.
  useEffect(() => {
    // Realtime connection state is external; reconnect intentionally schedules
    // the same state-refresh path used by the visibility listener below.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (connected) refresh()
  }, [connected, refresh])
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [refresh])

  // Mark conversation as read via the dedicated endpoint (decoupled from GET).
  // Fires on mount and whenever realtime reconnects (which also triggers refresh).
  useEffect(() => {
    fetch(`/api/conversations/${conversationId}/read`, { method: 'POST' }).catch(() => {})
  }, [conversationId, connected])

  // Safety fallback poll: if realtime never connects (e.g. auth not yet wired),
  // poll every 30 s so the UI still updates — degraded but not broken.
  useEffect(() => {
    if (connected) return
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, 30_000)
    return () => clearInterval(id)
  }, [connected, refresh])

  // Group events by day for date separators
  const grouped: Array<{ date: string; events: ConvEvent[] }> = []
  for (const ev of events) {
    const last = grouped[grouped.length - 1]
    const marketDay = (iso: string) => presentationCalendarDate(formatters.presentation, iso)
    if (!last || marketDay(last.events[last.events.length - 1].created_at) !== marketDay(ev.created_at)) {
      grouped.push({ date: ev.created_at, events: [ev] })
    } else {
      last.events.push(ev)
    }
  }

  const showActionBar = offer && conv.status === 'active'
  const isClosed = conv.status !== 'active'
  const listingHref = listing
    ? listingUrlFor(SITE_ORIGIN, listing.medusa_product_id ?? listing.id)
    : browseUrlFor(SITE_ORIGIN)

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Listing header */}
      <Link href={listingHref} className="no-underline" style={{ flexShrink: 0 }}>
        <div
          className="flex items-center gap-3"
          style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-elevated)' }}
        >
          {listing?.images?.[0] ? (
            <img src={listing.images[0].url} alt={listing.title} style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 'var(--r-md)', flexShrink: 0 }} />
          ) : (
            <div style={{ width: 44, height: 44, background: 'var(--bg-sunk)', borderRadius: 'var(--r-md)', flexShrink: 0 }} />
          )}
          <div className="flex-1 min-w-0">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {listing?.title}
              </p>
              {listing?.status && (
                <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 800, color: listing.status === 'active' ? 'var(--success)' : 'var(--fg-muted)', background: listing.status === 'active' ? 'var(--success-soft)' : 'var(--bg-sunk)', borderRadius: 'var(--r-pill)', padding: '2px 7px' }}>
                  {listingStatusLabel(listing.status)}
                </span>
              )}
            </div>
            <p style={{ fontSize: 13, color: agreedCents ? 'var(--success)' : 'var(--fg-muted)', fontWeight: agreedCents ? 800 : 400 }}>
              {agreedCents ? <BuyerCopyText copyKey="messages.id.ConversationClient.9c4e09c6" /> : ''}{headerPrice}
              <span style={{ marginLeft: 6, color: 'var(--fg-muted)', fontWeight: 400 }}>· {listingTypeLabel(listing?.listing_type)}</span>
              {role === 'buyer' && shop && (
                <span style={{ marginLeft: 6, color: 'var(--fg-muted)', fontWeight: 400 }}>· {shop.name}</span>
              )}
            </p>
          </div>
          <i className="iconoir-arrow-up-right" style={{ fontSize: 14, color: 'var(--fg-muted)', flexShrink: 0 }} />
        </div>
      </Link>

      {/* Trust capsule (C.5) — slim <TrustSignals> at the negotiation entry, so the buyer
          learns eligibility (verification · pago protegido · devoluciones) BEFORE submitting
          an offer. Channel-aware (conversations are platform-only today). Renders nothing
          when the seller has none of the three signals. */}
      {(trustCapsule.verified || trustCapsule.paymentProtected || !!trustCapsule.returnsLabel) && (
        <div style={{ flexShrink: 0, padding: '8px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-elevated)' }}>
          <TrustSignals
            channel="marketplace"
            variant="slim"
            paymentMethods={[]}
            fulfillmentMethods={[]}
            processingLabel={null}
            returnsLabel={trustCapsule.returnsLabel}
            verified={trustCapsule.verified}
            paymentProtected={trustCapsule.paymentProtected}
          />
        </div>
      )}

      {/* Agent CTA */}
      <div style={{ flexShrink: 0, padding: '8px 16px', background: 'var(--agent-soft)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <i className="iconoir-sparks" style={{ fontSize: 14, color: 'var(--agent)' }} />
        <span style={{ fontSize: 12, color: 'var(--agent)' }}>
          {role === 'buyer'
            ? <BuyerCopyText copyKey="messages.id.ConversationClient.78f7321a" />
            : <BuyerCopyText copyKey="messages.id.ConversationClient.5a463fba" />}
        </span>
        <Link href={role === 'buyer' ? '/agent' : '/shop/manage/settings/negociacion'} style={{ fontSize: 12, fontWeight: 600, color: 'var(--agent)', textDecoration: 'underline', marginLeft: 'auto', flexShrink: 0 }}>
          {role === 'buyer' ? <BuyerCopyText copyKey="messages.id.ConversationClient.6bc07191" /> : <BuyerCopyText copyKey="messages.id.ConversationClient.354fb2a2" />}
        </Link>
      </div>

      {/* Transaction ledger card (C.2) — durable shared state, read-only */}
      <TransactionLedgerCard ledger={transaction.ledger} orderId={transaction.orderId} role={role} />

      {/* Events scroll area */}
      <div
        ref={scrollRef}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{ flex: 1, overflowY: 'auto', padding: '8px 0', display: 'flex', flexDirection: 'column', touchAction: pullY > 0 ? 'none' : 'auto' }}
      >
        {/* Pull-to-refresh indicator */}
        {(pullY > 0 || isRefreshing) && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: isRefreshing ? 40 : pullY,
            transition: isRefreshing ? 'none' : 'height 60ms',
            overflow: 'hidden', flexShrink: 0,
          }}>
            <div style={{
              fontSize: 20,
              transform: `rotate(${isRefreshing ? 0 : Math.min((pullY / PULL_THRESHOLD) * 180, 180)}deg)`,
              transition: isRefreshing ? 'none' : 'transform 100ms',
              animation: isRefreshing ? 'spin 600ms linear infinite' : 'none',
            }}>
              ↻
            </div>
          </div>
        )}
        {events.length === 0 && (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--fg-muted)', fontSize: 13 }}>
            <BuyerCopyText copyKey="messages.id.ConversationClient.824c257f" /></div>
        )}
        {grouped.map(({ date, events: dayEvents }) => (
          <div key={date}>
            {/* Date separator */}
            <div style={{ textAlign: 'center', padding: '12px 0 6px' }}>
              <span style={{ fontSize: 11, color: 'var(--fg-subtle)', background: 'var(--bg-sunk)', borderRadius: 'var(--r-pill)', padding: '3px 10px', display: 'inline-block' }}>
                {formatters.date(date, { day: 'numeric', month: 'long', year: 'numeric' })}
              </span>
            </div>
            {dayEvents.map(ev => (
              <EventBubble
                key={ev.id}
                event={ev}
                role={role}
                conversationId={conversationId}
                onRefresh={refresh}
                proofApproved={events.some(e => e.event_type === 'proof_approved')}
              />
            ))}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Action bar / stamp chooser */}
      {!isClosed && (
        <div style={{ flexShrink: 0 }}>
          {showActionBar && (
            <OfferActionBar
              offer={offer}
              role={role}
              listing={listing}
              checkoutProvider={conv.checkout_provider}
              checkoutAvailable={conv.checkout_available}
              isSignedIn
              onRefresh={refresh}
            />
          )}
          {/* Stamp input bar */}
          <div style={{ padding: '10px 16px', background: 'var(--bg-elevated)', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 'max(10px, env(safe-area-inset-bottom))' }}>
            <StampChooser role={role} conversationId={conversationId} onStampSent={refresh} />
            <div style={{ flex: 1, fontSize: 13, color: 'var(--fg-muted)', fontStyle: 'italic', paddingLeft: 4 }}>
              <BuyerCopyText copyKey="messages.id.ConversationClient.152dc9f0" /></div>
          </div>
        </div>
      )}

      {isClosed && (
        <div style={{ flexShrink: 0, padding: '14px 16px', background: 'var(--bg-sunk)', borderTop: '1px solid var(--border)', textAlign: 'center' }}>
          <p style={{ fontSize: 13, color: 'var(--fg-muted)' }}><BuyerCopyText copyKey="messages.id.ConversationClient.6f93ffef" /></p>
        </div>
      )}
    </div>
  )
}
