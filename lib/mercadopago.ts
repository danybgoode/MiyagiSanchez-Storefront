/**
 * MercadoPago client — lazy singleton, same pattern as lib/stripe.ts.
 * Never throws at module evaluation time; errors surface at request time.
 *
 * Architecture note: currently uses the platform's access token so all payments
 * collect to the platform's MP account. When Marketplace seller OAuth is added
 * (future), swap `getMpClient()` for a per-seller token stored in
 * marketplace_shops.metadata.settings.mercadopago.access_token
 */

import { MercadoPagoConfig, Preference, Payment, PreApproval, PreApprovalPlan } from 'mercadopago'
import { listingUrlFor } from './market-url'

// ── Client singleton ──────────────────────────────────────────────────────────

let _client: MercadoPagoConfig | null = null

export function getMpClient(): MercadoPagoConfig {
  if (!_client) {
    const token = process.env.MP_ACCESS_TOKEN
    if (!token) throw new Error('Missing MP_ACCESS_TOKEN environment variable')
    _client = new MercadoPagoConfig({ accessToken: token, options: { timeout: 5000 } })
  }
  return _client
}

// ── Create checkout preference ────────────────────────────────────────────────

export interface CreatePreferenceParams {
  title: string
  /** Stored as integer centavos (e.g. 150000 = MXN $1,500.00) */
  priceCents: number
  currency: string   // 'MXN', 'ARS', 'COP', etc.
  buyerEmail?: string
  listingId: string
  shopId: string
  listingType: string
  offerId?: string
  origin: string
  channel?: string   // federated commerce channel tag
  /** Preference lifetime; set for a reserved offer so an abandoned checkout frees it (lib/offer-reservation.ts). */
  expiresInMs?: number
}

export interface MpPreference {
  id: string
  /** Redirect here in production */
  initPoint: string
  /** Redirect here in sandbox / testing */
  sandboxInitPoint: string
}

export async function createMpPreference(p: CreatePreferenceParams): Promise<MpPreference> {
  const preference = new Preference(getMpClient())

  const result = await preference.create({
    body: {
      items: [{
        id: p.listingId,
        title: p.title.slice(0, 256), // MP enforces 256-char limit
        quantity: 1,
        // MP unit_price is in full monetary units (pesos), not centavos
        unit_price: p.priceCents / 100,
        currency_id: p.currency.toUpperCase(),
      }],
      ...(p.buyerEmail ? { payer: { email: p.buyerEmail } } : {}),
      // Passed back verbatim in the webhook — used to correlate with our DB
      external_reference: JSON.stringify({
        listing_id: p.listingId,
        shop_id: p.shopId,
        listing_type: p.listingType,
        offer_id: p.offerId ?? null,
        channel: p.channel ?? 'marketplace',
      }),
      notification_url: `${p.origin}/api/webhooks/mercadopago`,
      back_urls: {
        success: `${p.origin}/payment/success?source=mp`,
        failure: `${listingUrlFor(p.origin, p.listingId)}?payment=failed`,
        pending: `${p.origin}/payment/pending?source=mp`,
      },
      auto_return: 'approved',
      ...(p.expiresInMs ? { expires: true, expiration_date_to: new Date(Date.now() + p.expiresInMs).toISOString() } : {}),
      statement_descriptor: 'MIYAGI SANCHEZ',
    },
  })

  return {
    id: result.id!,
    initPoint: result.init_point!,
    sandboxInitPoint: result.sandbox_init_point!,
  }
}

// ── Fetch payment detail ──────────────────────────────────────────────────────

export async function getMpPayment(paymentId: string) {
  const payment = new Payment(getMpClient())
  return payment.get({ id: paymentId })
}

// ── Subscriptions (preapproval) ───────────────────────────────────────────────

export interface MpPreapprovalPlanParams {
  title: string
  priceCents: number
  currency: string
  /** 1 = every 1 frequencyType */
  frequency?: number
  frequencyType?: 'months' | 'days'
}

/**
 * Creates a reusable subscription plan template on MercadoPago.
 * Store the returned planId in listing metadata for idempotency.
 */
export async function createMpPreapprovalPlan(
  p: MpPreapprovalPlanParams,
): Promise<{ planId: string }> {
  const plan = new PreApprovalPlan(getMpClient())
  const result = await plan.create({
    body: {
      reason: p.title.slice(0, 200),
      auto_recurring: {
        frequency: p.frequency ?? 1,
        frequency_type: p.frequencyType ?? 'months',
        transaction_amount: p.priceCents / 100,
        currency_id: p.currency.toUpperCase(),
      },
    },
  })
  return { planId: result.id! }
}

export interface MpPreapprovalParams {
  planId: string
  title: string
  priceCents: number
  currency: string
  frequency?: number
  frequencyType?: 'months' | 'days'
  buyerEmail?: string
  listingId: string
  shopId: string
  tierId?: string
  origin: string
}

/**
 * Creates a buyer-specific subscription instance (preapproval).
 * Redirecting the buyer to initPoint triggers the authorization flow.
 */
export async function createMpPreapproval(
  p: MpPreapprovalParams,
): Promise<{ preapprovalId: string; initPoint: string }> {
  const preapproval = new PreApproval(getMpClient())
  const result = await preapproval.create({
    body: {
      preapproval_plan_id: p.planId,
      reason: p.title.slice(0, 200),
      payer_email: p.buyerEmail,
      auto_recurring: {
        frequency: p.frequency ?? 1,
        frequency_type: p.frequencyType ?? 'months',
        transaction_amount: p.priceCents / 100,
        currency_id: p.currency.toUpperCase(),
      },
      back_url: `${listingUrlFor(p.origin, p.listingId)}?payment=mp_sub`,
      external_reference: JSON.stringify({
        listing_id: p.listingId,
        shop_id: p.shopId,
        tier_id: p.tierId ?? null,
        type: 'subscription',
      }),
      status: 'pending',
    },
  })
  return { preapprovalId: result.id!, initPoint: result.init_point! }
}

/**
 * Fetches the current state of a preapproval (subscription) by ID.
 */
export async function getMpPreapproval(preapprovalId: string) {
  const preapproval = new PreApproval(getMpClient())
  return preapproval.get({ id: preapprovalId })
}
