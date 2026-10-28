import { BuyerCopyText } from '@/app/components/BuyerPresentationContext'
/* eslint-disable @next/next/no-img-element -- seller logos may use arbitrary remote hosts */
import Link from 'next/link'
import type { Shop } from '@/lib/types'
import { whatsappDigits, whatsappMessageLink } from '@/lib/share-kit/whatsapp'

/**
 * Seller trust card — the "who am I buying from + how to reach them" block:
 * seller identity (logo, verified ✓, name, location), contact actions
 * (WhatsApp / phone / email), scheduling, pickup spots, and the claim nudge.
 *
 * Extracted from the PDP (`app/l/[id]/page.tsx`) in Discovery Polish S3.2 so it
 * can lead above payment/fulfillment on mobile (the PDP dual-renders it via the
 * `md:hidden` / `hidden md:block` idiom). Kept a self-contained reusable seam so
 * Epic D (per-channel parity) can render the same trust block inside
 * `ChannelLayout`, and Epic C can hang its "trust capsules" off it.
 */

type PickupSpot = { name?: string; address?: string; instructions?: string }

function whatsappUrl(raw: string, title: string): string {
  // Normalization is shared with the share kit's order link (`lib/share-kit/whatsapp.ts`, D3).
  const full = whatsappDigits(raw) ?? '52'
  return whatsappMessageLink(full, `Hola, vi tu anuncio "${title}" en miyagisanchez.com y me interesa. ¿Sigue disponible?`)
}

export default function SellerTrustCard({
  shop,
  onChannel,
  isClaimed,
  listingTitle,
  whatsappPhone,
  visiblePhone,
  contactEmail,
  bookingUrl,
  bookingText,
  agendarLabel,
  pickupSpots,
  marketBasePath = '',
}: {
  shop: Shop
  onChannel: boolean
  isClaimed: boolean
  listingTitle: string
  whatsappPhone: string | null
  visiblePhone: string | null
  contactEmail: string | null
  bookingUrl: string | null
  bookingText: string | null
  agendarLabel: string
  pickupSpots: PickupSpot[]
  marketBasePath?: string
}) {
  return (
    <div data-testid="seller-trust-card" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', overflow: 'hidden', marginBottom: 20 }}>
      <Link href={onChannel ? '/' : `${marketBasePath}/s/${shop.slug}`} className="no-underline block">
        <div className="flex items-center gap-3" style={{ padding: '14px 16px' }}>
          <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--accent-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {shop.logo_url ? (
              <img src={shop.logo_url as unknown as string} alt={shop.name} style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover' }} />
            ) : (
              <i className="iconoir-shop" style={{ fontSize: 20, color: 'var(--accent)' }} />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--fg)' }}>
                {shop.verified && <i className="iconoir-badge-check" style={{ color: 'var(--accent)', marginRight: 3, verticalAlign: 'middle' }} aria-hidden />}
                {shop.name}
              </span>
            </div>
            {shop.location && (
              <p style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 1 }}>
                <i className="iconoir-map-pin" style={{ fontSize: 11, verticalAlign: 'middle', marginRight: 2 }} />
                {shop.location}
              </p>
            )}
          </div>
          <i className="iconoir-arrow-right" style={{ fontSize: 16, color: 'var(--fg-subtle)', flexShrink: 0 }} />
        </div>
      </Link>

      {/* Contact */}
      {(whatsappPhone || visiblePhone || contactEmail) && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '10px 16px' }}>
          <div style={{ display: 'grid', gap: 8 }}>
            {whatsappPhone && (
              <a
                href={whatsappUrl(whatsappPhone, listingTitle)}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-lg no-underline"
                style={{ width: '100%', justifyContent: 'center', background: 'var(--provider-whatsapp)', color: 'var(--fg-inverse)', borderRadius: 'var(--r-pill)' }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                </svg>
                <BuyerCopyText copyKey="components.SellerTrustCard.c0851756" /></a>
            )}
            {visiblePhone && (
              <a href={`tel:${visiblePhone}`} className="btn btn-lg no-underline" style={{ width: '100%', justifyContent: 'center' }}>
                <i className="iconoir-phone" style={{ fontSize: 16 }} />
                <BuyerCopyText copyKey="components.SellerTrustCard.598970d5" /></a>
            )}
            {contactEmail && (
              <a href={`mailto:${contactEmail}?subject=${encodeURIComponent(`Consulta por ${listingTitle}`)}`} className="btn btn-lg no-underline" style={{ width: '100%', justifyContent: 'center' }}>
                <i className="iconoir-mail" style={{ fontSize: 16 }} />
                <BuyerCopyText copyKey="components.SellerTrustCard.5d61ddad" /></a>
            )}
          </div>
        </div>
      )}

      {/* Scheduling */}
      {bookingUrl && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '10px 16px' }}>
          <a href={bookingUrl} target="_blank" rel="noopener noreferrer" className="btn btn-dark btn-lg no-underline" style={{ width: '100%', justifyContent: 'center' }}>
            <i className="iconoir-calendar" style={{ fontSize: 16 }} />
            {bookingText ?? agendarLabel.replace(/^[^\s]+\s/, '')}
            <i className="iconoir-arrow-up-right" style={{ fontSize: 12, opacity: 0.6 }} />
          </a>
        </div>
      )}

      {pickupSpots.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px' }}>
          <p style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}><BuyerCopyText copyKey="components.SellerTrustCard.7ac10c4e" /></p>
          <div style={{ display: 'grid', gap: 8 }}>
            {pickupSpots.slice(0, 3).map((spot, index) => (
              <div key={`${spot.name ?? 'punto'}-${index}`} style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                <strong style={{ color: 'var(--fg)' }}>{spot.name ?? <BuyerCopyText copyKey="components.SellerTrustCard.c6fc5b53" values={[index + 1]} />}</strong>
                {spot.address && <span> · {spot.address}</span>}
                {spot.instructions && <p style={{ marginTop: 2 }}>{spot.instructions}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Claim nudge */}
      {!isClaimed && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '10px 16px', background: 'var(--bg-sunk)' }}>
          <Link href={`${marketBasePath}/s/${shop.slug}/claim`} style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none' }}>
            <BuyerCopyText copyKey="components.SellerTrustCard.6ed89bba" /></Link>
        </div>
      )}
    </div>
  )
}
