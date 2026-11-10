import { expect, test } from '@playwright/test'
import { negocioPageView, gratisPauses, MONTHLY_BUTTON_LABEL, YEARLY_BUTTON_LABEL, RENEW_BUTTON_LABEL } from '../lib/negocio-page'
import { NEGOCIO_PRICE_MONTHLY_MXN, NEGOCIO_PRICE_YEARLY_MXN } from '../lib/negocio-pricing'
import { PLAN_ALLOWANCES } from '../lib/plan-allowances'
import type { PlanState } from '../lib/plan'

/**
 * plans-gratis-negocio S3.2 — what «Tu suscripción» shows per plan (README D15), with the copy Daniel asked for on
 * 2026-11-05: the shop never closes after the trial, what the Plan Gratis keeps and pauses, and what each way of paying
 * does and when it starts. The buttons mirror what the checkout route accepts, so the page never offers a purchase the
 * server then refuses.
 */

const NOW = new Date('2026-11-04T12:00:00Z')
const st = (plan: PlanState['plan'], reason: PlanState['reason'], endsAt: string | null = null): PlanState => ({ plan, reason, endsAt })
const cadences = (p: PlanState) => negocioPageView(p, NOW).buttons.map((b) => b.cadence)
const in5 = new Date(NOW.getTime() + 5 * 86_400_000).toISOString()

test.describe('«Tu suscripción» view', () => {
  test('the button labels are built from lib/negocio-pricing.ts', () => {
    expect(MONTHLY_BUTTON_LABEL).toBe(`Pagar $${NEGOCIO_PRICE_MONTHLY_MXN} al mes`)
    expect(YEARLY_BUTTON_LABEL).toBe(`Pagar $${NEGOCIO_PRICE_YEARLY_MXN.toLocaleString('en-US')} por un año`)
    expect(RENEW_BUTTON_LABEL).toContain(NEGOCIO_PRICE_YEARLY_MXN.toLocaleString('en-US'))
  })

  test('the trial: days left with the date, the shop never closes, and what pauses on the Plan Gratis', () => {
    const v = negocioPageView(st('trial', 'trial', in5), NOW)
    expect(v.headline).toBe('Tienes el Plan Negocio gratis: te quedan 5 días, hasta el 9 de noviembre de 2026.')
    expect(v.tone).toBe('trial')
    expect(v.afterTrial?.body).toContain('Tu tienda no se cierra')
    expect(v.afterTrial?.body).toContain('Plan Gratis')
    expect(v.pauses?.items).toEqual(gratisPauses())
    // The allowances are read, never typed.
    expect(v.pauses?.items.join(' ')).toContain(`a ${PLAN_ALLOWANCES.gratis.chatAnswersPerMonth} respuestas`)
    expect(cadences(st('trial', 'trial', in5))).toEqual(['month', 'year'])
    const in1 = new Date(NOW.getTime() + 3_600_000).toISOString()
    expect(negocioPageView(st('trial', 'trial', in1), NOW).headline).toContain('te queda 1 día,')
  })

  test('each button says what it is and when it starts: during the trial nothing is lost', () => {
    const [month, year] = negocioPageView(st('trial', 'trial', in5), NOW).buttons
    expect(month.lines.join(' ')).toContain('se cobra sola cada mes')
    expect(month.lines.join(' ')).toContain('El primer cobro llega el 9 de noviembre de 2026, cuando ya terminaron tus días gratis.')
    expect(month.lines.join(' ')).toContain('sigues con el Plan Negocio hasta el final del mes que pagaste')
    expect(year.lines.join(' ')).toContain('Un solo pago')
    expect(year.lines.join(' ')).toContain('meses empiezan cuando terminan tus días gratis, el 9 de noviembre de 2026.')
    expect(year.lines.join(' ')).toContain('No se renueva solo')
    expect(year.lines.join(' ')).toContain(`Ahorras $${(NEGOCIO_PRICE_MONTHLY_MXN * 12 - NEGOCIO_PRICE_YEARLY_MXN).toLocaleString('en-US')}`)
  })

  test('on Gratis: open on the Plan Gratis, both buttons, and payment starts today', () => {
    for (const reason of ['legacy', 'trial_ended'] as const) {
      const v = negocioPageView(st('gratis', reason), NOW)
      expect(v.headline).toContain('abierta en el Plan Gratis')
      expect(v.afterTrial).toBeNull()
      expect(v.buttons.map((b) => b.cadence)).toEqual(['month', 'year'])
      expect(v.buttons[0].lines).toContain('El primer cobro es hoy.')
      expect(v.buttons[1].lines.join(' ')).toContain('meses empiezan hoy')
    }
  })

  test('one_time: shows the end date and offers ONLY another year, added after the current end', () => {
    const v = negocioPageView(st('negocio', 'one_time', '2027-11-04T12:00:00.000Z'), NOW)
    expect(v.headline).toBe('Tienes el Plan Negocio pagado hasta el 4 de noviembre de 2027.')
    expect(v.buttons.map((b) => b.label)).toEqual([RENEW_BUTTON_LABEL])
    expect(v.buttons[0].lines.join(' ')).toContain('hasta el 4 de noviembre de 2028')
  })

  test('a monthly subscriber gets the manage-or-cancel button and nothing to buy; a comp gets neither', () => {
    const sub = negocioPageView(st('negocio', 'subscription'), NOW)
    expect(sub.headline).toContain('se cobra solo cada mes')
    expect(sub.manage).toBe(true)
    expect(sub.buttons).toEqual([])
    const comp = negocioPageView(st('negocio', 'comp'), NOW)
    expect(comp.manage).toBe(false)
    expect(comp.buttons).toEqual([])
  })

  test('unavailable: says it could not confirm, and offers no purchase (could not look is not none)', () => {
    const v = negocioPageView(st('gratis', 'unavailable'), NOW)
    expect(v.headline).toContain('No pudimos confirmar tu suscripción')
    expect(v.tone).toBe('unknown')
    expect(v.buttons).toEqual([])
    expect(v.manage).toBe(false)
  })
})

test.describe('Plan Tienda and "no plan" on «Tu suscripción» (plan-tienda S1.1)', () => {
  test('a Tienda shop is told it is on Plan Tienda — never «Plan Gratis» — and is offered nothing to buy yet', () => {
    const dated = negocioPageView(st('tienda', 'tienda_one_time', '2027-11-04T12:00:00.000Z'), NOW)
    expect(dated.headline).toBe('Tienes el Plan Tienda pagado hasta el 4 de noviembre de 2027.')
    const monthly = negocioPageView(st('tienda', 'tienda_subscription'), NOW)
    expect(monthly.headline).toContain('Plan Tienda mensual')
    for (const v of [dated, monthly]) {
      expect(v.headline).not.toContain('Gratis')
      expect(v.tone).toBe('ok')
      expect(v.buttons).toEqual([])
      expect(v.manage).toBe(false)
    }
  })

  test('an unpaid shop is told it has no plan — never «Plan Gratis» — and may pay Negocio today', () => {
    const v = negocioPageView(st('unpaid', 'unpaid'), NOW)
    expect(v.headline).toBe('Tu tienda no tiene un plan activo.')
    expect(v.headline).not.toContain('Gratis')
    expect(v.buttons.map((b) => b.cadence)).toEqual(['month', 'year'])
    expect(v.buttons[0].lines).toContain('El primer cobro es hoy.')
  })

  test('no reason prints «undefined» or leaves the headline empty', () => {
    const reasons = ['comp', 'one_time', 'subscription', 'trial', 'tienda_one_time', 'tienda_subscription', 'trial_ended', 'legacy', 'unpaid', 'unavailable'] as const
    for (const reason of reasons) {
      const v = negocioPageView(st('gratis', reason, '2027-01-01T00:00:00.000Z'), NOW)
      expect(v.headline.length).toBeGreaterThan(10)
      expect(JSON.stringify(v)).not.toContain('undefined')
    }
  })
})
