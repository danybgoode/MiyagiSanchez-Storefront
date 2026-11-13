import { getLanguagePreference } from '@/lib/site-language-server'
import { BuyerCopyText, BuyerPresentationProvider } from '@/app/components/BuyerPresentationContext'
/**
 * /payment/success
 *
 * Handles two flows:
 *   - New Medusa flow:  ?cart_id=cart_xxx  (from start-checkout success_url)
 *     Also supports MP extra params: &payment_id=xxx&status=approved
 *   - Legacy Stripe flow: ?session_id=cs_xxx (backwards compat)
 */

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import Link from 'next/link'
import { stripe } from '@/lib/stripe'
import { db } from '@/lib/supabase'
import { isVerifiedCustomDomain } from '@/lib/custom-domain'
import { browseUrlFor, listingUrlFor, shopUrlFor } from '@/lib/market-url'
import { SITE_ORIGIN } from '@/lib/market-seo'
import { formatPresentationCurrency, formatPresentationDate, resolveMarketPresentation, type MarketPresentation } from '@/lib/market-presentation'
import { isMarketCode } from '@/lib/markets'
import { getDictionary } from '@/lib/dictionary'

export const metadata = { title: { absolute: 'Pago completado — Miyagi Sánchez' } }

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const MEDUSA_PUB_KEY = process.env.MEDUSA_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

async function completeMedusaCart(cartId: string): Promise<{ type?: string; order?: Record<string, unknown> } | null> {
  try {
    const res = await fetch(`${MEDUSA_BASE}/store/carts/${cartId}/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-publishable-api-key': MEDUSA_PUB_KEY,
      },
      cache: 'no-store',
    })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

async function authorizeMpPayment(cartId: string, mpPaymentId: string): Promise<void> {
  try {
    await fetch(`${MEDUSA_BASE}/store/carts/${cartId}/mp-authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-publishable-api-key': MEDUSA_PUB_KEY,
      },
      body: JSON.stringify({ mp_payment_id: mpPaymentId }),
      cache: 'no-store',
    })
  } catch {
    // non-fatal — webhook may have already done this
  }
}

/** Seller/shop name for the post-purchase summary (channel-agnostic listings endpoint). */
async function getListingSeller(productId: string): Promise<{ name: string | null; marketCode: string | null }> {
  try {
    const res = await fetch(`${MEDUSA_BASE}/store/listings/${productId}`, {
      headers: { 'x-publishable-api-key': MEDUSA_PUB_KEY },
      cache: 'no-store',
    })
    if (!res.ok) return { name: null, marketCode: null }
    const { listing } = await res.json()
    const seller = listing?.seller ?? listing?.shop
    return { name: seller?.name ?? null, marketCode: seller?.market_code ?? null }
  } catch {
    return { name: null, marketCode: null }
  }
}

function presentationFor(value: unknown, language: string | null): MarketPresentation {
  return resolveMarketPresentation(isMarketCode(value) ? value : 'mx', language)
}

function formatCents(presentation: MarketPresentation, cents: unknown, currency: unknown): string | null {
  const amount = Math.round(Number(cents ?? 0))
  if (!Number.isFinite(amount) || amount <= 0) return null
  return formatPresentationCurrency(presentation, amount, String(currency ?? presentation.currency), { maximumFractionDigits: 0 })
}

export default async function PaymentSuccessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const requestHeaders = await headers()
  const language = await getLanguagePreference()
  const channel = requestHeaders.get('x-miyagi-channel')
  const onCustomDomain = channel === 'custom'
  const onTenantChannel = channel === 'custom' || channel === 'subdomain'
  const channelDomain = requestHeaders.get('x-miyagi-domain')
  const marketOrigin = onTenantChannel && channelDomain
    ? `https://${channelDomain.split(':')[0]}`
    : SITE_ORIGIN

  // ── New Medusa flow ──────────────────────────────────────────────────────
  if (params.cart_id) {
    const cartId = params.cart_id

    // MP appends payment_id + status to the success URL
    const mpPaymentId = params.payment_id
    const mpStatus = params.status

    // If MP payment_id is present and approved, authorize the session first
    if (mpPaymentId && mpStatus === 'approved') {
      await authorizeMpPayment(cartId, mpPaymentId)
    }

    // Complete the cart → creates Medusa order (idempotent if already done by webhook)
    const result = await completeMedusaCart(cartId)
    const order = result?.order as Record<string, unknown> | undefined

    // Async-success recovery (S3.3): completion can still be settling (webhook race)
    // or have failed. Never show a false "success" with a null order — render a
    // recovery state with a retry (re-runs this idempotent completion) instead.
    if (!order) {
      return <PaymentPendingRecovery cartId={cartId} mpPaymentId={mpPaymentId} mpStatus={mpStatus} />
    }

    // Own-channel return: if this purchase began on a tenant's custom domain, send
    // the buyer back to that domain's success page so the funnel ends on their brand.
    // Guards: redirect ONLY to a VERIFIED tenant domain (never a value forged into
    // order metadata → no open redirect), and ONLY from outside that custom domain —
    // the onCustomDomain check stops a loop once we're already there. completeMedusaCart
    // is idempotent, so re-running it on the domain just returns the same order.
    const orderMeta = (order?.metadata ?? {}) as Record<string, unknown>
    const originDomain = typeof orderMeta.origin_domain === 'string' ? orderMeta.origin_domain : null
    if (originDomain && orderMeta.channel === 'custom_domain') {
      if (!onCustomDomain && (await isVerifiedCustomDomain(originDomain))) {
        const qs = new URLSearchParams({ cart_id: cartId })
        if (mpPaymentId) qs.set('payment_id', mpPaymentId)
        if (mpStatus) qs.set('status', mpStatus)
        redirect(`https://${originDomain}/payment/success?${qs.toString()}`)
      }
    }

    const supportMeta = (orderMeta.support ?? null) as Record<string, unknown> | null
    if (supportMeta?.kind === 'support') {
      const presentation = presentationFor(supportMeta.market_code ?? orderMeta.market_code, language)
      const buyerCopy = (await getDictionary(presentation.language)).buyerCopy
      return <BuyerPresentationProvider presentation={presentation} copy={buyerCopy}><SupportSuccessUI
        cartId={cartId}
        orderId={(order?.id as string | undefined) ?? null}
        amountPaid={formatCents(presentation, supportMeta.amount_cents, supportMeta.currency)}
        amountCents={Math.round(Number(supportMeta.amount_cents ?? 0))}
        currency={String(supportMeta.currency ?? 'MXN').toUpperCase()}
        sellerSlug={(supportMeta.seller_slug as string | undefined) ?? null}
        provider={mpPaymentId ? 'mercadopago' : 'stripe'}
        marketOrigin={marketOrigin}
      /></BuyerPresentationProvider>
    }

    const productId = (order?.items as Array<Record<string, unknown>> | undefined)?.[0]?.product_id as string | undefined
    const itemName = ((order?.items as Array<Record<string, unknown>> | undefined)?.[0]?.title as string | undefined) ?? null
    const seller = productId ? await getListingSeller(productId) : { name: null, marketCode: null }
    const presentation = presentationFor(orderMeta.market_code ?? seller.marketCode, language)
    const buyerCopy = (await getDictionary(presentation.language)).buyerCopy
    const amountTotal = order?.total as number | undefined
    const currency = order?.currency_code as string ?? 'MXN'
    const amountPaid = formatCents(presentation, amountTotal, currency)

    // ── Print-ad placement? Route to the print management surface ──────────
    // (a placement is not a shippable order; it lives in /account/print-ads)
    const { data: printSub } = await db
      .from('print_ad_submissions').select('id').eq('cart_id', cartId).maybeSingle()
    if (printSub) return <BuyerPresentationProvider presentation={presentation} copy={buyerCopy}><PrintSuccessUI amountPaid={amountPaid} /></BuyerPresentationProvider>

    // Human-friendly order number (Medusa display_id) + seller name for the summary.
    const orderNumber = order?.display_id != null ? `#${order.display_id}` : null
    return <BuyerPresentationProvider presentation={presentation} copy={buyerCopy}><SuccessUI
      buyerName={null}
      amountPaid={amountPaid}
      itemName={itemName}
      orderNumber={orderNumber}
      sellerName={seller.name}
      listingId={productId ?? null}
      isDigital={false}
      provider={mpPaymentId ? 'mercadopago' : 'stripe'}
      marketOrigin={marketOrigin}
    /></BuyerPresentationProvider>
  }

  // ── Legacy Stripe flow ───────────────────────────────────────────────────
  const { session_id } = params
  if (!session_id) redirect('/')

  let session: Awaited<ReturnType<typeof stripe.checkout.sessions.retrieve>> | null = null
  try {
    session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['line_items'],
    })
  } catch {
    redirect('/')
  }

  const listingId = session!.metadata?.listing_id
  const listingType = session!.metadata?.listing_type
  const legacySeller = listingId ? await getListingSeller(listingId) : { name: null, marketCode: null }
  const presentation = presentationFor(session!.metadata?.market_code ?? legacySeller.marketCode, language)
  const buyerCopy = (await getDictionary(presentation.language)).buyerCopy

  // Fetch order for digital download URL (legacy Supabase orders)
  const { data: order } = listingId ? await db
    .from('marketplace_orders')
    .select('id, status, digital_download_url, digital_download_expires_at')
    .eq('stripe_session_id', session_id)
    .maybeSingle() : { data: null }

  const buyerName = session!.customer_details?.name?.split(' ')[0] ?? null
  const amountPaid = formatCents(presentation, session!.amount_total, session!.currency)

  const itemName = session!.line_items?.data?.[0]?.description
    ?? session!.line_items?.data?.[0]?.price?.nickname
    ?? null

  return (
    <BuyerPresentationProvider presentation={presentation} copy={buyerCopy}>
    <div className="min-h-[70vh] flex items-center justify-center px-4 py-16">
      <div className="max-w-md w-full text-center">
        <CheckIcon />
        <h1 className="text-2xl font-bold mb-2">
          {buyerName ? <BuyerCopyText copyKey="payment.success.page.8343240b" values={[buyerName]} /> : <BuyerCopyText copyKey="payment.success.page.10a06ee0" />}
        </h1>
        {amountPaid && (
          <p className="text-[var(--color-muted)] mb-6">
            <BuyerCopyText copyKey="payment.success.page.fc2b2d84" />{' '}<strong className="text-[var(--color-foreground)]">{amountPaid}</strong> <BuyerCopyText copyKey="payment.success.page.2c829972" />{' '}{itemName}.
          </p>
        )}

        {listingType === 'digital' && (
          <div className="border border-blue-200 bg-blue-50 rounded-[var(--r-md)] p-5 mb-6 text-left">
            <div className="flex items-center gap-2 mb-2">
              <i className="iconoir-download text-xl" aria-hidden />
              <span className="font-semibold text-blue-800"><BuyerCopyText copyKey="payment.success.page.bd7c6765" /></span>
            </div>
            {order?.digital_download_url ? (
              <>
                <p className="text-sm text-blue-700 mb-3"><BuyerCopyText copyKey="payment.success.page.36194349" /></p>
                <a href={order.digital_download_url}
                  className="flex items-center justify-center gap-2 w-full bg-blue-600 text-white py-2.5 rounded-[var(--r-md)] font-semibold text-sm no-underline hover:bg-blue-700 transition-colors">
                  <i className="iconoir-download" aria-hidden /> <BuyerCopyText copyKey="payment.success.page.31b67fea" /></a>
                {order.digital_download_expires_at && (
                  <p className="text-xs text-blue-500 mt-2 text-center">
                    <BuyerCopyText copyKey="payment.success.page.63b04269" />{' '}{formatPresentationDate(presentation, order.digital_download_expires_at as string, { dateStyle: 'medium', timeStyle: 'short' })}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-blue-700">
                <BuyerCopyText copyKey="payment.success.page.b1340a7f" /></p>
            )}
          </div>
        )}

        {listingType !== 'digital' && (
          <div className="border border-[var(--color-border)] rounded-[var(--r-md)] p-4 mb-6 text-sm text-left">
            <p className="text-[var(--color-muted)]">
              <BuyerCopyText copyKey="payment.success.page.36a9055f" /></p>
          </div>
        )}

        <div className="flex flex-col gap-3">
          {listingId && (
            <Link href={listingUrlFor(marketOrigin, listingId)}
              className="border border-[var(--color-border)] px-5 py-2.5 rounded-[var(--r-md)] text-sm font-medium no-underline hover:bg-[var(--color-surface-alt)] transition-colors">
              <BuyerCopyText copyKey="payment.success.page.d792b667" /></Link>
          )}
          <Link href={browseUrlFor(marketOrigin)}
            className="text-sm text-[var(--color-muted)] no-underline hover:text-[var(--color-foreground)]">
            <BuyerCopyText copyKey="payment.success.page.eddd7461" /></Link>
        </div>

        <p className="text-xs text-[var(--color-muted)] mt-8">
          <i className="iconoir-check" aria-hidden /> <BuyerCopyText copyKey="payment.success.page.6796e062" />{' '}<i className="iconoir-check" aria-hidden /> <BuyerCopyText copyKey="payment.success.page.b73f5c69" /></p>
      </div>
    </div>
    </BuyerPresentationProvider>
  )
}

function SupportSuccessBridge({
  cartId,
  orderId,
  amountCents,
  currency,
}: {
  cartId: string
  orderId: string | null
  amountCents: number
  currency: string
}) {
  const payload = JSON.stringify({
    type: 'miyagi:support:success',
    cart_id: cartId,
    order_id: orderId,
    amount_cents: amountCents,
    currency,
  }).replace(/</g, '\\u003c')

  return (
    <script
      dangerouslySetInnerHTML={{
        __html: `
          (function () {
            var payload = ${payload};
            try {
              if (window.opener && !window.opener.closed) window.opener.postMessage(payload, '*');
              if (window.parent && window.parent !== window) window.parent.postMessage(payload, '*');
            } catch (e) {}
          })();
        `,
      }}
    />
  )
}

function SupportSuccessUI({
  cartId,
  orderId,
  amountPaid,
  amountCents,
  currency,
  sellerSlug,
  provider,
  marketOrigin,
}: {
  cartId: string
  orderId: string | null
  amountPaid: string | null
  amountCents: number
  currency: string
  sellerSlug: string | null
  provider: 'stripe' | 'mercadopago'
  marketOrigin: string
}) {
  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4 py-16">
      <SupportSuccessBridge cartId={cartId} orderId={orderId} amountCents={amountCents} currency={currency} />
      <div className="max-w-md w-full text-center">
        <CheckIcon />
        <h1 className="text-2xl font-bold mb-2"><BuyerCopyText copyKey="payment.success.page.4ab5d378" /></h1>
        <p className="text-[var(--color-muted)] mb-6">
          {amountPaid ? <><BuyerCopyText copyKey="payment.success.page.d436a8bb" />{' '}<strong className="text-[var(--color-foreground)]">{amountPaid}</strong> <BuyerCopyText copyKey="payment.success.page.f5e6da86" /></> : <BuyerCopyText copyKey="payment.success.page.edbdb02f" />}
        </p>

        <div className="border border-[var(--color-border)] rounded-[var(--r-md)] p-4 mb-6 text-sm text-left">
          <div className="flex justify-between gap-3 py-1">
            <span className="text-[var(--color-muted)]"><BuyerCopyText copyKey="payment.success.page.1dc0583f" /></span>
            <span className="font-medium text-right"><BuyerCopyText copyKey="payment.success.page.1bf16dba" /></span>
          </div>
          {amountPaid && (
            <div className="flex justify-between gap-3 py-1 mt-1 pt-2 border-t border-[var(--color-border)]">
              <span className="text-[var(--color-muted)]"><BuyerCopyText copyKey="payment.success.page.7bce59f7" /></span>
              <span className="font-bold text-right">{amountPaid}</span>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3">
          {sellerSlug && (
            <Link href={shopUrlFor(marketOrigin, sellerSlug)}
              className="border border-[var(--color-border)] px-5 py-2.5 rounded-[var(--r-md)] text-sm font-medium no-underline hover:bg-[var(--color-surface-alt)] transition-colors">
              <BuyerCopyText copyKey="payment.success.page.a9f5de98" /></Link>
          )}
          <Link href="/"
            className="text-sm text-[var(--color-muted)] no-underline hover:text-[var(--color-foreground)]">
            <BuyerCopyText copyKey="payment.success.page.dd6c672d" /></Link>
        </div>

        <p className="text-xs text-[var(--color-muted)] mt-8">
          {provider === 'mercadopago' ? <BuyerCopyText copyKey="payment.success.page.d019aee8" /> : <BuyerCopyText copyKey="payment.success.page.8233441b" />}
        </p>
      </div>
    </div>
  )
}

// ── Print-ad placement success — routes to /account/print-ads ────────────────

function PrintSuccessUI({ amountPaid }: { amountPaid: string | null }) {
  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4 py-16">
      <div className="max-w-md w-full text-center">
        <div className="text-5xl mb-4"><i className="iconoir-journal" aria-hidden /></div>
        <h1 className="text-2xl font-bold mb-2"><BuyerCopyText copyKey="payment.success.page.57cfb669" /></h1>
        <p className="text-[var(--color-muted)] mb-6">
          {amountPaid ? <><BuyerCopyText copyKey="payment.success.page.fc2b2d84" />{' '}<strong className="text-[var(--color-foreground)]">{amountPaid}</strong>. </> : null}
          <BuyerCopyText copyKey="payment.success.page.35722f4b" /></p>
        <Link
          href="/account/print-ads"
          className="inline-block bg-[var(--color-accent)] text-white px-6 py-3 rounded-[var(--r-md)] font-semibold no-underline hover:bg-[var(--color-accent-hover)] transition-colors"
        >
          <BuyerCopyText copyKey="payment.success.page.636d6ac0" /></Link>
      </div>
    </div>
  )
}

// ── Shared UI for new Medusa flow ─────────────────────────────────────────────

function CheckIcon() {
  return (
    <div className="w-16 h-16 rounded-[var(--r-pill)] bg-green-100 flex items-center justify-center mx-auto mb-5">
      <svg xmlns="http://www.w3.org/2000/svg" className="w-8 h-8 text-green-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </div>
  )
}

// S3.3 — shown when cart completion hasn't produced an order yet (webhook race or
// a failed/settling payment). A recovery state, never a false success. "Revisar de
// nuevo" re-navigates to this same URL, re-running the idempotent completion;
// prefetch is disabled so a hover can't silently re-run it.
function PaymentPendingRecovery({
  cartId,
  mpPaymentId,
  mpStatus,
}: {
  cartId: string
  mpPaymentId?: string
  mpStatus?: string
}) {
  const qs = new URLSearchParams({ cart_id: cartId })
  if (mpPaymentId) qs.set('payment_id', mpPaymentId)
  if (mpStatus) qs.set('status', mpStatus)
  const retryHref = `/payment/success?${qs.toString()}`
  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4 py-16">
      <div className="max-w-md w-full text-center">
        <div className="w-16 h-16 rounded-[var(--r-pill)] bg-amber-100 flex items-center justify-center mx-auto mb-6">
          <i className="iconoir-hourglass text-3xl" aria-hidden />
        </div>
        <h1 className="text-2xl font-bold mb-1"><BuyerCopyText copyKey="payment.success.page.533331e0" /></h1>
        <p className="text-sm text-[var(--color-muted)] mb-6">
          <BuyerCopyText copyKey="payment.success.page.2de144c5" />{' '}<strong><BuyerCopyText copyKey="payment.success.page.65d88d5b" /></strong> <BuyerCopyText copyKey="payment.success.page.6dfefb2a" /></p>
        <div className="flex flex-col gap-2">
          <Link href={retryHref} prefetch={false}
            className="w-full bg-[var(--color-accent)] text-white py-3 rounded-[var(--r-md)] text-sm font-semibold no-underline">
            <BuyerCopyText copyKey="payment.success.page.6a7b440b" /></Link>
          <Link href="/account/orders"
            className="w-full border border-[var(--color-border)] py-3 rounded-[var(--r-md)] text-sm font-semibold no-underline text-[var(--color-text)]">
            <BuyerCopyText copyKey="payment.success.page.110acfcd" /></Link>
        </div>
        <p className="text-xs text-[var(--color-muted)] mt-4">
          <BuyerCopyText copyKey="payment.success.page.b1c92855" /></p>
      </div>
    </div>
  )
}

function SuccessUI({
  buyerName,
  amountPaid,
  itemName,
  orderNumber,
  sellerName,
  listingId,
  provider,
  marketOrigin,
}: {
  buyerName: string | null
  amountPaid: string | null
  itemName: string | null
  orderNumber: string | null
  sellerName: string | null
  listingId: string | null
  isDigital: boolean
  provider: 'stripe' | 'mercadopago'
  marketOrigin: string
}) {
  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4 py-16">
      <div className="max-w-md w-full text-center">
        <CheckIcon />
        <h1 className="text-2xl font-bold mb-1">
          {buyerName ? <BuyerCopyText copyKey="payment.success.page.8343240b" values={[buyerName]} /> : <BuyerCopyText copyKey="payment.success.page.10a06ee0" />}
        </h1>
        {orderNumber && (
          <p className="text-sm text-[var(--color-muted)] mb-6"><BuyerCopyText copyKey="payment.success.page.0f704c90" />{' '}{orderNumber}</p>
        )}

        {/* Order summary */}
        <div className="border border-[var(--color-border)] rounded-[var(--r-md)] p-4 mb-4 text-sm text-left">
          <div className="flex justify-between gap-3 py-1">
            <span className="text-[var(--color-muted)]"><BuyerCopyText copyKey="payment.success.page.39534106" /></span>
            <span className="font-medium text-right">{itemName ?? <BuyerCopyText copyKey="payment.purchaseFallback" />}</span>
          </div>
          {sellerName && (
            <div className="flex justify-between gap-3 py-1">
              <span className="text-[var(--color-muted)]"><BuyerCopyText copyKey="payment.success.page.0e698b7e" /></span>
              <span className="font-medium text-right">{sellerName}</span>
            </div>
          )}
          {amountPaid && (
            <div className="flex justify-between gap-3 py-1 mt-1 pt-2 border-t border-[var(--color-border)]">
              <span className="text-[var(--color-muted)]"><BuyerCopyText copyKey="payment.success.page.7bce59f7" /></span>
              <span className="font-bold text-right">{amountPaid}</span>
            </div>
          )}
        </div>

        <div className="border border-[var(--color-border)] rounded-[var(--r-md)] p-4 mb-6 text-sm text-left">
          <p className="text-[var(--color-muted)]">
            <BuyerCopyText copyKey="payment.success.page.36a9055f" /></p>
        </div>

        <div className="flex flex-col gap-3">
          <Link href="/account/orders"
            className="bg-[var(--color-foreground)] text-[var(--color-background)] px-5 py-2.5 rounded-[var(--r-md)] text-sm font-semibold no-underline hover:opacity-90 transition-opacity">
            <BuyerCopyText copyKey="payment.success.page.110acfcd" /></Link>
          {listingId && (
            <Link href={listingUrlFor(marketOrigin, listingId)}
              className="border border-[var(--color-border)] px-5 py-2.5 rounded-[var(--r-md)] text-sm font-medium no-underline hover:bg-[var(--color-surface-alt)] transition-colors">
              <BuyerCopyText copyKey="payment.success.page.d792b667" /></Link>
          )}
          <Link href={browseUrlFor(marketOrigin)}
            className="text-sm text-[var(--color-muted)] no-underline hover:text-[var(--color-foreground)]">
            <BuyerCopyText copyKey="payment.success.page.eddd7461" /></Link>
        </div>

        <p className="text-xs text-[var(--color-muted)] mt-8">
          {provider === 'mercadopago'
            ? <><i className="iconoir-check" aria-hidden /> <BuyerCopyText copyKey="payment.success.page.31cf0958" />{' '}<i className="iconoir-check" aria-hidden /> <BuyerCopyText copyKey="payment.success.page.b73f5c69" /></>
            : <><i className="iconoir-check" aria-hidden /> <BuyerCopyText copyKey="payment.success.page.6796e062" />{' '}<i className="iconoir-check" aria-hidden /> <BuyerCopyText copyKey="payment.success.page.b73f5c69" /></>}
        </p>
      </div>
    </div>
  )
}
