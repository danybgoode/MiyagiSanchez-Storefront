/**
 * A yearly plan payment whose promoter share fails AFTER the grant landed (plan-tienda S4, the gap found at the review
 * of PR 485): the delivery answers `retry`, and the redelivery records the share — the grant once, the share once,
 * the first-time steps once.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { runOneTimeSteps, type OneTimeStepsDeps } from '../lib/plan-one-time-steps'
import { webhookAnswerStatus } from '../lib/plan-subscription-sync'

/** One shop and the ledger behind the webhook, with the same keys production uses. */
function world() {
  const grantPayments = new Set<string>() // the grant's `payments` list
  const shareRefs = new Map<string, number>() // `payment_ref` → rows (the unique index admits one)
  const attributions = new Map<string, number>() // (promoter, shop, sku) → rows
  const firstTime: string[] = []
  let failShareOnce = false
  let failAttributionOnce = false
  let failGrantOnce = false
  const deps = (paymentId: string): OneTimeStepsDeps => ({
    applyGrant: async () => {
      if (failGrantOnce) { failGrantOnce = false; throw new Error('grant rpc down') }
      if (grantPayments.has(paymentId)) return 'replay'
      grantPayments.add(paymentId)
      return 'written'
    },
    shares: async () => {
      if (failShareOnce) { failShareOnce = false; throw new Error('attribution insert failed') }
      // An insert keyed by payment_ref: a duplicate collides (23505) and adds nothing.
      if (!shareRefs.has(paymentId)) shareRefs.set(paymentId, 1)
      return true
    },
    attribution: async () => {
      if (failAttributionOnce) { failAttributionOnce = false; return false }
      attributions.set('prm|shop|sku', 1)
      return true
    },
    firstTime: async (g) => { firstTime.push(g) },
    onGrantFailed: () => {},
  })
  return {
    deps,
    grantPayments,
    shareRefs,
    attributions,
    firstTime,
    failShare: () => { failShareOnce = true },
    failAttribution: () => { failAttributionOnce = true },
    failGrant: () => { failGrantOnce = true },
  }
}

test('a share that throws after the grant landed: retry (500), then the redelivery records it — grant once, share once', async () => {
  const w = world()
  w.failShare()
  const first = await runOneTimeSteps(w.deps('cs_1'))
  expect(first).toEqual({ outcome: 'retry', grant: 'written' })
  expect(webhookAnswerStatus(first.outcome)).toBe(500)
  expect(w.shareRefs.size).toBe(0)
  // The grant DID land, so the steps that happen once already ran: the redelivery is a replay and must not repeat them.
  expect(w.firstTime).toEqual(['written'])

  const second = await runOneTimeSteps(w.deps('cs_1'))
  expect(second).toEqual({ outcome: 'done', grant: 'replay' })
  expect(webhookAnswerStatus(second.outcome)).toBe(200)
  expect([...w.grantPayments]).toEqual(['cs_1'])
  expect(w.shareRefs.get('cs_1')).toBe(1)
  expect(w.firstTime).toEqual(['written'])

  // A third delivery repeats nothing.
  expect(await runOneTimeSteps(w.deps('cs_1'))).toEqual({ outcome: 'done', grant: 'replay' })
  expect(w.shareRefs.get('cs_1')).toBe(1)
  expect(w.firstTime).toEqual(['written'])
})

test('a failed attribution is retried the same way', async () => {
  const w = world()
  w.failAttribution()
  expect((await runOneTimeSteps(w.deps('cs_2'))).outcome).toBe('retry')
  expect(w.attributions.size).toBe(0)
  expect((await runOneTimeSteps(w.deps('cs_2'))).outcome).toBe('done')
  expect(w.attributions.size).toBe(1)
  expect(w.firstTime).toEqual(['written'])
})

test('a failed grant runs nothing else and is retried', async () => {
  const w = world()
  w.failGrant()
  expect(await runOneTimeSteps(w.deps('cs_3'))).toEqual({ outcome: 'retry', grant: null })
  expect(w.shareRefs.size + w.attributions.size + w.firstTime.length).toBe(0)
  expect((await runOneTimeSteps(w.deps('cs_3'))).outcome).toBe('done')
  expect(w.firstTime).toEqual(['written'])
  expect(w.shareRefs.get('cs_3')).toBe(1)
})

test('a permanent Negocio (comp) earns no share, still says so once', async () => {
  const w = world()
  const d = { ...w.deps('cs_4'), applyGrant: async () => 'comp' as const }
  expect(await runOneTimeSteps(d)).toEqual({ outcome: 'done', grant: 'comp' })
  expect(w.shareRefs.size).toBe(0)
  expect(w.firstTime).toEqual(['comp'])
})

test('the webhook uses this order, and each share entry point says whether it landed', () => {
  const webhook = readFileSync('lib/negocio-webhook.ts', 'utf8')
  const yearly = webhook.slice(webhook.indexOf('export async function handlePlanOneTimeComplete'), webhook.indexOf('\nexport ', webhook.indexOf('export async function handlePlanOneTimeComplete') + 1))
  expect(yearly).toContain('await runOneTimeSteps({')
  // No early return on a replay any more: that was the gap.
  expect(yearly).not.toContain("if (outcome === 'replay') return")
  expect(yearly).toContain('if (promoterSku) return true')
  expect(yearly).toContain("return (await accrueTiendaPaymentShare({ ...input, amountCents: session.amount_total ?? 0 })) !== 'failed'")
  const shares = readFileSync('lib/promoter-renewal-server.ts', 'utf8')
  expect(shares).toContain("return renewal !== 'failed' && upgrade !== 'failed'")
})

test.describe('the D10 restore step (plan-tienda S3.4, verifier S4)', () => {
  function steps(grant: 'written' | 'replay' | 'comp', restore: () => Promise<void>, log: string[]): OneTimeStepsDeps {
    return {
      applyGrant: async () => grant,
      shares: async () => true,
      attribution: async () => true,
      firstTime: async (g) => { log.push(`first:${g}`) },
      onGrantFailed: () => {},
      restore: async () => { log.push('restore'); await restore() },
    }
  }
  test('runs on the delivery that wrote the grant AND on every replay; the first-time steps only once', async () => {
    const written: string[] = []
    await runOneTimeSteps(steps('written', async () => {}, written))
    expect(written).toEqual(['first:written', 'restore'])
    const replay: string[] = []
    await runOneTimeSteps(steps('replay', async () => {}, replay))
    expect(replay).toEqual(['restore'])
  })
  test('never on a comp shop (never paused for lack of a plan)', async () => {
    const log: string[] = []
    await runOneTimeSteps(steps('comp', async () => {}, log))
    expect(log).toEqual(['first:comp'])
  })
  test('a restore that throws never changes the outcome: the payment is not resent for it', async () => {
    const log: string[] = []
    const out = await runOneTimeSteps(steps('written', async () => { throw new Error('backend down') }, log))
    expect(out.outcome).toBe('done')
  })
})
