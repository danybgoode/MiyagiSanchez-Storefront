'use client'

import { BuyerCopyText, useBuyerFormatters } from '@/app/components/BuyerPresentationContext'
/* eslint-disable @next/next/no-img-element -- bundle media preserves arbitrary seller-hosted image URLs */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCart, type CartItem } from './CartContext'
import { readStashedPersonalization } from '@/lib/personalization'

interface BundleTier { min_items: number; percent_off: number }

function resolveTier(tiers: BundleTier[], count: number): BundleTier | null {
  if (!tiers.length || count < 2) return null
  const q = tiers.filter(t => t.min_items >= 2 && t.min_items <= count && t.percent_off > 0).sort((a, b) => b.min_items - a.min_items)
  return q[0] ?? null
}

export default function SellerBundleSection({
  sellerName,
  items,
  bundleTiers = [],
  listingBase = '',
}: {
  sellerName: string
  items: CartItem[]
  bundleTiers?: BundleTier[]
  /**
   * Where these sibling products open — `shopListingBase`'s answer, NOT the
   * market base: the items are the shop's OWN catalog, which includes «Solo mi
   * tienda» products that `/mx/l` 404s. See `ShopBases`.
   */
  listingBase?: string
}) {
  const formatters = useBuyerFormatters()
  const router = useRouter()
  const { addItem, removeItem, closeCart, items: cartItems } = useCart()
  const selected = items.filter(item => cartItems.some(cartItem => cartItem.productId === item.productId))
  const subtotal = selected.reduce((sum, item) => sum + item.price_cents, 0)
  const checkoutSellerId = selected[0]?.sellerId ?? items[0]?.sellerId
  if (items.length < 2) return null

  const activeTier = resolveTier(bundleTiers, selected.length)
  const discountCents = activeTier ? Math.round(subtotal * activeTier.percent_off / 100) : 0
  const discountedSubtotal = subtotal - discountCents

  function toggleItem(item: CartItem, inBundle: boolean) {
    if (inBundle) {
      removeItem(item.productId)
      return
    }
    // Carry personalization the buyer entered in this product's buy box (stashed
    // by PersonalizationBuyBox) into the cart line so it echoes + reaches the order.
    const personalization = readStashedPersonalization(item.productId)
    addItem(personalization ? { ...item, personalization } : item)
    closeCart()
  }

  return (
    <section style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
        <div>
          <h2 style={{ fontWeight: 700, fontSize: 16 }}><BuyerCopyText copyKey="components.SellerBundleSection.87d3c9ec" /></h2>
          <p style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}><BuyerCopyText copyKey="components.SellerBundleSection.6a64ce45" />{' '}{sellerName} <BuyerCopyText copyKey="components.SellerBundleSection.92cc22da" /></p>
        </div>
        <button
          type="button"
          onClick={() => router.push(`/checkout/bundle?sellerId=${checkoutSellerId}`)}
          disabled={selected.length === 0}
          className="font-semibold rounded-xl text-sm disabled:opacity-50"
          style={{ padding: '10px 14px', background: 'var(--accent)', color: 'var(--fg-inverse)', border: 'none', flexShrink: 0 }}
        >
          <BuyerCopyText copyKey="components.SellerBundleSection.88600a82" />{selected.length ? ` (${selected.length})` : ''}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
        {items.map((item, index) => {
          const inBundle = cartItems.some(cartItem => cartItem.productId === item.productId)
          return (
            <div key={item.productId} style={{ minWidth: 0 }}>
              <Link href={`${listingBase}/l/${item.productId}`} style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
                <div style={{ aspectRatio: '1 / 1', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-sunk)', marginBottom: 7 }}>
                  {item.imageUrl ? (
                    <img src={item.imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  ) : (
                    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <i className="iconoir-package" style={{ fontSize: 26, color: 'var(--fg-subtle)' }} />
                    </div>
                  )}
                </div>
                <p style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.25, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                  {index === 0 ? <BuyerCopyText copyKey="components.SellerBundleSection.b53f5897" /> : ''}{item.title}
                </p>
                <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 3 }}>{formatters.currency(item.price_cents, item.currency, { maximumFractionDigits: 0 })}</p>
              </Link>
              <button
                type="button"
                onClick={() => toggleItem(item, inBundle)}
                className="font-semibold rounded-xl text-sm"
                style={{
                  width: '100%',
                  marginTop: 8,
                  padding: '9px 12px',
                  background: inBundle ? 'var(--bg-elevated)' : 'transparent',
                  color: inBundle ? 'var(--danger)' : 'var(--accent)',
                  border: `1.5px solid ${inBundle ? 'var(--danger)' : 'var(--accent)'}`,
                }}
              >
                {inBundle ? <BuyerCopyText copyKey="components.SellerBundleSection.fbbe16aa" /> : <BuyerCopyText copyKey="components.SellerBundleSection.884f5ce3" />}
              </button>
            </div>
          )
        })}
      </div>

      {/* Next tier teaser — shown when no tier active yet */}
      {selected.length > 0 && !activeTier && bundleTiers.length > 0 && (() => {
        const nextTier = bundleTiers.filter(t => t.min_items > selected.length && t.percent_off > 0).sort((a, b) => a.min_items - b.min_items)[0]
        if (!nextTier) return null
        return (
          <p style={{ marginTop: 8, fontSize: 12, color: 'var(--fg-muted)', textAlign: 'center' }}>
            <BuyerCopyText copyKey="components.SellerBundleSection.2e2665d8" />{' '}{nextTier.min_items - selected.length} <BuyerCopyText copyKey="components.SellerBundleSection.fdedb1d1" />{nextTier.min_items - selected.length > 1 ? <BuyerCopyText copyKey="components.SellerBundleSection.79d7ef22" /> : ''} <BuyerCopyText copyKey="components.SellerBundleSection.680b9e74" />{' '}
            <strong style={{ color: 'var(--success)' }}>{nextTier.percent_off}<BuyerCopyText copyKey="components.SellerBundleSection.ea58a729" /></strong>
          </p>
        )
      })()}

      {selected.length > 0 && (
        <div style={{ marginTop: 12, padding: '12px 14px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{selected.length} {selected.length === 1 ? <BuyerCopyText copyKey="components.SellerBundleSection.fdedb1d1" /> : <BuyerCopyText copyKey="components.SellerBundleSection.42574adf" />} <BuyerCopyText copyKey="components.SellerBundleSection.0a7462b7" /></p>
            {activeTier ? (
              <>
                <p style={{ fontSize: 13, textDecoration: 'line-through', color: 'var(--fg-muted)', margin: 0 }}>{formatters.currency(subtotal, selected[0].currency, { maximumFractionDigits: 0 })}</p>
                <p style={{ fontSize: 17, fontWeight: 800, color: 'var(--success)' }}>{formatters.currency(discountedSubtotal, selected[0].currency, { maximumFractionDigits: 0 })}</p>
                <p style={{ fontSize: 11, color: 'var(--success)' }}><i className="iconoir-sparks" aria-hidden /> {activeTier.percent_off}<BuyerCopyText copyKey="components.SellerBundleSection.9b9aac5b" /></p>
              </>
            ) : (
              <p style={{ fontSize: 17, fontWeight: 800 }}>{formatters.currency(subtotal, selected[0].currency, { maximumFractionDigits: 0 })}</p>
            )}
          </div>
          <button type="button" onClick={() => router.push(`/checkout/bundle?sellerId=${checkoutSellerId}`)} className="font-semibold rounded-xl text-sm" style={{ padding: '10px 14px', background: 'var(--fg)', color: 'var(--fg-inverse)', border: 'none' }}>
            <BuyerCopyText copyKey="components.SellerBundleSection.0a748c29" /></button>
        </div>
      )}
    </section>
  )
}
