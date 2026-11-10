/**
 * lib/negocio-checkout-rules.ts — who may start which paid-plan checkout (epic 08 · plans-gratis-negocio S1.3; Plan
 * Tienda's rules added by plan-tienda-three-free-months S2.1/S2.2, README D6).
 *
 * Pure + next-free so the refusals are unit-tested. Plan Negocio's rules (`decideNegocioCheckout`, unchanged by
 * plan-tienda — the epic's no-gos say "no change to Plan Negocio"; D19 needs none, since a Tienda reason was never a
 * refusal here):
 *   - A live monthly subscription refuses BOTH cadences: paying again would double-charge.
 *   - A live yearly (one_time) grant refuses MONTHLY (it would charge every month on top of a year already paid) but
 *     ALLOWS yearly: a second year is added after the current end (`extendNegocioGrant`), so paying early loses nothing.
 *   - A comp refuses both: Negocio is already permanent.
 *   - A trial or Gratis may buy either.
 *   - An `unavailable` plan (Gratis, and the subscription could not be read) refuses both, rather than risk a double
 *     charge. A live TRIAL with an unreadable subscription may still buy YEARLY: a yearly payment adds after any end,
 *     so it can never double-charge a month; monthly re-reads the subscription and refuses if it cannot.
 */
import type { PlanState } from './plan'
import { NEGOCIO_YEARLY_MONTHS } from './negocio-pricing'
import type { PlanSubscription } from './plan-subscription-answer'

export type NegocioCadence = 'month' | 'year'

export function coerceNegocioCadence(raw: unknown): NegocioCadence | null {
  return raw === 'month' || raw === 'year' ? raw : null
}

export type NegocioCheckoutDecision = { ok: true } | { ok: false; status: number; error: string }

export function decideNegocioCheckout(input: { cadence: NegocioCadence; plan: PlanState }): NegocioCheckoutDecision {
  const { cadence, plan } = input
  if (plan.reason === 'unavailable') {
    return { ok: false, status: 503, error: 'No pudimos confirmar tu suscripción. Intenta de nuevo en unos minutos.' }
  }
  if (plan.reason === 'comp') {
    return { ok: false, status: 409, error: 'Tu tienda ya tiene Negocio sin costo.' }
  }
  if (plan.reason === 'subscription') {
    return { ok: false, status: 409, error: 'Ya pagas Negocio cada mes. Puedes administrarlo desde tu suscripción.' }
  }
  if (plan.reason === 'one_time' && cadence === 'month') {
    return { ok: false, status: 409, error: 'Ya tienes Negocio pagado por año. Puedes renovarlo por otro año cuando quieras.' }
  }
  return { ok: true }
}

/**
 * What a monthly-subscription read said, as the checkout needs it: three states, never two. `unavailable` is "could
 * not look", which no checkout may read as "none" — that is how a merchant gets charged twice.
 */
export type SubscriptionFact = 'live' | 'none' | 'unavailable'

export function subscriptionFact(sub: Pick<PlanSubscription, 'active' | 'unavailable'>): SubscriptionFact {
  if (sub.unavailable) return 'unavailable'
  return sub.active ? 'live' : 'none'
}

/**
 * Who may start which Plan Tienda checkout (README D6, sprint-2 build contract). The shell reads BOTH monthly
 * subscriptions itself and passes them here, rather than trusting the derived plan alone, because the plan hides
 * them: a live trial outranks a subscription (`derivePlan`), so a trial shop whose Negocio or Tienda subscription
 * could not be read still resolves to `trial`, and `resolvePlan` does not even look up Tienda's while a trial is live.
 * A checkout must not act on that guess.
 *
 *   - Anything unreadable (the plan, or either subscription) refuses BOTH cadences: paying again could double-charge.
 *   - Any paid Plan Negocio (comp, a dated grant, a subscription) refuses Plan Tienda: Negocio already includes all of
 *     Tienda, so the merchant would pay for months they cannot use. (The other direction, Negocio over a monthly
 *     Tienda, is allowed: D19 cancels the Tienda subscription at its period end.)
 *   - A live monthly Plan Tienda refuses both cadences: a second subscription double-charges, and a year bought on top
 *     would run under a subscription still charging every month.
 *   - A live Plan Tienda YEAR refuses monthly (it would charge every month on top of a paid year) but ALLOWS another
 *     year: it is added after the current end (`decideTiendaPayment`), so paying early loses nothing.
 *   - A trial, legacy Plan Gratis (with or without an ended trial) and an unpaid shop may buy either cadence. During a
 *     live trial the year starts at the trial's end, and the monthly first charge waits for it (`monthlyFirstChargeAt`).
 */
export function decideTiendaCheckout(input: {
  cadence: NegocioCadence
  plan: PlanState
  negocioSubscription: SubscriptionFact
  tiendaSubscription: SubscriptionFact
}): NegocioCheckoutDecision {
  const { cadence, plan } = input
  if (plan.reason === 'unavailable' || input.negocioSubscription === 'unavailable' || input.tiendaSubscription === 'unavailable') {
    return { ok: false, status: 503, error: 'No pudimos confirmar tu suscripción. Intenta de nuevo en unos minutos.' }
  }
  if (plan.plan === 'negocio' || input.negocioSubscription === 'live') {
    return { ok: false, status: 409, error: 'Tu tienda ya tiene el Plan Negocio, que incluye todo lo del Plan Tienda.' }
  }
  if (plan.reason === 'tienda_subscription' || input.tiendaSubscription === 'live') {
    return { ok: false, status: 409, error: 'Ya pagas el Plan Tienda cada mes. Puedes administrarlo desde tu suscripción.' }
  }
  if (plan.reason === 'tienda_one_time' && cadence === 'month') {
    return { ok: false, status: 409, error: 'Ya tienes el Plan Tienda pagado por año. Puedes pagar otro año cuando quieras.' }
  }
  return { ok: true }
}

/**
 * Stripe Checkout refuses a `subscription_data.trial_end` less than 48 hours away. A minute of slack keeps a request
 * built at the edge from being refused by the time Stripe reads it.
 */
export const STRIPE_MIN_TRIAL_SECONDS = 48 * 3600 + 60

/**
 * The window a paid-plan checkout's idempotency key is stable for (both plans share it). Every parameter sent with
 * one key must be identical for the whole window, or Stripe refuses the retry (`idempotency_error`), so anything
 * time-based is rounded to it.
 */
export const PLAN_CHECKOUT_WINDOW_MS = 600_000
/** The same window under its first name (plans-gratis-negocio). */
export const NEGOCIO_CHECKOUT_WINDOW_MS = PLAN_CHECKOUT_WINDOW_MS

/**
 * When a MONTHLY plan bought now — Plan Negocio or Plan Tienda, the rule is the same — should first charge (unix
 * seconds), or null to charge today. During a live free trial the first charge waits for its end (Daniel, 2026-11-05:
 * paying early never loses free days). Stripe needs at least 48 hours, so a trial ending sooner is rounded up to that:
 * the merchant gets up to two extra free days, never fewer than promised. Nothing else delays a first charge: Plan
 * Tienda is refused outright under any paid Plan Negocio (`decideTiendaCheckout`), so there is no other free period to
 * wait for.
 */
export function monthlyFirstChargeAt(plan: PlanState, now: Date = new Date()): number | null {
  if (plan.reason !== 'trial' || !plan.endsAt) return null
  const end = Math.floor(Date.parse(plan.endsAt) / 1000)
  if (!Number.isFinite(end)) return null
  // Measured from the END of the current idempotency window, not from this second: a double click or a retry within
  // the window must send the same trial_end, or Stripe refuses it (pr-reviewer, #477). At most ten minutes more free.
  const windowEndSec = (Math.floor(now.getTime() / PLAN_CHECKOUT_WINDOW_MS) + 1) * (PLAN_CHECKOUT_WINDOW_MS / 1000)
  return Math.max(end, windowEndSec + STRIPE_MIN_TRIAL_SECONDS)
}

/**
 * The subscription an invoice belongs to, on any Stripe API version: `invoice.subscription` before 2025-03-31.basil,
 * `invoice.parent.subscription_details.subscription` after. A webhook endpoint follows the account's API version, so
 * reading only one of them would silently drop every renewal and failed payment on the other (pr-reviewer, #477).
 */
export function invoiceSubscriptionId(invoice: unknown): string | null {
  const inv = (invoice ?? {}) as Record<string, unknown>
  const idOf = (v: unknown): string | null =>
    typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : null
  const parent = inv.parent as { subscription_details?: { subscription?: unknown } } | null | undefined
  return idOf(inv.subscription) ?? idOf(parent?.subscription_details?.subscription)
}

/** Months a one-time session grants: a whole number 1–24 from its metadata, or 12. Anything else is refused. */
export function sessionMonths(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return NEGOCIO_YEARLY_MONTHS
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= 24 ? n : null
}

/**
 * A subscription's current period, in seconds. Since Stripe API `2025-03-31.basil` (this SDK pins `2026-06-24.dahlia`)
 * the period lives on the subscription ITEM, not the subscription: reading the top-level field gives `undefined`, and
 * `new Date(undefined * 1000).toISOString()` throws — which would charge the merchant and never activate Negocio
 * (pr-reviewer, #471). Falls back to the old top-level fields; null when neither carries it.
 */
export function subscriptionPeriod(sub: unknown): { start: number; end: number } | null {
  const s = (sub ?? {}) as { items?: { data?: Array<Record<string, unknown>> }; current_period_start?: unknown; current_period_end?: unknown }
  const item = s.items?.data?.[0] ?? {}
  const start = typeof item.current_period_start === 'number' ? item.current_period_start : s.current_period_start
  const end = typeof item.current_period_end === 'number' ? item.current_period_end : s.current_period_end
  return typeof start === 'number' && typeof end === 'number' ? { start, end } : null
}

// `mapNegocioStatus` (Stripe status → a Negocio status, with `unpaid` folded into `past_due` and `paused` /
// `incomplete` dropped) was removed by plan-tienda S2.2: the webhook now sends Stripe's status AS IS and the Backend
// decides what is live (Backend #228; sprint-2 build contract). See `lib/plan-subscription-sync.ts`.
