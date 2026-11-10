/**
 * Stripe retries a plan step that failed (epic 08 · plan-tienda-three-free-months S2.2, PR 485 review).
 *
 * A Plan Negocio / Plan Tienda grant write, activation or status PATCH that fails in a way a later delivery can fix
 * answers Stripe 500, so Stripe delivers the event again instead of leaving a cancelled plan live until someone acts
 * on a Telegram alert. Every other event type and handler keeps its 200. And a "no row yet" on a brand-new
 * subscription (its update arrived before its activation) is retried WITHOUT an alert, so the alert keeps meaning
 * something.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import {
  YOUNG_SUBSCRIPTION_MS,
  quietNoRowYet,
  syncPlanSubscriptionStatus,
  syncWebhookOutcome,
  webhookAnswerStatus,
  type PlanStatusSyncDeps,
  type RetrievedPlanSubscription,
} from '../lib/plan-subscription-sync'

const NOW = new Date('2026-11-10T12:00:00Z')
const sec = (d: Date) => Math.floor(d.getTime() / 1000)

function deps(sub: RetrievedPlanSubscription | Error, patch: number | Error = 1) {
  const alerts: string[] = []
  const patched: string[] = []
  const d: PlanStatusSyncDeps = {
    retrieve: async () => { if (sub instanceof Error) throw sub; return sub },
    patch: {
      negocio: async (id) => { patched.push(`negocio:${id}`); if (patch instanceof Error) throw patch; return patch },
      tienda: async (id) => { patched.push(`tienda:${id}`); if (patch instanceof Error) throw patch; return patch },
    },
    alert: (m) => { alerts.push(m) },
    now: () => NOW,
  }
  return { d, alerts, patched }
}
const sub = (over: Partial<RetrievedPlanSubscription> = {}): RetrievedPlanSubscription => ({
  id: 'sub_1', status: 'canceled', metadata: { kind: 'tienda', shop_id: 'shop_1' }, created: sec(new Date(NOW.getTime() - 86_400_000)), ...over,
})

test.describe('the answer to Stripe, per plan outcome', () => {
  test('only a retryable plan failure is a 500; no plan step, a landed one, or a final failure stay 200', () => {
    expect(webhookAnswerStatus('retry')).toBe(500)
    for (const o of [undefined, null, 'done', 'final'] as const) expect(webhookAnswerStatus(o)).toBe(200)
  })

  test('sync outcomes map to plan outcomes: landed → done, retryable → retry, unfixable → final, not a plan → done', () => {
    expect(syncWebhookOutcome({ outcome: 'patched', plan: 'tienda', status: 'active', shopId: null })).toBe('done')
    expect(syncWebhookOutcome({ outcome: 'not_a_plan' })).toBe('done')
    expect(syncWebhookOutcome({ outcome: 'failed', plan: 'tienda', retry: true })).toBe('retry')
    expect(syncWebhookOutcome({ outcome: 'failed', plan: 'tienda', retry: false })).toBe('final')
  })

  test('Stripe down, Backend error, and no row matched are retried; every one alerts (an old subscription)', async () => {
    for (const [s, p] of [[new Error('stripe down'), 1], [sub(), new Error('backend 503')], [sub(), 0]] as const) {
      const x = deps(s, p)
      const out = await syncPlanSubscriptionStatus('sub_1', x.d)
      expect(out).toMatchObject({ outcome: 'failed', retry: true })
      expect(webhookAnswerStatus(syncWebhookOutcome(out))).toBe(500)
      expect(x.alerts).toHaveLength(1)
    }
  })

  test('a kind that contradicts its price or a status we do not know is NOT retried: a retry cannot fix it', async () => {
    for (const s of [sub({ items: { data: [{ price: { lookup_key: 'negocio_monthly' } }] } }), sub({ status: 'hibernating' })]) {
      const x = deps(s)
      const out = await syncPlanSubscriptionStatus('sub_1', x.d)
      expect(out).toMatchObject({ outcome: 'failed', retry: false })
      expect(webhookAnswerStatus(syncWebhookOutcome(out))).toBe(200)
    }
  })
})

test.describe('"no row yet" on a brand-new subscription: retried quietly', () => {
  test('a subscription created moments ago whose PATCH matched nothing is retried without an alert', async () => {
    const x = deps(sub({ status: 'trialing', created: sec(new Date(NOW.getTime() - 60_000)) }), 0)
    expect(await syncPlanSubscriptionStatus('sub_1', x.d)).toMatchObject({ outcome: 'failed', retry: true })
    expect(x.alerts).toEqual([])
  })

  test('past the window it alerts; an unknown age alerts; a Backend ERROR alerts however young', async () => {
    const old = deps(sub({ created: sec(new Date(NOW.getTime() - YOUNG_SUBSCRIPTION_MS - 60_000)) }), 0)
    await syncPlanSubscriptionStatus('sub_1', old.d)
    expect(old.alerts).toHaveLength(1)
    const unknown = deps(sub({ created: undefined }), 0)
    await syncPlanSubscriptionStatus('sub_1', unknown.d)
    expect(unknown.alerts).toHaveLength(1)
    const young = deps(sub({ created: sec(NOW) }), new Error('backend 503'))
    await syncPlanSubscriptionStatus('sub_1', young.d)
    expect(young.alerts).toHaveLength(1)
    expect(quietNoRowYet(sec(NOW) - 30, NOW)).toBe(true)
    expect(quietNoRowYet(undefined, NOW)).toBe(false)
  })
})

// ── The route: a 5xx only from a plan step ───────────────────────────────────────

const ROUTE = readFileSync('app/api/webhooks/stripe/route.ts', 'utf8')

/** The body of `async function <name>(` up to the next top-level `async function`. */
function fnBody(src: string, name: string): string {
  const at = src.indexOf(`async function ${name}(`)
  if (at < 0) throw new Error(`no function ${name}`)
  const next = src.indexOf('\nasync function ', at + 1)
  return src.slice(at, next < 0 ? undefined : next)
}

test.describe('the webhook route answers 5xx only for a failed plan step', () => {
  test('the one answer is computed from the plan outcome alone', () => {
    expect(ROUTE).toContain('return NextResponse.json({ received: true }, { status: webhookAnswerStatus(planOutcome) })')
    expect(ROUTE.match(/webhookAnswerStatus\(/g)).toHaveLength(1)
    expect(ROUTE).not.toMatch(/status: 5\d\d/)
  })

  test('planOutcome is assigned only from a plan handler or from one of the four handlers that hold a plan branch', () => {
    const post = fnBody(ROUTE, 'POST')
    const assigned = [...post.matchAll(/planOutcome = ([\s\S]*?)\n\s*(?:break|\}|\n)/g)].map((m) => m[1].replace(/\s+/g, ' ').trim())
    expect(assigned).toEqual([
      'await handlePlanSubscriptionComplete(session, sessionPlan)',
      'await handlePlanOneTimeComplete(session, sessionPlan, event.created)',
      // plan-tienda S4.1 review: a promoter package paid by card is a plan step too (its grants and attribution).
      'await handlePromoterPackageComplete(session)',
      "event.type === 'customer.subscription.updated' ? await handleSubscriptionUpdated(subscription) : await handleSubscriptionDeleted(subscription)",
      'await handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice)',
      'await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice)',
    ])
    // account.updated and the default branch never touch it.
    const account = post.slice(post.indexOf("case 'account.updated':"), post.indexOf('default:'))
    expect(account).not.toContain('planOutcome')
  })

  test('inside those four handlers, ONLY the plan branch returns a value: every other kind keeps its 200', () => {
    for (const name of ['handleSubscriptionUpdated', 'handleSubscriptionDeleted', 'handleInvoicePaymentSucceeded', 'handleInvoicePaymentFailed']) {
      const valued = [...fnBody(ROUTE, name).matchAll(/return ([^\n]+)/g)].map((m) => m[1].trim())
      expect({ name, valued }).toEqual({ name, valued: [expect.stringMatching(/^(await )?handlePlan(SubscriptionEvent|InvoicePaid|InvoiceFailed)\(/)] })
    }
  })
})

test.describe('a retried delivery cannot repeat a side effect', () => {
  const WEBHOOK = readFileSync('lib/negocio-webhook.ts', 'utf8')
  const body = (name: string) => {
    const at = WEBHOOK.indexOf(`export async function ${name}(`)
    return WEBHOOK.slice(at, WEBHOOK.indexOf('\nexport ', at + 1))
  }

  test('the yearly grant: retry is returned before every later step, and a replay repeats only the idempotent ones', () => {
    // plan-tienda S4: the order lives in lib/plan-one-time-steps.ts (behaviour in e2e/plan-one-time-steps.spec.ts). A
    // failed grant returns `retry` before anything else; the shares and the attribution, idempotent by their keys, run
    // on a replay too (a share that failed after the grant landed is then recorded); the ✅ alert, D19 and the hook
    // run only on the delivery that wrote.
    const steps = readFileSync('lib/plan-one-time-steps.ts', 'utf8')
    const run = steps.slice(steps.indexOf('export async function runOneTimeSteps'))
    const retry = run.indexOf("return { outcome: 'retry', grant: null }")
    expect(retry).toBeGreaterThan(-1)
    for (const later of ['deps.shares()', 'deps.attribution()', 'deps.firstTime(']) expect(run.indexOf(later)).toBeGreaterThan(retry)
    expect(run).toContain("if (grant !== 'replay') await deps.firstTime(grant)")
    const b = body('handlePlanOneTimeComplete')
    const first = b.slice(b.indexOf('firstTime: async'))
    for (const once of ['✅', 'cancelTiendaUnderNegocio(', 'afterPlanPaid(']) expect(first).toContain(once)
    expect(b.slice(0, b.indexOf('firstTime: async'))).not.toMatch(/✅|cancelTiendaUnderNegocio\(|afterPlanPaid\(/)
  })

  test('the monthly activation: retry is returned before the ✅ alert, D19 and the hook', () => {
    const b = body('handlePlanSubscriptionComplete')
    const retry = b.indexOf("return 'retry'")
    expect(retry).toBeGreaterThan(-1)
    // A failed activation is retried (`/store/subscriptions` dedupes on the Stripe subscription id); missing
    // metadata is not — the same session carries the same missing data on every delivery.
    expect(b).toContain("return 'final' // the same session")
    for (const later of ['✅', 'cancelTiendaUnderNegocio(', 'afterPlanPaid(']) expect(b.indexOf(later)).toBeGreaterThan(retry)
  })

  test('the failed-payment alert is said once, on the delivery that settles the event', () => {
    const b = body('handlePlanInvoiceFailed')
    expect(b).toContain("if (result !== 'retry') {")
    expect(b.indexOf("if (result !== 'retry') {")).toBeLessThan(b.indexOf('Pago fallido'))
  })

  test('the renewal share runs only after the status landed, and is keyed by the invoice id', () => {
    const b = body('handlePlanInvoicePaid')
    // plan-tienda S4: both plans' shares, only after the status landed; a share that did not land answers retry.
    expect(b).toContain("if (out.outcome !== 'patched' || !shopId || !invoice.id) return result")
    expect(b).toContain('paymentRef: invoice.id')
    expect(b).toContain("return shared ? result : 'retry'")
  })
})
