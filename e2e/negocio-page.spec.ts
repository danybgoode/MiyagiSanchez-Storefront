import { expect, test } from '@playwright/test'
import { negocioPageView, MONTHLY_BUTTON_LABEL, YEARLY_BUTTON_LABEL, RENEW_BUTTON_LABEL } from '../lib/negocio-page'
import { NEGOCIO_PRICE_MONTHLY_MXN, NEGOCIO_PRICE_YEARLY_MXN } from '../lib/negocio-pricing'
import type { PlanState } from '../lib/plan'

/**
 * plans-gratis-negocio S3.2 — what «Tu suscripción» shows per plan (README D15). The buttons mirror what the checkout
 * route accepts, so the page never offers a purchase the server then refuses.
 */

const NOW = new Date('2026-11-04T12:00:00Z')
const st = (plan: PlanState['plan'], reason: PlanState['reason'], endsAt: string | null = null): PlanState => ({ plan, reason, endsAt })
const cadences = (p: PlanState) => negocioPageView(p, NOW).buttons.map((b) => b.cadence)

test.describe('«Tu suscripción» view', () => {
  test('the button labels are built from lib/negocio-pricing.ts', () => {
    expect(MONTHLY_BUTTON_LABEL).toBe(`$${NEGOCIO_PRICE_MONTHLY_MXN} al mes`)
    expect(YEARLY_BUTTON_LABEL).toBe(`$${NEGOCIO_PRICE_YEARLY_MXN.toLocaleString('en-US')} al año (hasta 6 meses sin intereses)`)
    expect(RENEW_BUTTON_LABEL).toContain(NEGOCIO_PRICE_YEARLY_MXN.toLocaleString('en-US'))
  })

  test('gratis: says so and offers both buttons (also after an ended trial)', () => {
    const v = negocioPageView(st('gratis', 'none'), NOW)
    expect(v.headline).toBe('Estás en Gratis.')
    expect(v.buttons).toEqual([
      { cadence: 'month', label: MONTHLY_BUTTON_LABEL },
      { cadence: 'year', label: YEARLY_BUTTON_LABEL },
    ])
    const ended = negocioPageView(st('gratis', 'trial_ended'), NOW)
    expect(ended.headline).toContain('Gratis')
    expect(ended.headline).toContain('prueba')
    expect(ended.buttons.map((b) => b.cadence)).toEqual(['month', 'year'])
  })

  test('trial: counts the days left (singular at one) and offers both buttons', () => {
    const in5 = new Date(NOW.getTime() + 5 * 86_400_000).toISOString()
    const v = negocioPageView(st('trial', 'trial', in5), NOW)
    expect(v.headline).toBe('Estás en tu prueba de Negocio: te quedan 5 días.')
    expect(v.tone).toBe('trial')
    expect(cadences(st('trial', 'trial', in5))).toEqual(['month', 'year'])
    const in1 = new Date(NOW.getTime() + 3_600_000).toISOString()
    expect(negocioPageView(st('trial', 'trial', in1), NOW).headline).toContain('te quedan 1 día.')
  })

  test('one_time: shows the end date and offers ONLY the yearly renewal', () => {
    const v = negocioPageView(st('negocio', 'one_time', '2027-11-04T12:00:00.000Z'), NOW)
    expect(v.headline).toBe('Negocio activo hasta el 4 de noviembre de 2027.')
    expect(v.buttons).toEqual([{ cadence: 'year', label: RENEW_BUTTON_LABEL }])
  })

  test('subscription and comp: Negocio active, nothing to buy', () => {
    for (const reason of ['subscription', 'comp'] as const) {
      const v = negocioPageView(st('negocio', reason), NOW)
      expect(v.headline).toBe('Negocio activo.')
      expect(v.buttons).toEqual([])
    }
  })

  test('unavailable: says it could not confirm, and offers no purchase (could not look is not none)', () => {
    const v = negocioPageView(st('gratis', 'unavailable'), NOW)
    expect(v.headline).toContain('No pudimos confirmar tu suscripción')
    expect(v.tone).toBe('unknown')
    expect(v.buttons).toEqual([])
  })
})
