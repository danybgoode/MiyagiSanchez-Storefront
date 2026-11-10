/**
 * A payment brings a shop paused for lack of a plan back (epic 08 · plan-tienda-three-free-months S3.4, README D10).
 * Pure: restore only with `plan_pause`, relink first and clear after, a replay restores nothing twice, and a failure
 * never throws into the payment that called it. Plus what «Tu suscripción» says, and the paused owner's way in.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { PLAN_PAUSE_KEY, PLAN_RESTORE_REASON } from '../lib/plan-pause'
import { PACKAGES, applyPackageGrants, type PackageSku } from '../lib/promoter-packages'
import { restoreAfterPlanPaid, restoreOutcomeOf, type PlanRestoreDeps, type RestoreCallResult } from '../lib/plan-restore'
import { PLAN_PAUSED_HEADLINE, PLAN_PAUSED_NOTICE, PLAN_PAUSED_PAID_NOTICE, negocioPageView } from '../lib/negocio-page'
import type { PlanState } from '../lib/plan'

const CLAIM = { paused_at: '2027-02-09T06:00:00.000Z' }

/** A shop in memory: the metadata changes as the deps write, so a replay sees what the first run left. */
function harness(opts: { metadata?: Record<string, unknown> | null; activate?: RestoreCallResult | 'throw'; clear?: boolean; readThrows?: boolean }) {
  let metadata: Record<string, unknown> | null = opts.metadata === undefined ? { [PLAN_PAUSE_KEY]: CLAIM, medusa_seller_id: 'sel_1' } : opts.metadata
  const log: string[] = []
  const alerts: string[] = []
  const deps: PlanRestoreDeps = {
    readMetadata: async () => {
      log.push('read')
      if (opts.readThrows) throw new Error('db down')
      return metadata
    },
    activate: async () => {
      log.push('activate')
      if (opts.activate === 'throw') throw new Error('socket hang up')
      return opts.activate ?? { outcome: 'active', complete: true }
    },
    clearClaim: async (_id, expected) => {
      log.push(`clear:${JSON.stringify(expected)}`)
      if (opts.clear === false) return false
      if (metadata && JSON.stringify(metadata[PLAN_PAUSE_KEY]) === JSON.stringify(expected)) metadata = { ...metadata, [PLAN_PAUSE_KEY]: null }
      return true
    },
    alert: (m) => { alerts.push(m) },
  }
  return { deps, log, alerts }
}

test.describe('restoreAfterPlanPaid (D10)', () => {
  test('no plan_pause, no call: an admin pause (which never writes it) stays paused', async () => {
    for (const metadata of [{}, { [PLAN_PAUSE_KEY]: null }]) {
      const { deps, log } = harness({ metadata })
      expect(await restoreAfterPlanPaid('shop_1', deps)).toBe('not_paused')
      expect(log).toEqual(['read'])
    }
  })

  test('with plan_pause: the seller is set active FIRST, the claim cleared AFTER, guarded on the value read', async () => {
    const { deps, log } = harness({})
    expect(await restoreAfterPlanPaid('shop_1', deps)).toBe('restored')
    expect(log).toEqual(['read', 'activate', `clear:${JSON.stringify(CLAIM)}`])
  })

  test('a replayed payment restores nothing twice', async () => {
    const { deps, log } = harness({})
    await restoreAfterPlanPaid('shop_1', deps)
    expect(await restoreAfterPlanPaid('shop_1', deps)).toBe('not_paused')
    expect(log.filter((l) => l === 'activate')).toHaveLength(1)
  })

  test('already active (an earlier restore whose clear failed): the stale claim is cleared, nothing else', async () => {
    const { deps, log } = harness({ activate: { outcome: 'already_active' } })
    expect(await restoreAfterPlanPaid('shop_1', deps)).toBe('already_active')
    expect(log.at(-1)).toBe(`clear:${JSON.stringify(CLAIM)}`)
  })

  test('a failed or unknown restore alerts, KEEPS the claim and never throws into the payment', async () => {
    for (const activate of [{ outcome: 'failed', detail: 'HTTP 500' } as const, { outcome: 'unknown', detail: 'timeout' } as const, 'throw' as const]) {
      const { deps, log, alerts } = harness({ activate })
      await expect(restoreAfterPlanPaid('shop_1', deps)).resolves.toBe('failed')
      expect(log.some((l) => l.startsWith('clear'))).toBe(false)
      expect(alerts).toHaveLength(1)
    }
  })

  test('a shop that cannot be read alerts and does not throw', async () => {
    const { deps, alerts } = harness({ readThrows: true })
    await expect(restoreAfterPlanPaid('shop_1', deps)).resolves.toBe('failed')
    expect(alerts).toHaveLength(1)
  })

  test('a partial restore is reported as partial, and a clear that does not land alerts', async () => {
    const partial = harness({ activate: { outcome: 'active', complete: false } })
    expect(await restoreAfterPlanPaid('shop_1', partial.deps)).toBe('restored_partly')
    expect(partial.alerts).toHaveLength(1)
    const stuck = harness({ clear: false })
    expect(await restoreAfterPlanPaid('shop_1', stuck.deps)).toBe('restored')
    expect(stuck.alerts).toHaveLength(1)
  })

  test('the Backend answer: active, already active (409), failed, unknown', () => {
    expect(restoreOutcomeOf({ ok: true, to: 'active', complete: true })).toEqual({ outcome: 'active', complete: true })
    expect(restoreOutcomeOf({ ok: false, status: 409, message: 'ya' })).toEqual({ outcome: 'already_active' })
    expect(restoreOutcomeOf({ ok: false, status: 400, message: 'x' }).outcome).toBe('failed')
    expect(restoreOutcomeOf({ ok: false, status: 500, message: 'x' }).outcome).toBe('unknown')
    expect(restoreOutcomeOf({ ok: 'unknown', message: 't' }).outcome).toBe('unknown')
    expect(restoreOutcomeOf({ ok: true, to: 'paused', complete: false }).outcome).toBe('failed')
  })
})

test.describe('the payment paths call the restore', () => {
  const webhook = readFileSync('lib/negocio-webhook.ts', 'utf8')
  const shell = readFileSync('lib/plan-restore-server.ts', 'utf8')
  test('afterPlanPaid restores through the Backend route with the reason plan_paid', () => {
    expect(PLAN_RESTORE_REASON).toBe('plan_paid')
    expect(webhook).toMatch(/async function afterPlanPaid[\s\S]{0,200}restorePlanPausedShop\(input\.shopId\)/)
    expect(shell).toMatch(/changeSellerStatus\(\{ medusaSellerId, status: 'active', reason: PLAN_RESTORE_REASON \}\)/)
  })
  test('a failed restore can never make a plan step `retry`: the hook returns nothing (PR 485 outcome model)', () => {
    expect(webhook).toMatch(/async function afterPlanPaid\(input: \{ plan: PaidPlan; shopId: string; paymentRef: string \}\): Promise<void>/)
    // Every call is a statement whose result is ignored, followed by the step's own outcome.
    expect(webhook).not.toMatch(/return await afterPlanPaid|= await afterPlanPaid/)
    // The yearly step swallows anything the hook might throw, and its result never reaches the outcome.
    expect(readFileSync('lib/plan-one-time-steps.ts', 'utf8')).toContain("if ((grant === 'written' || grant === 'replay') && deps.restore) await deps.restore().catch(() => {})")
  })
  test('a replayed grant and a subscription event that moves a plan to live also restore (verifier S4)', () => {
    // The yearly path (sprint 4's step model): the restore is its own step, run on written AND replay
    // (lib/plan-one-time-steps.ts, specced in e2e/plan-one-time-steps.spec.ts), never inside the first-time steps.
    expect(webhook).toContain('restore: () => afterPlanPaid({ plan, shopId, paymentRef: session.id }),')
    const firstTime = webhook.slice(webhook.indexOf('firstTime: async (grant) => {'), webhook.indexOf('restore: () => afterPlanPaid'))
    expect(firstTime).not.toContain('afterPlanPaid')
    const event = webhook.slice(webhook.indexOf('export async function handlePlanSubscriptionEvent'))
    expect(event.slice(0, event.indexOf('\n}\n'))).toMatch(/out\.status === 'active' \|\| out\.status === 'trialing'\)\) \{\s*await afterPlanPaid/)
  })

  test('every recorded payment reaches it: monthly activation, one-time, the promoter wrappers, and a monthly plan back to live', () => {
    expect(webhook).toMatch(/await afterPlanPaid\(\{ plan, shopId, paymentRef: stripeSubscriptionId \}\)/)
    expect(webhook).toMatch(/restore: \(\) => afterPlanPaid\(\{ plan, shopId, paymentRef: session\.id \}\)/)
    expect(webhook).toMatch(/if \(outcome === 'written' \|\| outcome === 'replay'\) await afterPlanPaid\(\{ plan: 'negocio'/)
    expect(webhook).toMatch(/if \(outcome === 'written' \|\| outcome === 'replay'\) await afterPlanPaid\(\{ plan: 'tienda'/)
    expect(webhook).toMatch(/out\.status === 'active' \|\| out\.status === 'trialing'\)\) \{\s*await afterPlanPaid/)
  })
})

test.describe('«Tu suscripción» for a paused shop', () => {
  const NOW = new Date('2027-02-10T12:00:00Z')
  const unpaid: PlanState = { plan: 'unpaid', reason: 'unpaid', endsAt: null }
  test('paused for lack of a plan: says so, says nothing was deleted, and offers both plans', () => {
    const v = negocioPageView(unpaid, NOW, { planPaused: true })
    expect(v.headline).toBe(PLAN_PAUSED_HEADLINE)
    expect(v.notice).toBe(PLAN_PAUSED_NOTICE)
    expect(v.offers.map((o) => o.plan)).toEqual(['tienda', 'negocio'])
  })
  test('paid but still marked paused: says it is reopening, never that it is unpaid', () => {
    const v = negocioPageView({ plan: 'tienda', reason: 'tienda_one_time', endsAt: '2028-02-10T12:00:00.000Z' }, NOW, { planPaused: true })
    expect(v.notice).toBe(PLAN_PAUSED_PAID_NOTICE)
    expect(v.headline).not.toBe(PLAN_PAUSED_HEADLINE)
  })
  test('a plan that could not be read says only that; an unpaused shop reads as before', () => {
    const unknown = negocioPageView({ plan: 'gratis', reason: 'unavailable', endsAt: null }, NOW, { planPaused: true })
    expect(unknown.tone).toBe('unknown')
    expect(unknown.notice).toBeNull()
    expect(negocioPageView(unpaid, NOW, {}).headline).toBe('Tu tienda no tiene un plan activo.')
  })
  test('the page passes the plan\'s own pause record', () => {
    expect(readFileSync('app/(shell)/shop/manage/negocio/page.tsx', 'utf8')).toMatch(/hasPlanPause\(mine\.shop\.metadata\)/)
  })
})

test.describe('a paused owner can still reach «Tu suscripción» and both checkouts', () => {
  // The Backend refuses a paused seller's WRITES under /store/sellers/me (seller-portal-gate) and nothing else. These
  // surfaces must keep reading only Supabase, the Backend's /internal routes and Stripe, so the pause never locks the
  // way out. A change that routes them through the portal gate fails here.
  for (const file of ['app/(shell)/shop/manage/negocio/page.tsx', 'app/api/sell/negocio/checkout/route.ts', 'app/api/sell/tienda/checkout/route.ts', 'lib/negocio-checkout.ts', 'lib/plan-subscription-bridge.ts']) {
    test(file, () => {
      const src = readFileSync(file, 'utf8')
      expect(src).not.toMatch(/sellers\/me/)
      expect(src).not.toMatch(/getMySeller/)
    })
  }
})

test.describe('the promoter package and transfer paths reach the restore (sprint 4 rebase)', () => {
  test('both the card package and the approved transfer apply every grant through the two restoring wrappers', () => {
    const server = readFileSync('lib/promoter-package-server.ts', 'utf8')
    expect(server).toContain("apply: (plan, input) => (plan === 'negocio' ? applyNegocioPayment(input) : applyTiendaPayment(input)),")
    expect(server).toMatch(/applyPackageGrants\([\s\S]{0,200}PACKAGE_GRANT_DEPS\)/)
    expect(readFileSync('lib/promoter-grant-server.ts', 'utf8')).toMatch(/applyPackageGrants\([\s\S]{0,200}PACKAGE_GRANT_DEPS,/)
  })

  test('a redelivery that completes a half-written package still reaches the wrapper (and so the restore) for every grant', async () => {
    const sku = (Object.keys(PACKAGES) as PackageSku[]).find((k) => PACKAGES[k].grants.length >= 2)
    if (!sku) throw new Error('no two-grant package to test')
    const written = new Set<string>()
    const restoredOn: string[] = []
    // The wrappers' rule, restated as the dep: apply the grant, then restore on written OR replay.
    const deps = {
      apply: async (plan: 'negocio' | 'tienda', input: { paymentId: string }) => {
        const key = `${plan}:${input.paymentId}`
        const outcome = written.has(key) ? ('replay' as const) : ('written' as const)
        written.add(key)
        restoredOn.push(`${plan}:${outcome}`)
        return outcome
      },
    }
    // First delivery dies after the first grant: only that half is written.
    written.add(`${PACKAGES[sku].grants[0].plan}:cs_1`)
    const out = await applyPackageGrants({ sku, shopId: 'shop_1', paymentId: 'cs_1' }, deps)
    expect(out).toBe('written')
    expect(restoredOn).toEqual(PACKAGES[sku].grants.map((g, i) => `${g.plan}:${i === 0 ? 'replay' : 'written'}`))
  })
})
