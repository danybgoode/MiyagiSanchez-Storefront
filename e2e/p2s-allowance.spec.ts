import { expect, test } from '@playwright/test'
import {
  P2S_LIMITS,
  budgetPeriod,
  decideSpend,
  deviceSubject,
  monthPeriod,
  resolveDailyBudget,
  versionsLeftCopy,
} from '../lib/prompt-to-shop/allowance'

// Prompt-to-shop S1.1 — the allowance decision (epic D4–D6). The spend itself is one conditional write in
// Postgres; these pin what the app does with its answer, and above all that every unknown answer REFUSES.

test('a spent version reports what is left, counting the first shop', () => {
  expect(decideSpend({ data: { ok: true, reason: null, versions_used: 1 }, error: null }))
    .toEqual({ ok: true, versionsUsed: 1, versionsLeft: 2 })
  expect(decideSpend({ data: { ok: true, reason: null, versions_used: 3 }, error: null }))
    .toEqual({ ok: true, versionsUsed: 3, versionsLeft: 0 })
})

test('allowance and budget refusals keep their reason', () => {
  expect(decideSpend({ data: { ok: false, reason: 'allowance', versions_used: 3 }, error: null }))
    .toEqual({ ok: false, reason: 'allowance' })
  expect(decideSpend({ data: { ok: false, reason: 'budget', versions_used: 1 }, error: null }))
    .toEqual({ ok: false, reason: 'budget' })
})

test('anything that is not a recognised answer fails CLOSED, never as a spend', () => {
  const unavailable = { ok: false, reason: 'unavailable' }
  expect(decideSpend({ data: null, error: { message: 'connection refused' } })).toEqual(unavailable)
  expect(decideSpend({ data: { ok: true, versions_used: 1 }, error: { message: 'x' } })).toEqual(unavailable)
  expect(decideSpend({ data: null, error: null })).toEqual(unavailable)
  expect(decideSpend({ data: [], error: null })).toEqual(unavailable)
  expect(decideSpend({ data: { ok: true }, error: null })).toEqual(unavailable)
  expect(decideSpend({ data: { ok: true, versions_used: 0 }, error: null })).toEqual(unavailable)
  // A count above the cap means the cap was not enforced; it is not "−1 left".
  expect(decideSpend({ data: { ok: true, versions_used: 4 }, error: null })).toEqual(unavailable)
  expect(decideSpend({ data: { ok: false, reason: 'something-new' }, error: null })).toEqual(unavailable)
  expect(decideSpend({ data: 'ok', error: null })).toEqual(unavailable)
})

test('the daily budget never parses to unlimited or closed-for-good', () => {
  expect(P2S_LIMITS.dailyBudgetDefault).toBe(300)
  expect(resolveDailyBudget(undefined)).toBe(300)
  expect(resolveDailyBudget('120')).toBe(120)
  expect(resolveDailyBudget(' 500 ')).toBe(500)
  for (const bad of ['', '0', '-5', 'abc', '1e9', '12.5', 'Infinity', '99999999999999999999']) {
    expect(resolveDailyBudget(bad), bad).toBe(300)
  }
})

test('periods follow Mexico City, not UTC', () => {
  // 2026-11-01 03:00 UTC is still 31 October in Mexico City (UTC−6).
  const lateNight = new Date('2026-11-01T03:00:00Z')
  expect(budgetPeriod(lateNight)).toBe('2026-10-31')
  expect(monthPeriod(lateNight)).toBe('2026-10')
  expect(budgetPeriod(new Date('2026-11-01T07:00:00Z'))).toBe('2026-11-01')
})

test('subjects and the counter copy', () => {
  expect(deviceSubject('abc')).toBe('device:abc')
  expect(versionsLeftCopy(2)).toBe('Te quedan 2 versiones')
  expect(versionsLeftCopy(1)).toBe('Te queda 1 versión')
  expect(versionsLeftCopy(0)).toBe('Ya no te quedan versiones')
})
