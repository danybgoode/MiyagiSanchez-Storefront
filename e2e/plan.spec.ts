/**
 * The plan seam (epic 08 · plans-gratis-negocio S1.2, README D1/D4/D5; plan-tienda-three-free-months S1.1, D1–D4).
 *
 * `lib/plan.ts` decides gratis / trial / tienda / negocio / unpaid for every gate on the platform, so each precedence
 * row, the lapse on read and the "one trial ever" rule are asserted here directly. A wrong answer either gives a plan
 * away, takes away something a merchant paid for, or — since `unpaid` is what the pause job acts on — closes a shop
 * that was promised Plan Gratis.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import {
  NEGOCIO_GRANT_KEY,
  NEGOCIO_TRIAL_KEY,
  PLAN_LEGACY_KEY,
  TIENDA_GRANT_KEY,
  buildPlanLegacy,
  buildPlanOneTimeGrant,
  decideNegocioPayment,
  decideTiendaPayment,
  extendPlanGrant,
  grantWriteRpcArgs,
  guardFor,
  isLiveDatedGrant,
  readPlanGrant,
  readPlanLegacy,
  readPlanLegacyState,
  readTiendaGrant,
  type DerivePlanInput,
  type PlanLegacyState,
  type PlanName,
  type PlanReason,
  type PlanState,
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
const liveTienda = { type: 'one_time' as const, granted_at: iso(NOW.getTime() - 60 * DAY), expires_at: iso(NOW.getTime() + 200 * DAY) }
const lapsedTienda = { type: 'one_time' as const, granted_at: iso(NOW.getTime() - 500 * DAY), expires_at: iso(NOW.getTime() - 3 * DAY) }
const marker = { marked_at: '2026-11-10T00:00:00.000Z' }

/** A LEGACY shop with nothing else: every pre-existing test below describes one (they were written when every shop
 *  was what is now called legacy), so they keep their expectations and say so in their input. */
const legacyShop: DerivePlanInput = {
  grant: null, trial: null, tiendaGrant: null, legacy: 'marked',
  hasActiveSubscription: false, hasActiveTiendaSubscription: false, now: NOW,
}
/** The same shop without the marker: opened after the change. */
const newShop: DerivePlanInput = { ...legacyShop, legacy: 'absent' }

test.describe('derivePlan — precedence', () => {
  test('a comp grant is Negocio, permanently', () => {
    const s = derivePlan({ ...legacyShop, grant: { type: 'comp', granted_at: iso(0) } })
    expect(s).toEqual({ plan: 'negocio', reason: 'comp', endsAt: null })
  })

  test('a live one_time grant is Negocio until it ends', () => {
    const s = derivePlan({ ...legacyShop, grant: liveOneTime })
    expect(s).toEqual({ plan: 'negocio', reason: 'one_time', endsAt: liveOneTime.expires_at })
  })

  test('a lapsed one_time grant no longer counts — lapse on read, no timer', () => {
    const s = derivePlan({ ...legacyShop, grant: lapsedOneTime })
    expect(s.plan).toBe('gratis')
  })

  test('an active subscription is Negocio', () => {
    expect(derivePlan({ ...legacyShop, hasActiveSubscription: true }))
      .toEqual({ plan: 'negocio', reason: 'subscription', endsAt: null })
  })

  test('paying during the trial makes the shop Negocio, not trial', () => {
    expect(derivePlan({ ...legacyShop, trial: liveTrial, hasActiveSubscription: true }).plan).toBe('negocio')
    expect(derivePlan({ ...legacyShop, grant: liveOneTime, trial: liveTrial }).plan).toBe('negocio')
  })

  test('a live trial is trial, with its end date', () => {
    expect(derivePlan({ ...legacyShop, trial: liveTrial }))
      .toEqual({ plan: 'trial', reason: 'trial', endsAt: liveTrial.expires_at })
  })

  test('an ended trial is Gratis, and says so', () => {
    expect(derivePlan({ ...legacyShop, trial: endedTrial }))
      .toEqual({ plan: 'gratis', reason: 'trial_ended', endsAt: null })
  })

  test('a legacy shop with nothing at all is Gratis (the reason `none` is now `legacy`: Gratis without the marker no longer exists)', () => {
    expect(derivePlan(legacyShop)).toEqual({ plan: 'gratis', reason: 'legacy', endsAt: null })
  })

  test('a failed subscription read is Gratis for gating, but reported as unavailable — never a confident "none"', () => {
    const s = derivePlan({ ...legacyShop, hasActiveSubscription: undefined, subscriptionUnavailable: true })
    expect(s).toEqual({ plan: 'gratis', reason: 'unavailable', endsAt: null })
  })

  test('a failed read never hides a live trial or a live grant', () => {
    expect(derivePlan({ ...legacyShop, trial: liveTrial, hasActiveSubscription: undefined, subscriptionUnavailable: true }).plan).toBe('trial')
    expect(derivePlan({ ...legacyShop, grant: liveOneTime, hasActiveSubscription: undefined, subscriptionUnavailable: true }).plan).toBe('negocio')
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
    expect(derivePlanFromMetadata(meta, { hasActiveSubscription: false, hasActiveTiendaSubscription: false }, NOW).plan).toBe('trial')
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
    expect(daysLeft({ plan: 'gratis', reason: 'legacy', endsAt: iso(NOW.getTime() - DAY) }, NOW)).toBe(0)
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

test.describe('what each plan opens (D5, D7, D9; plan-tienda S1.3)', () => {
  const gratis: PlanState = { plan: 'gratis', reason: 'legacy', endsAt: null }
  const trial: PlanState = { plan: 'trial', reason: 'trial', endsAt: liveTrial.expires_at }
  const negocio: PlanState = { plan: 'negocio', reason: 'subscription', endsAt: null }
  const tienda: PlanState = { plan: 'tienda', reason: 'tienda_one_time', endsAt: liveTienda.expires_at }
  const unpaid: PlanState = { plan: 'unpaid', reason: 'unpaid', endsAt: null }
  const all = [gratis, trial, negocio, tienda, unpaid]

  test('the custom domain is Negocio only — never the trial, Tienda, Gratis or unpaid', () => {
    expect(all.map(planOpensCustomDomain)).toEqual([false, false, true, false, false])
  })
  test('ML sync and the check-in are Negocio and the trial — not Tienda, Gratis or unpaid', () => {
    expect(all.map(planOpensMlSync)).toEqual([false, true, true, false, false])
    expect(all.map(planGetsCheckin)).toEqual([false, true, true, false, false])
  })
  test('the badge shows on shops that pay nothing (legacy Gratis, unpaid) and never on a paid plan or the trial', () => {
    expect(all.map(planShowsBadge)).toEqual([true, false, false, false, true])
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
  const gratis = { plan: 'gratis', reason: 'legacy', endsAt: null } as const

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
  test('Gratis, Tienda, unpaid, or a plan that could not be read, opens nothing', () => {
    expect(entitleByPlan(none, gratis, planOpensMlSync)).toEqual(none)
    expect(entitleByPlan(none, null, planOpensMlSync)).toEqual(none)
    for (const state of [{ plan: 'tienda', reason: 'tienda_subscription', endsAt: null }, { plan: 'unpaid', reason: 'unpaid', endsAt: null }] as PlanState[]) {
      expect(entitleByPlan(none, state, planOpensMlSync)).toEqual(none)
      expect(entitleByPlan(none, state, planOpensCustomDomain)).toEqual(none)
    }
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

// ── plan-tienda-three-free-months S1.1 ────────────────────────────────────────

test.describe('Plan Tienda, legacy Gratis and unpaid — precedence (plan-tienda D1, D4)', () => {
  test('a live Tienda grant is Tienda until it ends; a lapsed one no longer counts', () => {
    expect(derivePlan({ ...newShop, tiendaGrant: liveTienda })).toEqual({ plan: 'tienda', reason: 'tienda_one_time', endsAt: liveTienda.expires_at })
    expect(derivePlan({ ...newShop, tiendaGrant: lapsedTienda })).toEqual({ plan: 'unpaid', reason: 'unpaid', endsAt: null })
    expect(derivePlan({ ...legacyShop, tiendaGrant: lapsedTienda })).toEqual({ plan: 'gratis', reason: 'legacy', endsAt: null })
  })

  test('a live monthly Tienda subscription is Tienda; the dated grant is named first when both are live', () => {
    expect(derivePlan({ ...newShop, hasActiveTiendaSubscription: true })).toEqual({ plan: 'tienda', reason: 'tienda_subscription', endsAt: null })
    expect(derivePlan({ ...newShop, tiendaGrant: liveTienda, hasActiveTiendaSubscription: true }).reason).toBe('tienda_one_time')
  })

  test('Negocio outranks Tienda, by comp, dated grant or subscription', () => {
    const tienda = { ...newShop, tiendaGrant: liveTienda, hasActiveTiendaSubscription: true }
    expect(derivePlan({ ...tienda, grant: { type: 'comp', granted_at: iso(0) } }).reason).toBe('comp')
    expect(derivePlan({ ...tienda, grant: liveOneTime }).reason).toBe('one_time')
    expect(derivePlan({ ...tienda, hasActiveSubscription: true }).reason).toBe('subscription')
  })

  test('a live trial outranks Tienda: the trial is Negocio for free', () => {
    expect(derivePlan({ ...newShop, trial: liveTrial, tiendaGrant: liveTienda })).toEqual({ plan: 'trial', reason: 'trial', endsAt: liveTrial.expires_at })
    expect(derivePlan({ ...newShop, trial: liveTrial, hasActiveTiendaSubscription: true }).plan).toBe('trial')
  })

  test('an ended trial: a marked shop is Gratis, an unmarked one is unpaid', () => {
    expect(derivePlan({ ...legacyShop, trial: endedTrial })).toEqual({ plan: 'gratis', reason: 'trial_ended', endsAt: null })
    expect(derivePlan({ ...newShop, trial: endedTrial })).toEqual({ plan: 'unpaid', reason: 'unpaid', endsAt: null })
  })

  test('no marker and nothing live is unpaid — a new outcome, not a rename of Gratis', () => {
    expect(derivePlan(newShop)).toEqual({ plan: 'unpaid', reason: 'unpaid', endsAt: null })
    expect(derivePlan(legacyShop).plan).toBe('gratis')
  })

  test('a marker we cannot read counts as legacy: a damaged marker never makes an old shop pausable', () => {
    expect(derivePlan({ ...newShop, legacy: 'unreadable' })).toEqual({ plan: 'gratis', reason: 'legacy', endsAt: null })
    expect(derivePlan({ ...newShop, legacy: 'unreadable', trial: endedTrial })).toEqual({ plan: 'gratis', reason: 'trial_ended', endsAt: null })
  })

  test('"could not read a subscription" is unavailable under Gratis for EVERY shop — never unpaid, never a confident legacy', () => {
    const unavailable = { plan: 'gratis', reason: 'unavailable', endsAt: null }
    for (const legacy of ['marked', 'absent', 'unreadable'] as PlanLegacyState[]) {
      expect(derivePlan({ ...newShop, legacy, hasActiveSubscription: undefined, subscriptionUnavailable: true })).toEqual(unavailable)
      expect(derivePlan({ ...newShop, legacy, hasActiveTiendaSubscription: undefined, tiendaSubscriptionUnavailable: true })).toEqual(unavailable)
      expect(derivePlan({ ...newShop, legacy, trial: endedTrial, tiendaGrant: lapsedTienda, hasActiveSubscription: undefined, subscriptionUnavailable: true })).toEqual(unavailable)
    }
  })

  test('a fact that WAS read and is live wins over a failed lookup: the shop is at least that', () => {
    const negocioDown = { hasActiveSubscription: undefined, subscriptionUnavailable: true }
    const tiendaDown = { hasActiveTiendaSubscription: undefined, tiendaSubscriptionUnavailable: true }
    expect(derivePlan({ ...newShop, ...negocioDown, tiendaGrant: liveTienda }).reason).toBe('tienda_one_time')
    expect(derivePlan({ ...newShop, ...negocioDown, hasActiveTiendaSubscription: true }).reason).toBe('tienda_subscription')
    expect(derivePlan({ ...newShop, ...tiendaDown, tiendaGrant: liveTienda }).reason).toBe('tienda_one_time')
    expect(derivePlan({ ...newShop, ...tiendaDown, trial: liveTrial }).reason).toBe('trial')
    expect(derivePlan({ ...newShop, ...tiendaDown, hasActiveSubscription: true }).reason).toBe('subscription')
  })

  test('`undefined` without the unavailable flag is "not asked", as before — it is not a failed read', () => {
    expect(derivePlan({ ...newShop, hasActiveSubscription: undefined, hasActiveTiendaSubscription: undefined }).plan).toBe('unpaid')
  })
})

test.describe('derivePlan — EVERY combination of the six facts (plan-tienda S1.1)', () => {
  const NEGOCIO = { none: null, comp: { type: 'comp' as const, granted_at: iso(0) }, live: liveOneTime, lapsed: lapsedOneTime }
  const TRIAL = { absent: null, live: liveTrial, ended: endedTrial }
  const TIENDA = { none: null, live: liveTienda, lapsed: lapsedTienda }
  const SUB = ['yes', 'no', 'unavailable'] as const
  const LEGACY = ['marked', 'absent', 'unreadable'] as const
  type Case = { neg: keyof typeof NEGOCIO; sub: typeof SUB[number]; trial: keyof typeof TRIAL; tg: keyof typeof TIENDA; tsub: typeof SUB[number]; legacy: typeof LEGACY[number] }

  const cases: Case[] = []
  for (const neg of Object.keys(NEGOCIO) as Case['neg'][])
    for (const sub of SUB)
      for (const trial of Object.keys(TRIAL) as Case['trial'][])
        for (const tg of Object.keys(TIENDA) as Case['tg'][])
          for (const tsub of SUB)
            for (const legacy of LEGACY) cases.push({ neg, sub, trial, tg, tsub, legacy })

  const run = (c: Case): PlanState => derivePlan({
    grant: NEGOCIO[c.neg],
    trial: TRIAL[c.trial],
    tiendaGrant: TIENDA[c.tg],
    legacy: c.legacy,
    hasActiveSubscription: c.sub === 'unavailable' ? undefined : c.sub === 'yes',
    subscriptionUnavailable: c.sub === 'unavailable',
    hasActiveTiendaSubscription: c.tsub === 'unavailable' ? undefined : c.tsub === 'yes',
    tiendaSubscriptionUnavailable: c.tsub === 'unavailable',
    now: NOW,
  })

  /** The lock's precedence (D4) written as a ranked list — the FIRST row whose condition holds is the answer. */
  const RANKED: Array<[(c: Case) => boolean, PlanName, PlanReason]> = [
    [(c) => c.neg === 'comp', 'negocio', 'comp'],
    [(c) => c.neg === 'live', 'negocio', 'one_time'],
    [(c) => c.sub === 'yes', 'negocio', 'subscription'],
    [(c) => c.trial === 'live', 'trial', 'trial'],
    [(c) => c.tg === 'live', 'tienda', 'tienda_one_time'],
    [(c) => c.tsub === 'yes', 'tienda', 'tienda_subscription'],
    [(c) => c.sub === 'unavailable' || c.tsub === 'unavailable', 'gratis', 'unavailable'],
    [(c) => c.legacy !== 'absent' && c.trial === 'ended', 'gratis', 'trial_ended'],
    [(c) => c.legacy !== 'absent', 'gratis', 'legacy'],
    [() => true, 'unpaid', 'unpaid'],
  ]

  test('the matrix is the full product: 4 × 3 × 3 × 3 × 3 × 3 = 972 combinations', () => {
    expect(cases).toHaveLength(972)
  })

  test('every combination resolves to the first matching row of the precedence', () => {
    for (const c of cases) {
      const [, plan, reason] = RANKED.find(([when]) => when(c))!
      expect({ c, got: run(c) }).toMatchObject({ c, got: { plan, reason } })
    }
  })

  test('unpaid is reached ONLY when everything was read, nothing is live and there is no marker', () => {
    const unpaid = cases.filter((c) => run(c).plan === 'unpaid')
    expect(unpaid.length).toBeGreaterThan(0)
    for (const c of unpaid) {
      expect(c.legacy).toBe('absent')
      expect([c.sub, c.tsub]).toEqual(['no', 'no'])
      expect(['none', 'lapsed']).toContain(c.neg)
      expect(['none', 'lapsed']).toContain(c.tg)
      expect(c.trial).not.toBe('live')
    }
    // …and it is exactly those: 2 Negocio grants × 2 trials × 2 Tienda grants.
    expect(unpaid).toHaveLength(8)
  })

  test('a failed lookup, a marker, or a damaged marker NEVER yields unpaid', () => {
    for (const c of cases) {
      if (c.sub === 'unavailable' || c.tsub === 'unavailable' || c.legacy !== 'absent') expect({ c, plan: run(c).plan }).not.toMatchObject({ plan: 'unpaid' })
    }
  })

  test('the end date is the live dated grant\'s or the trial\'s, and null otherwise', () => {
    for (const c of cases) {
      const s = run(c)
      const want = s.reason === 'one_time' ? liveOneTime.expires_at : s.reason === 'trial' ? liveTrial.expires_at : s.reason === 'tienda_one_time' ? liveTienda.expires_at : null
      expect({ c, endsAt: s.endsAt }).toEqual({ c, endsAt: want })
    }
  })
})

test.describe('Tienda\'s records — the same grant, under its own key (plan-tienda D3)', () => {
  test('the Tienda grant is read from its key with the same rules; it is never a comp', () => {
    expect(readTiendaGrant({ [TIENDA_GRANT_KEY]: liveTienda })).toEqual(liveTienda)
    expect(readTiendaGrant({ [NEGOCIO_GRANT_KEY]: liveTienda })).toBeNull()
    expect(readTiendaGrant({ [TIENDA_GRANT_KEY]: { type: 'comp', granted_at: iso(0) } })).toBeNull()
    expect(readTiendaGrant({ [TIENDA_GRANT_KEY]: { type: 'one_time', granted_at: iso(0) } })).toBeNull()
    expect(readTiendaGrant({ [TIENDA_GRANT_KEY]: 'yes' })).toBeNull()
    expect(readTiendaGrant(null)).toBeNull()
  })

  test('one reader and one set of builders serve both plans: the old names are the neutral ones', () => {
    const meta = { [NEGOCIO_GRANT_KEY]: liveOneTime, [TIENDA_GRANT_KEY]: liveTienda }
    expect(readNegocioGrant(meta)).toEqual(readPlanGrant(meta, NEGOCIO_GRANT_KEY))
    expect(readPlanGrant(meta, TIENDA_GRANT_KEY)).toEqual(liveTienda)
    expect(buildPlanOneTimeGrant).toBe(buildNegocioOneTimeGrant)
    expect(extendPlanGrant).toBe(extendNegocioGrant)
  })

  test('derivePlanFromMetadata reads the Tienda grant and the marker off the shop', () => {
    const facts = { hasActiveSubscription: false, hasActiveTiendaSubscription: false }
    expect(derivePlanFromMetadata({ [TIENDA_GRANT_KEY]: liveTienda }, facts, NOW)).toEqual({ plan: 'tienda', reason: 'tienda_one_time', endsAt: liveTienda.expires_at })
    expect(derivePlanFromMetadata({ [PLAN_LEGACY_KEY]: marker }, facts, NOW)).toEqual({ plan: 'gratis', reason: 'legacy', endsAt: null })
    expect(derivePlanFromMetadata({ [PLAN_LEGACY_KEY]: marker, [NEGOCIO_TRIAL_KEY]: endedTrial }, facts, NOW).reason).toBe('trial_ended')
    expect(derivePlanFromMetadata({ [NEGOCIO_TRIAL_KEY]: endedTrial }, facts, NOW).plan).toBe('unpaid')
    expect(derivePlanFromMetadata({}, facts, NOW).plan).toBe('unpaid')
    expect(derivePlanFromMetadata({ [PLAN_LEGACY_KEY]: { marked_at: 'yesterday' } }, facts, NOW).plan).toBe('gratis')
    expect(derivePlanFromMetadata({ [PLAN_LEGACY_KEY]: null }, facts, NOW).plan).toBe('unpaid')
  })

  test('a live dated grant is one that has not ended; a comp is not "dated"', () => {
    expect(isLiveDatedGrant(liveTienda, NOW)).toBe(true)
    expect(isLiveDatedGrant(lapsedTienda, NOW)).toBe(false)
    expect(isLiveDatedGrant({ ...liveTienda, expires_at: NOW.toISOString() }, NOW)).toBe(false)
    expect(isLiveDatedGrant({ type: 'comp', granted_at: iso(0) }, NOW)).toBe(false)
    expect(isLiveDatedGrant(null, NOW)).toBe(false)
  })
})

test.describe('the legacy marker (plan-tienda D2)', () => {
  test('a well-formed marker is read; the builder writes exactly that shape', () => {
    expect(readPlanLegacy({ [PLAN_LEGACY_KEY]: marker })).toEqual(marker)
    expect(buildPlanLegacy(NOW)).toEqual({ marked_at: NOW.toISOString() })
    expect(readPlanLegacy({ [PLAN_LEGACY_KEY]: { ...marker, extra: 1 } })).toEqual(marker)
  })

  test('strict read: a malformed value is not a marker', () => {
    for (const bad of [true, 'yes', 1, [], {}, { marked_at: '' }, { marked_at: 'soon' }, { marked_at: 5 }]) {
      expect(readPlanLegacy({ [PLAN_LEGACY_KEY]: bad })).toBeNull()
    }
    expect(readPlanLegacy(null)).toBeNull()
    expect(readPlanLegacy({})).toBeNull()
  })

  test('three states, never two: marked, absent (no key or JSON null), unreadable (anything else)', () => {
    expect(readPlanLegacyState({ [PLAN_LEGACY_KEY]: marker })).toBe('marked')
    expect(readPlanLegacyState({})).toBe('absent')
    expect(readPlanLegacyState({ settings: {} })).toBe('absent')
    expect(readPlanLegacyState(null)).toBe('absent')
    expect(readPlanLegacyState(undefined)).toBe('absent')
    expect(readPlanLegacyState({ [PLAN_LEGACY_KEY]: null })).toBe('absent')
    for (const bad of [true, false, 0, '', 'yes', [], {}, { marked_at: 'soon' }]) {
      expect({ bad, state: readPlanLegacyState({ [PLAN_LEGACY_KEY]: bad }) }).toEqual({ bad, state: 'unreadable' })
    }
    // Metadata that is not an object at all could hold anything: we could not look.
    expect(readPlanLegacyState('{}')).toBe('unreadable')
    expect(readPlanLegacyState([])).toBe('unreadable')
  })
})

test.describe('paying for Negocio or Tienda once — replays, where the months start, and the guard (plan-tienda D3, D4)', () => {
  const pay = { paymentId: 'cs_1', months: 12, now: NOW, note: 'yearly 12m' }

  test('Negocio, first payment: 12 months from now, guarded on the key being absent', () => {
    const d = decideNegocioPayment({}, pay)
    expect(d).toEqual({
      action: 'write',
      grant: { type: 'one_time', granted_at: NOW.toISOString(), expires_at: addMonthsClamped(NOW, 12).toISOString(), note: 'yearly 12m', payments: ['cs_1'] },
      guard: { mode: 'absent' },
    })
  })

  test('Negocio: a replayed payment writes nothing; a comp is never extended', () => {
    const paid = { [NEGOCIO_GRANT_KEY]: { ...liveOneTime, payments: ['cs_1'] } }
    expect(decideNegocioPayment(paid, pay)).toEqual({ action: 'replay' })
    expect(decideNegocioPayment({ [NEGOCIO_GRANT_KEY]: { type: 'comp', granted_at: iso(0) } }, pay)).toEqual({ action: 'comp' })
    // A replay is a replay even on a shop that holds live Tienda time: nothing moves twice.
    expect(decideNegocioPayment({ ...paid, [TIENDA_GRANT_KEY]: liveTienda }, pay)).toEqual({ action: 'replay' })
  })

  test('Negocio: a renewal adds after the current end, guarded on EXACTLY what was read; a live trial is not thrown away', () => {
    const meta = { [NEGOCIO_GRANT_KEY]: liveOneTime }
    const d = decideNegocioPayment(meta, pay)
    expect(d).toMatchObject({ action: 'write', grant: { expires_at: addMonthsClamped(new Date(liveOneTime.expires_at), 12).toISOString() }, guard: { mode: 'equals', expected: liveOneTime } })
    const onTrial = decideNegocioPayment({ [NEGOCIO_TRIAL_KEY]: liveTrial }, pay)
    expect(onTrial).toMatchObject({ grant: { expires_at: addMonthsClamped(new Date(liveTrial.expires_at), 12).toISOString() } })
    expect(decideNegocioPayment({ [NEGOCIO_GRANT_KEY]: null }, pay)).toMatchObject({ guard: { mode: 'json_null' } })
  })

  test('Negocio with no Tienda grant, or a lapsed one, moves nothing: there is no second key in the write', () => {
    for (const meta of [{}, { [TIENDA_GRANT_KEY]: lapsedTienda }, { [TIENDA_GRANT_KEY]: { type: 'comp', granted_at: iso(0) } }, { [TIENDA_GRANT_KEY]: 'x' }]) {
      const d = decideNegocioPayment(meta, pay)
      expect(d.action).toBe('write')
      expect('also' in d).toBe(false)
    }
  })

  test('Tienda time under Negocio: a live Tienda grant moves forward by the Negocio months, in the same write', () => {
    const tienda = { ...liveTienda, note: 'yearly 12m', payments: ['cs_t1'] }
    const meta = { [TIENDA_GRANT_KEY]: tienda }
    const d = decideNegocioPayment(meta, { ...pay, months: 9 })
    if (d.action !== 'write') throw new Error('expected a write')
    // The Negocio grant is exactly what it would have been without Tienda…
    expect(d.grant).toEqual((decideNegocioPayment({}, { ...pay, months: 9 }) as typeof d).grant)
    // …and the Tienda grant keeps everything but its end, which moves by the same 9 months.
    expect(d.also).toEqual({ key: TIENDA_GRANT_KEY, value: { ...tienda, expires_at: addMonthsClamped(new Date(tienda.expires_at), 9).toISOString() } })
    // The time left on Tienda when Negocio ends equals the time it had left when Negocio was bought (to the month clamp).
    const leftBefore = Date.parse(tienda.expires_at) - NOW.getTime()
    const leftAfter = Date.parse(d.also!.value.expires_at!) - Date.parse(d.grant.expires_at!)
    expect(Math.abs(leftAfter - leftBefore)).toBeLessThanOrEqual(3 * DAY)
    // The guard is still the Negocio key's, as read.
    expect(d.guard).toEqual({ mode: 'absent' })
  })

  test('a second Negocio payment moves the Tienda grant again, by its own months', () => {
    const first = decideNegocioPayment({ [TIENDA_GRANT_KEY]: liveTienda }, pay)
    if (first.action !== 'write' || !first.also) throw new Error('expected a write that moves Tienda')
    const after = { [NEGOCIO_GRANT_KEY]: first.grant, [TIENDA_GRANT_KEY]: first.also.value }
    const second = decideNegocioPayment(after, { ...pay, paymentId: 'cs_2', months: 3 })
    if (second.action !== 'write') throw new Error('expected a write')
    expect(second.also?.value.expires_at).toBe(addMonthsClamped(new Date(first.also.value.expires_at!), 3).toISOString())
    // And replaying either payment moves nothing.
    const done = { [NEGOCIO_GRANT_KEY]: second.grant, [TIENDA_GRANT_KEY]: second.also!.value }
    expect(decideNegocioPayment(done, pay)).toEqual({ action: 'replay' })
    expect(decideNegocioPayment(done, { ...pay, paymentId: 'cs_2', months: 3 })).toEqual({ action: 'replay' })
  })

  test('the write is ONE merge of both keys under the one guard on the paid plan\'s key', () => {
    const meta = { [NEGOCIO_GRANT_KEY]: liveOneTime, [TIENDA_GRANT_KEY]: liveTienda }
    const d = decideNegocioPayment(meta, pay)
    if (d.action !== 'write') throw new Error('expected a write')
    expect(grantWriteRpcArgs('shop_1', NEGOCIO_GRANT_KEY, d)).toEqual({
      p_shop_id: 'shop_1',
      p_patch: { [NEGOCIO_GRANT_KEY]: d.grant, [TIENDA_GRANT_KEY]: d.also!.value },
      p_guard_key: NEGOCIO_GRANT_KEY,
      p_guard_mode: 'equals',
      p_expected: liveOneTime,
    })
    const alone = decideNegocioPayment({}, pay)
    if (alone.action !== 'write') throw new Error('expected a write')
    expect(grantWriteRpcArgs('shop_1', NEGOCIO_GRANT_KEY, alone)).toEqual({
      p_shop_id: 'shop_1', p_patch: { [NEGOCIO_GRANT_KEY]: alone.grant }, p_guard_key: NEGOCIO_GRANT_KEY, p_guard_mode: 'absent', p_expected: null,
    })
  })

  test('the webhook writes through that one function: no second, unguarded write of the Tienda key', () => {
    const src = readFileSync('lib/negocio-webhook.ts', 'utf8')
    expect(src).toContain("db.rpc('merge_shop_metadata', grantWriteRpcArgs(input.shopId, NEGOCIO_GRANT_KEY, decision))")
    expect(src.match(/merge_shop_metadata'/g)).toHaveLength(1)
    expect(src).not.toContain('TIENDA_GRANT_KEY')
  })

  test('Tienda, first payment: the same rules under the Tienda key', () => {
    expect(decideTiendaPayment({}, pay)).toEqual({
      action: 'write',
      grant: { type: 'one_time', granted_at: NOW.toISOString(), expires_at: addMonthsClamped(NOW, 12).toISOString(), note: 'yearly 12m', payments: ['cs_1'] },
      guard: { mode: 'absent' },
    })
    expect(decideTiendaPayment({ [TIENDA_GRANT_KEY]: null }, pay)).toMatchObject({ guard: { mode: 'json_null' } })
    const d = decideTiendaPayment({}, pay)
    if (d.action !== 'write') throw new Error('expected a write')
    expect(grantWriteRpcArgs('shop_1', TIENDA_GRANT_KEY, d)).toMatchObject({ p_patch: { [TIENDA_GRANT_KEY]: d.grant }, p_guard_key: TIENDA_GRANT_KEY, p_guard_mode: 'absent' })
  })

  test('Tienda: a replay writes nothing — and a Negocio payment with the same id is not a Tienda replay', () => {
    expect(decideTiendaPayment({ [TIENDA_GRANT_KEY]: { ...liveTienda, payments: ['cs_1'] } }, pay)).toEqual({ action: 'replay' })
    expect(decideTiendaPayment({ [NEGOCIO_GRANT_KEY]: { ...lapsedOneTime, payments: ['cs_1'] } }, pay).action).toBe('write')
  })

  test('Tienda: a renewal adds after the current end, guarded on exactly what was read; a lapsed grant restarts from now', () => {
    const d = decideTiendaPayment({ [TIENDA_GRANT_KEY]: liveTienda }, pay)
    expect(d).toMatchObject({ action: 'write', grant: { expires_at: addMonthsClamped(new Date(liveTienda.expires_at), 12).toISOString(), granted_at: NOW.toISOString() }, guard: { mode: 'equals', expected: liveTienda } })
    expect(decideTiendaPayment({ [TIENDA_GRANT_KEY]: lapsedTienda }, pay)).toMatchObject({ grant: { expires_at: addMonthsClamped(NOW, 12).toISOString() }, guard: { mode: 'equals', expected: lapsedTienda } })
  })

  test('Tienda months start after a live trial and after a live dated Negocio grant — never underneath them', () => {
    expect(decideTiendaPayment({ [NEGOCIO_TRIAL_KEY]: liveTrial }, pay)).toMatchObject({ grant: { expires_at: addMonthsClamped(new Date(liveTrial.expires_at), 12).toISOString() } })
    expect(decideTiendaPayment({ [NEGOCIO_TRIAL_KEY]: endedTrial }, pay)).toMatchObject({ grant: { expires_at: addMonthsClamped(NOW, 12).toISOString() } })
    expect(decideTiendaPayment({ [NEGOCIO_GRANT_KEY]: liveOneTime }, pay)).toMatchObject({ grant: { expires_at: addMonthsClamped(new Date(liveOneTime.expires_at), 12).toISOString() } })
    expect(decideTiendaPayment({ [NEGOCIO_GRANT_KEY]: lapsedOneTime }, pay)).toMatchObject({ grant: { expires_at: addMonthsClamped(NOW, 12).toISOString() } })
    // The later of the two wins.
    expect(decideTiendaPayment({ [NEGOCIO_TRIAL_KEY]: liveTrial, [NEGOCIO_GRANT_KEY]: liveOneTime }, pay)).toMatchObject({ grant: { expires_at: addMonthsClamped(new Date(liveOneTime.expires_at), 12).toISOString() } })
  })

  test('whichever grant is written second, the shop ends with the same dates (a package that grants both)', () => {
    const negocio3 = { paymentId: 'pkg_n', months: 3, now: NOW }
    const tienda12 = { paymentId: 'pkg_t', months: 12, now: NOW }
    const apply = (meta: Record<string, unknown>, key: string, d: ReturnType<typeof decideNegocioPayment> | ReturnType<typeof decideTiendaPayment>) => {
      if (d.action !== 'write') throw new Error('expected a write')
      return { ...meta, [key]: d.grant, ...(d.also ? { [d.also.key]: d.also.value } : {}) }
    }
    const a1 = apply({}, NEGOCIO_GRANT_KEY, decideNegocioPayment({}, negocio3))
    const a = apply(a1, TIENDA_GRANT_KEY, decideTiendaPayment(a1, tienda12))
    const b1 = apply({}, TIENDA_GRANT_KEY, decideTiendaPayment({}, tienda12))
    const b = apply(b1, NEGOCIO_GRANT_KEY, decideNegocioPayment(b1, negocio3))
    const ends = (m: Record<string, unknown>) => [readNegocioGrant(m)?.expires_at, readTiendaGrant(m)?.expires_at]
    expect(ends(a)).toEqual([addMonthsClamped(NOW, 3).toISOString(), addMonthsClamped(NOW, 15).toISOString()])
    expect(ends(b)).toEqual(ends(a))
  })

  test('the guard matches what was read: absent, JSON null, or the exact value', () => {
    expect(guardFor({}, TIENDA_GRANT_KEY)).toEqual({ mode: 'absent' })
    expect(guardFor({ [TIENDA_GRANT_KEY]: null }, TIENDA_GRANT_KEY)).toEqual({ mode: 'json_null' })
    expect(guardFor({ [TIENDA_GRANT_KEY]: liveTienda }, TIENDA_GRANT_KEY)).toEqual({ mode: 'equals', expected: liveTienda })
  })
})
