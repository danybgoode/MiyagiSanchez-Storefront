/**
 * lib/negocio-page.ts — what «Tu suscripción» (/shop/manage/negocio) shows for a plan (epic 08 · plans-gratis-negocio
 * S3.2, README D15; copy rewritten 2026-11-05). Pure: the page and its spec both read the decision from here, so the
 * headline, the explanations and the buy buttons can never disagree about a plan.
 *
 * Daniel, 2026-11-05: the page read as if the shop would close after the trial. It now says plainly that the shop
 * stays open on the Plan Gratis, what it keeps and what pauses, and each button says what it is (a subscription that
 * charges itself, or one payment), when the first charge or the paid months start, and how to cancel.
 *
 * The buttons mirror what `decideNegocioCheckout` would accept, so the page never offers a purchase the server then
 * refuses: nothing to buy on Negocio by comp or subscription, only a yearly renewal on a dated grant, and nothing at
 * all when the plan could not be read ("could not look" ≠ "none" — offering to pay again could double-charge).
 *
 * Prices come from `lib/negocio-pricing.ts` through `formatPesos`, allowances from `PLAN_ALLOWANCES`; nothing is typed.
 */
import { addMonthsClamped, daysLeft, type PlanState } from './plan'
import { NEGOCIO_PRICE_MONTHLY_MXN, NEGOCIO_PRICE_YEARLY_MXN, NEGOCIO_YEARLY_MONTHS } from './negocio-pricing'
import { formatPesos } from './pricing-catalog'
import { PLAN_ALLOWANCES } from './plan-allowances'
import { monthlyFirstChargeAt } from './negocio-checkout-rules'

export type NegocioCadence = 'month' | 'year'

/** One way to pay, with the sentences that say what it is and what happens if you pay today. */
export type NegocioButton = { cadence: NegocioCadence; label: string; title: string; lines: string[] }

export type NegocioPageView = {
  /** Plain-Spanish line saying which plan the shop is on. */
  headline: string
  /** `ok` = a plan we are sure of; `unknown` = we could not read it (shown as a warning). */
  tone: 'ok' | 'trial' | 'unknown'
  buttons: NegocioButton[]
  /** The monthly subscriber can open Stripe's page to change the card, see invoices or cancel. */
  manage: boolean
  /** What happens when the free days end — only during the trial. */
  afterTrial: { title: string; body: string } | null
  /** What pauses on the Plan Gratis (shown while on the trial or on Gratis). */
  pauses: { title: string; items: string[] } | null
}

export const MONTHLY_BUTTON_LABEL = `Pagar ${formatPesos(NEGOCIO_PRICE_MONTHLY_MXN)} al mes`
export const YEARLY_BUTTON_LABEL = `Pagar ${formatPesos(NEGOCIO_PRICE_YEARLY_MXN)} por un año`
export const RENEW_BUTTON_LABEL = `Pagar otro año: ${formatPesos(NEGOCIO_PRICE_YEARLY_MXN)}`

/** `4 de noviembre de 2027` in es-MX, computed in UTC so a server's timezone never moves the date. */
export function formatPlanDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/** What the Plan Gratis pauses, from the allowances (never typed). */
export function gratisPauses(): string[] {
  const g = PLAN_ALLOWANCES.gratis
  const n = PLAN_ALLOWANCES.negocio
  return [
    'La sincronización con Mercado Libre',
    'El chequeo mensual de tu tienda',
    `El chat de tu tienda baja de ${n.chatAnswersPerMonth.toLocaleString('en-US')} a ${g.chatAnswersPerMonth.toLocaleString('en-US')} respuestas al mes`,
    `Las fotos con IA bajan de ${n.photosPerMonth} a ${g.photosPerMonth} al mes`,
    'Aparece un pequeño enlace «Tienda impulsada por Miyagi Sánchez» al pie de tu tienda',
  ]
}

/** What a Plan Gratis shop gains with the Plan Negocio, from the allowances (never typed). */
export function negocioGains(): string[] {
  const g = PLAN_ALLOWANCES.gratis
  const n = PLAN_ALLOWANCES.negocio
  return [
    'Conectar tu propio dominio (tunegocio.com), si tienes uno',
    'La sincronización con Mercado Libre',
    'El chequeo mensual de tu tienda',
    `${n.chatAnswersPerMonth.toLocaleString('en-US')} respuestas al mes en el chat de tu tienda (hoy tienes ${g.chatAnswersPerMonth.toLocaleString('en-US')})`,
    `${n.photosPerMonth} fotos con IA al mes (hoy tienes ${g.photosPerMonth})`,
    'Tu tienda sin el enlace «Tienda impulsada por Miyagi Sánchez»',
  ]
}

function monthlyButton(plan: PlanState, now: Date): NegocioButton {
  const firstCharge = monthlyFirstChargeAt(plan, now)
  return {
    cadence: 'month',
    label: MONTHLY_BUTTON_LABEL,
    title: `Mensual: ${formatPesos(NEGOCIO_PRICE_MONTHLY_MXN)} al mes`,
    lines: [
      'Es una suscripción: se cobra sola cada mes a tu tarjeta, sin que hagas nada.',
      firstCharge
        ? `Hoy solo guardas tu tarjeta. El primer cobro llega el ${formatPlanDate(new Date(firstCharge * 1000).toISOString())}, cuando ya terminaron tus días gratis.`
        : 'El primer cobro es hoy.',
      'La cancelas cuando quieras desde esta misma página, y sigues con el Plan Negocio hasta el final del mes que pagaste.',
    ],
  }
}

function yearlyButton(plan: PlanState, now: Date): NegocioButton {
  const saving = NEGOCIO_PRICE_MONTHLY_MXN * 12 - NEGOCIO_PRICE_YEARLY_MXN
  const startsAt = plan.reason === 'trial' && plan.endsAt && Date.parse(plan.endsAt) > now.getTime() ? plan.endsAt : null
  return {
    cadence: 'year',
    label: YEARLY_BUTTON_LABEL,
    title: `Anual: ${formatPesos(NEGOCIO_PRICE_YEARLY_MXN)} por ${NEGOCIO_YEARLY_MONTHS} meses`,
    lines: [
      'Un solo pago, también a meses sin intereses con tu tarjeta.',
      startsAt
        ? `Se cobra hoy, pero tus ${NEGOCIO_YEARLY_MONTHS} meses empiezan cuando terminan tus días gratis, el ${formatPlanDate(startsAt)}.`
        : `Tus ${NEGOCIO_YEARLY_MONTHS} meses empiezan hoy.`,
      'No se renueva solo: cuando termine, tú decides si pagas otro año.',
      ...(saving > 0 ? [`Ahorras ${formatPesos(saving)} frente a pagar mes a mes.`] : []),
    ],
  }
}

function renewButton(plan: PlanState): NegocioButton {
  const until = plan.endsAt ? formatPlanDate(addMonthsClamped(new Date(plan.endsAt), NEGOCIO_YEARLY_MONTHS).toISOString()) : null
  return {
    cadence: 'year',
    label: RENEW_BUTTON_LABEL,
    title: `Otro año: ${formatPesos(NEGOCIO_PRICE_YEARLY_MXN)}`,
    lines: [
      'Un solo pago, también a meses sin intereses.',
      until ? `Se suma al final de lo que ya tienes: tu Plan Negocio seguiría hasta el ${until}.` : 'Se suma al final de lo que ya tienes.',
    ],
  }
}

const PAUSES_TITLE = 'Con el Plan Gratis se pausa, hasta que contrates el Plan Negocio:'

export function negocioPageView(plan: PlanState, now: Date = new Date()): NegocioPageView {
  const base = { manage: false, afterTrial: null, pauses: null } as const
  switch (plan.reason) {
    case 'unavailable':
      return { ...base, headline: 'No pudimos confirmar tu suscripción. Intenta de nuevo en unos minutos.', tone: 'unknown', buttons: [] }
    case 'trial': {
      const n = daysLeft(plan, now) ?? 0
      const until = plan.endsAt ? `, hasta el ${formatPlanDate(plan.endsAt)}` : ''
      return {
        headline: `Tienes el Plan Negocio gratis: te ${n === 1 ? 'queda 1 día' : `quedan ${n} días`}${until}.`,
        tone: 'trial',
        buttons: [monthlyButton(plan, now), yearlyButton(plan, now)],
        manage: false,
        afterTrial: {
          title: '¿Qué pasa cuando terminan tus días gratis?',
          body: 'Tu tienda no se cierra. Pasa sola al Plan Gratis y sigue en línea, con tus productos, tu dirección y tus ventas. No tienes que hacer nada ni dar ninguna tarjeta.',
        },
        pauses: { title: PAUSES_TITLE, items: gratisPauses() },
      }
    }
    case 'one_time':
      return {
        ...base,
        headline: plan.endsAt ? `Tienes el Plan Negocio pagado hasta el ${formatPlanDate(plan.endsAt)}.` : 'Tienes el Plan Negocio.',
        tone: 'ok',
        buttons: [renewButton(plan)],
      }
    case 'subscription':
      return {
        ...base,
        headline: 'Tienes el Plan Negocio mensual: se cobra solo cada mes a tu tarjeta.',
        tone: 'ok',
        buttons: [],
        manage: true,
      }
    case 'comp':
      return { ...base, headline: 'Tienes el Plan Negocio.', tone: 'ok', buttons: [] }
    case 'trial_ended':
      return {
        ...base,
        headline: 'Tu tienda está abierta en el Plan Gratis. Tu prueba del Plan Negocio terminó.',
        tone: 'ok',
        buttons: [monthlyButton(plan, now), yearlyButton(plan, now)],
        pauses: { title: 'Lo que vuelve al contratar el Plan Negocio:', items: negocioGains() },
      }
    case 'none':
    default:
      return {
        ...base,
        headline: 'Tu tienda está abierta en el Plan Gratis.',
        tone: 'ok',
        buttons: [monthlyButton(plan, now), yearlyButton(plan, now)],
        pauses: { title: 'Lo que sumas con el Plan Negocio:', items: negocioGains() },
      }
  }
}
