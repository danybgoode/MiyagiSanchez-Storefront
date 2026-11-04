/**
 * The trial's two emails and the check-in by plan (epic 08 · plans-gratis-negocio S2.3, README D9/D10).
 * Day 31 is never a surprise, each notice goes once, a paying shop gets neither, and a stale end gets nothing.
 */
import { test, expect } from '@playwright/test'
import { decideTrialNotice, markNotified, runTrialNotices, type TrialNoticeDeps, type TrialShop } from '../lib/negocio-trial-notices'
import type { PlanState } from '../lib/plan'

const DAY = 86_400_000
const NOW = new Date('2026-12-08T15:00:00Z')
const trialEnding = (inDays: number) => ({ started_at: new Date(NOW.getTime() - (30 - inDays) * DAY).toISOString(), expires_at: new Date(NOW.getTime() + inDays * DAY).toISOString() })
const trialPlan = (t: { expires_at: string }): PlanState => ({ plan: 'trial', reason: 'trial', endsAt: t.expires_at })
const gratisEnded: PlanState = { plan: 'gratis', reason: 'trial_ended', endsAt: null }
const negocio: PlanState = { plan: 'negocio', reason: 'subscription', endsAt: null }

test('five days before the end: the reminder, once', () => {
  const t = trialEnding(5)
  expect(decideTrialNotice(t, trialPlan(t), NOW)).toBe('five_days')
  expect(decideTrialNotice(markNotified(t, 'five_days', NOW), trialPlan(t), NOW)).toBeNull()
  const early = trialEnding(12)
  expect(decideTrialNotice(early, trialPlan(early), NOW)).toBeNull()
})

test('after the end, on Gratis: «ya estás en Gratis», once, and never for an end older than a week', () => {
  const ended = trialEnding(-1)
  expect(decideTrialNotice(ended, gratisEnded, NOW)).toBe('ended')
  expect(decideTrialNotice(markNotified(ended, 'ended', NOW), gratisEnded, NOW)).toBeNull()
  expect(decideTrialNotice(trialEnding(-9), gratisEnded, NOW)).toBeNull()
})

test('a shop that paid gets neither notice', () => {
  expect(decideTrialNotice(trialEnding(3), negocio, NOW)).toBeNull()
  expect(decideTrialNotice(trialEnding(-1), negocio, NOW)).toBeNull()
})

test('the runner claims before it sends; a lost claim sends nothing; an unreadable plan waits', async () => {
  const sent: string[] = []
  const shops: TrialShop[] = [
    { id: 'a', slug: 'a', name: 'A', clerk_user_id: 'u', trial: trialEnding(4), rawTrial: {} },
    { id: 'b', slug: 'b', name: 'B', clerk_user_id: 'u', trial: trialEnding(4), rawTrial: {} },
    { id: 'c', slug: 'c', name: 'C', clerk_user_id: 'u', trial: trialEnding(4), rawTrial: {} },
  ]
  const deps: TrialNoticeDeps = {
    readShops: async () => shops,
    readPlan: async (s) => (s.id === 'c' ? null : trialPlan(s.trial)),
    claim: async (s) => s.id === 'a',
    send: async (s, n) => { sent.push(`${s.id}:${n}`) },
    now: () => NOW,
  }
  expect(await runTrialNotices(deps)).toEqual({ ok: true, sent: 1, skipped: 1, unavailable: 1, failed: 0 })
  expect(sent).toEqual(['a:five_days'])
})

test('a run that cannot read the shops reports unavailable, never "nobody"', async () => {
  const deps = { readShops: async () => null } as unknown as TrialNoticeDeps
  expect(await runTrialNotices(deps)).toEqual({ ok: false, error: 'unavailable' })
})
