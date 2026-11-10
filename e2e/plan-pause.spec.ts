/**
 * The pause for lack of a plan (epic 08 · plan-tienda-three-free-months S3.3, README D9). Pure: the decision for
 * every combination, the exact claim and clear arguments, and the runner's validate → claim → re-check → pause →
 * release order with every Backend answer, through injected I/O.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import {
  PLAN_PAUSE_KEY,
  PLAN_PAUSE_REASON,
  buildPlanPause,
  claimLanded,
  claimMarket,
  decidePlanPause,
  hadPlanThatEnded,
  hasPlanPause,
  pauseOutcomeOf,
  planPauseClaimArgs,
  planPauseClearArgs,
  planPauseMarketOf,
  runPlanPause,
  type PauseCallResult,
  type PauseCandidate,
  type PlanPauseDeps,
  type PlanPauseMarket,
  type SellerStatusFact,
} from '../lib/plan-pause'
import {
  NEGOCIO_GRANT_KEY,
  NEGOCIO_TRIAL_KEY,
  PLAN_LEGACY_KEY,
  TIENDA_GRANT_KEY,
  readPlanLegacyState,
  type PlanLegacyState,
  type PlanReason,
  type PlanState,
} from '../lib/plan'

const NOW = new Date('2027-02-10T12:00:00Z')
const endedTrial = { started_at: '2026-11-10T12:00:00.000Z', expires_at: '2027-02-08T12:00:00.000Z' }
const liveTrial = { started_at: '2026-12-10T12:00:00.000Z', expires_at: '2027-03-10T12:00:00.000Z' }

/** One state per PlanReason, as `derivePlan` reports it. */
const PLANS: Record<PlanReason, PlanState> = {
  comp: { plan: 'negocio', reason: 'comp', endsAt: null },
  one_time: { plan: 'negocio', reason: 'one_time', endsAt: '2027-06-01T00:00:00.000Z' },
  subscription: { plan: 'negocio', reason: 'subscription', endsAt: null },
  trial: { plan: 'trial', reason: 'trial', endsAt: liveTrial.expires_at },
  tienda_one_time: { plan: 'tienda', reason: 'tienda_one_time', endsAt: '2027-06-01T00:00:00.000Z' },
  tienda_subscription: { plan: 'tienda', reason: 'tienda_subscription', endsAt: null },
  trial_ended: { plan: 'gratis', reason: 'trial_ended', endsAt: null },
  legacy: { plan: 'gratis', reason: 'legacy', endsAt: null },
  unpaid: { plan: 'unpaid', reason: 'unpaid', endsAt: null },
  unavailable: { plan: 'gratis', reason: 'unavailable', endsAt: null },
}

test.describe('decidePlanPause — every combination (D9)', () => {
  const owners = [['owned', 'user_1'], ['unowned', null]] as const
  const legacies: PlanLegacyState[] = ['marked', 'absent', 'unreadable']
  const claims = [['unclaimed', undefined], ['claimed', { paused_at: '2027-02-09T00:00:00.000Z', market: 'mx' as const }]] as const
  const plans: Array<[string, PlanState | null]> = [...Object.entries(PLANS), ['read failed', null]]
  const markets: PlanPauseMarket[] = ['mx', 'other', 'unknown']

  for (const [ownerLabel, owner] of owners) {
    for (const legacy of legacies) {
      for (const [claimLabel, claim] of claims) {
        for (const market of markets) {
          test(`${ownerLabel} · legacy ${legacy} · ${claimLabel} · market ${market} · every plan`, () => {
            for (const [planLabel, plan] of plans) {
              const metadata = { [NEGOCIO_TRIAL_KEY]: endedTrial, ...(claim ? { [PLAN_PAUSE_KEY]: claim } : {}) }
              const d = decidePlanPause({ clerk_user_id: owner, metadata }, plan, legacy, NOW, market)
              const eligible = owner !== null && legacy === 'absent' && !claim
              const label = `${planLabel}: ${JSON.stringify(d)}`
              // Only a shop KNOWN to be in Mexico can be paused; another market leaves, an unknown one is unavailable.
              if (eligible && market === 'other') expect(d, label).toEqual({ action: 'leave', why: 'not_mx' })
              else if (eligible && market === 'unknown') expect(d, label).toEqual({ action: 'unavailable', why: 'market_unknown' })
              else if (eligible && plan?.reason === 'unpaid') expect(d, label).toEqual({ action: 'pause', why: 'unpaid' })
              else if (eligible && (plan === null || plan.reason === 'unavailable')) expect(d, label).toEqual({ action: 'unavailable', why: 'plan_unreadable' })
              else expect(d.action, label).toBe('leave')
            }
          })
        }
      }
    }
  }

  test('the leave reasons name the real cause', () => {
    const meta = { [NEGOCIO_TRIAL_KEY]: endedTrial }
    const unpaid = PLANS.unpaid
    expect(decidePlanPause({ clerk_user_id: null, metadata: meta }, unpaid, 'absent', NOW, 'mx').why).toBe('unowned')
    expect(decidePlanPause({ clerk_user_id: 'u', metadata: meta }, unpaid, 'marked', NOW, 'mx').why).toBe('legacy')
    expect(decidePlanPause({ clerk_user_id: 'u', metadata: meta }, unpaid, 'unreadable', NOW, 'mx').why).toBe('legacy_unreadable')
    expect(decidePlanPause({ clerk_user_id: 'u', metadata: { ...meta, [PLAN_PAUSE_KEY]: 'garbage' } }, unpaid, 'absent', NOW, 'mx').why).toBe('already_claimed')
    expect(decidePlanPause({ clerk_user_id: 'u', metadata: meta }, PLANS.tienda_one_time, 'absent', NOW, 'mx').why).toBe('has_plan')
  })

  test('a shop that never had a plan end (no trial was ever stamped) is never paused', () => {
    expect(decidePlanPause({ clerk_user_id: 'u', metadata: {} }, PLANS.unpaid, 'absent', NOW, 'mx')).toEqual({ action: 'leave', why: 'never_started' })
    // A lapsed paid grant with no trial counts as a plan that ended.
    const lapsed = { [TIENDA_GRANT_KEY]: { type: 'one_time', granted_at: '2026-01-01T00:00:00.000Z', expires_at: '2027-01-01T00:00:00.000Z' } }
    expect(decidePlanPause({ clerk_user_id: 'u', metadata: lapsed }, PLANS.unpaid, 'absent', NOW, 'mx').action).toBe('pause')
    expect(hadPlanThatEnded({ [NEGOCIO_TRIAL_KEY]: liveTrial }, NOW)).toBe(false)
  })

  test('the legacy state the shell passes is read with the seam\'s own reader', () => {
    expect(readPlanLegacyState({ [PLAN_LEGACY_KEY]: { marked_at: '2026-11-12T00:00:00Z' } })).toBe('marked')
    expect(readPlanLegacyState({ [PLAN_LEGACY_KEY]: 'yes' })).toBe('unreadable')
    expect(readPlanLegacyState({})).toBe('absent')
  })
})

test.describe('the claim record', () => {
  test('any non-null value is a claim; JSON null (a release) and absent are not', () => {
    expect(hasPlanPause({})).toBe(false)
    expect(hasPlanPause({ [PLAN_PAUSE_KEY]: null })).toBe(false)
    expect(hasPlanPause(null)).toBe(false)
    expect(hasPlanPause({ [PLAN_PAUSE_KEY]: { paused_at: 'x' } })).toBe(true)
    expect(hasPlanPause({ [PLAN_PAUSE_KEY]: 'malformed' })).toBe(true)
  })

  test('the claim guards plan_pause as read AND the three keys the plan was decided from', () => {
    const grant = { type: 'one_time', granted_at: '2026-01-01T00:00:00.000Z', expires_at: '2027-01-01T00:00:00.000Z' }
    const claim = buildPlanPause(NOW)
    const args = planPauseClaimArgs('shop_1', { [NEGOCIO_TRIAL_KEY]: endedTrial, [TIENDA_GRANT_KEY]: grant }, claim)
    expect(args).toEqual({
      p_shop_id: 'shop_1',
      p_patch: { [PLAN_PAUSE_KEY]: claim },
      p_guards: [
        { key: PLAN_PAUSE_KEY, mode: 'absent' },
        { key: NEGOCIO_GRANT_KEY, mode: 'absent' },
        { key: TIENDA_GRANT_KEY, mode: 'equals', expected: grant },
        { key: NEGOCIO_TRIAL_KEY, mode: 'equals', expected: endedTrial },
      ],
    })
    // After a release the key holds JSON null, and the next claim must match THAT, or it never lands.
    expect(planPauseClaimArgs('shop_1', { [PLAN_PAUSE_KEY]: null }, claim).p_guards[0]).toEqual({ key: PLAN_PAUSE_KEY, mode: 'json_null' })
  })

  test('the clear is guarded on exactly the value expected, and a claim counts only when the row carries it', () => {
    const claim = buildPlanPause(NOW)
    expect(planPauseClearArgs('shop_1', claim)).toEqual({ p_shop_id: 'shop_1', p_patch: { [PLAN_PAUSE_KEY]: null }, p_guard_key: PLAN_PAUSE_KEY, p_guard_mode: 'equals', p_expected: claim })
    expect(claimLanded({ [PLAN_PAUSE_KEY]: claim }, claim)).toBe(true)
    expect(claimLanded({ [PLAN_PAUSE_KEY]: { paused_at: 'another run' } }, claim)).toBe(false)
    expect(claimLanded({}, claim)).toBe(false)
  })
})

test.describe('the market fact', () => {
  test('only the code `mx` is Mexico; any other code is another market; nothing is unknown, never a default', () => {
    expect(planPauseMarketOf('mx')).toBe('mx')
    expect(planPauseMarketOf('us')).toBe('other')
    expect(planPauseMarketOf(null)).toBe('unknown')
    expect(planPauseMarketOf(undefined)).toBe('unknown')
    expect(planPauseMarketOf('')).toBe('unknown')
  })
  test('the claim records that the shop was known to be in Mexico; an older or malformed claim is unknown', () => {
    expect(buildPlanPause(NOW)).toEqual({ paused_at: NOW.toISOString(), market: 'mx' })
    expect(claimMarket({ [PLAN_PAUSE_KEY]: buildPlanPause(NOW) })).toBe('mx')
    expect(claimMarket({ [PLAN_PAUSE_KEY]: { paused_at: NOW.toISOString() } })).toBe('unknown')
    expect(claimMarket({ [PLAN_PAUSE_KEY]: 'x' })).toBe('unknown')
    expect(claimMarket({})).toBe('unknown')
  })
  test('the shell reads the market from the Medusa seller, fresh, trusted only when its id is the mirror\'s', () => {
    const src = readFileSync('lib/plan-pause-server.ts', 'utf8')
    expect(src).toMatch(/readShopFresh\(slug\)/)
    expect(src).toMatch(/if \(read\.shop\.id !== expectedId\) return 'unknown'/)
    expect(src).toMatch(/planPauseMarketOf\(readPublicSellerMarket\(read\.shop\)\?\.market_code\)/)
  })
})

test.describe('the Backend answer', () => {
  test('paused, already paused (409), failed, unknown — and a 200 that left the seller active is a failure', () => {
    expect(pauseOutcomeOf({ ok: true, to: 'paused', complete: true })).toEqual({ outcome: 'paused' })
    expect(pauseOutcomeOf({ ok: false, status: 409, message: 'ya' })).toEqual({ outcome: 'already_paused' })
    expect(pauseOutcomeOf({ ok: false, status: 400, message: 'no' }).outcome).toBe('failed')
    expect(pauseOutcomeOf({ ok: 'unknown', message: 'timeout' }).outcome).toBe('unknown')
    expect(pauseOutcomeOf({ ok: true, to: 'active', complete: false }).outcome).toBe('failed')
  })

  test('the shell sends status paused with the reason plan_unpaid, through the admin transport', () => {
    const src = readFileSync('lib/plan-pause-server.ts', 'utf8')
    expect(PLAN_PAUSE_REASON).toBe('plan_unpaid')
    expect(src).toMatch(/changeSellerStatus\(\{ medusaSellerId, status: 'paused', reason: PLAN_PAUSE_REASON \}\)/)
    expect(src).toMatch(/\.not\('clerk_user_id', 'is', null\)/)
    expect(src).toMatch(/\.order\('created_at'[\s\S]*\.order\('id'/)
  })
})

// ── The runner ──────────────────────────────────────────────────────────────

function shop(id: string, extra: Record<string, unknown> = {}): PauseCandidate {
  return { id, slug: id, name: id, clerk_user_id: 'user_' + id, metadata: { [NEGOCIO_TRIAL_KEY]: endedTrial, medusa_seller_id: 'sel_' + id, ...extra } }
}

function harness(opts: {
  shops: PauseCandidate[]
  plan?: (s: PauseCandidate, call: number) => PlanState | null
  status?: (s: PauseCandidate, call: number) => SellerStatusFact
  market?: (s: PauseCandidate) => PlanPauseMarket
  claim?: boolean
  pause?: PauseCallResult
  release?: boolean
  pageSize?: number
  failPage?: number
}) {
  const log: string[] = []
  const planCalls = new Map<string, number>()
  const statusCalls = new Map<string, number>()
  const alerts: string[] = []
  const pageSize = opts.pageSize ?? 500
  const deps: PlanPauseDeps = {
    pageSize,
    readPage: async (from, to) => {
      log.push(`page:${from}-${to}`)
      if (opts.failPage !== undefined && from === opts.failPage * pageSize) return null
      return opts.shops.slice(from, to + 1)
    },
    readPlan: async (s) => {
      const n = (planCalls.get(s.id) ?? 0) + 1
      planCalls.set(s.id, n)
      log.push(`plan:${s.id}`)
      return opts.plan ? opts.plan(s, n) : PLANS.unpaid
    },
    readLegacy: readPlanLegacyState,
    readMarket: async (s) => { log.push(`market:${s.id}`); return opts.market ? opts.market(s) : 'mx' },
    readSellerStatus: async (s) => {
      const n = (statusCalls.get(s.id) ?? 0) + 1
      statusCalls.set(s.id, n)
      log.push(`status:${s.id}`)
      return opts.status ? opts.status(s, n) : 'active'
    },
    claim: async (s, c) => { log.push(`claim:${s.id}:${c.paused_at}`); return opts.claim ?? true },
    pause: async (s) => { log.push(`pause:${s.id}`); return opts.pause ?? { outcome: 'paused' } },
    release: async (s, c) => { log.push(`release:${s.id}:${c.paused_at}`); return opts.release ?? true },
    alert: (m) => { alerts.push(m) },
    now: () => NOW,
  }
  return { deps, log, alerts }
}

test.describe('runPlanPause — validate, claim, re-check, apply, release', () => {
  test('a dry run reads and decides, and writes NOTHING: no claim, no Backend write, no release', async () => {
    const { deps, log } = harness({ shops: [shop('a'), shop('b', { [PLAN_LEGACY_KEY]: { marked_at: '2026-11-12T00:00:00Z' } })] })
    const run = await runPlanPause(deps, { dryRun: true })
    expect(run).toMatchObject({ ok: true, dryRun: true, read: 2, paused: 0, left: { legacy: 1 } })
    if (!run.ok) throw new Error('unreachable')
    expect(run.candidates).toEqual([{ shopId: 'a', slug: 'a', name: 'a', result: 'would_pause' }])
    expect(log.filter((l) => /^(claim|pause|release)/.test(l))).toEqual([])
  })

  test('the order: status → claim → plan re-check → pause, and nothing released on success', async () => {
    const { deps, log } = harness({ shops: [shop('a')] })
    const run = await runPlanPause(deps, { dryRun: false })
    expect(run).toMatchObject({ ok: true, paused: 1, failed: 0 })
    expect(log.filter((l) => !l.startsWith('page'))).toEqual(['market:a', 'plan:a', 'status:a', `claim:a:${NOW.toISOString()}`, 'plan:a', 'pause:a'])
  })

  test('a Backend failure releases exactly the claim written, so the next run retries, and alerts', async () => {
    const { deps, log, alerts } = harness({ shops: [shop('a')], pause: { outcome: 'failed', detail: 'HTTP 500' } })
    const run = await runPlanPause(deps, { dryRun: false })
    expect(run).toMatchObject({ ok: true, paused: 0, failed: 1 })
    expect(log.slice(-2)).toEqual(['pause:a', `release:a:${NOW.toISOString()}`])
    expect(alerts).toHaveLength(1)
  })

  test('already paused by someone else: the claim comes off, so a payment never lifts that pause', async () => {
    const { deps, log } = harness({ shops: [shop('a')], pause: { outcome: 'already_paused' } })
    const run = await runPlanPause(deps, { dryRun: false })
    expect(run.ok && run.candidates[0].result).toBe('already_paused')
    expect(log.at(-1)).toBe(`release:a:${NOW.toISOString()}`)
  })

  test('a seller already paused or deleted at the validate step is never claimed', async () => {
    for (const st of ['paused', 'deleted'] as const) {
      const { deps, log } = harness({ shops: [shop('a')], status: () => st })
      const run = await runPlanPause(deps, { dryRun: false })
      expect(run.ok && run.candidates[0]).toMatchObject({ result: 'not_active', detail: st })
      expect(log.some((l) => l.startsWith('claim'))).toBe(false)
    }
  })

  test('a seller status that cannot be read, or no Medusa seller, is never claimed', async () => {
    for (const st of ['unavailable', 'no_seller'] as const) {
      const { deps, log } = harness({ shops: [shop('a')], status: () => st })
      await runPlanPause(deps, { dryRun: false })
      expect(log.some((l) => l.startsWith('claim'))).toBe(false)
    }
  })

  test('a lost claim calls nothing', async () => {
    const { deps, log } = harness({ shops: [shop('a')], claim: false })
    const run = await runPlanPause(deps, { dryRun: false })
    expect(run.ok && run.candidates[0].result).toBe('claim_lost')
    expect(log.some((l) => l.startsWith('pause') || l.startsWith('release'))).toBe(false)
  })

  test('a shop that paid between the read and the claim is released and never paused', async () => {
    const { deps, log } = harness({ shops: [shop('a')], plan: (_s, n) => (n === 1 ? PLANS.unpaid : PLANS.tienda_subscription) })
    const run = await runPlanPause(deps, { dryRun: false })
    expect(run.ok && run.candidates[0].result).toBe('paid_meanwhile')
    expect(log.some((l) => l.startsWith('pause'))).toBe(false)
    expect(log.at(-1)).toBe(`release:a:${NOW.toISOString()}`)
  })

  test('an unknown answer is settled by reading the status back: paused keeps the claim, active releases it, unreadable keeps it and asks a person', async () => {
    const cases: Array<[SellerStatusFact, string, boolean]> = [['paused', 'paused', false], ['active', 'failed', true], ['unavailable', 'unknown', false]]
    for (const [after, result, released] of cases) {
      const { deps, log, alerts } = harness({ shops: [shop('a')], pause: { outcome: 'unknown', detail: 'timeout' }, status: (_s, n) => (n === 1 ? 'active' : after) })
      const run = await runPlanPause(deps, { dryRun: false })
      expect(run.ok && run.candidates[0].result).toBe(result)
      expect(log.some((l) => l.startsWith('release'))).toBe(released)
      if (after !== 'paused') expect(alerts.length).toBe(1)
    }
  })

  test('a plan that cannot be read is unavailable and never claimed', async () => {
    const { deps, log } = harness({ shops: [shop('a')], plan: () => null })
    const run = await runPlanPause(deps, { dryRun: false })
    expect(run).toMatchObject({ ok: true, unavailable: 1, paused: 0 })
    expect(log.some((l) => l.startsWith('claim') || l.startsWith('status'))).toBe(false)
  })

  test('legacy and unowned shops cost no plan read and no market read', async () => {
    const { deps, log } = harness({ shops: [shop('a', { [PLAN_LEGACY_KEY]: { marked_at: '2026-11-12T00:00:00Z' } }), { ...shop('b'), clerk_user_id: null }] })
    await runPlanPause(deps, { dryRun: false })
    expect(log.some((l) => l.startsWith('plan') || l.startsWith('market'))).toBe(false)
  })

  test('a shop outside Mexico is left, counted under `not_mx`, with no plan read and nothing written (S3.3 review)', async () => {
    const { deps, log } = harness({ shops: [shop('us1'), shop('mx1')], market: (s) => (s.id === 'us1' ? 'other' : 'mx') })
    const dry = await runPlanPause(deps, { dryRun: true })
    expect(dry).toMatchObject({ ok: true, left: { not_mx: 1 } })
    if (!dry.ok) throw new Error('unreachable')
    expect(dry.candidates.map((c) => c.shopId)).toEqual(['mx1'])
    await runPlanPause(deps, { dryRun: false })
    expect(log.filter((l) => l.endsWith(':us1') || l.includes(':us1:')).filter((l) => !l.startsWith('market'))).toEqual([])
  })

  test('a shop whose market cannot be read is unavailable, by reason, and never claimed', async () => {
    const { deps, log } = harness({ shops: [shop('a')], market: () => 'unknown' })
    const run = await runPlanPause(deps, { dryRun: false })
    expect(run).toMatchObject({ ok: true, unavailable: 1, unavailableBy: { market_unknown: 1 }, paused: 0 })
    expect(log.some((l) => /^(plan|status|claim|pause)/.test(l))).toBe(false)
  })

  test('a market read that throws is unknown, never Mexico', async () => {
    const { deps, log } = harness({ shops: [shop('a')], market: () => { throw new Error('socket hang up') } })
    const run = await runPlanPause(deps, { dryRun: false })
    expect(run).toMatchObject({ ok: true, unavailableBy: { market_unknown: 1 } })
    expect(log.some((l) => l.startsWith('claim'))).toBe(false)
  })

  test('every page is read, and a page that fails fails the run — never a confident short list', async () => {
    const shops = ['a', 'b', 'c', 'd', 'e'].map((id) => shop(id))
    const all = harness({ shops, pageSize: 2 })
    const run = await runPlanPause(all.deps, { dryRun: true })
    expect(run).toMatchObject({ ok: true, read: 5 })
    expect(all.log.filter((l) => l.startsWith('page'))).toEqual(['page:0-1', 'page:2-3', 'page:4-5'])
    const broken = harness({ shops, pageSize: 2, failPage: 1 })
    expect(await runPlanPause(broken.deps, { dryRun: true })).toEqual({ ok: false, error: 'unavailable', read: 2 })
  })
})

test.describe('the cron route', () => {
  const src = readFileSync('app/api/cron/plan-pause/route.ts', 'utf8')
  test('is authorised by the x-cron-secret header like the other VM crons, before anything is read', () => {
    expect(src).toMatch(/cronSecretMatches\(req\.headers\.get\('x-cron-secret'\), process\.env\.CRON_SECRET\)/)
    expect(src.indexOf('cronSecretMatches(')).toBeLessThan(src.indexOf('runPlanPause('))
  })
  test('any dry_run value but an explicit 0 is a dry run', () => {
    expect(src).toMatch(/dryParam !== null && dryParam !== '0'/)
  })
})
