/**
 * lib/plan-subscription-sync.ts — keeping Medusa Commerce's record of a monthly plan subscription in step with
 * Stripe (epic 08 · plan-tienda-three-free-months S2.2, README D6/D19; the sprint-2 build contract added at review of
 * Backend PR 228).
 *
 * THE RULES, and why each exists:
 *
 *   1. On EVERY Stripe event about a Plan Negocio or Plan Tienda subscription (`customer.subscription.updated`,
 *      `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed` — the four the webhook
 *      route handles; `customer.subscription.created` is not handled, the activation is `checkout.session.completed`),
 *      the subscription is RETRIEVED from Stripe and its CURRENT status is sent. Never the status in the event payload:
 *      Stripe does not deliver events in order, so a delayed `updated: active` handled after the cancellation would
 *      otherwise restore a plan nobody is paying for. The current status is the truth whatever order events arrive in.
 *   2. Stripe's status is sent AS IS (`unpaid`, `paused`, `incomplete`, `incomplete_expired` included). The old map
 *      folded `unpaid` into `past_due` — which the plan seam counts as live, so a subscription Stripe had stopped
 *      collecting kept its plan forever — and dropped the other three. The Backend decides what is live and what is
 *      final (Backend PR 228). A status Stripe adds later that we do not know is NOT guessed: it alerts.
 *   3. Each plan's status goes to ITS route: a Tienda subscription is never PATCHed on the Negocio route or the reverse
 *      (the Backend scopes each route to its own plan row and would answer `updated: 0`, but a mis-route must not
 *      depend on that). The plan is the RETRIEVED subscription's `metadata.kind`, which our server wrote at checkout
 *      (`lib/plan-kind.ts` says why the client cannot set it), cross-checked against the price's seeded
 *      `lookup_key`: when the price names the OTHER plan, nothing is sent and a person is asked.
 *   4. `{ updated: 0 }` is a failure (nothing matched) and alerts on Telegram. A failure that a later attempt can fix
 *      (Stripe or the Backend could not be reached, the PATCH errored or matched nothing) is `retry: true`, and the
 *      webhook then answers Stripe with a 5xx so Stripe delivers the event again (`webhookAnswerStatus`; PR 485
 *      review). Retrying is safe: every attempt retrieves the subscription afresh and the Backend's write is
 *      conditional (a cancelled row stays cancelled). A failure no retry can fix (a kind that contradicts its price,
 *      a status we do not know, an answer about another subscription) is `retry: false`: it alerts and answers 200,
 *      because a retry would only repeat the alert for three days.
 *
 * D19 (moving up from Plan Tienda): when Plan Negocio activates, a live monthly Plan Tienda subscription on the same
 * shop is set to cancel at its period end — no refund, no charge after the period already paid. One Stripe call,
 * idempotent (setting `cancel_at_period_end: true` again changes nothing), and a failure alerts without blocking the
 * Negocio activation: the merchant paid for Negocio, and that must land whatever happens to the Tienda cancel.
 *
 * Pure decisions + thin shells with every I/O injected, so the rules are tested without Stripe or a backend.
 */
import { PLAN_DISPLAY_NAMES, paidPlanOfKind, paidPlanOfLookupKey, type PaidPlan } from './plan-kind'
import type { PlanSubscription } from './plan-subscription-answer'

/** Every status a Stripe subscription can have today, all accepted by the Backend's PATCH (Backend PR 228). */
export const STRIPE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete', 'canceled', 'incomplete_expired',
])

/** The slice of a retrieved `Stripe.Subscription` the sync reads. */
export type RetrievedPlanSubscription = {
  id: string
  status: string
  /** Unix seconds the subscription was created (Stripe's `created`). */
  created?: number
  metadata?: Record<string, string> | null
  items?: { data?: Array<{ price?: { lookup_key?: string | null } | null } | null> } | null
}

export type PlanStatusSyncDecision =
  | { action: 'patch'; plan: PaidPlan; subscriptionId: string; status: string; shopId: string | null }
  | { action: 'not_a_plan' }
  | { action: 'alert'; plan: PaidPlan | null; reason: 'id_mismatch' | 'kind_price_mismatch' | 'unknown_status' }

/**
 * What to send for `subscriptionId`, decided from the subscription as RETRIEVED from Stripe — never from an event.
 * The PATCH body is `{ stripe_subscription_id: sub.id, status: sub.status }` and nothing else.
 */
export function decidePlanStatusSync(subscriptionId: string, sub: RetrievedPlanSubscription): PlanStatusSyncDecision {
  const plan = paidPlanOfKind(sub.metadata?.kind)
  // A retrieve that answered with a different subscription is not an answer about this one.
  if (sub.id !== subscriptionId) return { action: 'alert', plan, reason: 'id_mismatch' }
  if (!plan) return { action: 'not_a_plan' }
  const priced = (sub.items?.data ?? []).map((item) => paidPlanOfLookupKey(item?.price?.lookup_key)).filter((p): p is PaidPlan => p !== null)
  if (priced.some((p) => p !== plan)) return { action: 'alert', plan, reason: 'kind_price_mismatch' }
  if (!STRIPE_SUBSCRIPTION_STATUSES.has(sub.status)) return { action: 'alert', plan, reason: 'unknown_status' }
  return { action: 'patch', plan, subscriptionId: sub.id, status: sub.status, shopId: sub.metadata?.shop_id ?? null }
}

export type PlanStatusSyncDeps = {
  /** `stripe.subscriptions.retrieve` on the PLATFORM account (or the copy the caller just retrieved for this event). */
  retrieve: (subscriptionId: string) => Promise<RetrievedPlanSubscription>
  /** Each plan's Backend PATCH (`setNegocioSubscriptionStatus`, `setTiendaSubscriptionStatus`): rows written. */
  patch: Readonly<Record<PaidPlan, (subscriptionId: string, status: string) => Promise<number>>>
  alert: (message: string) => void
  /** The clock, for the young-subscription rule below. */
  now?: () => Date
}

export type PlanStatusSyncOutcome =
  | { outcome: 'patched'; plan: PaidPlan; status: string; shopId: string | null }
  | { outcome: 'not_a_plan' }
  | { outcome: 'failed'; plan: PaidPlan | null; retry: boolean }

/**
 * A subscription younger than this whose PATCH matched no row is not alerted on — it is still retried. WHY: Stripe
 * does not order events, so `customer.subscription.updated` and the $0 trial `invoice.payment_succeeded` routinely
 * arrive BEFORE `checkout.session.completed` has created the Backend row (verifier, PR 485). With a 5xx Stripe
 * delivers them again a little later, when the row exists, and they land. An alert for every new subscriber would
 * teach whoever reads Telegram to ignore this alert, which is the one that means "a plan is out of step with what the
 * merchant pays". Past this age the row should exist; if it still does not, the activation itself failed (and alerted
 * on its own) or something else is wrong, and every further attempt alerts. Ten minutes covers a slow activation and
 * Stripe's first retries; it is not a business number.
 */
export const YOUNG_SUBSCRIPTION_MS = 10 * 60_000

/** No alert yet for "no row matched" on a subscription created moments ago (see `YOUNG_SUBSCRIPTION_MS`). */
export function quietNoRowYet(created: number | undefined, now: Date): boolean {
  return typeof created === 'number' && Number.isFinite(created) && now.getTime() - created * 1000 < YOUNG_SUBSCRIPTION_MS
}

/** What a plan step of the webhook amounted to, for the answer to Stripe. */
export type PlanWebhookOutcome = 'done' | 'retry' | 'final'

/**
 * The HTTP status the webhook answers Stripe with (PR 485 review). Only a plan step that failed in a way a later
 * delivery can fix answers 500, so Stripe retries it; everything else — every other event type and handler (`null`,
 * no plan step ran), a plan step that landed, a plan failure no retry can fix — answers 200 exactly as before.
 */
export function webhookAnswerStatus(plan: PlanWebhookOutcome | null | undefined): 200 | 500 {
  return plan === 'retry' ? 500 : 200
}

/** A sync outcome as the webhook's plan outcome. */
export function syncWebhookOutcome(out: PlanStatusSyncOutcome): PlanWebhookOutcome {
  if (out.outcome === 'failed') return out.retry ? 'retry' : 'final'
  return 'done'
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Retrieve, decide, send — the whole of rule 1–4 for one event. Never throws: every failure alerts and says so. */
export async function syncPlanSubscriptionStatus(subscriptionId: string, deps: PlanStatusSyncDeps): Promise<PlanStatusSyncOutcome> {
  let sub: RetrievedPlanSubscription
  try {
    sub = await deps.retrieve(subscriptionId)
  } catch (e) {
    // No fallback to the event's status (rule 1): a guess is exactly what a delayed event would exploit.
    deps.alert(`🚨 Plan: no se pudo leer la suscripción en Stripe, su estado NO se actualizó — Stripe lo reintentará.\nStripe sub: ${subscriptionId}\nError: ${errText(e)}`)
    return { outcome: 'failed', plan: null, retry: true }
  }
  const decision = decidePlanStatusSync(subscriptionId, sub)
  if (decision.action === 'not_a_plan') return { outcome: 'not_a_plan' }
  if (decision.action === 'alert') {
    const why = {
      id_mismatch: 'Stripe devolvió otra suscripción',
      kind_price_mismatch: 'el plan de la suscripción no coincide con su precio',
      unknown_status: `Stripe reporta un estado desconocido («${sub.status}»)`,
    }[decision.reason]
    deps.alert(`🚨 Plan: ${why}; NO se actualizó — revisar.\nStripe sub: ${subscriptionId}`)
    return { outcome: 'failed', plan: decision.plan, retry: false }
  }
  const name = PLAN_DISPLAY_NAMES[decision.plan]
  let updated: number
  try {
    updated = await deps.patch[decision.plan](decision.subscriptionId, decision.status)
  } catch (e) {
    deps.alert(`🚨 ${name}: no se pudo actualizar la suscripción a «${decision.status}» — Stripe lo reintentará.\nStripe sub: ${subscriptionId}\nError: ${errText(e)}`)
    return { outcome: 'failed', plan: decision.plan, retry: true }
  }
  if (updated === 0) {
    if (!quietNoRowYet(sub.created, deps.now?.() ?? new Date())) {
      deps.alert(`🚨 ${name}: no se pudo actualizar la suscripción a «${decision.status}» — Stripe lo reintentará.\nStripe sub: ${subscriptionId}\nError: no ${name} subscription row matched`)
    }
    return { outcome: 'failed', plan: decision.plan, retry: true }
  }
  return { outcome: 'patched', plan: decision.plan, status: decision.status, shopId: decision.shopId }
}

// ── D19: Plan Negocio activates over a monthly Plan Tienda ─────────────────────────

export type TiendaCancelDecision =
  | { action: 'cancel'; subscriptionId: string }
  | { action: 'none' }
  | { action: 'unavailable' }

/**
 * Must a Tienda subscription be cancelled at its period end now that Plan Negocio is active? Only a LIVE one (the
 * Backend's live = active, trialing, past_due); its Stripe id comes from the Backend's own read, never from a client.
 * "Could not look" is reported as such — and so is "live, but no id": either way a person must check, because a
 * missed cancel charges the merchant for Tienda every month on top of Negocio.
 */
export function decideTiendaCancelOnNegocio(tienda: Pick<PlanSubscription, 'active' | 'unavailable' | 'subscription_id'>): TiendaCancelDecision {
  if (tienda.unavailable) return { action: 'unavailable' }
  if (!tienda.active) return { action: 'none' }
  return tienda.subscription_id ? { action: 'cancel', subscriptionId: tienda.subscription_id } : { action: 'unavailable' }
}

export type TiendaCancelDeps = {
  readTienda: (sellerClerkId: string, shopId: string) => Promise<Pick<PlanSubscription, 'active' | 'unavailable' | 'subscription_id'>>
  /** ONE Stripe call: `subscriptions.update(id, { cancel_at_period_end: true })`. */
  setCancelAtPeriodEnd: (subscriptionId: string) => Promise<void>
  alert: (message: string) => void
}

/** D19's shell. Never throws: the Negocio activation that called it has already landed and must stay landed. */
export async function cancelTiendaOnNegocio(
  input: { shopId: string; sellerClerkId: string },
  deps: TiendaCancelDeps,
): Promise<'cancelled' | 'none' | 'failed'> {
  let decision: TiendaCancelDecision
  try {
    decision = decideTiendaCancelOnNegocio(await deps.readTienda(input.sellerClerkId, input.shopId))
  } catch {
    decision = { action: 'unavailable' }
  }
  if (decision.action === 'none') return 'none'
  if (decision.action === 'unavailable') {
    deps.alert(`⚠️ Plan Negocio activado, pero no pudimos revisar si la tienda tiene un Plan Tienda mensual que cancelar — revisar a mano para que no se cobren los dos.\nShop: ${input.shopId}`)
    return 'failed'
  }
  try {
    await deps.setCancelAtPeriodEnd(decision.subscriptionId)
  } catch (e) {
    deps.alert(`🚨 Plan Negocio activado, pero NO se pudo cancelar el Plan Tienda mensual al final de su periodo — cancelarlo a mano en Stripe.\nShop: ${input.shopId}\nStripe sub: ${decision.subscriptionId}\nError: ${errText(e)}`)
    return 'failed'
  }
  return 'cancelled'
}
