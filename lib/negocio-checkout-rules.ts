/**
 * lib/negocio-checkout-rules.ts — who may start which Negocio checkout (epic 08 · plans-gratis-negocio S1.3).
 *
 * Pure + next-free so the refusals are unit-tested. The rules:
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

/** Stripe subscription status → the Medusa status Negocio understands, or null to leave it alone. */
export function mapNegocioStatus(status: string): 'active' | 'trialing' | 'past_due' | 'canceled' | null {
  const map: Record<string, 'active' | 'trialing' | 'past_due' | 'canceled'> = {
    active: 'active', trialing: 'trialing', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled',
  }
  return map[status] ?? null
}
