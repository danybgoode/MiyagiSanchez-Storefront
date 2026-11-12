'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth, useUser } from '@clerk/nextjs'
import { startCheckout } from '@/lib/cart-client'
import { isShippingQuoteInvalid } from '@/lib/checkout-error'
import type { CheckoutFulfillmentMethod, CheckoutProvider, CheckoutShippingAddress, CheckoutShippingQuote } from '@/lib/cart'
import type { CartItem } from './CartContext'
import type { PersonalizationPayload } from '@/lib/personalization'
import { computeCheckoutTotal } from '@/lib/checkout-total'
import { useBuyerFormatters } from './BuyerPresentationContext'
import type { MarketCode } from '@/lib/markets'

const PAY_LABEL: Record<CheckoutProvider, string> = {
  mercadopago: 'Pagar con Mercado Pago',
  stripe: 'Pagar con tarjeta',
  spei: 'Pagar con SPEI',
  cash: 'Confirmar pedido',
  manual: 'Confirmar pedido',
}

interface CheckoutPayButtonProps {
  provider: CheckoutProvider
  listingId?: string
  /** Specific variant for a multi-variant (configurator) listing's single-item path. */
  variantId?: string | null
  /** Personalization for the single-item path (bundle items carry their own). */
  personalization?: PersonalizationPayload | null
  items?: CartItem[]
  sellerId?: string
  /** Subtotal already reflecting quantity (N × unit) — drives the CTA total only. */
  amountCents: number
  currency: string
  /** Event admissions: units sent to the cart line item (default 1). */
  quantity?: number
  offerId?: string
  offerAmountCents?: number
  couponCode?: string
  /** Coupon discount in cents — so the CTA total matches the summary exactly. */
  couponDiscountCents?: number
  fulfillmentMethod?: CheckoutFulfillmentMethod
  pickupSpotId?: string
  /** Local pickup: the buyer's proposed appointment (date + time window). */
  pickupAppointment?: { date: string; window: string }
  shippingAddress?: CheckoutShippingAddress
  shippingQuote?: CheckoutShippingQuote
  /** The backend refused the shipping quote (stale/expired): the parent must clear it and re-quote. */
  onShippingQuoteInvalid?: () => void
  originDomain?: string
  /** Rental: buyer's chosen date range. ONLY dates — never an amount. */
  rental?: { check_in: string; check_out: string }
  disabled?: boolean
  onStarted?: () => void
  market?: MarketCode
}

export default function CheckoutPayButton({
  provider,
  listingId,
  variantId,
  personalization,
  items,
  sellerId,
  amountCents,
  currency,
  quantity,
  offerId,
  offerAmountCents,
  couponCode,
  couponDiscountCents,
  fulfillmentMethod,
  pickupSpotId,
  pickupAppointment,
  shippingAddress,
  shippingQuote,
  onShippingQuoteInvalid,
  originDomain,
  rental,
  disabled,
  onStarted,
  market = 'mx',
}: CheckoutPayButtonProps) {
  const formatters = useBuyerFormatters()
  const router = useRouter()
  const { getToken } = useAuth()
  const { user } = useUser()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isManual = provider === 'manual' || provider === 'spei' || provider === 'cash'
  // Same computation as the summary "Total" (lib/checkout-total) so the CTA never
  // shows a different number than the summary — coupon included.
  const total = computeCheckoutTotal({
    itemsCents: amountCents,
    couponDiscountCents,
    shippingCents: shippingQuote?.amountCents ?? 0,
  })
  const formattedTotal = formatters.currency(total, currency, { maximumFractionDigits: 0 })

  async function pay() {
    setLoading(true)
    setError(null)
    try {
      const buyerEmail = user?.primaryEmailAddress?.emailAddress
      const clerkJwt = (await getToken()) ?? undefined
      const result = await startCheckout({
        productId: listingId,
        variantId,
        personalization,
        quantity,
        items: items?.map(item => ({ productId: item.productId, variantId: item.variantId, personalization: item.personalization })),
        sellerId,
        provider,
        buyerEmail,
        buyerFirstName: user?.firstName ?? undefined,
        buyerLastName: user?.lastName ?? undefined,
        offerAmountCents,
        couponCode,
        offerId,
        clerkJwt,
        fulfillmentMethod,
        pickupSpotId,
        pickupAppointment,
        shippingAddress,
        shippingQuote,
        originDomain,
        rental,
        market,
      })
      onStarted?.()
      if (result.redirect_url) {
        window.location.href = result.redirect_url
        return
      }
      // Manual: order is registered → go to the dedicated order page, which shows
      // all the seller's payment instructions and the pending-payment state.
      if (result.cart_id?.startsWith('order_')) {
        router.push(`/account/orders/${result.cart_id}`)
        return
      }
      setError('No se pudo registrar el pedido. Intenta de nuevo.')
    } catch (err) {
      if (isShippingQuoteInvalid(err)) onShippingQuoteInvalid?.()
      const msg = err instanceof Error ? err.message : 'No se pudo iniciar el pago.'
      setError(msg.includes('SELLER_NOT_CONNECTED') ? 'El vendedor aún no ha activado pagos en línea.' : msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={pay}
        disabled={disabled || loading}
        className="flex items-center justify-center gap-2 w-full font-semibold py-3 rounded-[var(--r-md)] text-sm disabled:opacity-60 transition-colors"
        style={{
          background: provider === 'mercadopago' ? 'var(--provider-mercadopago)' : isManual ? 'var(--bg-elevated)' : 'var(--fg)',
          color: provider === 'mercadopago' ? 'var(--fg-inverse)' : isManual ? 'var(--fg)' : 'var(--fg-inverse)',
          border: isManual ? '1.5px solid var(--border)' : 'none',
        }}
      >
        {loading ? (
          <span className="animate-spin inline-block">⟳</span>
        ) : (
          <>{PAY_LABEL[provider]} — {formattedTotal}</>
        )}
      </button>
      {error && <p className="text-[var(--danger)] text-xs mt-2 text-center"><i className="iconoir-warning-triangle" aria-hidden /> {error}</p>}
    </div>
  )
}
