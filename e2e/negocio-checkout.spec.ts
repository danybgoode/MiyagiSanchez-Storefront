/**
 * Buying Negocio (epic 08 · plans-gratis-negocio S1.3, README D3/D6).
 *
 * Money rules, asserted on the pure seams: who may start which checkout (no double charge), how many months a paid
 * session grants, how Stripe statuses map, and — the one that protects the merchant — that a replayed webhook never
 * adds a second year while a real second payment always adds after the current end.
 */
import { test, expect } from '@playwright/test'
import { coerceNegocioCadence, decideNegocioCheckout, mapNegocioStatus, sessionMonths, subscriptionPeriod } from '../lib/negocio-checkout-rules'
import { NEGOCIO_GRANT_KEY, decideNegocioPayment, guardFor, type PlanState } from '../lib/plan'

const NOW = new Date('2026-11-10T12:00:00Z')
const st = (plan: PlanState['plan'], reason: PlanState['reason']): PlanState => ({ plan, reason, endsAt: null })

test.describe('decideNegocioCheckout — never a double charge', () => {
  test('Gratis and the trial may buy either cadence', () => {
    for (const s of [st('gratis', 'none'), st('gratis', 'trial_ended'), st('trial', 'trial')]) {
      expect(decideNegocioCheckout({ cadence: 'month', plan: s }).ok).toBe(true)
      expect(decideNegocioCheckout({ cadence: 'year', plan: s }).ok).toBe(true)
    }
  })

  test('a live monthly subscription refuses both', () => {
    expect(decideNegocioCheckout({ cadence: 'month', plan: st('negocio', 'subscription') })).toMatchObject({ ok: false, status: 409 })
    expect(decideNegocioCheckout({ cadence: 'year', plan: st('negocio', 'subscription') })).toMatchObject({ ok: false, status: 409 })
  })

  test('a paid year refuses monthly but allows another year (added after the current end)', () => {
    expect(decideNegocioCheckout({ cadence: 'month', plan: st('negocio', 'one_time') })).toMatchObject({ ok: false, status: 409 })
    expect(decideNegocioCheckout({ cadence: 'year', plan: st('negocio', 'one_time') }).ok).toBe(true)
  })

  test('a comp refuses both; an unreadable subscription refuses both rather than risk a double charge', () => {
    expect(decideNegocioCheckout({ cadence: 'year', plan: st('negocio', 'comp') })).toMatchObject({ ok: false, status: 409 })
    expect(decideNegocioCheckout({ cadence: 'month', plan: st('gratis', 'unavailable') })).toMatchObject({ ok: false, status: 503 })
  })

  test('only month and year are cadences', () => {
    expect(coerceNegocioCadence('month')).toBe('month')
    expect(coerceNegocioCadence('year')).toBe('year')
    expect(coerceNegocioCadence('week')).toBeNull()
    expect(coerceNegocioCadence(undefined)).toBeNull()
  })
})

test.describe('webhook inputs', () => {
  test('months: default 12, a whole number 1–24, anything else refused', () => {
    expect(sessionMonths(undefined)).toBe(12)
    expect(sessionMonths('3')).toBe(3)
    expect(sessionMonths('12')).toBe(12)
    expect(sessionMonths('0')).toBeNull()
    expect(sessionMonths('36')).toBeNull()
    expect(sessionMonths('1.5')).toBeNull()
    expect(sessionMonths('doce')).toBeNull()
  })

  test('statuses: unpaid is the past_due grace window; unknown statuses are left alone', () => {
    expect(mapNegocioStatus('active')).toBe('active')
    expect(mapNegocioStatus('unpaid')).toBe('past_due')
    expect(mapNegocioStatus('canceled')).toBe('canceled')
    expect(mapNegocioStatus('incomplete')).toBeNull()
  })
})

test.describe('decideNegocioPayment — a replay adds nothing, a real payment always adds', () => {
  test('a first payment writes a 12-month grant guarded on the key being absent', () => {
    const d = decideNegocioPayment({}, { paymentId: 'cs_1', months: 12, now: NOW })
    expect(d.action).toBe('write')
    if (d.action !== 'write') return
    expect(d.guard).toEqual({ mode: 'absent' })
    expect(d.grant.payments).toEqual(['cs_1'])
    expect(d.grant.expires_at?.slice(0, 10)).toBe('2027-11-10')
  })

  test('the same session again is a replay: nothing is written', () => {
    const first = decideNegocioPayment({}, { paymentId: 'cs_1', months: 12, now: NOW })
    if (first.action !== 'write') throw new Error('expected write')
    const meta = { [NEGOCIO_GRANT_KEY]: first.grant }
    expect(decideNegocioPayment(meta, { paymentId: 'cs_1', months: 12, now: NOW })).toEqual({ action: 'replay' })
  })

  test('a second, different payment adds after the current end and remembers both', () => {
    const first = decideNegocioPayment({}, { paymentId: 'cs_1', months: 12, now: NOW })
    if (first.action !== 'write') throw new Error('expected write')
    const meta = { [NEGOCIO_GRANT_KEY]: first.grant }
    const second = decideNegocioPayment(meta, { paymentId: 'cs_2', months: 3, now: NOW })
    expect(second.action).toBe('write')
    if (second.action !== 'write') return
    expect(second.grant.expires_at?.slice(0, 10)).toBe('2028-02-10')
    expect(second.grant.payments).toEqual(['cs_1', 'cs_2'])
    // The CAS guard is the RAW value read, so a concurrent change makes the write a no-op.
    expect(second.guard).toEqual({ mode: 'equals', expected: first.grant })
  })

  test('a shop with a comp is never extended', () => {
    const meta = { [NEGOCIO_GRANT_KEY]: { type: 'comp', granted_at: NOW.toISOString() } }
    expect(decideNegocioPayment(meta, { paymentId: 'cs_9', months: 12, now: NOW })).toEqual({ action: 'comp' })
  })

  test('a malformed grant is replaced, guarded on its exact malformed value', () => {
    const broken = { type: 'one_time', granted_at: 'x' }
    const d = decideNegocioPayment({ [NEGOCIO_GRANT_KEY]: broken }, { paymentId: 'cs_3', months: 12, now: NOW })
    expect(d.action).toBe('write')
    if (d.action === 'write') expect(d.guard).toEqual({ mode: 'equals', expected: broken })
  })
})

test.describe('#471 review fixes', () => {
  test('a key holding JSON null is guarded as json_null, never as absent or equals-NULL (it would jam forever)', () => {
    expect(guardFor({}, NEGOCIO_GRANT_KEY)).toEqual({ mode: 'absent' })
    expect(guardFor({ [NEGOCIO_GRANT_KEY]: null }, NEGOCIO_GRANT_KEY)).toEqual({ mode: 'json_null' })
    const d = decideNegocioPayment({ [NEGOCIO_GRANT_KEY]: null }, { paymentId: 'cs_n', months: 12, now: NOW })
    expect(d.action === 'write' && d.guard).toEqual({ mode: 'json_null' })
  })

  test('the subscription period is read off the ITEM (current API), falling back to the top level', () => {
    expect(subscriptionPeriod({ items: { data: [{ current_period_start: 10, current_period_end: 20 }] } })).toEqual({ start: 10, end: 20 })
    expect(subscriptionPeriod({ current_period_start: 1, current_period_end: 2, items: { data: [{}] } })).toEqual({ start: 1, end: 2 })
    // The shape that broke activation: no period anywhere → null (the handler falls back), never NaN.
    expect(subscriptionPeriod({ items: { data: [{}] } })).toBeNull()
    expect(subscriptionPeriod(null)).toBeNull()
  })
})
