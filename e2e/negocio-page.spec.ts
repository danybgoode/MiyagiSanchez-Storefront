import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import {
  negocioPageView,
  gratisPauses,
  MONTHLY_BUTTON_LABEL,
  YEARLY_BUTTON_LABEL,
  RENEW_BUTTON_LABEL,
  TIENDA_MONTHLY_BUTTON_LABEL,
  TIENDA_YEARLY_BUTTON_LABEL,
  TIENDA_RENEW_BUTTON_LABEL,
  type NegocioPageView,
} from '../lib/negocio-page'
import { NEGOCIO_PRICE_MONTHLY_MXN, NEGOCIO_PRICE_YEARLY_MXN } from '../lib/negocio-pricing'
import { TIENDA_PRICE_MONTHLY_MXN, TIENDA_PRICE_YEARLY_MXN } from '../lib/tienda-pricing'
import { PLAN_ALLOWANCES } from '../lib/plan-allowances'
import { decideNegocioCheckout, decideTiendaCheckout } from '../lib/negocio-checkout-rules'
import type { PlanState } from '../lib/plan'

/**
 * plans-gratis-negocio S3.2 — what «Tu suscripción» shows per plan (README D15), with the copy Daniel asked for on
 * 2026-11-05: what each way of paying does and when it starts. Since plan-tienda S2.3 the page sells both paid plans:
 * a trial, legacy or unpaid shop is offered both; an unpaid shop is told it needs a plan; a Tienda shop sees its plan
 * and «Pasar al Plan Negocio». The buttons mirror what the checkout rules accept, so the page never offers a purchase
 * the server then refuses.
 */

const NOW = new Date('2026-11-04T12:00:00Z')
const st = (plan: PlanState['plan'], reason: PlanState['reason'], endsAt: string | null = null): PlanState => ({ plan, reason, endsAt })
const offered = (v: NegocioPageView) => v.buttons.map((b) => `${b.plan}:${b.cadence}`)
const in5 = new Date(NOW.getTime() + 5 * 86_400_000).toISOString()
const BOTH = ['tienda:month', 'tienda:year', 'negocio:month', 'negocio:year']

test.describe('«Tu suscripción» view', () => {
  test('the button labels are built from the two pricing modules', () => {
    expect(MONTHLY_BUTTON_LABEL).toBe(`Pagar $${NEGOCIO_PRICE_MONTHLY_MXN} al mes`)
    expect(YEARLY_BUTTON_LABEL).toBe(`Pagar $${NEGOCIO_PRICE_YEARLY_MXN.toLocaleString('en-US')} por un año`)
    expect(RENEW_BUTTON_LABEL).toContain(NEGOCIO_PRICE_YEARLY_MXN.toLocaleString('en-US'))
    expect(TIENDA_MONTHLY_BUTTON_LABEL).toBe(`Pagar $${TIENDA_PRICE_MONTHLY_MXN} al mes`)
    expect(TIENDA_YEARLY_BUTTON_LABEL).toBe(`Pagar $${TIENDA_PRICE_YEARLY_MXN} por un año`)
    expect(TIENDA_RENEW_BUTTON_LABEL).toContain(String(TIENDA_PRICE_YEARLY_MXN))
  })

  test('the trial of a LEGACY shop: days left, it falls back to Plan Gratis, and both plans are offered', () => {
    const v = negocioPageView(st('trial', 'trial', in5), NOW, { legacy: true })
    expect(v.headline).toBe('Tienes el Plan Negocio gratis: te quedan 5 días, hasta el 9 de noviembre de 2026.')
    expect(v.tone).toBe('trial')
    expect(v.afterTrial?.body).toContain('Tu tienda no se cierra')
    expect(v.afterTrial?.body).toContain('Plan Gratis')
    expect(v.afterTrial?.keeps?.title).toContain('Plan Gratis')
    expect(v.pauses?.items).toEqual(gratisPauses())
    // The allowances are read, never typed.
    expect(v.pauses?.items.join(' ')).toContain(`a ${PLAN_ALLOWANCES.gratis.chatAnswersPerMonth} respuestas`)
    expect(offered(v)).toEqual(BOTH)
    const in1 = new Date(NOW.getTime() + 3_600_000).toISOString()
    expect(negocioPageView(st('trial', 'trial', in1), NOW).headline).toContain('te queda 1 día,')
  })

  test('the trial of a NEW shop: choose a plan or the shop pauses with nothing deleted — never «Plan Gratis»', () => {
    const v = negocioPageView(st('trial', 'trial', in5), NOW, { legacy: false })
    expect(v.afterTrial?.body).toContain('Plan Tienda o el Plan Negocio')
    expect(v.afterTrial?.body).toContain('se pausa')
    expect(v.afterTrial?.body).toContain('no se borra nada')
    expect(JSON.stringify(v)).not.toContain('Plan Gratis')
    expect(offered(v)).toEqual(BOTH)
    // Without the option the page assumes NOT legacy: it never promises Plan Gratis by accident.
    expect(JSON.stringify(negocioPageView(st('trial', 'trial', in5), NOW))).not.toContain('Plan Gratis')
  })

  test('each button says what it is and when it starts: during the trial nothing is lost, on either plan', () => {
    const v = negocioPageView(st('trial', 'trial', in5), NOW)
    const pick = (plan: string, cadence: string) => v.buttons.find((b) => b.plan === plan && b.cadence === cadence)!
    for (const plan of ['negocio', 'tienda']) {
      const month = pick(plan, 'month').lines.join(' ')
      const year = pick(plan, 'year').lines.join(' ')
      expect(month).toContain('se cobra sola cada mes')
      expect(month).toContain('El primer cobro llega el 9 de noviembre de 2026, cuando ya terminaron tus días gratis.')
      expect(year).toContain('Un solo pago')
      expect(year).toContain('meses empiezan cuando terminan tus días gratis, el 9 de noviembre de 2026.')
      expect(year).toContain('No se renueva solo')
    }
    expect(pick('negocio', 'month').lines.join(' ')).toContain('sigues con el Plan Negocio hasta el final del mes que pagaste')
    expect(pick('tienda', 'month').lines.join(' ')).toContain('sigues con el Plan Tienda hasta el final del mes que pagaste')
    expect(pick('negocio', 'year').lines.join(' ')).toContain(`Ahorras $${(NEGOCIO_PRICE_MONTHLY_MXN * 12 - NEGOCIO_PRICE_YEARLY_MXN).toLocaleString('en-US')}`)
    expect(pick('tienda', 'year').lines.join(' ')).toContain(`Ahorras $${TIENDA_PRICE_MONTHLY_MXN * 12 - TIENDA_PRICE_YEARLY_MXN}`)
    // Plan Tienda's year is one card payment — it does NOT promise meses sin intereses.
    expect(pick('tienda', 'year').lines.join(' ')).not.toContain('meses sin intereses')
  })

  test('on legacy Plan Gratis: still reads Plan Gratis, is offered BOTH paid plans, and payment starts today', () => {
    for (const reason of ['legacy', 'trial_ended'] as const) {
      const v = negocioPageView(st('gratis', reason), NOW)
      expect(v.headline).toContain('abierta en el Plan Gratis')
      expect(v.afterTrial).toBeNull()
      expect(offered(v)).toEqual(BOTH)
      for (const b of v.buttons) {
        expect(b.lines.join(' ')).toMatch(/El primer cobro es hoy\.|meses empiezan hoy/)
      }
    }
  })

  test('one_time Negocio: shows the end date and offers ONLY another Negocio year, added after the current end', () => {
    const v = negocioPageView(st('negocio', 'one_time', '2027-11-04T12:00:00.000Z'), NOW)
    expect(v.headline).toBe('Tienes el Plan Negocio pagado hasta el 4 de noviembre de 2027.')
    expect(v.buttons.map((b) => b.label)).toEqual([RENEW_BUTTON_LABEL])
    expect(v.buttons[0].lines.join(' ')).toContain('hasta el 4 de noviembre de 2028')
  })

  test('a monthly Negocio subscriber gets the manage-or-cancel button and nothing to buy; a comp gets neither', () => {
    const sub = negocioPageView(st('negocio', 'subscription'), NOW)
    expect(sub.headline).toContain('se cobra solo cada mes')
    expect(sub).toMatchObject({ manage: true, managePlan: 'negocio', buttons: [] })
    const comp = negocioPageView(st('negocio', 'comp'), NOW)
    expect(comp).toMatchObject({ manage: false, buttons: [] })
  })

  test('unavailable: says it could not confirm, and offers no purchase (could not look is not none)', () => {
    const v = negocioPageView(st('gratis', 'unavailable'), NOW)
    expect(v.headline).toContain('No pudimos confirmar tu suscripción')
    expect(v).toMatchObject({ tone: 'unknown', buttons: [], offers: [], manage: false })
  })
})

test.describe('Plan Tienda and "no plan" on «Tu suscripción» (plan-tienda S2.3)', () => {
  test('a Tienda year: its plan and end date, «Pasar al Plan Negocio», and another Tienda year — never monthly Tienda', () => {
    const v = negocioPageView(st('tienda', 'tienda_one_time', '2027-11-04T12:00:00.000Z'), NOW)
    expect(v.headline).toBe('Tienes el Plan Tienda pagado hasta el 4 de noviembre de 2027.')
    expect(v.offers.map((o) => o.title)).toEqual(['Pasar al Plan Negocio', 'Renueva tu Plan Tienda'])
    expect(offered(v)).toEqual(['negocio:month', 'negocio:year', 'tienda:year'])
    expect(v.buttons.find((b) => b.plan === 'tienda')!.label).toBe(TIENDA_RENEW_BUTTON_LABEL)
    expect(v.buttons.find((b) => b.plan === 'tienda')!.lines.join(' ')).toContain('hasta el 4 de noviembre de 2028')
    // What happens to the paid Tienda year is said on each Negocio button (D4 and its deviation).
    expect(v.buttons.find((b) => b.plan === 'negocio' && b.cadence === 'year')!.lines.join(' ')).toContain('se recorre')
    expect(v.buttons.find((b) => b.plan === 'negocio' && b.cadence === 'month')!.lines.join(' ')).toContain('sigue contando sus días')
    expect(v.manage).toBe(false)
  })

  test('a monthly Tienda: manage-or-cancel for Plan Tienda, and «Pasar al Plan Negocio» that ends the Tienda month (D19)', () => {
    const v = negocioPageView(st('tienda', 'tienda_subscription'), NOW)
    expect(v.headline).toContain('Plan Tienda mensual')
    expect(v).toMatchObject({ manage: true, managePlan: 'tienda' })
    expect(v.offers.map((o) => o.title)).toEqual(['Pasar al Plan Negocio'])
    expect(offered(v)).toEqual(['negocio:month', 'negocio:year'])
    for (const b of v.buttons) expect(b.lines.join(' ')).toContain('Tu Plan Tienda mensual se cancela solo')
  })

  test('an unpaid shop: no plan, a plain line that it needs one, and both plans — never «Plan Gratis»', () => {
    const v = negocioPageView(st('unpaid', 'unpaid'), NOW)
    expect(v.headline).toBe('Tu tienda no tiene un plan activo.')
    expect(v.notice).toContain('Tu tienda necesita un plan')
    expect(JSON.stringify(v)).not.toContain('Plan Gratis')
    expect(offered(v)).toEqual(BOTH)
  })

  test('the page never offers what the checkout rules refuse for that plan (both plans, every reason)', () => {
    const reasons: Array<[PlanState['plan'], PlanState['reason']]> = [
      ['negocio', 'comp'], ['negocio', 'one_time'], ['negocio', 'subscription'], ['trial', 'trial'], ['tienda', 'tienda_one_time'],
      ['tienda', 'tienda_subscription'], ['gratis', 'trial_ended'], ['gratis', 'legacy'], ['unpaid', 'unpaid'], ['gratis', 'unavailable'],
    ]
    for (const [plan, reason] of reasons) {
      const state = st(plan, reason, reason === 'trial' ? in5 : reason.endsWith('one_time') ? '2027-11-04T12:00:00.000Z' : null)
      for (const b of negocioPageView(state, NOW).buttons) {
        const d = b.plan === 'negocio'
          ? decideNegocioCheckout({ cadence: b.cadence, plan: state })
          // The page only knows the plan; the facts it implies are what the plan says.
          : decideTiendaCheckout({ cadence: b.cadence, plan: state, negocioSubscription: reason === 'subscription' ? 'live' : 'none', tiendaSubscription: reason === 'tienda_subscription' ? 'live' : 'none' })
        expect({ reason, button: `${b.plan}:${b.cadence}`, ok: d.ok }).toEqual({ reason, button: `${b.plan}:${b.cadence}`, ok: true })
      }
    }
  })

  test('no reason prints «undefined» or leaves the headline empty', () => {
    const reasons = ['comp', 'one_time', 'subscription', 'trial', 'tienda_one_time', 'tienda_subscription', 'trial_ended', 'legacy', 'unpaid', 'unavailable'] as const
    for (const reason of reasons) {
      for (const legacy of [true, false]) {
        const v = negocioPageView(st('gratis', reason, '2027-01-01T00:00:00.000Z'), NOW, { legacy })
        expect(v.headline.length).toBeGreaterThan(10)
        expect(JSON.stringify(v)).not.toContain('undefined')
      }
    }
  })

  test('each buy button posts to its own plan\'s checkout route; the manage button names the plan', () => {
    const buttons = readFileSync('app/(shell)/shop/manage/negocio/NegocioBuyButtons.tsx', 'utf8')
    expect(buttons).toContain("fetch(b.plan === 'tienda' ? '/api/sell/tienda/checkout' : '/api/sell/negocio/checkout'")
    expect(buttons).toContain('body: JSON.stringify({ cadence: b.cadence })')
    const manage = readFileSync('app/(shell)/shop/manage/negocio/NegocioManageButton.tsx', 'utf8')
    expect(manage).toContain('{PLAN_DISPLAY_NAMES[plan]}')
  })
})

test('«Tu suscripción» never prints a plan for one that could not be read (PR #484 review)', () => {
  const v = negocioPageView(st('gratis', 'unavailable'), NOW)
  expect(v.headline).toBe('No pudimos confirmar tu suscripción. Intenta de nuevo en unos minutos.')
  expect(v.headline).not.toMatch(/Plan (Gratis|Tienda|Negocio)/)
  expect(v).toMatchObject({ tone: 'unknown', buttons: [], manage: false, afterTrial: null, pauses: null })
  // The page file renders that tone as a warning, builds the same state when the read itself throws, and reads the
  // legacy marker the way derivePlan does.
  const page = readFileSync('app/(shell)/shop/manage/negocio/page.tsx', 'utf8')
  expect(page).toContain("view.tone === 'unknown' ? (\n          <Banner variant=\"warning\">{view.headline}</Banner>")
  expect(page).toContain("negocioPageView(mine === 'unavailable' ? { plan: 'gratis', reason: 'unavailable', endsAt: null } : mine.plan, new Date(), { legacy, planPaused })")
  expect(page).toContain("readPlanLegacyState(mine.shop.metadata) !== 'absent'")
})
