/**
 * lib/negocio-page.ts — what «Tu suscripción» (/shop/manage/negocio) shows for a plan (epic 08 · plans-gratis-negocio
 * S3.2, README D15; copy rewritten 2026-11-05; both paid plans since plan-tienda-three-free-months S2.3). Pure: the
 * page and its spec both read the decision from here, so the headline, the explanations and the buy buttons can never
 * disagree about a plan.
 *
 * Daniel, 2026-11-05: every button says what it is (a subscription that charges itself, or one payment), when the
 * first charge or the paid months start, and how to cancel. Since plan-tienda the page sells TWO plans, Plan Tienda
 * and Plan Negocio:
 *   - a trial shop, a legacy Plan Gratis shop and an unpaid shop are offered both;
 *   - an unpaid shop is told plainly that its shop needs a plan;
 *   - a Plan Tienda shop sees its plan and «Pasar al Plan Negocio» (and, on a paid year, another year);
 *   - what happens when the trial ends depends on the legacy marker: a legacy shop falls back to Plan Gratis, a new
 *     shop must choose a plan or is paused (sprint 3; sprints 2 and 3 deploy together, README D20).
 *
 * The buttons mirror what the checkout rules accept (`decideNegocioCheckout`, `decideTiendaCheckout`) from the plan
 * alone, so the page never offers a purchase the server would refuse for that plan: nothing on Negocio by comp or
 * subscription, only a yearly renewal on a dated grant, no Plan Tienda under any paid Plan Negocio, no monthly Plan
 * Tienda over a paid Tienda year, and nothing at all when the plan could not be read ("could not look" ≠ "none" —
 * offering to pay again could double-charge). (The Tienda route also re-reads both subscriptions; a refusal there
 * shows the server's own sentence.)
 *
 * Prices come from `lib/negocio-pricing.ts` and `lib/tienda-pricing.ts` through `formatPesos`, allowances from
 * `PLAN_ALLOWANCES`; nothing is typed.
 */
import { addMonthsClamped, daysLeft, type PlanState } from './plan'
import { NEGOCIO_PRICE_MONTHLY_MXN, NEGOCIO_PRICE_YEARLY_MXN, NEGOCIO_YEARLY_MONTHS } from './negocio-pricing'
import { TIENDA_PRICE_MONTHLY_MXN, TIENDA_PRICE_YEARLY_MXN, TIENDA_YEARLY_MONTHS } from './tienda-pricing'
import { formatPesos, tiendaIncludes, yearlyAsMonthly } from './pricing-catalog'
import { PLAN_ALLOWANCES } from './plan-allowances'
import { monthlyFirstChargeAt } from './negocio-checkout-rules'
import type { PaidPlan } from './plan-kind'

export type NegocioCadence = 'month' | 'year'

/** One way to pay, with the sentences that say what it is and what happens if you pay today. `plan` picks the
 *  checkout route the button posts to (`/api/sell/<plan>/checkout`). */
export type PlanButton = { plan: PaidPlan; cadence: NegocioCadence; label: string; title: string; lines: string[] }
/** The first name of a button, from when the page sold Negocio only. */
export type NegocioButton = PlanButton

/** The buttons of one plan, under a heading that says what buying it does for this shop. */
export type PlanOffer = { plan: PaidPlan; title: string; intro: string; buttons: PlanButton[] }

export type NegocioPageView = {
  /** Plain-Spanish line saying which plan the shop is on. */
  headline: string
  /** `ok` = a plan we are sure of; `unknown` = we could not read it (shown as a warning). */
  tone: 'ok' | 'trial' | 'unknown'
  /** A second plain line under the headline, or null (an unpaid shop is told it needs a plan). */
  notice: string | null
  /** The plans offered, Plan Tienda first, each with its buttons. */
  offers: PlanOffer[]
  /** Every button of every offer, in order — the flat list the spec and the agents' mirror read. */
  buttons: PlanButton[]
  /** The monthly subscriber can open Stripe's page to change the card, see invoices or cancel. */
  manage: boolean
  /** Which monthly plan the manage button is for (its text names the plan), or null. */
  managePlan: PaidPlan | null
  /** What happens when the free days end — only during the trial — and what the shop keeps on the plan it falls to. */
  afterTrial: { title: string; body: string; keeps: { title: string; items: string[] } | null } | null
  /** What pauses (or what Plan Negocio adds), shown while on the trial, legacy Gratis or unpaid. */
  pauses: { title: string; items: string[] } | null
}

export const MONTHLY_BUTTON_LABEL = `Pagar ${formatPesos(NEGOCIO_PRICE_MONTHLY_MXN)} al mes`
export const YEARLY_BUTTON_LABEL = `Pagar ${formatPesos(NEGOCIO_PRICE_YEARLY_MXN)} por un año`
export const RENEW_BUTTON_LABEL = `Pagar otro año: ${formatPesos(NEGOCIO_PRICE_YEARLY_MXN)}`
export const TIENDA_MONTHLY_BUTTON_LABEL = `Pagar ${formatPesos(TIENDA_PRICE_MONTHLY_MXN)} al mes`
export const TIENDA_YEARLY_BUTTON_LABEL = `Pagar ${formatPesos(TIENDA_PRICE_YEARLY_MXN)} por un año`
export const TIENDA_RENEW_BUTTON_LABEL = `Pagar otro año: ${formatPesos(TIENDA_PRICE_YEARLY_MXN)}`

/** `4 de noviembre de 2027` in es-MX, computed in UTC so a server's timezone never moves the date. */
export function formatPlanDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/** What pauses when a shop goes from Plan Negocio (or its trial) to `lower` — Plan Gratis or Plan Tienda, which have
 *  the same features — from the allowances (never typed). */
export function gratisPauses(lower: 'gratis' | 'tienda' = 'gratis'): string[] {
  const g = PLAN_ALLOWANCES[lower]
  const n = PLAN_ALLOWANCES.negocio
  return [
    'La sincronización con Mercado Libre',
    'El chequeo mensual de tu tienda',
    `El chat de tu tienda baja de ${n.chatAnswersPerMonth.toLocaleString('en-US')} a ${g.chatAnswersPerMonth.toLocaleString('en-US')} respuestas al mes`,
    `Las fotos con IA bajan de ${n.photosPerMonth} a ${g.photosPerMonth} al mes`,
    'Aparece un pequeño enlace «Tienda impulsada por Miyagi Sánchez» al pie de tu tienda',
  ]
}

/** What a Plan Gratis, Plan Tienda or unpaid shop gains with the Plan Negocio, from the allowances (never typed). */
export function negocioGains(from: 'gratis' | 'tienda' | 'unpaid' = 'gratis'): string[] {
  const g = PLAN_ALLOWANCES[from]
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

/** The end of a trial that is still running, or null. */
function liveTrialEnd(plan: PlanState, now: Date): string | null {
  return plan.reason === 'trial' && plan.endsAt && Date.parse(plan.endsAt) > now.getTime() ? plan.endsAt : null
}

function firstChargeLine(plan: PlanState, now: Date): string {
  const firstCharge = monthlyFirstChargeAt(plan, now)
  return firstCharge
    ? `Hoy solo guardas tu tarjeta. El primer cobro llega el ${formatPlanDate(new Date(firstCharge * 1000).toISOString())}, cuando ya terminaron tus días gratis.`
    : 'El primer cobro es hoy.'
}

function startsLine(plan: PlanState, now: Date, months: number): string {
  const startsAt = liveTrialEnd(plan, now)
  return startsAt
    ? `Se cobra hoy, pero tus ${months} meses empiezan cuando terminan tus días gratis, el ${formatPlanDate(startsAt)}.`
    : `Tus ${months} meses empiezan hoy.`
}

/**
 * What buying Plan Negocio does to a Plan Tienda the shop already holds — said on the button, because the merchant
 * is paying twice for a while otherwise without knowing it:
 *   - over a MONTHLY Plan Tienda, either Negocio cadence cancels it at the end of the month already paid (D19);
 *   - over a paid Tienda YEAR, a Negocio year moves the remaining Tienda time to after it (D4), but under a monthly
 *     Negocio the Tienda year keeps running (D4's documented deviation: the months are not known in advance).
 */
function overTiendaLine(plan: PlanState, cadence: NegocioCadence): string[] {
  if (plan.reason === 'tienda_subscription') return ['Tu Plan Tienda mensual se cancela solo: termina al final del mes que ya pagaste, sin más cobros.']
  if (plan.reason !== 'tienda_one_time') return []
  return cadence === 'year'
    ? [`Tu Plan Tienda pagado no se pierde: lo que te queda se recorre y empieza cuando terminen estos ${NEGOCIO_YEARLY_MONTHS} meses.`]
    : ['Ojo: tu Plan Tienda pagado sigue contando sus días mientras tengas el Plan Negocio mensual.']
}

function monthlyButton(plan: PlanState, now: Date): PlanButton {
  return {
    plan: 'negocio',
    cadence: 'month',
    label: MONTHLY_BUTTON_LABEL,
    title: `Mensual: ${formatPesos(NEGOCIO_PRICE_MONTHLY_MXN)} al mes`,
    lines: [
      'Es una suscripción: se cobra sola cada mes a tu tarjeta, sin que hagas nada.',
      firstChargeLine(plan, now),
      'La cancelas cuando quieras desde esta misma página, y sigues con el Plan Negocio hasta el final del mes que pagaste.',
      ...overTiendaLine(plan, 'month'),
    ],
  }
}

function yearlyButton(plan: PlanState, now: Date): PlanButton {
  const saving = NEGOCIO_PRICE_MONTHLY_MXN * 12 - NEGOCIO_PRICE_YEARLY_MXN
  return {
    plan: 'negocio',
    cadence: 'year',
    label: YEARLY_BUTTON_LABEL,
    title: `Anual: ${formatPesos(NEGOCIO_PRICE_YEARLY_MXN)} por ${NEGOCIO_YEARLY_MONTHS} meses`,
    lines: [
      'Un solo pago, también a meses sin intereses con tu tarjeta.',
      startsLine(plan, now, NEGOCIO_YEARLY_MONTHS),
      'No se renueva solo: cuando termine, tú decides si pagas otro año.',
      ...(saving > 0 ? [`Ahorras ${formatPesos(saving)} frente a pagar mes a mes.`] : []),
      ...overTiendaLine(plan, 'year'),
    ],
  }
}

function renewButton(plan: PlanState): PlanButton {
  const until = plan.endsAt ? formatPlanDate(addMonthsClamped(new Date(plan.endsAt), NEGOCIO_YEARLY_MONTHS).toISOString()) : null
  return {
    plan: 'negocio',
    cadence: 'year',
    label: RENEW_BUTTON_LABEL,
    title: `Otro año: ${formatPesos(NEGOCIO_PRICE_YEARLY_MXN)}`,
    lines: [
      'Un solo pago, también a meses sin intereses.',
      until ? `Se suma al final de lo que ya tienes: tu Plan Negocio seguiría hasta el ${until}.` : 'Se suma al final de lo que ya tienes.',
    ],
  }
}

function tiendaMonthlyButton(plan: PlanState, now: Date): PlanButton {
  return {
    plan: 'tienda',
    cadence: 'month',
    label: TIENDA_MONTHLY_BUTTON_LABEL,
    title: `Mensual: ${formatPesos(TIENDA_PRICE_MONTHLY_MXN)} al mes`,
    lines: [
      'Es una suscripción: se cobra sola cada mes a tu tarjeta, sin que hagas nada.',
      firstChargeLine(plan, now),
      'La cancelas cuando quieras desde esta misma página, y sigues con el Plan Tienda hasta el final del mes que pagaste.',
    ],
  }
}

function tiendaYearlyButton(plan: PlanState, now: Date): PlanButton {
  const saving = TIENDA_PRICE_MONTHLY_MXN * 12 - TIENDA_PRICE_YEARLY_MXN
  return {
    plan: 'tienda',
    cadence: 'year',
    label: TIENDA_YEARLY_BUTTON_LABEL,
    title: `Anual: ${formatPesos(TIENDA_PRICE_YEARLY_MXN)} por ${TIENDA_YEARLY_MONTHS} meses`,
    lines: [
      `Un solo pago con tarjeta: te sale en ${formatPesos(yearlyAsMonthly(TIENDA_PRICE_YEARLY_MXN))} al mes.`,
      startsLine(plan, now, TIENDA_YEARLY_MONTHS),
      'No se renueva solo: cuando termine, tú decides si pagas otro año.',
      ...(saving > 0 ? [`Ahorras ${formatPesos(saving)} frente a pagar mes a mes.`] : []),
    ],
  }
}

function tiendaRenewButton(plan: PlanState): PlanButton {
  const until = plan.endsAt ? formatPlanDate(addMonthsClamped(new Date(plan.endsAt), TIENDA_YEARLY_MONTHS).toISOString()) : null
  return {
    plan: 'tienda',
    cadence: 'year',
    label: TIENDA_RENEW_BUTTON_LABEL,
    title: `Otro año: ${formatPesos(TIENDA_PRICE_YEARLY_MXN)}`,
    lines: [
      'Un solo pago con tarjeta.',
      until ? `Se suma al final de lo que ya tienes: tu Plan Tienda seguiría hasta el ${until}.` : 'Se suma al final de lo que ya tienes.',
    ],
  }
}

const TIENDA_INTRO = `Tu tienda en línea, sin comisión por venta. Desde ${formatPesos(yearlyAsMonthly(TIENDA_PRICE_YEARLY_MXN))} al mes, IVA incluido.`
const NEGOCIO_INTRO = 'Tu propio dominio, Mercado Libre y mucha más ayuda de la IA. IVA incluido.'

function tiendaOffer(title: string, buttons: PlanButton[]): PlanOffer {
  return { plan: 'tienda', title, intro: TIENDA_INTRO, buttons }
}
function negocioOffer(title: string, buttons: PlanButton[]): PlanOffer {
  return { plan: 'negocio', title, intro: NEGOCIO_INTRO, buttons }
}

/** Both plans, both cadences: what a trial, a legacy or an unpaid shop may buy. */
function bothPlans(plan: PlanState, now: Date): PlanOffer[] {
  return [
    tiendaOffer('Contrata el Plan Tienda', [tiendaMonthlyButton(plan, now), tiendaYearlyButton(plan, now)]),
    negocioOffer('Contrata el Plan Negocio', [monthlyButton(plan, now), yearlyButton(plan, now)]),
  ]
}

const PAUSES_TITLE = 'Con el Plan Gratis se pausa, hasta que contrates el Plan Negocio:'

const UNKNOWN_HEADLINE = 'No pudimos confirmar tu suscripción. Intenta de nuevo en unos minutos.'

export type NegocioPageOptions = {
  /**
   * The shop carries the legacy marker (README D2; `readPlanLegacyState(metadata) !== 'absent'`, the same reading
   * `derivePlan` uses, so a damaged marker counts as legacy). It decides only what the TRIAL view says happens at
   * its end: legacy falls back to Plan Gratis, a new shop must choose a plan. Default false — a page that forgets to
   * pass it tells a legacy merchant to pick a plan (they still can), never a new merchant that they keep Plan Gratis.
   */
  legacy?: boolean
  /**
   * The shop holds `plan_pause` (`hasPlanPause`, lib/plan-pause.ts): the plan job paused it because its free months
   * ended with no plan (plan-tienda S3.3). The page then says so plainly, and how to bring it back. Only the plan's
   * own record is read: an admin pause is not this, and the page does not guess at it.
   */
  planPaused?: boolean
}

/** What «Tu suscripción» says about a shop paused for lack of a plan (plan-tienda S3.4). */
export const PLAN_PAUSED_HEADLINE = 'Tu tienda está en pausa porque no tiene un plan.'
export const PLAN_PAUSED_NOTICE =
  'No se borró nada: tus productos, tu dirección y tus ventas están guardados. Elige el Plan Tienda o el Plan Negocio aquí abajo y tu tienda vuelve a estar en línea en cuanto recibamos tu pago.'
/** Paid, but the restore has not landed yet (or failed and a person is on it). */
export const PLAN_PAUSED_PAID_NOTICE =
  'Recibimos tu pago y tu tienda se está reabriendo. Si en unos minutos sigue en pausa, escríbenos y la reactivamos.'

export function negocioPageView(plan: PlanState, now: Date = new Date(), opts: NegocioPageOptions = {}): NegocioPageView {
  const base = negocioPlanView(plan, now, opts)
  // A plan we could not read says only that: never "paused" or "reopening" over a guess.
  if (!opts.planPaused || plan.reason === 'unavailable') return base
  if (plan.plan === 'unpaid') return { ...base, headline: PLAN_PAUSED_HEADLINE, notice: PLAN_PAUSED_NOTICE }
  return { ...base, notice: PLAN_PAUSED_PAID_NOTICE }
}

function negocioPlanView(plan: PlanState, now: Date, opts: NegocioPageOptions): NegocioPageView {
  const view = (v: Omit<NegocioPageView, 'buttons' | 'manage' | 'managePlan' | 'notice' | 'afterTrial' | 'pauses'> & Partial<NegocioPageView>): NegocioPageView => ({
    notice: null,
    manage: false,
    managePlan: null,
    afterTrial: null,
    pauses: null,
    ...v,
    buttons: v.offers.flatMap((o) => o.buttons),
  })
  switch (plan.reason) {
    case 'unavailable':
      return view({ headline: UNKNOWN_HEADLINE, tone: 'unknown', offers: [] })
    case 'trial': {
      const n = daysLeft(plan, now) ?? 0
      const until = plan.endsAt ? `, hasta el ${formatPlanDate(plan.endsAt)}` : ''
      const includes = tiendaIncludes().map((line) => line.es)
      return view({
        headline: `Tienes el Plan Negocio gratis: te ${n === 1 ? 'queda 1 día' : `quedan ${n} días`}${until}.`,
        tone: 'trial',
        offers: bothPlans(plan, now),
        afterTrial: opts.legacy
          ? {
              title: '¿Qué pasa cuando terminan tus días gratis?',
              body: 'Tu tienda no se cierra. Pasa sola al Plan Gratis y sigue en línea, con tus productos, tu dirección y tus ventas. No tienes que hacer nada ni dar ninguna tarjeta.',
              keeps: { title: 'Te quedas con el Plan Gratis, para siempre:', items: includes },
            }
          : {
              title: '¿Qué pasa cuando terminan tus días gratis?',
              body: 'Eliges con qué plan sigues: el Plan Tienda o el Plan Negocio. Si no eliges ninguno, tu tienda se pausa: no se borra nada, tus productos, tu dirección y tus ventas se quedan guardados, y vuelve en cuanto pagas un plan.',
              keeps: { title: 'Con el Plan Tienda tienes:', items: includes },
            },
        pauses: opts.legacy
          ? { title: PAUSES_TITLE, items: gratisPauses('gratis') }
          : { title: 'Si sigues con el Plan Tienda, se pausa lo del Plan Negocio:', items: gratisPauses('tienda') },
      })
    }
    case 'one_time':
      return view({
        headline: plan.endsAt ? `Tienes el Plan Negocio pagado hasta el ${formatPlanDate(plan.endsAt)}.` : 'Tienes el Plan Negocio.',
        tone: 'ok',
        offers: [negocioOffer('Renueva tu Plan Negocio', [renewButton(plan)])],
      })
    case 'subscription':
      return view({
        headline: 'Tienes el Plan Negocio mensual: se cobra solo cada mes a tu tarjeta.',
        tone: 'ok',
        offers: [],
        manage: true,
        managePlan: 'negocio',
      })
    case 'comp':
      return view({ headline: 'Tienes el Plan Negocio.', tone: 'ok', offers: [] })
    case 'trial_ended':
      return view({
        headline: 'Tu tienda está abierta en el Plan Gratis. Tu prueba del Plan Negocio terminó.',
        tone: 'ok',
        offers: bothPlans(plan, now),
        pauses: { title: 'Lo que vuelve al contratar el Plan Negocio:', items: negocioGains('gratis') },
      })
    case 'legacy':
      return view({
        headline: 'Tu tienda está abierta en el Plan Gratis.',
        tone: 'ok',
        offers: bothPlans(plan, now),
        pauses: { title: 'Lo que sumas con el Plan Negocio:', items: negocioGains('gratis') },
      })
    case 'tienda_one_time':
      return view({
        headline: plan.endsAt ? `Tienes el Plan Tienda pagado hasta el ${formatPlanDate(plan.endsAt)}.` : 'Tienes el Plan Tienda.',
        tone: 'ok',
        // A paid Tienda year may add another year; monthly Tienda is refused over it (decideTiendaCheckout).
        offers: [
          negocioOffer('Pasar al Plan Negocio', [monthlyButton(plan, now), yearlyButton(plan, now)]),
          tiendaOffer('Renueva tu Plan Tienda', [tiendaRenewButton(plan)]),
        ],
        pauses: { title: 'Lo que sumas con el Plan Negocio:', items: negocioGains('tienda') },
      })
    case 'tienda_subscription':
      return view({
        headline: 'Tienes el Plan Tienda mensual: se cobra solo cada mes a tu tarjeta.',
        tone: 'ok',
        offers: [negocioOffer('Pasar al Plan Negocio', [monthlyButton(plan, now), yearlyButton(plan, now)])],
        manage: true,
        managePlan: 'tienda',
        pauses: { title: 'Lo que sumas con el Plan Negocio:', items: negocioGains('tienda') },
      })
    case 'unpaid':
      return view({
        headline: 'Tu tienda no tiene un plan activo.',
        tone: 'ok',
        notice: 'Tu tienda necesita un plan. Elige el Plan Tienda o el Plan Negocio; si ya pagaste, recarga la página en unos minutos.',
        offers: bothPlans(plan, now),
        pauses: { title: 'Lo que incluye el Plan Negocio:', items: negocioGains('unpaid') },
      })
    default: {
      // Exhaustive: a new PlanReason is a type error on the next line until it has its own sentence. At run time a
      // reason this page does not know is shown as "could not confirm" — never a guessed plan, and never a crash.
      const unhandled: never = plan.reason
      void unhandled
      return view({ headline: UNKNOWN_HEADLINE, tone: 'unknown', offers: [] })
    }
  }
}
