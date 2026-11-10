/**
 * lib/negocio-webhook.ts — what a paid plan checkout, and every later Stripe event about it, does (epic 08 ·
 * plans-gratis-negocio S1.3, README D6; takes the plan as a parameter since plan-tienda-three-free-months S2.1/S2.2,
 * README D6/D19).
 *
 * Kept out of `app/api/webhooks/stripe/route.ts` (already ~1,600 lines): the route only dispatches here by
 * `metadata.kind` (`paidPlanOfKind`, lib/plan-kind.ts). Plan Negocio and Plan Tienda run the SAME handlers; what
 * differs per plan is named where it differs.
 *
 *   - Subscription complete (monthly) → record the Medusa Commerce subscription against that plan, keyed by the shop
 *     (a plan is per shop). `/store/subscriptions` dedupes on the Stripe subscription id, so a replay is safe.
 *   - One-time complete (a yearly payment; for Negocio also a promoter package by card) → add the paid months to the
 *     shop's grant through `applyPlanPayment` (lib/plan-payment.ts): compare-and-swap on every key the decision read,
 *     retried on a lost race, and a replayed webhook adds nothing.
 *   - Status changes, cancellations, renewals and failed payments → the subscription's CURRENT status, retrieved from
 *     Stripe, goes to that plan's Backend route (`syncPlanSubscriptionStatus`, lib/plan-subscription-sync.ts).
 *   - Plan Negocio activating (monthly or yearly) sets a live monthly Plan Tienda to cancel at its period end (D19).
 *
 * The seller PAID in every one of these paths, so a write that does not land alerts on Telegram. Every handler here
 * returns a `PlanWebhookOutcome`: `retry` when a later delivery can fix the failure (a grant write that errored or
 * lost its races, an activation or status PATCH that failed or matched nothing), and the route then answers Stripe
 * 500 so Stripe delivers the event again (PR 485 review). That is safe because every step that can fail runs FIRST
 * and is idempotent: the grant is replay-checked by payment id, `/store/subscriptions` dedupes on the Stripe
 * subscription id, the status PATCH is a conditional write of the freshly retrieved status. The steps that are not
 * safe to repeat (the ✅ alert, D19, the D10 hook) run only AFTER the money step landed, and only on the delivery
 * that wrote it. The promoter shares and the attribution run on EVERY delivery whose grant is counted, a replay
 * included, because each is idempotent by its own key (lib/plan-one-time-steps.ts): a share that failed after the
 * grant landed answers `retry`, and the redelivery records only what is missing (plan-tienda S4, the PR 485 gap).
 * `final` is a failure no retry can fix (an unpaid session, missing metadata): alert, answer 200.
 *
 * server-only.
 */
import 'server-only'
import type Stripe from 'stripe'
import { stripe } from '@/lib/stripe'
import { db } from '@/lib/supabase'
import { tg } from '@/lib/telegram'
import { getNegocioSubscription, setNegocioSubscriptionStatus } from '@/lib/negocio-subscription'
import { getTiendaSubscription, setTiendaSubscriptionStatus } from '@/lib/tienda-subscription'
import { GRANT_WRITE_RPC } from '@/lib/plan'
import { sessionMonths, subscriptionPeriod } from '@/lib/negocio-checkout-rules'
import { PLAN_CHECKOUT_KINDS, PLAN_DISPLAY_NAMES, paidPlanOfKind, type PaidPlan } from '@/lib/plan-kind'
import { applyPlanPayment, type PlanPaymentDeps, type PlanPaymentInput, type PlanPaymentOutcome } from '@/lib/plan-payment'
import {
  cancelTiendaOnNegocio,
  syncPlanSubscriptionStatus,
  syncWebhookOutcome,
  type PlanStatusSyncDeps,
  type PlanWebhookOutcome,
  type RetrievedPlanSubscription,
} from '@/lib/plan-subscription-sync'
import { markAttributionPaid, isPromoterSku } from '@/lib/promoter'
import { releaseCustomDomainForShop } from '@/lib/domain-lapse-server'
import { accrueTiendaPaymentShare, recordNegocioPaymentShares } from '@/lib/promoter-renewal-server'
import { runOneTimeSteps } from '@/lib/plan-one-time-steps'
import { paymentInstant } from '@/lib/promoter-packages'
import { restorePlanPausedShop } from '@/lib/plan-restore-server'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const MEDUSA_PUB_KEY = process.env.MEDUSA_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

const SUBSCRIPTION_READS = { negocio: getNegocioSubscription, tienda: getTiendaSubscription } as const
/** Each plan's status goes to ITS Backend route, never the other's (lib/plan-subscription-sync.ts, rule 3). */
const STATUS_PATCHES = { negocio: setNegocioSubscriptionStatus, tienda: setTiendaSubscriptionStatus } as const

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * D10 — a payment brings a shop paused for lack of a plan back (plan-tienda S3.4).
 *
 * Called after a plan payment or subscription activation has been RECORDED (a grant written, or the Medusa
 * subscription created or back to live), for both plans. When the shop holds `metadata.plan_pause`, the seller is set
 * `active` (reason `plan_paid`) through `POST /internal/sellers/:id/status` — the Backend relinks the catalog from its
 * ledger — and the claim is cleared afterwards (`lib/plan-restore.ts`). No `plan_pause`, no restore: an admin pause is
 * never lifted here. A replay finds no claim and restores nothing twice. It never throws into the payment path that
 * called it (the payment already landed); a failed restore alerts on Telegram for hand repair.
 */
async function afterPlanPaid(input: { plan: PaidPlan; shopId: string; paymentRef: string }): Promise<void> {
  const outcome = await restorePlanPausedShop(input.shopId)
  if (outcome === 'restored' || outcome === 'restored_partly') {
    tg.alert(`✅ Tienda reactivada tras pagar ${PLAN_DISPLAY_NAMES[input.plan]}\nShop: ${input.shopId}\nPago: ${input.paymentRef}`)
  }
}

/** D19: Plan Negocio is now active on this shop; a live monthly Plan Tienda is set to end with its paid period. */
async function cancelTiendaUnderNegocio(shopId: string, sellerClerkId: string | null | undefined): Promise<void> {
  if (!sellerClerkId) {
    // The Backend's read is keyed by the owner, so without one we cannot look: say so instead of assuming "none".
    tg.alert(`⚠️ Plan Negocio activado sin dueño en los datos del pago: revisar a mano si hay un Plan Tienda mensual que cancelar.\nShop: ${shopId}`)
    return
  }
  await cancelTiendaOnNegocio(
    { shopId, sellerClerkId },
    {
      readTienda: getTiendaSubscription,
      setCancelAtPeriodEnd: async (subscriptionId) => {
        // The idempotency key makes a replayed activation send the same request, which Stripe answers from its cache.
        await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true }, { idempotencyKey: `tienda-cancel-on-negocio:${subscriptionId}` })
      },
      alert: (m) => tg.alert(m),
    },
  )
}

export async function handlePlanSubscriptionComplete(session: Stripe.Checkout.Session, plan: PaidPlan): Promise<PlanWebhookOutcome> {
  const name = PLAN_DISPLAY_NAMES[plan]
  const shopId = session.metadata?.shop_id
  const sellerClerkId = session.metadata?.seller_clerk_id
  const stripeSubscriptionId = session.subscription as string | null
  if (!shopId || !sellerClerkId || !stripeSubscriptionId) {
    console.error(`[${plan} sub] missing metadata/subscription:`, session.id)
    tg.alert(`🚨 ${name} mensual PAGADO sin datos para activarlo — revisar.\nSession: ${session.id}`)
    return 'final' // the same session will carry the same missing data on every delivery
  }
  try {
    const stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId)
    // The period is on the subscription ITEM in this API version; a missing one must not block activation.
    const period = subscriptionPeriod(stripeSub)
    const nowSec = Math.floor(Date.now() / 1000)
    const periodStart = period?.start ?? nowSec
    const periodEnd = period?.end ?? nowSec + 31 * 86_400
    const { plan_id } = await SUBSCRIPTION_READS[plan](sellerClerkId, shopId)
    if (!plan_id) throw new Error(`${plan} plan not found`)
    const email = session.customer_details?.email?.toLowerCase().trim() ?? ''
    const res = await fetch(`${MEDUSA_BASE}/store/subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-publishable-api-key': MEDUSA_PUB_KEY,
        'x-internal-secret': process.env.MEDUSA_INTERNAL_SECRET ?? '',
      },
      body: JSON.stringify({
        plan_id,
        // The marketplace shop id: the Backend counts only this shop's subscription (a plan is per shop).
        seller_id: shopId,
        clerk_user_id: sellerClerkId,
        buyer_email: email || `${sellerClerkId}@seller.miyagisanchez.com`,
        // Bought during the free trial, Stripe holds it as `trialing` until the first charge; both are live for the
        // plan. Any later status (unpaid, canceled…) arrives through the status sync, which reads Stripe's current one.
        status: stripeSub.status === 'trialing' ? 'trialing' : 'active',
        payment_method: 'stripe',
        stripe_subscription_id: stripeSubscriptionId,
        stripe_customer_id: session.customer as string | null,
        current_period_start: new Date(periodStart * 1000).toISOString(),
        current_period_end: new Date(periodEnd * 1000).toISOString(),
        metadata: { kind: PLAN_CHECKOUT_KINDS[plan], shop_id: shopId },
      }),
    })
    if (!res.ok) throw new Error(`subscription create ${res.status}`)
  } catch (e) {
    console.error(`[${plan} sub] Medusa activation failed:`, e)
    tg.alert(
      `🚨 ${name} mensual PAGADO pero NO activado — Stripe lo reintentará; si sigue, reparar a mano.\nShop: ${shopId}\nSeller: ${sellerClerkId}\n` +
      `Stripe sub: ${stripeSubscriptionId}\nError: ${errText(e)}`,
    )
    // Retried: `/store/subscriptions` dedupes on the Stripe subscription id, and nothing below has run yet.
    return 'retry'
  }
  tg.alert(`✅ ${name} mensual activado\nShop: ${shopId}`)
  // AFTER the activation landed, never before: a failed Tienda cancel must not cost the merchant their Negocio. D19
  // stays best-effort (it alerts; it never asks Stripe to retry the activation).
  if (plan === 'negocio') await cancelTiendaUnderNegocio(shopId, sellerClerkId)
  await afterPlanPaid({ plan, shopId, paymentRef: stripeSubscriptionId })
  return 'done'
}

/** `applyPlanPayment`'s I/O: the shop row read and the ONE guarded grant write (`merge_shop_metadata_guards`). */
const PLAN_PAYMENT_DB: PlanPaymentDeps = {
  readMetadata: async (shopId) => {
    const { data: shop, error } = await db.from('marketplace_shops').select('metadata').eq('id', shopId).maybeSingle()
    if (error) throw new Error(`shop read failed: ${error.message}`)
    return shop ? { metadata: (shop as { metadata: unknown }).metadata } : null
  },
  writeGrant: async (args) => {
    // ONE statement: the grant and, for a Negocio payment over a live Tienda grant, that grant moved forward
    // (plan-tienda D4) land together or not at all — and only if both grants and the trial are still as read.
    const { data: merged, error } = await db.rpc(GRANT_WRITE_RPC, args)
    if (error) throw new Error(`grant write failed: ${error.message}`)
    return Array.isArray(merged) && merged.length > 0
  },
}

/** Write the paid months onto the shop's Negocio grant. Every dated Negocio grant goes through here (the yearly
 *  payment, a promoter package by card or by transfer), so this is the one place the Tienda shift is written. */
export async function applyNegocioPayment(input: PlanPaymentInput): Promise<PlanPaymentOutcome> {
  const outcome = await applyPlanPayment('negocio', input, PLAN_PAYMENT_DB)
  // A promoter package (by card or by an approved transfer) is a Plan Negocio payment too (D10): restore a shop the
  // plan job paused. Only on a grant actually written, so a replay restores nothing.
  if (outcome === 'written') await afterPlanPaid({ plan: 'negocio', shopId: input.shopId, paymentRef: input.paymentId })
  return outcome
}

/** Write the paid months onto the shop's Tienda grant (the yearly Plan Tienda payment). */
export async function applyTiendaPayment(input: PlanPaymentInput): Promise<PlanPaymentOutcome> {
  const outcome = await applyPlanPayment('tienda', input, PLAN_PAYMENT_DB)
  if (outcome === 'written') await afterPlanPaid({ plan: 'tienda', shopId: input.shopId, paymentRef: input.paymentId })
  return outcome
}

export async function handlePlanOneTimeComplete(session: Stripe.Checkout.Session, plan: PaidPlan, completedAt?: number): Promise<PlanWebhookOutcome> {
  const name = PLAN_DISPLAY_NAMES[plan]
  const shopId = session.metadata?.shop_id
  const months = sessionMonths(session.metadata?.months)
  // Promoter packages are sold as Plan Negocio only; a Tienda session never carries one (sprint 4 adds its own path).
  const promoterSku = plan === 'negocio' ? session.metadata?.promoter_sku : undefined
  // Grant only money that arrived. A delayed method completes the session `unpaid`; this checkout is card-only, but
  // a session that is not `paid` must never become months of a plan.
  if (session.payment_status !== 'paid') {
    console.error(`[${plan} one-time] session not paid:`, session.id, session.payment_status)
    tg.alert(`⚠️ ${name} (pago único): sesión completada SIN pago (${session.payment_status}) — no se activó.\nSession: ${session.id}`)
    return 'final'
  }
  if (!shopId || months === null) {
    console.error(`[${plan} one-time] bad metadata:`, session.id)
    tg.alert(`🚨 ${name} (pago único) PAGADO con datos inválidos — revisar.\nSession: ${session.id}`)
    return 'final'
  }
  // The payment's own moment (the event's `created`): the grant AND the shares are dated from it, so a delayed or
  // redelivered event writes the same term as a prompt one (Codex, PR 486).
  const paidAt = paymentInstant(completedAt) ?? new Date()
  const { outcome } = await runOneTimeSteps({
    applyGrant: () =>
      applyPlanPayment(plan, { shopId, paymentId: session.id, months, note: promoterSku ? `promoter ${promoterSku}` : `yearly ${months}m`, now: paidAt }, PLAN_PAYMENT_DB),
    onGrantFailed: (e) => {
      console.error(`[${plan} one-time] grant write failed:`, e)
      tg.alert(`🚨 ${name} (pago único) PAGADO pero NO activado — Stripe lo reintentará; si sigue, reparar a mano.\nShop: ${shopId}\nSession: ${session.id}\nError: ${errText(e)}`)
    },
    // The merchant's own payment may earn a promoter a share (D13, plan-tienda D14): the Negocio renewal or the move
    // up from a Plan Tienda package; for Plan Tienda, the Tienda renewal. A checkout carrying a `promoter_sku` is a
    // promoter's sale, never a share. Paid at the event's own timestamp, never processing time (Codex security, #474).
    // Runs on a replay too (lib/plan-one-time-steps.ts): each share is keyed by `payment_ref`.
    shares: async () => {
      if (promoterSku) return true
      const input = { shopId, paymentRef: session.id, paidAt }
      if (plan === 'negocio') return recordNegocioPaymentShares({ ...input, grossCents: session.amount_total ?? 0 })
      return (await accrueTiendaPaymentShare({ ...input, amountCents: session.amount_total ?? 0 })) !== 'failed'
    },
    attribution: async () => {
      const promoterId = session.metadata?.promoter_id
      if (plan !== 'negocio' || !promoterId || !isPromoterSku(promoterSku)) return true
      const r = await markAttributionPaid({ promoterId, sellerId: shopId, sku: promoterSku, grossAmountCents: session.amount_total ?? 0, cadence: 'one_time' })
      if (r !== 'recorded') tg.alert(`🚨 ${name} (pago único): la atribución del promotor NO se registró — Stripe lo reintentará.\nShop: ${shopId}\nSession: ${session.id}`)
      return r === 'recorded'
    },
    firstTime: async (grant) => {
      tg.alert(
        grant === 'comp'
          ? `ℹ️ Negocio pagado en una tienda que ya lo tenía sin costo — revisar si hay que reembolsar.\nShop: ${shopId}\nSession: ${session.id}`
          : `✅ ${name} activado (${months} meses)\nShop: ${shopId}`,
      )
      if (grant !== 'written') return
      if (plan === 'negocio') await cancelTiendaUnderNegocio(shopId, session.metadata?.seller_clerk_id)
      await afterPlanPaid({ plan, shopId, paymentRef: session.id })
    },
  })
  return outcome
}

function syncDeps(retrieved?: RetrievedPlanSubscription): PlanStatusSyncDeps {
  return {
    // The invoice handlers already retrieved the subscription for this very event; reuse that fresh copy.
    retrieve: retrieved ? async () => retrieved : async (id) => (await stripe.subscriptions.retrieve(id)) as RetrievedPlanSubscription,
    patch: STATUS_PATCHES,
    alert: (m) => tg.alert(m),
  }
}

/**
 * `customer.subscription.updated` / `.deleted` for a plan subscription: send its CURRENT status (retrieved, never
 * the event's) to the right plan's route. On a Negocio deletion, the custom domain the shop had THROUGH Negocio is
 * released, unless it is still entitled another way — the one release function decides (Codex, #471), unchanged.
 */
export async function handlePlanSubscriptionEvent(subscriptionId: string, opts: { deleted: boolean }): Promise<PlanWebhookOutcome> {
  const out = await syncPlanSubscriptionStatus(subscriptionId, syncDeps())
  // The domain release runs only after the PATCH landed, so a retried delivery reaches it once the status is in.
  if (out.outcome !== 'patched' || !opts.deleted || out.plan !== 'negocio') return syncWebhookOutcome(out)
  try {
    await releaseCustomDomainForShop(out.shopId ?? undefined, 'negocio_ended')
  } catch (e) {
    console.error('[negocio sub] domain release failed:', e)
    tg.alert(`🚨 Negocio: no se pudo liberar el dominio propio al cancelar — revisar.\nStripe sub: ${subscriptionId}\nError: ${errText(e)}`)
  }
  // The plan step landed; a failed domain release is alerted and is not a reason to replay the event (unchanged).
  return 'done'
}

/**
 * A monthly renewal paid (or a recovery from past_due / unpaid): send the current status. The platform is the payee —
 * this path must NEVER reach the seller-subscription transfer below it in the webhook.
 */
export async function handlePlanInvoicePaid(invoice: Stripe.Invoice, subscription: RetrievedPlanSubscription): Promise<PlanWebhookOutcome> {
  const out = await syncPlanSubscriptionStatus(subscription.id, syncDeps(subscription))
  // A monthly plan that came back to live by paying (D21: `unpaid` ends the plan, a paid invoice brings it back) is a
  // subscription activation for D10: restore a shop the plan job paused meanwhile. No claim, no call.
  if (out.outcome === 'patched' && out.shopId && (out.status === 'active' || out.status === 'trialing')) {
    await afterPlanPaid({ plan: out.plan, shopId: out.shopId, paymentRef: invoice.id ?? subscription.id })
  }
  // The $0 invoice that opens a free period is not a payment: no renewal share for a promoter.
  if ((invoice.amount_paid ?? 0) <= 0) return syncWebhookOutcome(out)
  // Every paid invoice may earn a promoter a share, only once the status landed: for Negocio the year-2 renewal (D13)
  // or the first move up from a Plan Tienda package (plan-tienda D14); for Plan Tienda the year-2 Tienda renewal.
  // Keyed by `payment_ref` (unique), so the retried delivery that finally lands records each once; a share that did
  // not land answers `retry`, and the redelivery records only what is missing.
  const shopId = subscription.metadata?.shop_id
  const result = syncWebhookOutcome(out)
  if (out.outcome !== 'patched' || !shopId || !invoice.id) return result
  const paidAt = invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000) : new Date()
  const shared =
    out.plan === 'negocio'
      ? await recordNegocioPaymentShares({ shopId, paymentRef: invoice.id, grossCents: invoice.amount_paid ?? 0, paidAt })
      : (await accrueTiendaPaymentShare({ shopId, paymentRef: invoice.id, amountCents: invoice.amount_paid ?? 0, paidAt })) !== 'failed'
  return shared ? result : 'retry'
}

/** A failed renewal: send the current status (past_due is a grace state the Backend keeps live; unpaid is not). */
export async function handlePlanInvoiceFailed(subscription: RetrievedPlanSubscription): Promise<PlanWebhookOutcome> {
  const result = syncWebhookOutcome(await syncPlanSubscriptionStatus(subscription.id, syncDeps(subscription)))
  // Said once, on the delivery that settles the event: a retried delivery would otherwise repeat it. (A failed sync has
  // already alerted on its own.)
  if (result !== 'retry') {
    const plan = paidPlanOfKind(subscription.metadata?.kind)
    tg.alert(`⚠️ Pago fallido en ${plan ? PLAN_DISPLAY_NAMES[plan] : 'un plan'} — estado en Stripe: ${subscription.status}\nSubscription: ${subscription.id}`)
  }
  return result
}
