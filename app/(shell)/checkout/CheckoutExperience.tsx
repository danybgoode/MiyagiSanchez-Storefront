'use client'

/* eslint-disable react-hooks/set-state-in-effect, react-hooks/immutability, react-hooks/exhaustive-deps -- S2 mechanically localizes this pre-existing checkout state machine; changing its sequencing belongs to a dedicated money-path change. */

import { BuyerCopyText, useBuyerCopy, useBuyerFormatters } from '@/app/components/BuyerPresentationContext'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import CheckoutPayButton from '@/app/components/CheckoutPayButton'
import type { CartItem } from '@/app/components/CartContext'
import type { CheckoutFulfillmentMethod, CheckoutProvider, CheckoutShippingAddress, CheckoutShippingQuote } from '@/lib/cart'
import type { CheckoutOptions } from '@/lib/checkout-options'
import { type PersonalizationPayload, type PersonalizationField, readStashedPersonalization } from '@/lib/personalization'
import PersonalizationEcho from '@/app/components/PersonalizationEcho'
import { shouldOfferCoordinatedFallback, pickManualPaymentId, isCoordDeliverySelected } from '@/lib/checkout-fallback'
import { raceWithTimeout, isTimeoutError } from '@/lib/fetch-timeout'
import { computeCheckoutTotal } from '@/lib/checkout-total'
import { PICKUP_WINDOWS } from '@/lib/pickup-appointment'
import type { MarketCode } from '@/lib/markets'

// The /api/checkout/options response shapes live in lib/checkout-options.ts, shared with the prompt-to-shop
// checkout preview (S5.1) so the preview and this page can never read different shapes.

type ShippingRate = {
  id: string
  rateId: string
  carrier: string
  service: string
  amountCents: number
  currency: string
  deliveryEstimate: number | null
  deliveryLabel: string | null
}

type PostalLookupResult = {
  zipCode: string
  stateCode: string
  stateName: string
  alcaldia: string
  colonias: string[]
}

function optionButtonStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    width: '100%',
    gap: 10,
    alignItems: 'flex-start',
    padding: 12,
    textAlign: 'left',
    borderRadius: 8,
    border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
    background: active ? 'var(--accent-soft)' : 'var(--bg-sunk)',
    color: 'var(--fg)',
  }
}

function radioDot(active: boolean): CSSProperties {
  return { width: 18, height: 18, borderRadius: '50%', border: `5px solid ${active ? 'var(--accent)' : 'var(--border)'}`, flexShrink: 0, marginTop: 1 }
}

function blankAddress(market: MarketCode): CheckoutShippingAddress {
  return { country: market === 'us' ? 'US' : 'MX', name: '', phone: '', line1: '', ext_number: '', int_number: '', line2: '', city: '', state: '', state_code: '', postal_code: '' }
}

export default function CheckoutExperience({
  sellerId,
  listingId,
  variantId,
  items,
  amountCents,
  currency,
  offerId,
  offerAmountCents,
  quantity = 1,
  listingType = 'product',
  isDigital = false,
  deliveryMode = 'carrier',
  originDomain,
  rental,
  onStarted,
  market = 'mx',
}: {
  sellerId: string
  listingId?: string
  /** Specific variant for a multi-variant (configurator) listing's single-item path. */
  variantId?: string | null
  items?: CartItem[]
  /** Unit price (single-item path) or bundle subtotal. */
  amountCents: number
  currency: string
  offerId?: string
  offerAmountCents?: number
  /** Event admissions: units for the single-item path (default 1). */
  quantity?: number
  listingType?: string
  isDigital?: boolean
  /** Arranged-only delivery (epic, S1.3) — the backend ignores this off-flag. */
  deliveryMode?: 'carrier' | 'arranged'
  originDomain?: string
  /** Rental: buyer's chosen date range. ONLY dates — never an amount. */
  rental?: { check_in: string; check_out: string }
  onStarted?: () => void
  market?: MarketCode
}) {
  const formatters = useBuyerFormatters()
  const formatCents = (cents: number, currency: string) => formatters.currency(cents, currency, { maximumFractionDigits: 0 })
  const copy = useBuyerCopy()
  // Single-item event admissions can be N units; the bundle path keeps quantity 1
  // (each bundle item carries its own). itemsCents drives the coupon base, the
  // summary subtotal, and the CTA total so all three reflect N × unit.
  const itemsCents = amountCents * Math.max(1, Math.floor(quantity) || 1)
  // ── Fetch checkout options from Medusa (single source of truth) ───────────
  const [options, setOptions] = useState<CheckoutOptions | null>(null)
  const [optionsError, setOptionsError] = useState<string | null>(null)

  // Personalization the buyer entered in the PDP buy box, stashed for hand-off
  // (single-item path). Bundle items carry their own payload on the CartItem.
  const [personalization, setPersonalization] = useState<PersonalizationPayload | null>(null)
  useEffect(() => {
    if (listingId) setPersonalization(readStashedPersonalization(listingId))
  }, [listingId])

  useEffect(() => {
    let cancelled = false
    const qs = new URLSearchParams({ sellerId, listingType, isDigital: String(isDigital), deliveryMode, market })
    fetch(`/api/checkout/options?${qs}`)
      .then(r => r.json())
      .then((data: CheckoutOptions & { error?: string }) => {
        if (cancelled) return
        if (data.error) { setOptionsError(data.error); return }
        setOptions(data)
        setSelectedDeliveryId(data.delivery_default ?? data.delivery_methods[0]?.id ?? 'none')
        setSelectedPaymentId(data.payment_default ?? data.payment_methods[0]?.id ?? null)
      })
      .catch(() => { if (!cancelled) setOptionsError('No se pudieron cargar las opciones de pago.') })
    return () => { cancelled = true }
  }, [sellerId, listingType, isDigital, deliveryMode, market])

  const [selectedDeliveryId, setSelectedDeliveryId] = useState<CheckoutFulfillmentMethod>('none')
  const [selectedPickupSpotId, setSelectedPickupSpotId] = useState<string | null>(null)
  // Pickup appointment (S2.1) — the buyer proposes a date + time window.
  const [pickupDate, setPickupDate] = useState('')
  const [pickupWindow, setPickupWindow] = useState('')
  const [selectedPaymentId, setSelectedPaymentId] = useState<CheckoutProvider | null>(null)
  const [address, setAddress] = useState<CheckoutShippingAddress>(() => blankAddress(market))

  // CP-first lookup state
  const [cpLookupLoading, setCpLookupLoading] = useState(false)
  const [cpLookupError, setCpLookupError] = useState<string | null>(null)
  const [cpResult, setCpResult] = useState<PostalLookupResult | null>(null)
  const cpLookupRef = useRef<AbortController | null>(null)

  const [shippingRates, setShippingRates] = useState<ShippingRate[]>([])
  const [selectedShippingRateId, setSelectedShippingRateId] = useState<string | null>(null)
  const [shippingRatesLoading, setShippingRatesLoading] = useState(false)
  const [shippingRatesError, setShippingRatesError] = useState<string | null>(null)
  const [shippingRatesMessage, setShippingRatesMessage] = useState<string | null>(null)
  // S3.2 — when quoting dead-ends, the buyer can choose coordinated ("entrega
  // acordada") delivery to proceed. Reset whenever a fresh quote attempt starts
  // or the delivery method changes.
  const [coordinatedFallback, setCoordinatedFallback] = useState(false)

  // ── Coupon code ───────────────────────────────────────────────────────────
  // Not offered when an accepted offer OR a rental booking is in play (coupons
  // don't stack on either, mirroring the backend rule — start-checkout silently
  // ignores `coupon_code` whenever a rentalBooking is present, so leaving this UI
  // open for a rental checkout would show a discount the backend never actually
  // charges, breaking the pay-button-total-equals-charge house rule). Validation
  // is a real-time preview; start-checkout re-checks authoritatively.
  const couponsAllowed = !offerAmountCents && !rental
  const [couponInput, setCouponInput] = useState('')
  const [appliedCoupon, setAppliedCoupon] = useState<{ code: string; discountCents: number } | null>(null)
  const [couponValidating, setCouponValidating] = useState(false)
  const [couponError, setCouponError] = useState<string | null>(null)

  async function applyCoupon() {
    const code = couponInput.trim().toUpperCase()
    if (!code) return
    setCouponValidating(true)
    setCouponError(null)
    try {
      const qs = new URLSearchParams({ sellerId, code, itemsCents: String(itemsCents) })
      const res = await fetch(`/api/checkout/validate-coupon?${qs}`)
      const data = await res.json() as { valid?: boolean; code?: string; discount_cents?: number; message?: string }
      if (!res.ok || !data.valid) {
        setAppliedCoupon(null)
        setCouponError(data.message ?? 'Cupón no válido.')
        return
      }
      setAppliedCoupon({ code: data.code ?? code, discountCents: data.discount_cents ?? 0 })
      setCouponInput(data.code ?? code)
    } catch {
      setCouponError('No se pudo validar el cupón. Intenta de nuevo.')
    } finally {
      setCouponValidating(false)
    }
  }

  function removeCoupon() {
    setAppliedCoupon(null)
    setCouponInput('')
    setCouponError(null)
  }

  const couponDiscountCents = appliedCoupon?.discountCents ?? 0

  const deliveryMethods = options?.delivery_methods ?? []
  const paymentMethods = options?.payment_methods ?? []

  const selectedDelivery = useMemo(
    () => deliveryMethods.find(o => o.id === selectedDeliveryId) ?? deliveryMethods[0],
    [deliveryMethods, selectedDeliveryId],
  )
  const selectedPayment = useMemo(
    () => paymentMethods.find(o => o.id === selectedPaymentId) ?? null,
    [paymentMethods, selectedPaymentId],
  )

  const cpResolved = market === 'us' || Boolean(cpResult?.stateCode)
  const addressReady = !selectedDelivery?.requires_address || Boolean(
    address.name?.trim() && address.line1?.trim() && address.ext_number?.trim() && address.state_code?.trim() && address.postal_code?.trim(),
  )
  const needsShippingRate = selectedDelivery?.id === 'shipping' && !!selectedDelivery.requires_address
  const isPickupDelivery = selectedDelivery?.id === 'local_pickup'
  const needsPickupSpot = isPickupDelivery && !!selectedDelivery.requires_pickup_spot
  // Local pickup is now a real appointment: the buyer must propose a date + window.
  const appointmentReady = !isPickupDelivery || (!!pickupDate && !!pickupWindow)
  const pickupReady = (!needsPickupSpot || !!selectedPickupSpotId) && appointmentReady

  const selectedShippingRate = useMemo(
    () => shippingRates.find(r => r.id === selectedShippingRateId) ?? null,
    [shippingRates, selectedShippingRateId],
  )
  const selectedShippingQuote: CheckoutShippingQuote | undefined = selectedShippingRate
    ? {
        rateId: selectedShippingRate.rateId,
        carrier: selectedShippingRate.carrier,
        service: selectedShippingRate.service,
        amountCents: selectedShippingRate.amountCents,
        currency: selectedShippingRate.currency,
        deliveryEstimate: selectedShippingRate.deliveryEstimate,
        deliveryLabel: selectedShippingRate.deliveryLabel,
      }
    : undefined
  const totalCents = computeCheckoutTotal({
    itemsCents,
    couponDiscountCents,
    shippingCents: selectedShippingRate?.amountCents ?? 0,
  })

  // Manual ("Pago directo") — the buyer does NOT pick a sub-type at checkout.
  // We preview what the seller accepts (method + how it works) so they don't commit
  // blind; the exact account numbers appear on the order page after placing. Cash
  // applies only with pickup.
  const isPickup = selectedDelivery?.id === 'local_pickup'
  const isManualPayment = selectedPayment?.kind === 'manual'
  const manualMethods = useMemo(
    () => (isManualPayment ? selectedPayment!.sub_options ?? [] : [])
      .filter(o => o.type !== 'cash' || isPickup),
    [isManualPayment, selectedPayment, isPickup],
  )

  // S3.2 — coordinated ("entrega acordada") fallback when shipping can't be quoted.
  const offerCoordinatedFallback = needsShippingRate && shouldOfferCoordinatedFallback({
    loading: shippingRatesLoading,
    error: shippingRatesError,
    ratesCount: shippingRates.length,
    message: shippingRatesMessage,
  })
  const manualPaymentId = pickManualPaymentId(paymentMethods)
  // Active only when the buyer picked the fallback AND quoting is still failing.
  const coordinatedActive = offerCoordinatedFallback && coordinatedFallback
  // Arranged-only delivery (epic, S1.3) — the buyer reaches "coord" either via
  // the S3.2 shipping-quote-failure fallback above, OR by picking the `coord`
  // delivery method directly (only possible for an arranged listing, since
  // that's the only case the backend ever pushes a `coord` entry). Both are
  // the same money-path state (fulfillment_method:'coord', manual-only pay),
  // so unify them once here rather than repeating the OR at each call site.
  const isCoordCheckout = isCoordDeliverySelected({
    coordinatedFallbackActive: coordinatedActive,
    selectedDeliveryId: selectedDelivery?.id,
  })
  // The narrower "direct pick" half of isCoordCheckout, kept as its own named
  // value (not a repeated string literal) so this file has exactly ONE place
  // that defines what 'coord' means — used below where the effect must react
  // ONLY to a direct pick, not the S3.2-fallback-active case (which already has
  // its own steering in selectCoordinatedFallback).
  const isDirectCoordPick = selectedDelivery?.id === 'coord'

  function selectCoordinatedFallback() {
    setCoordinatedFallback(true)
    // Coordinated delivery requires "pago directo" — the backend 422s on card + coord.
    if (selectedPayment?.kind !== 'manual' && manualPaymentId) setSelectedPaymentId(manualPaymentId)
  }

  // Auto-steer to manual payment when the buyer picks `coord` directly as a
  // primary delivery choice (not via the S3.2 fallback button, which already
  // does this in selectCoordinatedFallback above).
  useEffect(() => {
    if (isDirectCoordPick && selectedPayment?.kind !== 'manual' && manualPaymentId) {
      setSelectedPaymentId(manualPaymentId)
    }
  }, [isDirectCoordPick, selectedPayment?.kind, manualPaymentId])

  const canPay = Boolean(
    selectedDelivery && selectedPayment && addressReady && pickupReady &&
    (isCoordCheckout
      ? selectedPayment.kind === 'manual'
      : (!needsShippingRate || selectedShippingRate)),
  )

  // Reset pickup spot selection + proposed appointment when delivery method changes.
  useEffect(() => { setSelectedPickupSpotId(null); setPickupDate(''); setPickupWindow(''); setCoordinatedFallback(false) }, [selectedDeliveryId])

  // ── CP-first lookup ────────────────────────────────────────────────────────
  function handleCpChange(value: string) {
    const cp = value.replace(/\D/g, '').slice(0, 5)
    setAddress(a => ({ ...a, postal_code: cp, state: '', state_code: '', city: '', line2: '' }))
    setCpResult(null)
    setCpLookupError(null)
    if (cp.length < 5) return

    cpLookupRef.current?.abort()
    const ctrl = new AbortController()
    cpLookupRef.current = ctrl
    setCpLookupLoading(true)

    fetch('/api/checkout/postal-lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cp }),
      signal: ctrl.signal,
    })
      .then(r => r.json())
      .then((data: PostalLookupResult & { error?: string }) => {
        if (ctrl.signal.aborted) return
        if (data.error) { setCpLookupError(data.error); return }
        setCpResult(data)
        setAddress(a => ({ ...a, postal_code: data.zipCode, state: data.stateName, state_code: data.stateCode, city: data.alcaldia, line2: '' }))
      })
      .catch(e => {
        if (ctrl.signal.aborted) return
        setCpLookupError('No se pudo validar el código postal.')
        console.error('[postal-lookup]', e)
      })
      .finally(() => { if (!ctrl.signal.aborted) setCpLookupLoading(false) })
  }

  // ── Quote shipping rates ───────────────────────────────────────────────────
  useEffect(() => {
    if (!needsShippingRate || !addressReady) return
    const controller = new AbortController()
    let cancelled = false
    // S3.3 — bound the quote so "Cotizando…" can't spin forever on a hung carrier.
    const QUOTE_TIMEOUT_MS = 9_000
    const timeout = window.setTimeout(async () => {
      setShippingRatesLoading(true)
      setShippingRatesError(null)
      setShippingRatesMessage(null)
      setCoordinatedFallback(false)
      try {
        const res = await raceWithTimeout(
          fetch('/api/checkout/shipping-rates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              items?.length
                ? { items: items.map(i => i.productId), address }
                : { listingId, address },
            ),
            signal: controller.signal,
          }),
          QUOTE_TIMEOUT_MS,
        )
        const data = await res.json().catch(() => null) as { rates?: ShippingRate[]; error?: string; message?: string } | null
        if (cancelled) return
        if (!res.ok) throw new Error(data?.error ?? 'No se pudo cotizar el envío.')
        const rates = data?.rates ?? []
        setShippingRates(rates)
        setSelectedShippingRateId(rates[0]?.id ?? null)
        if (rates.length === 0) setShippingRatesMessage(data?.message ?? 'Las paqueterías no tienen cobertura para ese destino.')
      } catch (err) {
        if (isTimeoutError(err)) controller.abort() // cancel the hung request
        if (cancelled) return
        setShippingRates([])
        setSelectedShippingRateId(null)
        setShippingRatesError(
          isTimeoutError(err)
            ? 'El envío tardó demasiado en cotizar. Puedes coordinar la entrega con el vendedor.'
            : err instanceof Error ? err.message : 'No se pudo cotizar el envío.',
        )
      } finally {
        if (!cancelled) setShippingRatesLoading(false)
      }
    }, 450)
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timeout) }
  }, [needsShippingRate, addressReady, listingId, items, address])

  // ── Loading / error states ─────────────────────────────────────────────────
  if (optionsError) {
    return (
      <section style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 16 }}>
        <p style={{ fontSize: 13, color: 'var(--danger)' }}><i className="iconoir-warning-triangle" aria-hidden /> {optionsError}</p>
      </section>
    )
  }
  if (!options) {
    return (
      <section style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 16, display: 'grid', gap: 8 }}>
        {[0, 1, 2].map(i => <div key={i} style={{ height: 54, borderRadius: 8, background: 'var(--bg-sunk)', opacity: 0.7 }} />)}
      </section>
    )
  }

  return (
    <>
      {/* ── Delivery not configured (no coord fallback) ────────────────────── */}
      {deliveryMethods.length === 0 && (
        <section style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 16 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <i className="iconoir-package" aria-hidden style={{ fontSize: 20, flexShrink: 0 }} />
            <div>
              <p style={{ fontSize: 14, fontWeight: 800, marginBottom: 6 }}><BuyerCopyText copyKey="checkout.CheckoutExperience.f44e2af5" /></p>
              <p style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
                <BuyerCopyText copyKey="checkout.CheckoutExperience.40981279" /></p>
            </div>
          </div>
        </section>
      )}

      {/* ── Delivery section ───────────────────────────────────────────────── */}
      {deliveryMethods.length > 0 && (
        <section style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 16 }}>
          <h2 style={{ fontSize: 'var(--t-base)', fontWeight: 800, marginBottom: 10 }}><BuyerCopyText copyKey="checkout.CheckoutExperience.f966c4ce" /></h2>
          <div style={{ display: 'grid', gap: 8 }}>
            {deliveryMethods.map(option => (
              <button key={option.id} type="button" onClick={() => setSelectedDeliveryId(option.id)} style={optionButtonStyle(selectedDelivery?.id === option.id)}>
                <span aria-hidden style={radioDot(selectedDelivery?.id === option.id)} />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 800 }}>{option.label}</span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>{option.note}</span>
                </span>
              </button>
            ))}
          </div>

          {/* Pickup spot picker — deterministic list of where you can recoger */}
          {selectedDelivery?.id === 'local_pickup' && (selectedDelivery.pickup_spots?.length ?? 0) > 0 && (
            <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
              <p style={{ fontSize: 12, fontWeight: 800, color: 'var(--fg-muted)' }}><BuyerCopyText copyKey="checkout.CheckoutExperience.2ce52737" /></p>
              {selectedDelivery.pickup_spots!.map(spot => {
                const active = selectedPickupSpotId === spot.id
                return (
                  <button key={spot.id} type="button" onClick={() => setSelectedPickupSpotId(spot.id)} style={optionButtonStyle(active)}>
                    <span aria-hidden style={radioDot(active)} />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'block', fontSize: 13, fontWeight: 800 }}>{spot.name ?? <BuyerCopyText copyKey="checkout.CheckoutExperience.8ac686ce" />}</span>
                      {spot.address && <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>{spot.address}</span>}
                      {spot.hours && <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-subtle)', marginTop: 2 }}><i className="iconoir-clock" aria-hidden /> {spot.hours}</span>}
                      {spot.notes && <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-subtle)', marginTop: 2 }}>{spot.notes}</span>}
                      {spot.scheduling_url && active && (
                        <a href={spot.scheduling_url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', marginTop: 6, fontSize: 12, fontWeight: 700, color: 'var(--accent)', textDecoration: 'none' }}>
                          <BuyerCopyText copyKey="checkout.CheckoutExperience.f6c423f5" /></a>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {/* Pickup appointment (S2.1) — propose a date + time window instead of an
              external scheduling link. The seller confirms or reschedules after placing. */}
          {selectedDelivery?.id === 'local_pickup' && (
            <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
              <p style={{ fontSize: 12, fontWeight: 800, color: 'var(--fg-muted)' }}><BuyerCopyText copyKey="checkout.CheckoutExperience.86b7aa9f" /></p>
              <input
                type="date"
                value={pickupDate}
                min={new Date().toISOString().slice(0, 10)}
                onChange={e => setPickupDate(e.target.value)}
                style={inputStyle}
              />
              <div style={{ display: 'grid', gap: 8 }}>
                {PICKUP_WINDOWS.map(w => {
                  const active = pickupWindow === w.key
                  return (
                    <button key={w.key} type="button" onClick={() => setPickupWindow(w.key)} style={optionButtonStyle(active)}>
                      <span aria-hidden style={radioDot(active)} />
                      <span style={{ fontSize: 13, fontWeight: 800 }}>{w.label}</span>
                    </button>
                  )
                })}
              </div>
              <p style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                <BuyerCopyText copyKey="checkout.CheckoutExperience.95b7fbaa" /></p>
            </div>
          )}

          {/* Address form (shipping) */}
          {selectedDelivery?.requires_address && (
            <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
              {/* CP-first (S3.1) — the CP leads. It drives the postal-lookup auto-fill,
                  so name/phone and the rest of the address reveal only once it resolves. */}
              <div>
                <div style={{ position: 'relative' }}>
                  <input
                    value={address.postal_code ?? ''}
                    onChange={e => handleCpChange(e.target.value)}
                    placeholder={copy('checkout.CheckoutExperience.5a3a6431')}
                    inputMode="numeric"
                    maxLength={5}
                    style={{ ...inputStyle, paddingRight: 34, border: `1px solid ${cpLookupError ? 'var(--danger)' : cpResolved ? 'var(--success)' : 'var(--border)'}` }}
                  />
                  {cpLookupLoading && <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: 'var(--fg-subtle)' }}>·</span>}
                  {cpResolved && !cpLookupLoading && <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 14, color: 'var(--success)' }}><i className="iconoir-check" aria-hidden /></span>}
                </div>
                {cpLookupError && <p style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4 }}>{cpLookupError}</p>}
                {!cpResolved && !cpLookupError && (
                  <p style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}><BuyerCopyText copyKey="checkout.CheckoutExperience.ce529c42" /></p>
                )}
              </div>

              {cpResolved && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <input value={address.name ?? ''} onChange={e => setAddress({ ...address, name: e.target.value })} placeholder={copy('checkout.CheckoutExperience.6493099f')} style={inputStyle} />
                    <input value={address.phone ?? ''} onChange={e => setAddress({ ...address, phone: e.target.value })} placeholder={copy('checkout.CheckoutExperience.e0dc125a')} inputMode="tel" style={inputStyle} />
                  </div>

                  {cpResult && (
                    <>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        <div>
                          <p style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 3 }}><BuyerCopyText copyKey="checkout.CheckoutExperience.451e916f" /></p>
                          <div style={{ ...inputStyle, background: 'var(--bg-sunk)', color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 12, color: 'var(--success)' }}><i className="iconoir-check" aria-hidden /></span>
                            <span style={{ fontSize: 13 }}>{cpResult.stateName}</span>
                          </div>
                        </div>
                        <div>
                          <p style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 3 }}><BuyerCopyText copyKey="checkout.CheckoutExperience.a2751ff1" /></p>
                          <div style={{ ...inputStyle, background: 'var(--bg-sunk)', color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 12, color: 'var(--success)' }}><i className="iconoir-check" aria-hidden /></span>
                            <span style={{ fontSize: 13 }}>{cpResult.alcaldia}</span>
                          </div>
                        </div>
                      </div>

                      {cpResult.colonias.length > 0 && (
                        <select value={address.line2 ?? ''} onChange={e => setAddress({ ...address, line2: e.target.value })} style={inputStyle as CSSProperties}>
                          <option value=""><BuyerCopyText copyKey="checkout.CheckoutExperience.a5f5ec3a" /></option>
                          {cpResult.colonias.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      )}
                    </>
                  )}

                  <input value={address.line1 ?? ''} onChange={e => setAddress({ ...address, line1: e.target.value })} placeholder={copy('checkout.CheckoutExperience.ac32dc77')} style={inputStyle} />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <input value={address.ext_number ?? ''} onChange={e => setAddress({ ...address, ext_number: e.target.value })} placeholder={copy('checkout.CheckoutExperience.862d2c75')} style={inputStyle} />
                    <input value={address.int_number ?? ''} onChange={e => setAddress({ ...address, int_number: e.target.value })} placeholder={copy('checkout.CheckoutExperience.8fd9c87c')} style={inputStyle} />
                  </div>
                </>
              )}

              {addressReady && needsShippingRate && (
                <div style={{ display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <p style={{ fontSize: 12, fontWeight: 800, color: 'var(--fg-muted)' }}><BuyerCopyText copyKey="checkout.CheckoutExperience.e08e0036" /></p>
                    {shippingRatesLoading && <p style={{ fontSize: 12, color: 'var(--fg-subtle)' }}><BuyerCopyText copyKey="checkout.CheckoutExperience.065c6061" /></p>}
                  </div>

                  {shippingRatesLoading && shippingRates.length === 0 && (
                    <div style={{ display: 'grid', gap: 8 }}>
                      {[0, 1].map(i => <div key={i} style={{ height: 58, borderRadius: 8, background: 'var(--bg-sunk)', border: '1px solid var(--border)', opacity: 0.75 }} />)}
                    </div>
                  )}

                  {shippingRatesError && !shippingRatesLoading && (
                    <div style={{ background: 'var(--danger-soft)', border: '1px solid var(--danger)', borderRadius: 8, padding: 10 }}>
                      <p style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 4 }}>{shippingRatesError}</p>
                      <p style={{ fontSize: 11, color: 'var(--fg-muted)' }}><BuyerCopyText copyKey="checkout.CheckoutExperience.3dd0e30b" /></p>
                    </div>
                  )}

                  {shippingRatesMessage && !shippingRatesLoading && shippingRates.length === 0 && !shippingRatesError && (
                    <div style={{ background: 'var(--warning-soft)', border: '1px solid var(--warning)', borderRadius: 8, padding: 10 }}>
                      <p style={{ fontSize: 12, color: 'var(--warning)' }}>{shippingRatesMessage}</p>
                    </div>
                  )}

                  {shippingRates.map(rate => {
                    const active = selectedShippingRateId === rate.id
                    return (
                      <button key={rate.id} type="button" onClick={() => setSelectedShippingRateId(rate.id)} style={optionButtonStyle(active)}>
                        <span aria-hidden style={radioDot(active)} />
                        <span style={{ minWidth: 0, flex: 1 }}>
                          <span style={{ display: 'block', fontSize: 13, fontWeight: 800 }}>{rate.carrier.toUpperCase()} · {rate.service}</span>
                          <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
                            {rate.deliveryLabel ? <BuyerCopyText copyKey="checkout.CheckoutExperience.5a116d9d" values={[rate.deliveryLabel]} /> : <BuyerCopyText copyKey="checkout.CheckoutExperience.aa650f82" />}
                          </span>
                        </span>
                        <strong style={{ fontSize: 14, whiteSpace: 'nowrap' }}>{formatCents(rate.amountCents, rate.currency)}</strong>
                      </button>
                    )
                  })}

                  {/* S3.2 — coordinated fallback so a quote failure / timeout isn't a dead end. */}
                  {offerCoordinatedFallback && (
                    <div style={{ display: 'grid', gap: 6 }}>
                      <button type="button" onClick={selectCoordinatedFallback} style={optionButtonStyle(coordinatedActive)}>
                        <span aria-hidden style={radioDot(coordinatedActive)} />
                        <span style={{ minWidth: 0, flex: 1 }}>
                          <span style={{ display: 'block', fontSize: 13, fontWeight: 800 }}><BuyerCopyText copyKey="checkout.CheckoutExperience.3b2c5986" /></span>
                          <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
                            <BuyerCopyText copyKey="checkout.CheckoutExperience.4692ee2e" /></span>
                        </span>
                      </button>
                      {coordinatedActive && (
                        <p style={{ fontSize: 11.5, color: 'var(--fg-subtle)', lineHeight: 1.5 }}>
                          {manualPaymentId
                            ? <BuyerCopyText copyKey="checkout.CheckoutExperience.5104dad5" />
                            : <BuyerCopyText copyKey="checkout.CheckoutExperience.71322f2f" />}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {options.preparation && (
            <p style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 10 }}><i className="iconoir-package" aria-hidden /> <BuyerCopyText copyKey="checkout.CheckoutExperience.9cca4011" />{' '}{options.preparation}</p>
          )}
        </section>
      )}

      {/* ── Payment section ────────────────────────────────────────────────── */}
      <section style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 16 }}>
        <h2 style={{ fontSize: 'var(--t-base)', fontWeight: 800, marginBottom: 10 }}><BuyerCopyText copyKey="checkout.CheckoutExperience.e04fb7d1" /></h2>

        {paymentMethods.length === 0 ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <i className="iconoir-community" aria-hidden style={{ fontSize: 20, flexShrink: 0 }} />
            <div>
              <p style={{ fontSize: 14, fontWeight: 800, marginBottom: 6 }}>
                {options.only_coordinated ? <BuyerCopyText copyKey="checkout.CheckoutExperience.5e428788" /> : <BuyerCopyText copyKey="checkout.CheckoutExperience.99c8151f" />}
              </p>
              <p style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
                <BuyerCopyText copyKey="checkout.CheckoutExperience.c1ade5f3" /></p>
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {/* Arranged-only delivery (epic, S1.3) — new copy, not a repurposing
                of the empty-payment-methods branch above (that one stays reserved
                for a seller with literally zero payment methods configured — a
                correctly-configured arranged listing always has a manual method,
                so paymentMethods.length is never 0 here). */}
            {options.only_coordinated && (
              <p style={{ fontSize: 12.5, color: 'var(--fg-muted)', marginBottom: 2 }}>
                <i className="iconoir-community" aria-hidden /> <BuyerCopyText copyKey="checkout.CheckoutExperience.7d779f09" /></p>
            )}
            {paymentMethods.map(option => {
              const active = selectedPayment?.id === option.id
              // A coord checkout (S1.3) requires manual payment — the backend
              // 422s card + coord, so disable the online buttons here instead
              // of letting a mistaken submit fail late.
              const disabledForCoord = isCoordCheckout && option.kind !== 'manual'
              return (
                <div key={option.id}>
                  <button
                    type="button"
                    onClick={() => !disabledForCoord && setSelectedPaymentId(option.id)}
                    disabled={disabledForCoord}
                    style={{ ...optionButtonStyle(active), ...(disabledForCoord ? { opacity: 0.45, cursor: 'not-allowed' } : {}) }}
                  >
                    <span aria-hidden style={radioDot(active)} />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 13, fontWeight: 800 }}>{option.label}</span>
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999,
                          background: option.protected ? 'var(--success-soft)' : 'var(--bg-sunk)',
                          color: option.protected ? 'var(--success-strong)' : 'var(--fg-muted)',
                          border: `1px solid ${option.protected ? 'var(--success)' : 'var(--border)'}`,
                        }}>
                          {option.protected ? <BuyerCopyText copyKey="checkout.CheckoutExperience.07b3ef16" /> : <BuyerCopyText copyKey="checkout.CheckoutExperience.c5ec516b" />}
                        </span>
                      </span>
                      <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>{option.note}</span>
                    </span>
                  </button>

                  {/* Manual — preview the accepted methods + how each works so the
                      buyer doesn't commit blind. The exact account numbers (CLABE,
                      phone) appear on the order page right after placing. */}
                  {active && option.kind === 'manual' && manualMethods.length > 0 && (
                    <div style={{ marginTop: 6, marginLeft: 14, paddingLeft: 12, borderLeft: '2px solid var(--border)', display: 'grid', gap: 8 }}>
                      {manualMethods.map(m => (
                        <div key={m.type} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                          <i
                            aria-hidden
                            className={m.type === 'clabe' ? 'iconoir-bank' : m.type === 'dimo' ? 'iconoir-smartphone-device' : 'iconoir-cash'}
                            style={{ fontSize: 14, lineHeight: 1.4 }}
                          />
                          <span style={{ display: 'block' }}>
                            <strong style={{ fontSize: 12.5, color: 'var(--fg)' }}>{m.label}</strong>
                            {m.note && <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.5, marginTop: 1 }}>{m.note}</span>}
                          </span>
                        </div>
                      ))}
                      <p style={{ fontSize: 11.5, color: 'var(--fg-subtle)', lineHeight: 1.5 }}>
                        <BuyerCopyText copyKey="checkout.CheckoutExperience.c343b18c" /></p>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ── Summary section ────────────────────────────────────────────────── */}
      <section style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 16 }}>
        <h2 style={{ fontSize: 'var(--t-base)', fontWeight: 800, marginBottom: 10 }}><BuyerCopyText copyKey="checkout.CheckoutExperience.c6e967ad" /></h2>
        <div style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
            <span style={{ color: 'var(--fg-muted)' }}>{items?.length ? <BuyerCopyText copyKey="checkout.CheckoutExperience.f0cc03dd" values={[items.length]} /> : quantity > 1 ? <BuyerCopyText copyKey="checkout.CheckoutExperience.d217bfe5" values={[quantity]} /> : <BuyerCopyText copyKey="checkout.CheckoutExperience.7bd49bef" />}</span>
            <strong>{formatCents(itemsCents, currency)}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
            <span style={{ color: 'var(--fg-muted)' }}><BuyerCopyText copyKey="checkout.CheckoutExperience.674b5195" /></span>
            <strong>{selectedDelivery?.label ?? <BuyerCopyText copyKey="checkout.CheckoutExperience.376cf3ff" />}</strong>
          </div>
          {needsShippingRate && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, gap: 12 }}>
              <span style={{ color: 'var(--fg-muted)' }}><BuyerCopyText copyKey="checkout.CheckoutExperience.c98c769a" /></span>
              <strong style={{ textAlign: 'right' }}>
                {selectedShippingRate ? `${selectedShippingRate.carrier.toUpperCase()} ${formatCents(selectedShippingRate.amountCents, selectedShippingRate.currency)}` : <BuyerCopyText copyKey="checkout.CheckoutExperience.8cf23a2c" />}
              </strong>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
            <span style={{ color: 'var(--fg-muted)' }}><BuyerCopyText copyKey="checkout.CheckoutExperience.ab0e974f" /></span>
            <strong>{selectedPayment?.label ?? <BuyerCopyText copyKey="checkout.CheckoutExperience.ef50e1d9" />}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
            <span style={{ color: 'var(--fg-muted)' }}><BuyerCopyText copyKey="checkout.CheckoutExperience.e2c77520" /></span>
            <strong>$0</strong>
          </div>

          {/* ── Personalization echo (AC 3.1 — final review step) ─────────── */}
          {(() => {
            const blocks: Array<{ title?: string; fields: PersonalizationField[] }> = []
            if (personalization?.fields?.length) blocks.push({ fields: personalization.fields })
            for (const it of items ?? []) {
              if (it.personalization?.fields?.length) blocks.push({ title: it.title, fields: it.personalization.fields })
            }
            if (!blocks.length) return null
            return (
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 2 }}>
                <p style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <i className="iconoir-edit-pencil" style={{ fontSize: 13, color: 'var(--accent)' }} />
                  <BuyerCopyText copyKey="checkout.CheckoutExperience.32e6e589" /></p>
                {blocks.map((b, bi) => (
                  <div key={bi} style={{ marginBottom: bi < blocks.length - 1 ? 6 : 0 }}>
                    {b.title && <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)' }}>{b.title}</p>}
                    {b.fields.map((f, i) => (
                      <PersonalizationEcho
                        key={i}
                        field={f}
                        valueStyle={{ fontSize: 12, color: 'var(--fg-muted)', wordBreak: 'break-word' }}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )
          })()}

          {/* ── Coupon code ─────────────────────────────────────────────── */}
          {couponsAllowed && (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 2 }}>
              {appliedCoupon ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 14, gap: 12 }}>
                  <span style={{ color: 'var(--fg-muted)' }}>
                    <BuyerCopyText copyKey="checkout.CheckoutExperience.0d2cfcfb" />{' '}<strong style={{ color: 'var(--fg)', fontFamily: 'monospace' }}>{appliedCoupon.code}</strong>
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <strong style={{ color: 'var(--success-ink)' }}>−{formatCents(couponDiscountCents, currency)}</strong>
                    <button type="button" onClick={removeCoupon} style={{ background: 'none', border: 'none', color: 'var(--fg-muted)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}>
                      <BuyerCopyText copyKey="checkout.CheckoutExperience.db971e8f" /></button>
                  </span>
                </div>
              ) : (
                <div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      value={couponInput}
                      onChange={e => { setCouponInput(e.target.value.toUpperCase()); if (couponError) setCouponError(null) }}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); applyCoupon() } }}
                      placeholder={copy('checkout.CheckoutExperience.aafeaa30')}
                      maxLength={24}
                      style={{ ...inputStyle, flex: 1, fontFamily: 'monospace', letterSpacing: '0.04em' }}
                    />
                    <button
                      type="button"
                      onClick={applyCoupon}
                      disabled={couponValidating || !couponInput.trim()}
                      style={{ padding: '0 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg)', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: couponValidating || !couponInput.trim() ? 0.5 : 1, whiteSpace: 'nowrap' }}
                    >
                      {couponValidating ? '…' : <BuyerCopyText copyKey="checkout.CheckoutExperience.d3ef0dd2" />}
                    </button>
                  </div>
                  {couponError && <p style={{ fontSize: 12, color: 'var(--danger-strong)', marginTop: 6 }}>{couponError}</p>}
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 2 }}>
            <span style={{ fontWeight: 800 }}><BuyerCopyText copyKey="checkout.CheckoutExperience.c6da623f" /></span>
            <strong>{formatCents(totalCents, currency)}</strong>
          </div>
        </div>

        {selectedPayment ? (
          <CheckoutPayButton
            provider={selectedPayment.id}
            listingId={listingId}
            variantId={variantId}
            personalization={personalization}
            items={items}
            sellerId={sellerId}
            amountCents={itemsCents}
            currency={currency}
            quantity={quantity}
            offerId={offerId}
            offerAmountCents={offerAmountCents}
            couponCode={appliedCoupon?.code}
            couponDiscountCents={couponDiscountCents}
            fulfillmentMethod={isCoordCheckout ? 'coord' : (selectedDelivery?.id ?? 'none')}
            pickupSpotId={selectedPickupSpotId ?? undefined}
            pickupAppointment={isPickupDelivery && pickupDate && pickupWindow ? { date: pickupDate, window: pickupWindow } : undefined}
            shippingAddress={selectedDelivery?.requires_address ? address : undefined}
            shippingQuote={isCoordCheckout ? undefined : (needsShippingRate ? selectedShippingQuote : undefined)}
            originDomain={originDomain}
            rental={rental}
            market={market}
            disabled={!canPay}
            onStarted={onStarted}
          />
        ) : (
          <p style={{ fontSize: 13, color: 'var(--fg-muted)' }}><BuyerCopyText copyKey="checkout.CheckoutExperience.182b86ba" /></p>
        )}
      </section>
    </>
  )
}

const inputStyle: CSSProperties = {
  width: '100%',
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'var(--bg)',
  color: 'var(--fg)',
  padding: '10px 12px',
  fontSize: 13,
}
