/**
 * lib/negocio-page.ts — what «Tu suscripción» (/shop/manage/negocio) shows for a plan (epic 08 · plans-gratis-negocio
 * S3.2, README D15). Pure: the page and its spec both read the decision from here, so the headline and the buy buttons
 * can never disagree about a plan.
 *
 * The buttons mirror what `decideNegocioCheckout` would accept, so the page never offers a purchase the server then
 * refuses: nothing to buy on Negocio by comp or subscription, only a yearly renewal on a dated grant, and nothing at
 * all when the plan could not be read ("could not look" ≠ "none" — offering to pay again could double-charge).
 *
 * Prices come from `lib/negocio-pricing.ts` through `formatPesos`; no price is typed here.
 */
import { daysLeft, type PlanState } from './plan'
import { NEGOCIO_PRICE_MONTHLY_MXN, NEGOCIO_PRICE_YEARLY_MXN } from './negocio-pricing'
import { formatPesos } from './pricing-catalog'

export type NegocioCadence = 'month' | 'year'

export type NegocioButton = { cadence: NegocioCadence; label: string }

export type NegocioPageView = {
  /** Plain-Spanish line saying which plan the shop is on. */
  headline: string
  /** `ok` = a plan we are sure of; `unknown` = we could not read it (shown as a warning). */
  tone: 'ok' | 'trial' | 'unknown'
  buttons: NegocioButton[]
}

export const MONTHLY_BUTTON_LABEL = `${formatPesos(NEGOCIO_PRICE_MONTHLY_MXN)} al mes`
export const YEARLY_BUTTON_LABEL = `${formatPesos(NEGOCIO_PRICE_YEARLY_MXN)} al año (a meses sin intereses)`
export const RENEW_BUTTON_LABEL = `Renovar por otro año: ${formatPesos(NEGOCIO_PRICE_YEARLY_MXN)}`

/** `4 de noviembre de 2027` in es-MX, computed in UTC so a server's timezone never moves the date. */
export function formatPlanDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

export function negocioPageView(plan: PlanState, now: Date = new Date()): NegocioPageView {
  const both: NegocioButton[] = [
    { cadence: 'month', label: MONTHLY_BUTTON_LABEL },
    { cadence: 'year', label: YEARLY_BUTTON_LABEL },
  ]
  switch (plan.reason) {
    case 'unavailable':
      return { headline: 'No pudimos confirmar tu suscripción. Intenta de nuevo en unos minutos.', tone: 'unknown', buttons: [] }
    case 'trial': {
      const n = daysLeft(plan, now) ?? 0
      return {
        headline: `Estás en tu prueba de Negocio: te quedan ${n} ${n === 1 ? 'día' : 'días'}.`,
        tone: 'trial',
        buttons: both,
      }
    }
    case 'one_time':
      return {
        headline: plan.endsAt ? `Negocio activo hasta el ${formatPlanDate(plan.endsAt)}.` : 'Negocio activo.',
        tone: 'ok',
        buttons: [{ cadence: 'year', label: RENEW_BUTTON_LABEL }],
      }
    case 'comp':
    case 'subscription':
      return { headline: 'Negocio activo.', tone: 'ok', buttons: [] }
    case 'trial_ended':
      return { headline: 'Estás en Gratis. Tu prueba de Negocio terminó.', tone: 'ok', buttons: both }
    case 'none':
    default:
      return { headline: 'Estás en Gratis.', tone: 'ok', buttons: both }
  }
}
