/**
 * A promoter share the rules correctly do not pay is DONE, not a failure (plan-tienda S4 review, verifier S1). A 0%
 * rate set in /admin/promoter, a self-referral, no gross, or a promoter off the `promoter` track writes no commission
 * row, and that must not make Stripe redeliver for days. Only a read or write that failed is retried.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { accrualOutcomeOf, accrualSettles, decideAccrual } from '../lib/promoter-commission'

const paid = { status: 'paid', sku: 'tienda_renewal', gross_amount_cents: 22_800 }

test('each reason the rules give for paying nothing is settled', () => {
  const cases = [
    { name: 'rate 0', input: { attribution: paid, ratePct: 0, existingCommission: false }, reason: 'no_rate' },
    { name: 'no rate row', input: { attribution: paid, ratePct: null, existingCommission: false }, reason: 'no_rate' },
    { name: 'self-referral', input: { attribution: paid, ratePct: 10, existingCommission: false, promoterClerkUserId: 'u', shopOwnerClerkUserId: 'u' }, reason: 'self_referral' },
    { name: 'no gross', input: { attribution: { ...paid, gross_amount_cents: 0 }, ratePct: 10, existingCommission: false }, reason: 'no_gross' },
    { name: 'sku that earns nothing', input: { attribution: { ...paid, sku: 'not_a_sku' }, ratePct: 10, existingCommission: false }, reason: 'sku_not_eligible' },
  ] as const
  for (const c of cases) {
    const outcome = accrualOutcomeOf(decideAccrual(c.input))
    expect(outcome, c.name).toEqual({ kind: 'will_not_accrue', reason: c.reason })
    expect(accrualSettles(outcome), c.name).toBe(true)
  }
  // A promoter no longer on the promoter track (read in the server shell) is the same kind of answer.
  expect(accrualSettles({ kind: 'will_not_accrue', reason: 'not_promoter_track' })).toBe(true)
})

test('an accrual that landed, now or before, is settled; a failure is not', () => {
  expect(accrualOutcomeOf(decideAccrual({ attribution: paid, ratePct: 10, existingCommission: false }))).toEqual({ kind: 'accrued' })
  expect(accrualOutcomeOf(decideAccrual({ attribution: paid, ratePct: 10, existingCommission: true }))).toEqual({ kind: 'accrued' })
  expect(accrualSettles({ kind: 'accrued' })).toBe(true)
  expect(accrualSettles({ kind: 'failed', error: 'insert failed' })).toBe(false)
  // A share is written paid; finding it unpaid is something to look at, not a rule.
  expect(accrualOutcomeOf(decideAccrual({ attribution: { ...paid, status: 'enrolled' }, ratePct: 10, existingCommission: false }))).toMatchObject({ kind: 'failed' })
})

test('the server keeps "could not look" apart from "nothing owed", and the share path throws only on a failure', () => {
  const promoter = readFileSync('lib/promoter.ts', 'utf8')
  const fn = promoter.slice(promoter.indexOf('export async function accrueCommissionOutcome'), promoter.indexOf('\nexport ', promoter.indexOf('export async function accrueCommissionOutcome') + 1))
  for (const err of ['attrErr', 'existingErr', 'rateErr', 'promoterErr']) expect(fn, err).toMatch(new RegExp(`if \\(${err}[^)]*\\) return \\{ kind: 'failed'`))
  expect(fn).not.toContain('getCommissionRates()') // it falls back to 0% on a failed read
  expect(fn).toContain("return { kind: 'will_not_accrue', reason: 'not_promoter_track' }")
  expect(fn).toContain("return { kind: 'failed', error: error.message }")
  const shares = readFileSync('lib/promoter-renewal-server.ts', 'utf8')
  expect(shares).toContain('const accrual = await accrueCommissionOutcome(attributionId)')
  expect(shares).toContain('if (!accrualSettles(accrual)) throw new Error(')
  expect(shares).not.toContain("throw new Error('renewal commission did not accrue')")
})
