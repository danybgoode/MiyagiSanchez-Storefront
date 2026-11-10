/**
 * Buying Plan Tienda (epic 08 · plan-tienda-three-free-months S2.1/S2.2, README D3/D5/D6).
 *
 * Money rules, on the pure seams: the prices are tokens from one module; who may start which Plan Tienda checkout
 * (every plan state × cadence, never a double charge, never Tienda under a paid Negocio); and the payment loop that
 * writes the yearly grant — a replay adds nothing, a lost race re-decides from the truth, paying during the trial or a
 * dated Negocio starts the year after them.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import {
  TIENDA_CURRENCY,
  TIENDA_PRICE_MONTHLY_CENTS,
  TIENDA_PRICE_MONTHLY_MXN,
  TIENDA_PRICE_YEARLY_CENTS,
  TIENDA_PRICE_YEARLY_MXN,
  TIENDA_YEARLY_MONTHS,
} from '../lib/tienda-pricing'
import { yearlyAsMonthly } from '../lib/pricing-catalog'
import { decideTiendaCheckout, monthlyFirstChargeAt, subscriptionFact, type SubscriptionFact } from '../lib/negocio-checkout-rules'
import {
  NEGOCIO_GRANT_KEY,
  NEGOCIO_TRIAL_KEY,
  TIENDA_GRANT_KEY,
  addMonthsClamped,
  type GrantWriteRpcArgs,
  type PlanReason,
  type PlanState,
} from '../lib/plan'
import { applyPlanPayment, type PlanPaymentDeps } from '../lib/plan-payment'
import { readPlanSubscriptionAnswer } from '../lib/plan-subscription-answer'

const NOW = new Date('2026-11-10T12:00:00Z')
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000)

test.describe('Plan Tienda prices (README D5)', () => {
  test('$228 a year, $29 a month, in cents for Stripe, 12 months — and «desde $19 al mes» is the year over twelve', () => {
    expect(TIENDA_PRICE_YEARLY_MXN).toBe(228)
    expect(TIENDA_PRICE_MONTHLY_MXN).toBe(29)
    expect(TIENDA_PRICE_YEARLY_CENTS).toBe(22_800)
    expect(TIENDA_PRICE_MONTHLY_CENTS).toBe(2_900)
    expect(TIENDA_YEARLY_MONTHS).toBe(12)
    expect(TIENDA_CURRENCY).toBe('MXN')
    expect(yearlyAsMonthly(TIENDA_PRICE_YEARLY_MXN)).toBe(19)
  })

  test('the yearly checkout charges the module price, card only, without installments; the seed script charges the monthly one', () => {
    const checkout = readFileSync('lib/negocio-checkout.ts', 'utf8')
    expect(checkout).toContain('yearlyCents: TIENDA_PRICE_YEARLY_CENTS')
    const tienda = checkout.slice(checkout.indexOf('  tienda: {'), checkout.indexOf('export async function startPlanCheckout'))
    expect(tienda).toContain('installments: false')
    const seed = readFileSync('scripts/seed-tienda-plan.mjs', 'utf8')
    expect(seed).toContain(`const MONTHLY_CENTS = ${TIENDA_PRICE_MONTHLY_CENTS}`)
    expect(seed).toContain("const LOOKUP_KEY = 'tienda_monthly'")
    expect(seed).toContain('/internal/setup-tienda-plan')
  })
})

// ── Who may buy Plan Tienda ─────────────────────────────────────────────────────

const st = (plan: PlanState['plan'], reason: PlanReason, endsAt: string | null = null): PlanState => ({ plan, reason, endsAt })

/** Every plan state the seam can produce. */
const STATES: Record<string, PlanState> = {
  negocio_comp: st('negocio', 'comp'),
  negocio_year: st('negocio', 'one_time', days(200).toISOString()),
  negocio_month: st('negocio', 'subscription'),
  trial: st('trial', 'trial', days(20).toISOString()),
  tienda_year: st('tienda', 'tienda_one_time', days(100).toISOString()),
  tienda_month: st('tienda', 'tienda_subscription'),
  legacy: st('gratis', 'legacy'),
  legacy_trial_ended: st('gratis', 'trial_ended'),
  unpaid: st('unpaid', 'unpaid'),
  unavailable: st('gratis', 'unavailable'),
}

/** What each state may buy when both subscriptions read cleanly as what the state implies. */
const EXPECTED: Record<string, { month: number | 'ok'; year: number | 'ok' }> = {
  negocio_comp: { month: 409, year: 409 },
  negocio_year: { month: 409, year: 409 },
  negocio_month: { month: 409, year: 409 },
  trial: { month: 'ok', year: 'ok' },
  tienda_year: { month: 409, year: 'ok' },
  tienda_month: { month: 409, year: 409 },
  legacy: { month: 'ok', year: 'ok' },
  legacy_trial_ended: { month: 'ok', year: 'ok' },
  unpaid: { month: 'ok', year: 'ok' },
  unavailable: { month: 503, year: 503 },
}

function facts(name: string): { negocioSubscription: SubscriptionFact; tiendaSubscription: SubscriptionFact } {
  return {
    negocioSubscription: name === 'negocio_month' ? 'live' : 'none',
    tiendaSubscription: name === 'tienda_month' ? 'live' : 'none',
  }
}

test.describe('decideTiendaCheckout — every plan state × cadence (README D6)', () => {
  for (const [name, plan] of Object.entries(STATES)) {
    for (const cadence of ['month', 'year'] as const) {
      const want = EXPECTED[name][cadence]
      test(`${name} · ${cadence} → ${want}`, () => {
        const d = decideTiendaCheckout({ cadence, plan, ...facts(name) })
        if (want === 'ok') expect(d).toEqual({ ok: true })
        else expect(d).toMatchObject({ ok: false, status: want })
      })
    }
  }

  test('a subscription the derived plan hides behind a live trial still decides: unreadable refuses, live refuses', () => {
    // A live trial outranks every subscription in derivePlan, so the plan alone would say "trial, buy away".
    const trial = STATES.trial
    for (const cadence of ['month', 'year'] as const) {
      expect(decideTiendaCheckout({ cadence, plan: trial, negocioSubscription: 'unavailable', tiendaSubscription: 'none' })).toMatchObject({ ok: false, status: 503 })
      expect(decideTiendaCheckout({ cadence, plan: trial, negocioSubscription: 'none', tiendaSubscription: 'unavailable' })).toMatchObject({ ok: false, status: 503 })
      expect(decideTiendaCheckout({ cadence, plan: trial, negocioSubscription: 'live', tiendaSubscription: 'none' })).toMatchObject({ ok: false, status: 409 })
      expect(decideTiendaCheckout({ cadence, plan: trial, negocioSubscription: 'none', tiendaSubscription: 'live' })).toMatchObject({ ok: false, status: 409 })
    }
  })

  test('an unreadable subscription refuses even a legacy or unpaid shop — "could not look" is never "none"', () => {
    for (const plan of [STATES.legacy, STATES.unpaid, STATES.tienda_year]) {
      expect(decideTiendaCheckout({ cadence: 'year', plan, negocioSubscription: 'none', tiendaSubscription: 'unavailable' })).toMatchObject({ status: 503 })
    }
  })

  test('a subscription read is three states: live, none, unavailable', () => {
    expect(subscriptionFact({ active: true, unavailable: false })).toBe('live')
    expect(subscriptionFact({ active: false, unavailable: false })).toBe('none')
    expect(subscriptionFact({ active: false, unavailable: true })).toBe('unavailable')
  })

  test('the checkout reads BOTH subscriptions for every Tienda purchase and takes the monthly price id from the Backend', () => {
    const src = readFileSync('lib/negocio-checkout.ts', 'utf8')
    expect(src).toContain('Promise.all([getNegocioSubscription(sellerClerkId, shopId), getTiendaSubscription(sellerClerkId, shopId)])')
    expect(src).toContain('priceId: sub.stripe_price_id')
    // The plan is in the idempotency key: a Tienda request can never be answered with a cached Negocio session.
    expect(src).toContain('const idempotencyKey = `${plan}:${shopId}:${cadence}:${Math.floor(Date.now() / PLAN_CHECKOUT_WINDOW_MS)}`')
    // The monthly first charge waits for a live trial exactly as Negocio's does — the same function.
    expect(src).toContain('trialEnd: monthlyFirstChargeAt(state)')
  })

  test('the monthly first charge is plan-neutral: a trial delays it, a Tienda or unpaid shop is charged today', () => {
    expect(monthlyFirstChargeAt(STATES.trial, NOW)).toBe(Math.floor(days(20).getTime() / 1000))
    for (const plan of [STATES.tienda_year, STATES.unpaid, STATES.legacy]) expect(monthlyFirstChargeAt(plan, NOW)).toBeNull()
  })

  test('the Tienda route reads the shop from the session, never from the body, and sends only the cadence', () => {
    const route = readFileSync('app/api/sell/tienda/checkout/route.ts', 'utf8')
    expect(route).toContain('readOwnedShop(user.id)')
    expect(route.indexOf('currentUser()')).toBeLessThan(route.indexOf('readOwnedShop('))
    expect(route).toContain('startTiendaCheckout(')
    for (const clientPrice of ['priceId', 'price_id', 'amountCents', 'amount_cents', 'body.price', 'body.amount']) expect(route).not.toContain(clientPrice)
  })
})

// ── The yearly payment writes the grant once ────────────────────────────────────

/** An in-memory shop row behind `merge_shop_metadata_guards`: a write lands only if every guard holds. */
function fakeShop(initial: Record<string, unknown>, opts: { interfere?: (attempt: number, meta: Record<string, unknown>) => void } = {}) {
  let meta: Record<string, unknown> = structuredClone(initial)
  let writes = 0
  let attempt = 0
  const deps: PlanPaymentDeps = {
    readMetadata: async () => ({ metadata: structuredClone(meta) }),
    writeGrant: async (args: GrantWriteRpcArgs) => {
      opts.interfere?.(attempt++, meta)
      const holds = args.p_guards.every((g) => {
        if (g.mode === 'absent') return !(g.key in meta)
        if (g.mode === 'json_null') return meta[g.key] === null
        return g.mode === 'equals' && JSON.stringify(meta[g.key]) === JSON.stringify(g.expected)
      })
      if (!holds) return false
      meta = { ...meta, ...structuredClone(args.p_patch) }
      writes += 1
      return true
    },
  }
  return { deps, get meta() { return meta }, get writes() { return writes } }
}

const pay = (paymentId: string) => ({ shopId: 'shop_1', paymentId, months: TIENDA_YEARLY_MONTHS, note: 'yearly 12m', now: NOW })

test.describe('applyPlanPayment(tienda) — the yearly Plan Tienda payment', () => {
  test('a first payment writes a 12-month Tienda grant, and the replayed webhook adds nothing', async () => {
    const shop = fakeShop({})
    expect(await applyPlanPayment('tienda', pay('cs_1'), shop.deps)).toBe('written')
    const grant = shop.meta[TIENDA_GRANT_KEY] as { expires_at: string; payments: string[] }
    expect(grant.expires_at).toBe(addMonthsClamped(NOW, 12).toISOString())
    expect(grant.payments).toEqual(['cs_1'])
    expect(await applyPlanPayment('tienda', pay('cs_1'), shop.deps)).toBe('replay')
    expect(shop.writes).toBe(1)
    expect((shop.meta[TIENDA_GRANT_KEY] as { expires_at: string }).expires_at).toBe(grant.expires_at)
  })

  test('a second yearly payment adds twelve months after the current end', async () => {
    const shop = fakeShop({})
    await applyPlanPayment('tienda', pay('cs_1'), shop.deps)
    await applyPlanPayment('tienda', pay('cs_2'), shop.deps)
    const grant = shop.meta[TIENDA_GRANT_KEY] as { expires_at: string; payments: string[] }
    expect(grant.expires_at).toBe(addMonthsClamped(addMonthsClamped(NOW, 12), 12).toISOString())
    expect(grant.payments).toEqual(['cs_1', 'cs_2'])
  })

  test('paying during the free trial starts the year when the trial ends', async () => {
    const trialEnd = days(80)
    const shop = fakeShop({ [NEGOCIO_TRIAL_KEY]: { started_at: days(-10).toISOString(), expires_at: trialEnd.toISOString() } })
    await applyPlanPayment('tienda', pay('cs_1'), shop.deps)
    expect((shop.meta[TIENDA_GRANT_KEY] as { expires_at: string }).expires_at).toBe(addMonthsClamped(trialEnd, 12).toISOString())
  })

  test('paying during a live dated Plan Negocio starts the year when Negocio ends', async () => {
    const negocioEnd = days(150)
    const shop = fakeShop({ [NEGOCIO_GRANT_KEY]: { type: 'one_time', granted_at: NOW.toISOString(), expires_at: negocioEnd.toISOString() } })
    await applyPlanPayment('tienda', pay('cs_1'), shop.deps)
    expect((shop.meta[TIENDA_GRANT_KEY] as { expires_at: string }).expires_at).toBe(addMonthsClamped(negocioEnd, 12).toISOString())
  })

  test('a lost race re-reads and decides from the truth: a trial stamped in between moves the start', async () => {
    const trialEnd = days(60)
    const shop = fakeShop({}, {
      interfere: (attempt, meta) => {
        if (attempt === 0) meta[NEGOCIO_TRIAL_KEY] = { started_at: NOW.toISOString(), expires_at: trialEnd.toISOString() }
      },
    })
    expect(await applyPlanPayment('tienda', pay('cs_1'), shop.deps)).toBe('written')
    expect(shop.writes).toBe(1)
    expect((shop.meta[TIENDA_GRANT_KEY] as { expires_at: string }).expires_at).toBe(addMonthsClamped(trialEnd, 12).toISOString())
  })

  test('three lost races give up loudly (the webhook alerts); a missing shop row is an error, never a silent no-op', async () => {
    let n = 0
    const always = fakeShop({}, { interfere: (_a, meta) => { meta[NEGOCIO_TRIAL_KEY] = { started_at: NOW.toISOString(), expires_at: days(++n).toISOString() } } })
    await expect(applyPlanPayment('tienda', pay('cs_1'), always.deps)).rejects.toThrow('three compare-and-swap races')
    expect(always.writes).toBe(0)
    const none: PlanPaymentDeps = { readMetadata: async () => null, writeGrant: async () => true }
    await expect(applyPlanPayment('tienda', pay('cs_1'), none)).rejects.toThrow('no shop row')
  })

  test('the Negocio payment keeps its rules through the same loop: a comp shop is not extended', async () => {
    const shop = fakeShop({ [NEGOCIO_GRANT_KEY]: { type: 'comp', granted_at: NOW.toISOString() } })
    expect(await applyPlanPayment('negocio', pay('cs_9'), shop.deps)).toBe('comp')
    expect(shop.writes).toBe(0)
  })

  test('the webhook writes every grant through that one loop and one guarded RPC', () => {
    const src = readFileSync('lib/negocio-webhook.ts', 'utf8')
    expect(src.match(/db\.rpc\(/g)).toHaveLength(1)
    expect(src).toContain('db.rpc(GRANT_WRITE_RPC, args)')
    expect(src).toContain("applyPlanPayment('tienda', input, PLAN_PAYMENT_DB)")
    expect(src).not.toContain("'merge_shop_metadata'")
    const loop = readFileSync('lib/plan-payment.ts', 'utf8')
    expect(loop).toContain('deps.writeGrant(grantWriteRpcArgs(input.shopId, key, decision))')
  })
})

test.describe('a Backend subscription answer is three states, never two', () => {
  test('a real read, a known absence (not seeded), and could-not-look', () => {
    expect(readPlanSubscriptionAnswer({ active: true, plan_id: 'p', stripe_price_id: 'price_1', price_cents: 2900, subscription_id: 'sub_1' }))
      .toEqual({ active: true, unavailable: false, plan_id: 'p', stripe_price_id: 'price_1', price_cents: 2900, subscription_id: 'sub_1' })
    expect(readPlanSubscriptionAnswer({ active: false, reason: 'no_plan', plan_id: null })).toMatchObject({ active: false, unavailable: false, stripe_price_id: null })
    expect(readPlanSubscriptionAnswer({ active: false, reason: 'error', plan_id: 'p' })).toMatchObject({ active: false, unavailable: true, plan_id: 'p' })
  })

  test('anything else is could-not-look: an unknown reason, a missing `active`, not an object', () => {
    for (const raw of [{ active: false, reason: 'maintenance' }, { plan_id: 'p' }, null, 'ok', 42]) {
      expect(readPlanSubscriptionAnswer(raw).unavailable).toBe(true)
    }
  })
})
