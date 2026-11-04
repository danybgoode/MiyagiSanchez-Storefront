/**
 * Stripe subscription helpers — Sprint 2 Subscriptions Phase A.
 *
 * Pattern: platform-side subscriptions with manual 97% transfer to seller.
 *   1. Create Product + Price on platform Stripe account.
 *   2. Checkout Session in subscription mode (platform account).
 *   3. On invoice.payment_succeeded: transfer (amount × 0.97) to connected account.
 *
 * Why not destination charges for subscriptions?
 *   Stripe's `subscription_data.transfer_data` is only available for
 *   Payment Links and requires specific capabilities. Platform-side
 *   subscriptions + manual transfers are simpler and work everywhere.
 */

import { stripe } from '@/lib/stripe'

export interface SubscriptionPlanInput {
  listingId: string
  shopId: string
  title: string
  description: string | null
  price_cents: number
  currency: string
  interval: 'month' | 'year'
}

/**
 * Creates a Stripe Product + Price on the platform account.
 * Called once when a seller publishes a subscription listing.
 */
export async function createSubscriptionPrice(
  plan: SubscriptionPlanInput,
): Promise<{ productId: string; priceId: string }> {
  const product = await stripe.products.create({
    name: plan.title,
    description: plan.description ?? undefined,
    metadata: { listing_id: plan.listingId, shop_id: plan.shopId },
  })

  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: plan.price_cents,
    currency: plan.currency.toLowerCase(),
    recurring: { interval: plan.interval },
    metadata: { listing_id: plan.listingId, shop_id: plan.shopId },
  })

  return { productId: product.id, priceId: price.id }
}

/**
 * Creates a Stripe Checkout Session in subscription mode.
 * Returns the checkout URL to redirect the buyer to.
 *
 * `promotionCodeId` (optional) applies a Stripe Promotion Code as a discount —
 * used by the custom-domain campaign coupon (`miyagisan`, 100% off the first
 * year). When a discount is applied the caller also passes
 * `paymentMethodCollection: 'if_required'` so a $0 first invoice collects NO
 * card (the free year is a real gift; the subscription lapses gracefully at
 * renewal if no card is added). The non-coupon path is unchanged (no discount,
 * card always collected).
 */
export async function createSubscriptionCheckout({
  priceId,
  successUrl,
  cancelUrl,
  metadata,
  buyerEmail,
  promotionCodeId,
  paymentMethodCollection,
}: {
  priceId: string
  successUrl: string
  cancelUrl: string
  metadata: Record<string, string>
  buyerEmail?: string
  promotionCodeId?: string
  paymentMethodCollection?: 'always' | 'if_required'
}): Promise<string> {
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: { metadata },
    customer_email: buyerEmail,
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata,
    ...(promotionCodeId ? { discounts: [{ promotion_code: promotionCodeId }] } : {}),
    ...(paymentMethodCollection ? { payment_method_collection: paymentMethodCollection } : {}),
  })
  return session.url!
}

/**
 * Creates a Stripe Checkout Session in ONE-TIME payment mode (`mode:'payment'`)
 * for a PLATFORM-owned SKU — the promoter-program one-time cadence (epic 08 · S2).
 * Pay-a-year-up-front with NO recurring mandate: a `mode:'payment'` session never
 * creates a Stripe Subscription or an upcoming invoice, so nothing auto-charges at
 * year end. The platform is the payee, so there is NO `transfer_data` and NO
 * application fee (unlike a seller-listing one-time charge).
 *
 * The price is passed inline as `price_data` (no Stripe Price object needed),
 * mirroring `app/api/stripe/checkout/route.ts`. An optional `promotionCodeId`
 * applies a real Stripe discount (the promoter's coupon). `metadata` is stamped
 * on the session so the webhook can route + activate the dated grant.
 */
export async function createOneTimeCheckout({
  amountCents,
  currency,
  productName,
  successUrl,
  cancelUrl,
  metadata,
  buyerEmail,
  promotionCodeId,
  installments,
}: {
  amountCents: number
  currency: string
  productName: string
  successUrl: string
  cancelUrl: string
  metadata: Record<string, string>
  buyerEmail?: string
  promotionCodeId?: string
  /** Offer card installments (meses sin intereses, Mexico). Stripe allows them on one-time payments only. */
  installments?: boolean
}): Promise<string> {
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: currency.toLowerCase(),
        unit_amount: amountCents,
        product_data: { name: productName },
      },
    }],
    payment_intent_data: { metadata },
    ...(installments ? { payment_method_options: { card: { installments: { enabled: true } } } } : {}),
    customer_email: buyerEmail,
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata,
    ...(promotionCodeId ? { discounts: [{ promotion_code: promotionCodeId }] } : {}),
  })
  return session.url!
}

/**
 * Transfers the seller's 97% share to their connected Stripe account.
 * Called on invoice.payment_succeeded — non-fatal, logs on failure.
 */
export async function transferToSeller({
  amountCents,
  currency,
  connectedAccountId,
  sourceTransaction,
  metadata,
}: {
  amountCents: number
  currency: string
  connectedAccountId: string
  sourceTransaction: string        // charge ID from invoice
  metadata: Record<string, string>
}): Promise<void> {
  const sellerAmount = Math.floor(amountCents * 0.97) // 3% platform fee
  if (sellerAmount <= 0) return

  try {
    await stripe.transfers.create({
      amount: sellerAmount,
      currency: currency.toLowerCase(),
      destination: connectedAccountId,
      source_transaction: sourceTransaction,
      metadata,
    })
  } catch (e) {
    console.error('[stripe-subscriptions] transfer failed:', e)
    // Non-fatal — payout can be retried manually from Stripe dashboard
  }
}

/**
 * Cancels a Stripe subscription at period end (graceful cancel).
 */
export async function cancelSubscriptionAtPeriodEnd(
  stripeSubscriptionId: string,
): Promise<void> {
  await stripe.subscriptions.update(stripeSubscriptionId, {
    cancel_at_period_end: true,
  })
}

/**
 * Immediately cancels a Stripe subscription.
 */
export async function cancelSubscriptionImmediately(
  stripeSubscriptionId: string,
): Promise<void> {
  await stripe.subscriptions.cancel(stripeSubscriptionId)
}

/**
 * Creates a Stripe Customer Portal session so the buyer can manage
 * their payment method, view invoices, and cancel.
 * Returns the portal URL to redirect the buyer to.
 */
export async function createBillingPortalSession(
  customerId: string,
  returnUrl: string,
): Promise<string> {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  })
  return session.url
}
