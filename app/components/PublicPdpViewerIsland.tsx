'use client'

import { useAuth } from '@clerk/nextjs'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { BuyerCopyText, useBuyerFormatters } from '@/app/components/BuyerPresentationContext'
import AskSellerButton from '@/app/components/AskSellerButton'
import FavoriteButton from '@/app/components/FavoriteButton'
import MakeOfferButton from '@/app/components/MakeOfferButton'
import OfferCheckoutButton from '@/app/components/OfferCheckoutButton'
import BuyButton from '@/app/components/BuyButton'
import PersonalizationBuyBox from '@/app/components/PersonalizationBuyBox'
import ConfiguratorBuyBox from '@/app/(shell)/l/[id]/ConfiguratorBuyBox'
import EventBuyBox from '@/app/(shell)/l/[id]/EventBuyBox'
import RentalBooking from '@/app/(shell)/l/[id]/RentalBooking'
import SubscriptionSection, { type SubscriptionTier } from '@/app/(shell)/l/[id]/SubscriptionSection'
import { checkoutHopHref, signInHopHref } from '@/lib/checkout-hop'
import { agreedDealDisplay, type PdpViewerState } from '@/lib/pdp-viewer-state'
import type { PriceGrid } from '@/lib/price-grid'
import type { CustomFieldDef } from '@/lib/personalization'
import type { RatePeriod } from '@/lib/rental-pricing'
import type { CommerceReadiness } from '@/lib/commerce-readiness'

export type PublicPdpAction =
  | { kind: 'contact' }
  | { kind: 'print'; href: string }
  | { kind: 'schedule'; bookingUrl: string | null; label: string }
  | { kind: 'generic'; canBuy: boolean; canOffer: boolean; schedule?: { bookingUrl: string | null; label: string } }
  | { kind: 'configurator'; priceGrid: PriceGrid; currency: string; customFields: CustomFieldDef[] }
  | { kind: 'personalization'; defs: CustomFieldDef[]; priceLabel: string; buyNowLabel?: string; signInBuyLabel?: string }
  | { kind: 'event'; unitCents: number; currency: string; cap: number; buyLabelPrefix: string; signInLabel: string }
  | { kind: 'rental'; dailyRateCents: number; depositCents: number; period: RatePeriod; currency: string; bookingUrl: string | null; rentalPricingEnabled: boolean; sellerHasPaymentMethod: boolean }
  | { kind: 'subscription'; tiers: SubscriptionTier[]; shopName: string; hasStripe: boolean; hasBankTransfer: boolean; hasMp: boolean; redesign: boolean }
  | { kind: 'digital'; priceLabel: string; sellerHasStripe: boolean }

type Props = {
  listing: {
    id: string
    title: string
    priceCents: number | null
    priceLabel: string
    currency: string
    imageUrl: string | null
  }
  shopSlug: string
  marketBasePath: '/mx'
  customDomain: string | null
  action: PublicPdpAction
  commerceReadiness: CommerceReadiness
}

/**
 * D8's single, fixed action region. Static HTML contains only the reserved,
 * disabled state; ownership/buy/offer/favorite assertions appear after the one
 * authenticated endpoint read succeeds.
 */
export default function PublicPdpViewerIsland({
  listing,
  shopSlug,
  marketBasePath,
  customDomain,
  action,
  commerceReadiness,
}: Props) {
  const { isLoaded } = useAuth()
  const formatters = useBuyerFormatters()
  const requestKey = `${listing.id}:${shopSlug}`
  const started = useRef<string | null>(null)
  const [result, setResult] = useState<{ key: string; state: PdpViewerState } | null>(null)
  const [failedKey, setFailedKey] = useState<string | null>(null)

  useEffect(() => {
    if (!isLoaded || started.current === requestKey) return
    started.current = requestKey
    const controller = new AbortController()
    const query = new URLSearchParams({ listingId: listing.id, shopSlug })
    void fetch(`/api/public/pdp-viewer-state?${query.toString()}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`viewer state ${response.status}`)
        return response.json() as Promise<PdpViewerState>
      })
      .then((state) => setResult({ key: requestKey, state }))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setFailedKey(requestKey)
      })
    return () => controller.abort()
  }, [isLoaded, listing.id, requestKey, shopSlug])

  const state = result?.key === requestKey ? result.state : null
  const failed = failedKey === requestKey

  const frameStyle: React.CSSProperties = {
    height: 260,
    overflow: 'auto',
    padding: 16,
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-lg)',
    background: 'var(--bg-elevated)',
  }

  if (!state) {
    return (
      <section data-testid="pdp-viewer-state" data-state={failed ? 'disabled' : 'settling'} aria-busy={!failed} style={frameStyle}>
        <div className="h-10 rounded-lg bg-[var(--bg-sunk)] opacity-70" />
        <div className="h-10 rounded-lg bg-[var(--bg-sunk)] opacity-50 mt-2" />
        <p className="text-xs text-[var(--fg-muted)] mt-3">
          <BuyerCopyText copyKey={failed ? 'l.id.page.publicPdpUnavailable' : 'l.id.page.publicPdpSettling'} />
        </p>
      </section>
    )
  }

  if (state.ownsListing) {
    return (
      <section data-testid="pdp-viewer-state" data-state="owner" style={frameStyle}>
        <Link href={`/sell/edit/${listing.id}`} className="btn btn-dark btn-lg no-underline w-full justify-center">
          <BuyerCopyText copyKey="l.id.page.ba97b5b0" />
        </Link>
      </section>
    )
  }

  const deal = state.activeDeal
  // The agreed price, as the dynamic PDP shows it (see `agreedDealDisplay`).
  const agreed = agreedDealDisplay(deal, listing.priceCents)
  const checkoutHref = checkoutHopHref(`/checkout?listingId=${listing.id}&market=mx`, customDomain)
  const signInHref = signInHopHref(`/checkout?listingId=${listing.id}&market=mx`, customDomain)

  const schedule = action.kind === 'schedule'
    ? action
    : action.kind === 'generic'
      ? action.schedule
      : undefined
  const scheduleContent = schedule ? (
    schedule.bookingUrl ? (
      <a
        href={schedule.bookingUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-2 w-full font-semibold py-3 rounded-[var(--r-md)] text-sm no-underline transition-colors"
        style={{ background: 'var(--fg)', color: 'var(--fg-inverse)' }}
      >
        <i className="iconoir-calendar" style={{ fontSize: 16 }} />
        {schedule.label}
      </a>
    ) : (
      <AskSellerButton listingId={listing.id} isSignedIn={state.signedIn} label={schedule.label} marketBasePath={marketBasePath} />
    )
  ) : null

  const actionContent = action.kind === 'print' ? (
    <Link
      href={action.href}
      className="flex items-center justify-center gap-2 w-full font-semibold py-3 rounded-[var(--r-md)] text-sm no-underline transition-colors"
      style={{ background: 'var(--fg)', color: 'var(--fg-inverse)' }}
    >
      <i className="iconoir-journal" aria-hidden />
      <BuyerCopyText copyKey="l.id.page.4b20055a" />
    </Link>
  ) : action.kind === 'schedule' ? scheduleContent : action.kind === 'configurator' ? (
    <ConfiguratorBuyBox
      listingId={listing.id}
      priceGrid={action.priceGrid}
      isSignedIn={state.signedIn}
      customDomain={customDomain}
      currency={action.currency}
      customFields={action.customFields}
    />
  ) : action.kind === 'personalization' ? (
    <PersonalizationBuyBox
      listingId={listing.id}
      defs={action.defs}
      isSignedIn={state.signedIn}
      customDomain={customDomain}
      priceLabel={action.priceLabel}
      buyNowLabel={action.buyNowLabel}
      signInBuyLabel={action.signInBuyLabel}
    />
  ) : action.kind === 'event' ? (
    <EventBuyBox
      listingId={listing.id}
      unitCents={action.unitCents}
      currency={action.currency}
      cap={action.cap}
      isSignedIn={state.signedIn}
      customDomain={customDomain}
      buyLabelPrefix={action.buyLabelPrefix}
      signInLabel={action.signInLabel}
    />
  ) : action.kind === 'rental' ? (
    <RentalBooking
      listingId={listing.id}
      dailyRateCents={action.dailyRateCents}
      depositCents={action.depositCents}
      period={action.period}
      currency={action.currency}
      isSignedIn={state.signedIn}
      bookingUrl={action.bookingUrl}
      rentalPricingEnabled={action.rentalPricingEnabled}
      sellerHasPaymentMethod={action.sellerHasPaymentMethod}
      marketBasePath={marketBasePath}
    />
  ) : action.kind === 'subscription' ? (
    <SubscriptionSection
      listingId={listing.id}
      tiers={action.tiers}
      shopName={action.shopName}
      hasStripe={action.hasStripe}
      hasBankTransfer={action.hasBankTransfer}
      hasMp={action.hasMp}
      isSignedIn={state.signedIn}
      buyerDisplayName={state.buyerPrefill?.name}
      buyerUserEmail={state.buyerPrefill?.email}
      redesign={action.redesign}
    />
  ) : action.kind === 'digital' ? (
    <BuyButton
      listingId={listing.id}
      price={action.priceLabel}
      isDigital
      sellerHasStripe={action.sellerHasStripe}
      isSignedIn={state.signedIn}
      customDomain={customDomain}
    />
  ) : action.kind === 'generic' ? (
    <>
      {action.canBuy && (
        <Link
          href={state.signedIn ? checkoutHref : signInHref}
          className="flex items-center justify-center w-full font-semibold py-3 rounded-lg no-underline"
          style={{ background: 'var(--fg)', color: 'var(--fg-inverse)' }}
        >
          {state.signedIn ? <BuyerCopyText copyKey="listing.buyNowWithPrice" values={[listing.priceLabel]} /> : <BuyerCopyText copyKey="listing.signInToBuy" />}
        </Link>
      )}
      {scheduleContent}
      {action.canOffer && listing.priceCents !== null && listing.priceCents > 0 && (
        <MakeOfferButton
          listing={{
            id: listing.id,
            title: listing.title,
            price_cents: listing.priceCents,
            currency: listing.currency,
            imageUrl: listing.imageUrl,
          }}
          buyerInfo={state.buyerPrefill ?? undefined}
          isSignedIn={state.signedIn}
          skipActiveOfferRead
        />
      )}
    </>
  ) : null

  return (
    <section
      data-testid="pdp-viewer-state"
      data-state="ready"
      data-buyer-prefill={state.buyerPrefill ? 'available' : 'absent'}
      style={frameStyle}
    >
      <div className="flex justify-end mb-2">
        <FavoriteButton listingId={listing.id} initialFavorited={state.favorited} isSignedIn={state.signedIn} />
      </div>

      {deal?.status === 'accepted_unpaid' && agreed ? (
        <div className="flex flex-col gap-2">
          <div data-testid="agreed-deal" className="rounded-lg p-3 bg-[var(--success-soft)]">
            <p className="text-xs font-bold text-[var(--success)]"><BuyerCopyText copyKey="l.id.page.6252ff7c" /></p>
            <p className="text-2xl font-extrabold">{formatters.currency(agreed.dealCents, agreed.currency, { maximumFractionDigits: 0 })}</p>
            {agreed.listCents && (
              <p className="text-xs text-[var(--fg-muted)]">
                <BuyerCopyText copyKey="l.id.page.c5d76f70" />{' '}
                <span className="line-through">{formatters.currency(agreed.listCents, listing.currency, { maximumFractionDigits: 0 })}</span>
              </p>
            )}
          </div>
          {commerceReadiness.ready ? (
            <OfferCheckoutButton
              listingId={listing.id}
              offerId={deal.offerId}
              amountCents={agreed.dealCents}
              currency={deal.currency}
              isSignedIn={state.signedIn}
              customDomain={customDomain}
            />
          ) : (
            <div data-testid="commerce-readiness" data-reason={commerceReadiness.reason} className="text-xs text-center text-[var(--fg-muted)] px-2">
              <BuyerCopyText copyKey={commerceReadiness.reason === 'checkout_not_available' ? 'market.checkoutComingSoon' : 'l.id.page.e0984f2d'} />
            </div>
          )}
          {deal.conversationId && <Link href={`/messages/${deal.conversationId}`}><BuyerCopyText copyKey="l.id.page.fb1415fb" /></Link>}
        </div>
      ) : deal?.status === 'pending' || deal?.status === 'countered' ? (
        <div className="flex flex-col gap-2">
          <div className="rounded-lg p-3 bg-[var(--warning-soft)] text-sm font-semibold">
            {deal.status === 'pending' ? <BuyerCopyText copyKey="l.id.page.db5f23a5" /> : <BuyerCopyText copyKey="l.id.page.7ee28bbf" />}
          </div>
          {deal.conversationId && <Link href={`/messages/${deal.conversationId}`}><BuyerCopyText copyKey="l.id.page.fb1415fb" /></Link>}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {actionContent}
          <AskSellerButton listingId={listing.id} isSignedIn={state.signedIn} marketBasePath={marketBasePath} />
        </div>
      )}
    </section>
  )
}
