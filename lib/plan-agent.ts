/**
 * What an agent is told about a shop's plan (epic 08 · plans-gratis-negocio S3.3, README D17). Pure, so the MCP tool's
 * answer is tested without a token. Prices and allowances come from their one modules; the wording is es-MX, and the
 * JSON half is the contract an agent reads.
 */
import { daysLeft, planOpensCustomDomain, planOpensMlSync, planShowsBadge, planGetsCheckin, type PlanState } from './plan'
import { allowanceFor } from './plan-allowances'
import { NEGOCIO_PRICE_MONTHLY_MXN, NEGOCIO_PRICE_YEARLY_MXN, NEGOCIO_CURRENCY } from './negocio-pricing'

export type PlanAgentView = {
  summary: string
  json: {
    plan: PlanState['plan']
    reason: PlanState['reason']
    ends_at: string | null
    days_left: number | null
    includes: {
      custom_domain: boolean
      mercadolibre_sync: boolean
      badge_shown: boolean
      monthly_checkin: boolean
      chat_answers_per_month: number
      photos_per_month: number
    }
    negocio_price: { monthly: number; yearly: number; currency: string; yearly_installments: true }
    can_start: { month: boolean; year: boolean }
  }
}

export function planAgentView(plan: PlanState, now: Date = new Date()): PlanAgentView {
  const left = daysLeft(plan, now)
  const a = allowanceFor(plan.plan)
  const canMonth = plan.plan !== 'negocio' && plan.reason !== 'unavailable'
  const canYear = !(plan.reason === 'comp' || plan.reason === 'subscription' || plan.reason === 'unavailable')
  const summary =
    plan.reason === 'unavailable' ? 'No se pudo confirmar la suscripción de la tienda en este momento; inténtalo de nuevo en unos minutos.'
    : plan.plan === 'trial' ? `La tienda está en su prueba del Plan Negocio: le quedan ${left} día(s). Después sigue abierta en el Plan Gratis, sin perder sus productos.`
    : plan.plan === 'negocio' && plan.reason === 'one_time' ? `La tienda tiene el Plan Negocio pagado hasta ${plan.endsAt?.slice(0, 10)}.`
    : plan.plan === 'negocio' ? 'La tienda tiene el Plan Negocio activo.'
    : 'La tienda está en el Plan Gratis. El Plan Negocio agrega dominio propio, Mercado Libre, mucho más chat y la revisión del mes.'
  return {
    summary,
    json: {
      plan: plan.plan,
      reason: plan.reason,
      ends_at: plan.endsAt,
      days_left: left,
      includes: {
        custom_domain: planOpensCustomDomain(plan),
        mercadolibre_sync: planOpensMlSync(plan),
        badge_shown: planShowsBadge(plan),
        monthly_checkin: planGetsCheckin(plan),
        chat_answers_per_month: a.chatAnswersPerMonth,
        photos_per_month: a.photosPerMonth,
      },
      negocio_price: { monthly: NEGOCIO_PRICE_MONTHLY_MXN, yearly: NEGOCIO_PRICE_YEARLY_MXN, currency: NEGOCIO_CURRENCY, yearly_installments: true },
      can_start: { month: canMonth, year: canYear },
    },
  }
}
