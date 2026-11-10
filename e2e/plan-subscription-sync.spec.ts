/**
 * The webhook keeps Medusa Commerce in step with Stripe for both monthly plans (epic 08 · plan-tienda-three-free-months
 * S2.2; the sprint-2 build contract added at review of Backend PR 228; README D19).
 *
 *   - The PATCH body comes from the subscription RETRIEVED from Stripe, never from the event: a delayed event cannot
 *     restore a plan.
 *   - Stripe's status goes AS IS (unpaid, paused, incomplete, incomplete_expired included).
 *   - A Tienda subscription goes to the Tienda route and a Negocio one to the Negocio route, never crossed.
 *   - `updated: 0` alerts.
 *   - D19: Negocio activating sets a live monthly Tienda to cancel at its period end, once, without ever blocking.
 * Plus the two reads that changed with them: when the Tienda subscription must be looked up, and which monthly plan
 * «Ver mis pagos o cancelar» opens.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import {
  STRIPE_SUBSCRIPTION_STATUSES,
  cancelTiendaOnNegocio,
  decidePlanStatusSync,
  decideTiendaCancelOnNegocio,
  syncPlanSubscriptionStatus,
  type PlanStatusSyncDeps,
  type RetrievedPlanSubscription,
} from '../lib/plan-subscription-sync'
import { PLAN_CHECKOUT_KINDS, paidPlanOfKind, paidPlanOfLookupKey } from '../lib/plan-kind'
import { NEGOCIO_GRANT_KEY, NEGOCIO_TRIAL_KEY, TIENDA_GRANT_KEY, tiendaLookupNeeded } from '../lib/plan'
import { pickPlanSubscription, startNegocioManage, type NegocioSubscriptionLike } from '../lib/negocio-manage'

const sub = (over: Partial<RetrievedPlanSubscription> & { kind?: string; lookupKey?: string | null } = {}): RetrievedPlanSubscription => ({
  id: over.id ?? 'sub_1',
  status: over.status ?? 'active',
  metadata: over.metadata ?? { kind: over.kind ?? 'tienda', shop_id: 'shop_1' },
  items: over.items ?? { data: [{ price: { lookup_key: over.lookupKey === undefined ? null : over.lookupKey } }] },
})

function deps(retrieved: RetrievedPlanSubscription | (() => Promise<RetrievedPlanSubscription>), updated = 1) {
  const calls = { negocio: [] as Array<[string, string]>, tienda: [] as Array<[string, string]>, alerts: [] as string[] }
  const d: PlanStatusSyncDeps = {
    retrieve: typeof retrieved === 'function' ? retrieved : async () => retrieved,
    patch: {
      negocio: async (id, status) => { calls.negocio.push([id, status]); return updated },
      tienda: async (id, status) => { calls.tienda.push([id, status]); return updated },
    },
    alert: (m) => { calls.alerts.push(m) },
  }
  return { d, calls }
}

test.describe('plan-kind routing — a subscription is Tienda or Negocio by the data Stripe holds', () => {
  test('the kind our checkout wrote decides the plan; any other kind is not a plan', () => {
    expect(paidPlanOfKind(PLAN_CHECKOUT_KINDS.tienda)).toBe('tienda')
    expect(paidPlanOfKind(PLAN_CHECKOUT_KINDS.negocio)).toBe('negocio')
    for (const k of ['custom_domain', 'subdomain', 'ml_sync', '', undefined, null, 'tienda_plan']) expect(paidPlanOfKind(k)).toBeNull()
    expect(paidPlanOfLookupKey('tienda_monthly')).toBe('tienda')
    expect(paidPlanOfLookupKey('negocio_monthly')).toBe('negocio')
    expect(paidPlanOfLookupKey(null)).toBeNull()
  })

  test('a Tienda subscription is PATCHed on the Tienda route only, a Negocio one on the Negocio route only', async () => {
    const t = deps(sub({ kind: 'tienda', status: 'active', lookupKey: 'tienda_monthly' }))
    expect(await syncPlanSubscriptionStatus('sub_1', t.d)).toMatchObject({ outcome: 'patched', plan: 'tienda' })
    expect(t.calls.tienda).toEqual([['sub_1', 'active']])
    expect(t.calls.negocio).toEqual([])
    const n = deps(sub({ kind: 'negocio', status: 'past_due', lookupKey: 'negocio_monthly' }))
    expect(await syncPlanSubscriptionStatus('sub_1', n.d)).toMatchObject({ outcome: 'patched', plan: 'negocio' })
    expect(n.calls.negocio).toEqual([['sub_1', 'past_due']])
    expect(n.calls.tienda).toEqual([])
  })

  test('a kind that contradicts its seeded price sends nothing and asks a person', async () => {
    expect(decidePlanStatusSync('sub_1', sub({ kind: 'tienda', lookupKey: 'negocio_monthly' }))).toMatchObject({ action: 'alert', reason: 'kind_price_mismatch' })
    const x = deps(sub({ kind: 'negocio', lookupKey: 'tienda_monthly' }))
    expect(await syncPlanSubscriptionStatus('sub_1', x.d)).toEqual({ outcome: 'failed', plan: 'negocio' })
    expect(x.calls.negocio).toEqual([])
    expect(x.calls.tienda).toEqual([])
    expect(x.calls.alerts).toHaveLength(1)
  })

  test('a subscription of another product is left alone: no PATCH, no alert', async () => {
    const x = deps(sub({ kind: 'custom_domain' }))
    expect(await syncPlanSubscriptionStatus('sub_1', x.d)).toEqual({ outcome: 'not_a_plan' })
    expect(x.calls.alerts).toEqual([])
  })
})

test.describe('the CURRENT status from Stripe — never the event payload', () => {
  test('the PATCH body is the retrieved subscription, whatever the event said', async () => {
    // The event (handled late) still says active; Stripe has since cancelled it.
    const eventPayload = sub({ status: 'active' })
    let asked = ''
    const x = deps(async () => { asked = eventPayload.id; return sub({ status: 'canceled' }) })
    await syncPlanSubscriptionStatus(eventPayload.id, x.d)
    expect(asked).toBe('sub_1')
    expect(x.calls.tienda).toEqual([['sub_1', 'canceled']])
  })

  test('every Stripe status is sent as it is — unpaid is no longer folded into past_due', async () => {
    for (const status of ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete', 'canceled', 'incomplete_expired']) {
      expect(STRIPE_SUBSCRIPTION_STATUSES.has(status)).toBe(true)
      const x = deps(sub({ kind: 'negocio', status }))
      await syncPlanSubscriptionStatus('sub_1', x.d)
      expect(x.calls.negocio).toEqual([['sub_1', status]])
    }
  })

  test('a status Stripe adds later is not guessed: it alerts and sends nothing', async () => {
    const x = deps(sub({ status: 'hibernating' }))
    expect(await syncPlanSubscriptionStatus('sub_1', x.d)).toMatchObject({ outcome: 'failed' })
    expect(x.calls.tienda).toEqual([])
    expect(x.calls.alerts[0]).toContain('hibernating')
  })

  test('a retrieve that fails sends nothing (no fallback to the event) and alerts; so does an answer about another subscription', async () => {
    const down = deps(async () => { throw new Error('stripe down') })
    expect(await syncPlanSubscriptionStatus('sub_1', down.d)).toEqual({ outcome: 'failed', plan: null })
    expect(down.calls.tienda.length + down.calls.negocio.length).toBe(0)
    expect(down.calls.alerts).toHaveLength(1)
    const other = deps(sub({ id: 'sub_OTHER' }))
    expect(await syncPlanSubscriptionStatus('sub_1', other.d)).toMatchObject({ outcome: 'failed' })
    expect(other.calls.tienda).toEqual([])
  })

  test('{ updated: 0 } is a failure and alerts; a throwing PATCH too', async () => {
    const zero = deps(sub({ status: 'unpaid' }), 0)
    expect(await syncPlanSubscriptionStatus('sub_1', zero.d)).toEqual({ outcome: 'failed', plan: 'tienda' })
    expect(zero.calls.alerts[0]).toContain('Plan Tienda')
    expect(zero.calls.alerts[0]).toContain('unpaid')
    const x = deps(sub())
    x.d.patch = { ...x.d.patch, tienda: async () => { throw new Error('500') } }
    expect(await syncPlanSubscriptionStatus('sub_1', x.d)).toMatchObject({ outcome: 'failed' })
    expect(x.calls.alerts).toHaveLength(1)
  })

  test('the webhook routes all four subscription events by plan kind into the sync, and nothing reads the event status', () => {
    const route = readFileSync('app/api/webhooks/stripe/route.ts', 'utf8')
    expect(route).toContain('await handlePlanSubscriptionEvent(subscription.id, { deleted: false })')
    expect(route).toContain('await handlePlanSubscriptionEvent(subscription.id, { deleted: true })')
    expect(route).toContain('await handlePlanInvoicePaid(invoice, stripeSub)')
    expect(route).toContain('await handlePlanInvoiceFailed(sub)')
    expect(route).not.toContain('NEGOCIO_CHECKOUT_KIND')
    const webhook = readFileSync('lib/negocio-webhook.ts', 'utf8')
    expect(webhook).not.toContain('mapNegocioStatus')
    expect(webhook).not.toMatch(/subscription\.status\s*\)/) // no handler PATCHes an event's status
    expect(webhook).toContain('const STATUS_PATCHES = { negocio: setNegocioSubscriptionStatus, tienda: setTiendaSubscriptionStatus } as const')
    // The Negocio domain release on deletion is kept, after a successful PATCH only.
    expect(webhook).toContain("if (out.outcome !== 'patched' || !opts.deleted || out.plan !== 'negocio') return")
    expect(webhook).toContain("releaseCustomDomainForShop(out.shopId ?? undefined, 'negocio_ended')")
  })

  test('a plan-kind subscription event from a connected account is ignored (forged metadata)', () => {
    const route = readFileSync('app/api/webhooks/stripe/route.ts', 'utf8')
    const at = route.indexOf("case 'customer.subscription.deleted': {")
    const block = route.slice(at, route.indexOf("case 'invoice.payment_succeeded'"))
    expect(block).toContain('.account && paidPlanOfKind(subscription.metadata?.kind)')
  })
})

test.describe('D19 — Plan Negocio over a monthly Plan Tienda', () => {
  test('only a live Tienda subscription with an id is cancelled; none is nothing; unknown is a question for a person', () => {
    expect(decideTiendaCancelOnNegocio({ active: true, unavailable: false, subscription_id: 'sub_t' })).toEqual({ action: 'cancel', subscriptionId: 'sub_t' })
    expect(decideTiendaCancelOnNegocio({ active: false, unavailable: false, subscription_id: null })).toEqual({ action: 'none' })
    expect(decideTiendaCancelOnNegocio({ active: false, unavailable: true, subscription_id: null })).toEqual({ action: 'unavailable' })
    expect(decideTiendaCancelOnNegocio({ active: true, unavailable: false, subscription_id: null })).toEqual({ action: 'unavailable' })
  })

  test('one Stripe call for a live subscription; a failure alerts and never throws into the Negocio activation', async () => {
    const cancelled: string[] = []
    const alerts: string[] = []
    const base = { alert: (m: string) => { alerts.push(m) } }
    expect(await cancelTiendaOnNegocio({ shopId: 'shop_1', sellerClerkId: 'user_1' }, {
      ...base,
      readTienda: async () => ({ active: true, unavailable: false, subscription_id: 'sub_t' }),
      setCancelAtPeriodEnd: async (id) => { cancelled.push(id) },
    })).toBe('cancelled')
    expect(cancelled).toEqual(['sub_t'])
    expect(alerts).toEqual([])

    expect(await cancelTiendaOnNegocio({ shopId: 'shop_1', sellerClerkId: 'user_1' }, {
      ...base,
      readTienda: async () => ({ active: false, unavailable: false, subscription_id: null }),
      setCancelAtPeriodEnd: async (id) => { cancelled.push(id) },
    })).toBe('none')
    expect(cancelled).toEqual(['sub_t'])

    expect(await cancelTiendaOnNegocio({ shopId: 'shop_1', sellerClerkId: 'user_1' }, {
      ...base,
      readTienda: async () => ({ active: true, unavailable: false, subscription_id: 'sub_t' }),
      setCancelAtPeriodEnd: async () => { throw new Error('stripe down') },
    })).toBe('failed')
    expect(await cancelTiendaOnNegocio({ shopId: 'shop_1', sellerClerkId: 'user_1' }, {
      ...base,
      readTienda: async () => { throw new Error('backend down') },
      setCancelAtPeriodEnd: async (id) => { cancelled.push(id) },
    })).toBe('failed')
    expect(alerts).toHaveLength(2)
    expect(cancelled).toEqual(['sub_t'])
  })

  test('the webhook cancels only AFTER Negocio landed, monthly and yearly, with cancel_at_period_end and an idempotency key', () => {
    const src = readFileSync('lib/negocio-webhook.ts', 'utf8')
    expect(src).toContain("{ cancel_at_period_end: true }, { idempotencyKey: `tienda-cancel-on-negocio:${subscriptionId}` }")
    const monthly = src.slice(src.indexOf('export async function handlePlanSubscriptionComplete'), src.indexOf('const PLAN_PAYMENT_DB'))
    expect(monthly.indexOf("if (plan === 'negocio') await cancelTiendaUnderNegocio(shopId, sellerClerkId)")).toBeGreaterThan(monthly.indexOf("if (!res.ok) throw new Error(`subscription create"))
    const yearly = src.slice(src.indexOf('export async function handlePlanOneTimeComplete'), src.indexOf('function syncDeps'))
    expect(yearly.indexOf("if (outcome !== 'written') return")).toBeLessThan(yearly.indexOf('await cancelTiendaUnderNegocio('))
    expect(yearly.indexOf('await cancelTiendaUnderNegocio(')).toBeGreaterThan(-1)
  })
})

test.describe('the Tienda subscription is looked up only when nothing outranking it decides', () => {
  const NOW = new Date('2026-11-10T12:00:00Z')
  const later = '2027-06-01T00:00:00.000Z'
  const earlier = '2026-01-01T00:00:00.000Z'
  test('skipped under Negocio (comp, dated, live subscription), a live trial, or a live Tienda year', () => {
    expect(tiendaLookupNeeded({ [NEGOCIO_GRANT_KEY]: { type: 'comp', granted_at: earlier } }, undefined, NOW)).toBe(false)
    expect(tiendaLookupNeeded({ [NEGOCIO_GRANT_KEY]: { type: 'one_time', granted_at: earlier, expires_at: later } }, undefined, NOW)).toBe(false)
    expect(tiendaLookupNeeded({}, true, NOW)).toBe(false)
    expect(tiendaLookupNeeded({ [NEGOCIO_TRIAL_KEY]: { started_at: earlier, expires_at: later } }, false, NOW)).toBe(false)
    expect(tiendaLookupNeeded({ [TIENDA_GRANT_KEY]: { type: 'one_time', granted_at: earlier, expires_at: later } }, false, NOW)).toBe(false)
  })

  test('needed otherwise — including when the Negocio subscription could not be read, and after a trial or grant lapsed', () => {
    expect(tiendaLookupNeeded({}, false, NOW)).toBe(true)
    expect(tiendaLookupNeeded({}, undefined, NOW)).toBe(true)
    expect(tiendaLookupNeeded({ [NEGOCIO_TRIAL_KEY]: { started_at: earlier, expires_at: '2026-02-01T00:00:00.000Z' } }, false, NOW)).toBe(true)
    expect(tiendaLookupNeeded({ [TIENDA_GRANT_KEY]: { type: 'one_time', granted_at: earlier, expires_at: '2026-02-01T00:00:00.000Z' } }, false, NOW)).toBe(true)
  })

  test('plan-server reads it through tienda-subscription and reports a failed read as unavailable, never as "none"', () => {
    const src = readFileSync('lib/plan-server.ts', 'utf8')
    expect(src).toContain('getTiendaSubscription(opts.sellerClerkId, opts.shopId)')
    expect(src).toContain('{ hasActiveTiendaSubscription: undefined, tiendaSubscriptionUnavailable: true }')
    expect(src).toContain('if (!tiendaLookupNeeded(metadata, hasActiveSubscription, now))')
  })
})

test.describe('«Ver mis pagos o cancelar» opens whichever monthly plan the owner holds', () => {
  const s = (over: Partial<NegocioSubscriptionLike> & { kind?: string } = {}): NegocioSubscriptionLike => ({
    id: over.id ?? 'sub_1', status: over.status ?? 'active', customer: over.customer ?? 'cus_1', created: over.created ?? 100,
    metadata: over.metadata ?? { kind: over.kind ?? 'tienda', shop_id: 'shop-1', seller_clerk_id: 'user_1' },
  })

  test('a Tienda subscriber gets the Tienda subscription; holding both (D19) opens Negocio', () => {
    expect(pickPlanSubscription([s({ kind: 'tienda' })], 'shop-1', 'user_1')).toEqual({ subscriptionId: 'sub_1', customerId: 'cus_1', plan: 'tienda' })
    const both = [s({ id: 'sub_t', kind: 'tienda', created: 900 }), s({ id: 'sub_n', kind: 'negocio', created: 100, customer: 'cus_n' })]
    expect(pickPlanSubscription(both, 'shop-1', 'user_1')).toEqual({ subscriptionId: 'sub_n', customerId: 'cus_n', plan: 'negocio' })
  })

  test('shop AND user must match, for Tienda as for Negocio; another kind is never picked', () => {
    expect(pickPlanSubscription([s({ metadata: { kind: 'tienda', shop_id: 'shop-2', seller_clerk_id: 'user_1' } })], 'shop-1', 'user_1')).toBeNull()
    expect(pickPlanSubscription([s({ metadata: { kind: 'tienda', shop_id: 'shop-1', seller_clerk_id: 'user_2' } })], 'shop-1', 'user_1')).toBeNull()
    expect(pickPlanSubscription([s({ kind: 'custom_domain' })], 'shop-1', 'user_1')).toBeNull()
  })

  test('the portal searches each plan kind for this shop', async () => {
    const queries: string[] = []
    const out = await startNegocioManage(
      { shopId: 'shop-1', sellerClerkId: 'user_1', returnUrl: 'https://miyagisanchez.com/shop/manage/negocio' },
      {
        searchSubscriptions: async (q) => { queries.push(q); return q.includes("'tienda'") ? [s({ kind: 'tienda' })] : [] },
        createPortal: async (customer) => `https://billing.stripe.com/${customer}`,
      },
    )
    expect(out).toEqual({ ok: true, url: 'https://billing.stripe.com/cus_1' })
    expect(queries.sort()).toEqual([
      "metadata['kind']:'negocio' AND metadata['shop_id']:'shop-1'",
      "metadata['kind']:'tienda' AND metadata['shop_id']:'shop-1'",
    ])
  })
})
