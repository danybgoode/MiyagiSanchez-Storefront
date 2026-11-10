/**
 * What an agent is told about a shop's plan (epic 08 · plans-gratis-negocio S3.3, README D17; both paid plans since
 * plan-tienda-three-free-months S2.3). Pure, so the MCP tool's answer is tested without a token. Prices and allowances
 * come from their one modules; the wording is es-MX, and the JSON half is the contract an agent reads.
 *
 * `can_start` (Plan Negocio) and `can_start_tienda` mirror the checkout rules from the plan alone
 * (`decideNegocioCheckout`, `decideTiendaCheckout`): an agent is never told a checkout can start that the server would
 * refuse for that plan. (Plan Tienda's checkout also re-reads both subscriptions, so during a trial it can still
 * refuse when one cannot be read — the tool then answers the server's sentence.)
 */
import { daysLeft, planOpensCustomDomain, planOpensMlSync, planShowsBadge, planGetsCheckin, type PlanState } from './plan'
import { allowanceFor } from './plan-allowances'
import { NEGOCIO_PRICE_MONTHLY_MXN, NEGOCIO_PRICE_YEARLY_MXN, NEGOCIO_CURRENCY } from './negocio-pricing'
import { TIENDA_PRICE_MONTHLY_MXN, TIENDA_PRICE_YEARLY_MXN, TIENDA_CURRENCY } from './tienda-pricing'
import { yearlyAsMonthly } from './pricing-catalog'

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
    /** Every price includes IVA (plan-tienda D5). */
    negocio_price: { monthly: number; yearly: number; currency: string; yearly_installments: true; iva_included: true }
    tienda_price: { monthly: number; yearly: number; yearly_as_monthly: number; currency: string; yearly_installments: false; iva_included: true }
    /** Plan Negocio: which checkout `start_negocio` can start now. */
    can_start: { month: boolean; year: boolean }
    /** Plan Tienda: which checkout `start_tienda` can start now. */
    can_start_tienda: { month: boolean; year: boolean }
  }
}

export function planAgentView(plan: PlanState, now: Date = new Date()): PlanAgentView {
  const left = daysLeft(plan, now)
  const a = allowanceFor(plan.plan)
  const unknown = plan.reason === 'unavailable'
  const canMonth = plan.plan !== 'negocio' && !unknown
  const canYear = !(plan.reason === 'comp' || plan.reason === 'subscription' || unknown)
  // decideTiendaCheckout, from the plan: no Tienda under any paid Negocio, none over a live monthly Tienda, no monthly
  // over a paid Tienda year (another year is fine), nothing on a guess.
  const tiendaBlocked = unknown || plan.plan === 'negocio' || plan.reason === 'tienda_subscription'
  const canTiendaMonth = !tiendaBlocked && plan.reason !== 'tienda_one_time'
  const canTiendaYear = !tiendaBlocked
  const summary =
    unknown ? 'No se pudo confirmar la suscripción de la tienda en este momento; inténtalo de nuevo en unos minutos.'
    : plan.plan === 'trial' ? `La tienda está en su prueba del Plan Negocio: le quedan ${left} día(s). Puede contratar desde ahora el Plan Tienda o el Plan Negocio sin perder sus días gratis.`
    : plan.plan === 'negocio' && plan.reason === 'one_time' ? `La tienda tiene el Plan Negocio pagado hasta ${plan.endsAt?.slice(0, 10)}.`
    : plan.plan === 'negocio' ? 'La tienda tiene el Plan Negocio activo.'
    : plan.plan === 'tienda' && plan.reason === 'tienda_one_time' ? `La tienda tiene el Plan Tienda pagado hasta ${plan.endsAt?.slice(0, 10)}. Puede pasar al Plan Negocio cuando quiera.`
    : plan.plan === 'tienda' ? 'La tienda tiene el Plan Tienda activo. Puede pasar al Plan Negocio cuando quiera.'
    : plan.plan === 'unpaid' ? 'La tienda no tiene un plan activo y necesita uno: el Plan Tienda o el Plan Negocio, que agrega dominio propio, Mercado Libre, mucho más chat y la revisión del mes.'
    : 'La tienda está en el Plan Gratis. Puede contratar el Plan Tienda o el Plan Negocio, que agrega dominio propio, Mercado Libre, mucho más chat y la revisión del mes.'
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
      negocio_price: { monthly: NEGOCIO_PRICE_MONTHLY_MXN, yearly: NEGOCIO_PRICE_YEARLY_MXN, currency: NEGOCIO_CURRENCY, yearly_installments: true, iva_included: true },
      tienda_price: {
        monthly: TIENDA_PRICE_MONTHLY_MXN,
        yearly: TIENDA_PRICE_YEARLY_MXN,
        yearly_as_monthly: yearlyAsMonthly(TIENDA_PRICE_YEARLY_MXN),
        currency: TIENDA_CURRENCY,
        yearly_installments: false,
        iva_included: true,
      },
      can_start: { month: canMonth, year: canYear },
      can_start_tienda: { month: canTiendaMonth, year: canTiendaYear },
    },
  }
}
