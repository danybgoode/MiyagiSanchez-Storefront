/**
 * The plan seam (epic 08 · plans-gratis-negocio S1.2, README D1/D4/D5).
 *
 * `lib/plan.ts` decides gratis / trial / negocio for every gate on the platform, so each precedence row, the lapse on
 * read and the "one trial ever" rule are asserted here directly. A wrong answer either gives Negocio away or takes
 * away something a merchant paid for.
 */
import { test, expect } from '@playwright/test'
import {
  NEGOCIO_GRANT_KEY,
  NEGOCIO_TRIAL_KEY,
  buildNegocioOneTimeGrant,
  buildNegocioTrial,
  addMonthsClamped,
  badgeHref,
  canStartTrial,
  daysLeft,
  decideDomainRelease,
  entitleByPlan,
  derivePlan,
  derivePlanFromMetadata,
  extendNegocioGrant,
  planGetsCheckin,
  planNegocioTrialBackfill,
  planOpensCustomDomain,
  planOpensMlSync,
  planShowsBadge,
  readNegocioGrant,
  readNegocioTrial,
} from '../lib/plan'
import { NEGOCIO_TRIAL_DAYS } from '../lib/negocio-pricing'
import { parseArgs } from '../scripts/backfill-negocio-trial'

const NOW = new Date('2026-11-10T12:00:00Z')
const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()
const liveTrial = { started_at: iso(NOW.getTime() - 5 * DAY), expires_at: iso(NOW.getTime() + 25 * DAY) }
const endedTrial = { started_at: iso(NOW.getTime() - 40 * DAY), expires_at: iso(NOW.getTime() - 10 * DAY) }
const liveOneTime = { type: 'one_time' as const, granted_at: iso(NOW.getTime() - DAY), expires_at: iso(NOW.getTime() + 300 * DAY) }
const lapsedOneTime = { type: 'one_time' as const, granted_at: iso(NOW.getTime() - 400 * DAY), expires_at: iso(NOW.getTime() - DAY) }

test.describe('derivePlan — precedence', () => {
  test('a comp grant is Negocio, permanently', () => {
    const s = derivePlan({ grant: { type: 'comp', granted_at: iso(0) }, trial: null, hasActiveSubscription: false, now: NOW })
    expect(s).toEqual({ plan: 'negocio', reason: 'comp', endsAt: null })
  })

  test('a live one_time grant is Negocio until it ends', () => {
    const s = derivePlan({ grant: liveOneTime, trial: null, hasActiveSubscription: false, now: NOW })
    expect(s).toEqual({ plan: 'negocio', reason: 'one_time', endsAt: liveOneTime.expires_at })
  })

  test('a lapsed one_time grant no longer counts — lapse on read, no timer', () => {
    const s = derivePlan({ grant: lapsedOneTime, trial: null, hasActiveSubscription: false, now: NOW })
    expect(s.plan).toBe('gratis')
  })

  test('an active subscription is Negocio', () => {
    expect(derivePlan({ grant: null, trial: null, hasActiveSubscription: true, now: NOW }))
      .toEqual({ plan: 'negocio', reason: 'subscription', endsAt: null })
  })

  test('paying during the trial makes the shop Negocio, not trial', () => {
    expect(derivePlan({ grant: null, trial: liveTrial, hasActiveSubscription: true, now: NOW }).plan).toBe('negocio')
    expect(derivePlan({ grant: liveOneTime, trial: liveTrial, hasActiveSubscription: false, now: NOW }).plan).toBe('negocio')
  })

  test('a live trial is trial, with its end date', () => {
    expect(derivePlan({ grant: null, trial: liveTrial, hasActiveSubscription: false, now: NOW }))
      .toEqual({ plan: 'trial', reason: 'trial', endsAt: liveTrial.expires_at })
  })

  test('an ended trial is Gratis, and says so', () => {
    expect(derivePlan({ grant: null, trial: endedTrial, hasActiveSubscription: false, now: NOW }))
      .toEqual({ plan: 'gratis', reason: 'trial_ended', endsAt: null })
  })

  test('nothing at all is Gratis', () => {
    expect(derivePlan({ grant: null, trial: null, hasActiveSubscription: false, now: NOW }))
      .toEqual({ plan: 'gratis', reason: 'none', endsAt: null })
  })

  test('a failed subscription read is Gratis for gating, but reported as unavailable — never a confident "none"', () => {
    const s = derivePlan({ grant: null, trial: null, hasActiveSubscription: undefined, subscriptionUnavailable: true, now: NOW })
    expect(s).toEqual({ plan: 'gratis', reason: 'unavailable', endsAt: null })
  })

  test('a failed read never hides a live trial or a live grant', () => {
    expect(derivePlan({ grant: null, trial: liveTrial, hasActiveSubscription: undefined, subscriptionUnavailable: true, now: NOW }).plan).toBe('trial')
    expect(derivePlan({ grant: liveOneTime, trial: null, hasActiveSubscription: undefined, subscriptionUnavailable: true, now: NOW }).plan).toBe('negocio')
  })
})

test.describe('parsing — a corrupt value never grants', () => {
  test('unknown grant types, a grandfather, or a one_time without an end are refused', () => {
    expect(readNegocioGrant({ [NEGOCIO_GRANT_KEY]: { type: 'grandfather', granted_at: iso(0) } })).toBeNull()
    expect(readNegocioGrant({ [NEGOCIO_GRANT_KEY]: { type: 'one_time', granted_at: iso(0) } })).toBeNull()
    expect(readNegocioGrant({ [NEGOCIO_GRANT_KEY]: { type: 'one_time', granted_at: iso(0), expires_at: 'soon' } })).toBeNull()
    expect(readNegocioGrant({ [NEGOCIO_GRANT_KEY]: 'yes' })).toBeNull()
    expect(readNegocioGrant(null)).toBeNull()
  })

  test('a trial needs both dates', () => {
    expect(readNegocioTrial({ [NEGOCIO_TRIAL_KEY]: { started_at: iso(0) } })).toBeNull()
    expect(readNegocioTrial({ [NEGOCIO_TRIAL_KEY]: liveTrial })).toEqual(liveTrial)
  })

  test('derivePlanFromMetadata reads both keys off the shop', () => {
    const meta = { [NEGOCIO_TRIAL_KEY]: liveTrial, settings: {} }
    expect(derivePlanFromMetadata(meta, { hasActiveSubscription: false }, NOW).plan).toBe('trial')
  })
})

test.describe('the trial — once, 30 days', () => {
  test('lasts exactly NEGOCIO_TRIAL_DAYS', () => {
    const t = buildNegocioTrial(NOW)
    expect(Date.parse(t.expires_at) - Date.parse(t.started_at)).toBe(NEGOCIO_TRIAL_DAYS * DAY)
  })

  test('a shop with no trial and no grant may start one', () => {
    expect(canStartTrial({})).toBe(true)
    expect(canStartTrial(null)).toBe(true)
  })

  test('never twice: an ended trial, a malformed trial or any Negocio grant blocks a new one', () => {
    expect(canStartTrial({ [NEGOCIO_TRIAL_KEY]: endedTrial })).toBe(false)
    expect(canStartTrial({ [NEGOCIO_TRIAL_KEY]: { broken: true } })).toBe(false)
    expect(canStartTrial({ [NEGOCIO_GRANT_KEY]: lapsedOneTime })).toBe(false)
  })

  test('days left rounds up and never goes negative', () => {
    expect(daysLeft({ plan: 'trial', reason: 'trial', endsAt: iso(NOW.getTime() + 1.2 * DAY) }, NOW)).toBe(2)
    expect(daysLeft({ plan: 'gratis', reason: 'none', endsAt: iso(NOW.getTime() - DAY) }, NOW)).toBe(0)
    expect(daysLeft({ plan: 'negocio', reason: 'comp', endsAt: null }, NOW)).toBeNull()
  })
})

test.describe('grants — paying early never throws days away', () => {
  test('a yearly grant is 12 calendar months', () => {
    const g = buildNegocioOneTimeGrant({ now: new Date('2026-02-15T00:00:00Z') })
    expect(g.expires_at?.slice(0, 10)).toBe('2027-02-15')
  })

  test('month ends clamp instead of overflowing into the next month (no free days)', () => {
    expect(addMonthsClamped(new Date('2027-01-31T10:00:00Z'), 1).toISOString()).toBe('2027-02-28T10:00:00.000Z')
    expect(addMonthsClamped(new Date('2028-01-31T10:00:00Z'), 1).toISOString()).toBe('2028-02-29T10:00:00.000Z')
    expect(addMonthsClamped(new Date('2028-02-29T10:00:00Z'), 12).toISOString()).toBe('2029-02-28T10:00:00.000Z')
    expect(addMonthsClamped(new Date('2026-11-30T10:00:00Z'), 3).toISOString()).toBe('2027-02-28T10:00:00.000Z')
    expect(addMonthsClamped(new Date('2026-11-10T10:00:00Z'), 12).toISOString()).toBe('2027-11-10T10:00:00.000Z')
  })

  test('a second payment adds after the current end', () => {
    const extended = extendNegocioGrant(liveOneTime, 12, { now: NOW })
    expect(extended.expires_at).toBe(addMonthsClamped(new Date(liveOneTime.expires_at), 12).toISOString())
    expect(extended.granted_at).toBe(NOW.toISOString())
  })

  test('a lapsed grant restarts from now; a comp is never replaced', () => {
    const restarted = extendNegocioGrant(lapsedOneTime, 3, { now: NOW })
    expect(restarted.expires_at).toBe(addMonthsClamped(NOW, 3).toISOString())
    const comp = { type: 'comp' as const, granted_at: iso(0) }
    expect(extendNegocioGrant(comp, 12, { now: NOW })).toBe(comp)
  })

  test('months must be a positive whole number', () => {
    expect(() => buildNegocioOneTimeGrant({ months: 0 })).toThrow()
    expect(() => buildNegocioOneTimeGrant({ months: 1.5 })).toThrow()
  })
})

test.describe('what each plan opens (D5, D7, D9)', () => {
  const gratis = { plan: 'gratis', reason: 'none', endsAt: null } as const
  const trial = { plan: 'trial', reason: 'trial', endsAt: liveTrial.expires_at } as const
  const negocio = { plan: 'negocio', reason: 'subscription', endsAt: null } as const

  test('the custom domain is Negocio only — never the trial', () => {
    expect([gratis, trial, negocio].map(planOpensCustomDomain)).toEqual([false, false, true])
  })
  test('ML sync and the check-in are Negocio and the trial', () => {
    expect([gratis, trial, negocio].map(planOpensMlSync)).toEqual([false, true, true])
    expect([gratis, trial, negocio].map(planGetsCheckin)).toEqual([false, true, true])
  })
  test('the badge is Gratis only', () => {
    expect([gratis, trial, negocio].map(planShowsBadge)).toEqual([true, false, false])
  })
})

test.describe('the launch-day trial backfill (decision a)', () => {
  test('stamps owned shops that never trialed; skips unowned and already-trialed shops', () => {
    const decisions = planNegocioTrialBackfill([
      { id: '1', slug: 'owned-new', clerk_user_id: 'u1', metadata: { settings: {} } },
      { id: '2', slug: 'unowned', clerk_user_id: null, metadata: {} },
      { id: '3', slug: 'trialed', clerk_user_id: 'u3', metadata: { [NEGOCIO_TRIAL_KEY]: endedTrial } },
      { id: '4', slug: 'paid', clerk_user_id: 'u4', metadata: { [NEGOCIO_GRANT_KEY]: liveOneTime } },
    ])
    expect(decisions.map((d) => [d.slug, d.action, d.why])).toEqual([
      ['owned-new', 'stamp', 'owned_never_trialed'],
      ['unowned', 'skip', 'unowned'],
      ['trialed', 'skip', 'already_trialed_or_negocio'],
      ['paid', 'skip', 'already_trialed_or_negocio'],
    ])
  })

  test('the script defaults to a dry run and refuses unknown flags', () => {
    expect(parseArgs([])).toEqual({ ok: true, apply: false })
    expect(parseArgs(['--apply'])).toEqual({ ok: true, apply: true })
    expect(parseArgs(['--aply']).ok).toBe(false)
  })
})

test.describe('entitleByPlan — Negocio opens items, never takes one away (D5)', () => {
  const none = { entitled: false, reason: 'none' } as const
  const trial = { plan: 'trial', reason: 'trial', endsAt: liveTrial.expires_at } as const
  const negocio = { plan: 'negocio', reason: 'one_time', endsAt: liveOneTime.expires_at } as const
  const gratis = { plan: 'gratis', reason: 'none', endsAt: null } as const

  test('an item the shop already holds stays, whatever the plan', () => {
    const grandfathered = { entitled: true, reason: 'grandfathered' } as const
    expect(entitleByPlan(grandfathered, gratis, planOpensCustomDomain)).toBe(grandfathered)
    // Even on Negocio, the item keeps its own reason: an admin must still see it was grandfathered, not bundled.
    expect(entitleByPlan(grandfathered, negocio, planOpensCustomDomain)).toBe(grandfathered)
  })
  test('Negocio opens the custom domain; the trial does not', () => {
    expect(entitleByPlan(none, negocio, planOpensCustomDomain)).toEqual({ entitled: true, reason: 'negocio' })
    expect(entitleByPlan(none, trial, planOpensCustomDomain)).toEqual(none)
  })
  test('the trial opens ML sync, and says so', () => {
    expect(entitleByPlan(none, trial, planOpensMlSync)).toEqual({ entitled: true, reason: 'trial' })
  })
  test('Gratis, or a plan that could not be read, opens nothing', () => {
    expect(entitleByPlan(none, gratis, planOpensMlSync)).toEqual(none)
    expect(entitleByPlan(none, null, planOpensMlSync)).toEqual(none)
  })
})

test('custom-domain release: only when entitled by no path; an unreadable plan keeps it and alerts (D5)', () => {
  const base = { reason: 'subscription_canceled' as const, hasDomain: true, entitled: false, planUnavailable: false }
  expect(decideDomainRelease(base)).toBe('release')
  expect(decideDomainRelease({ ...base, entitled: true })).toBe('keep')
  expect(decideDomainRelease({ ...base, planUnavailable: true })).toBe('keep_and_alert')
  expect(decideDomainRelease({ ...base, reason: 'negocio_ended', hasDomain: false })).toBe('nothing_to_release')
  expect(decideDomainRelease({ ...base, reason: 'negocio_ended' })).toBe('release')
})

test('the badge links home, tagged with the shop (and encodes it)', () => {
  expect(badgeHref('tacos-don-beto')).toBe('https://miyagisanchez.com/?utm_source=badge&utm_medium=shop&utm_campaign=tacos-don-beto')
  expect(badgeHref('a b&c')).toContain('utm_campaign=a%20b%26c')
})
