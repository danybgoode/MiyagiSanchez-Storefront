/**
 * A promoter package paid by card is completed on Stripe's retry (plan-tienda S4.1 review). The grants go through the
 * REAL plan seam (`applyPackageGrants` → `decideNegocioPayment` / `decideTiendaPayment` → `grantWriteRpcArgs`) over an
 * in-memory `merge_shop_metadata_guards`; the attribution and the receipt are counted by their production keys.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { applyPackageGrants, packageGrantRequest, type PackageGrantDeps, type PackageSku } from '../lib/promoter-packages'
import { runPackageSteps } from '../lib/promoter-package-steps'
import { webhookAnswerStatus } from '../lib/plan-subscription-sync'
import {
  NEGOCIO_GRANT_KEY,
  TIENDA_GRANT_KEY,
  decideNegocioPayment,
  decideTiendaPayment,
  grantWriteRpcArgs,
  readNegocioGrant,
  readTiendaGrant,
  type GrantWriteRpcArgs,
} from '../lib/plan'

const PAID = new Date('2026-11-10T12:00:00.000Z')
/** The `checkout.session.completed` event's own `created`: the same on every redelivery of that event. */
const EVENT_CREATED = Math.floor(PAID.getTime() / 1000)

function world(sku: PackageSku) {
  // When THIS delivery runs. The grants must not depend on it.
  let wall = PAID
  let metadata: Record<string, unknown> = {}
  let writes = 0
  let crashAtWrite: number | null = null
  let failAttribution = false
  let failRead = false
  const attributions = new Map<string, 'paid'>() // (promoter, shop, sku) → status: one row, the partial unique index
  const receipts: string[] = []
  const alerts: string[] = []
  const holds = (g: GrantWriteRpcArgs['p_guards'][number]) =>
    g.mode === 'absent' ? !(g.key in metadata) : g.mode === 'json_null' ? metadata[g.key] === null : g.mode === 'equals' && g.key in metadata && isDeepStrictEqual(metadata[g.key], g.expected)
  const grantDeps: PackageGrantDeps = {
    apply: async (plan, input) => {
      if (crashAtWrite !== null && writes >= crashAtWrite) throw new Error('grant rpc down')
      const d = plan === 'negocio' ? decideNegocioPayment(metadata, { ...input, now: input.now ?? wall }) : decideTiendaPayment(metadata, { ...input, now: input.now ?? wall })
      if (d.action !== 'write') return d.action
      const args = grantWriteRpcArgs('shop', plan === 'negocio' ? NEGOCIO_GRANT_KEY : TIENDA_GRANT_KEY, d)
      if (!args.p_guards.every(holds)) throw new Error('guard')
      metadata = { ...metadata, ...structuredClone(args.p_patch) }
      writes += 1
      return 'written'
    },
  }
  const deliver = () =>
    runPackageSteps({
      applyGrants: () => applyPackageGrants(packageGrantRequest({ sku, shopId: 'shop', sessionId: 'cs_pkg', eventCreatedSec: EVENT_CREATED }), grantDeps),
      alreadyPaid: async () => { if (failRead) throw new Error('read'); return attributions.get(`prm|shop|${sku}`) === 'paid' },
      attribution: async () => {
        if (failAttribution) { failAttribution = false; return false }
        attributions.set(`prm|shop|${sku}`, 'paid')
        return true
      },
      oneTime: async (kind) => { if (kind === 'first') receipts.push('receipt'); alerts.push(kind) },
      onGrantFailed: () => { alerts.push('grant failed') },
    })
  return {
    deliver,
    get metadata() { return metadata },
    get writes() { return writes },
    attributions,
    receipts,
    alerts,
    crashAt: (n: number | null) => { crashAtWrite = n },
    runAt: (d: Date) => { wall = d },
    failAttributionOnce: () => { failAttribution = true },
    failReadOnce: () => { failRead = true },
    healRead: () => { failRead = false },
  }
}

test('tienda_anual: the first delivery fails after the Negocio half; the redelivery completes the Tienda half and the records once; a third adds nothing', async () => {
  const w = world('tienda_anual')
  w.crashAt(1)
  const first = await w.deliver()
  expect(first).toBe('retry')
  expect(webhookAnswerStatus(first)).toBe(500)
  expect(w.writes).toBe(1)
  expect(readNegocioGrant(w.metadata)?.expires_at).toBe('2027-02-10T12:00:00.000Z')
  expect(readTiendaGrant(w.metadata)).toBeNull()
  expect(w.attributions.size).toBe(0)
  expect(w.receipts).toEqual([])

  w.crashAt(null)
  const second = await w.deliver()
  expect(second).toBe('done')
  expect(webhookAnswerStatus(second)).toBe(200)
  expect(w.writes).toBe(2) // only the Tienda half
  expect(readTiendaGrant(w.metadata)?.expires_at).toBe('2028-02-10T12:00:00.000Z')
  expect(readNegocioGrant(w.metadata)?.payments).toEqual(['cs_pkg'])
  expect(w.attributions.size).toBe(1)
  expect(w.receipts).toEqual(['receipt'])

  const snapshot = structuredClone(w.metadata)
  expect(await w.deliver()).toBe('done')
  expect(w.metadata).toEqual(snapshot)
  expect(w.writes).toBe(2)
  expect(w.attributions.size).toBe(1)
  expect(w.receipts).toEqual(['receipt'])
})

test('the grants landed but the attribution failed: retry, the receipt is sent once, the redelivery records the attribution', async () => {
  const w = world('negocio_anual')
  w.failAttributionOnce()
  expect(await w.deliver()).toBe('retry')
  expect(w.receipts).toEqual(['receipt'])
  expect(w.attributions.size).toBe(0)
  expect(await w.deliver()).toBe('done')
  expect(w.attributions.size).toBe(1)
  expect(w.receipts).toEqual(['receipt'])
  expect(w.writes).toBe(1)
})

test('a package with no grant (the retired free setup): the receipt waits for the attribution, its only memory', async () => {
  const w = world('setup_gratis')
  w.failAttributionOnce()
  expect(await w.deliver()).toBe('retry')
  expect(w.receipts).toEqual([])
  expect(await w.deliver()).toBe('done')
  expect(w.receipts).toEqual(['receipt'])
  expect(await w.deliver()).toBe('done')
  expect(w.receipts).toEqual(['receipt'])
  // "Could not read whether it was paid" is never "not paid": retry, no receipt.
  w.failReadOnce()
  expect(await w.deliver()).toBe('retry')
  expect(w.receipts).toEqual(['receipt'])
})

test('a permanent Negocio: nothing written, one refund alert, done', async () => {
  const w = world('tienda_anual')
  const d = await runPackageSteps({
    applyGrants: async () => 'comp',
    alreadyPaid: async () => false,
    attribution: async () => { throw new Error('must not run') },
    oneTime: async (k) => { w.alerts.push(k) },
    onGrantFailed: () => {},
  })
  expect(d).toBe('done')
  expect(w.alerts).toEqual(['comp'])
})

test('the webhook routes the package through this order, and only unfixable metadata is final', () => {
  const src = readFileSync('lib/promoter-package-server.ts', 'utf8')
  const h = src.slice(src.indexOf('export async function handlePromoterPackageComplete'), src.indexOf('/** «Negocio 3 meses + Tienda 12 meses»'))
  expect(h).toContain('Promise<PlanWebhookOutcome>')
  expect(h.match(/return 'final'/g)).toHaveLength(2)
  expect(h).toContain('return runPackageSteps({')
  // The messages live in the one-time step only.
  const before = h.slice(0, h.indexOf('oneTime: async'))
  expect(before).not.toMatch(/notifyMerchantCloseReceipt\(|✅/)
  // A failed read of "already paid" is a throw, never "not paid".
  expect(src).toContain('if (error) throw new Error(`package attribution read failed: ${error.message}`)')
  const route = readFileSync('app/api/webhooks/stripe/route.ts', 'utf8')
  expect(route).toContain('planOutcome = await handlePromoterPackageComplete(session, event.created)')
})

test('dated from the payment, not the delivery: a redelivery an hour (or a day) later writes the same end dates', async () => {
  const prompt = world('tienda_anual')
  await prompt.deliver()

  const late = world('tienda_anual')
  late.runAt(new Date(PAID.getTime() + 86_400_000)) // the first delivery itself runs a day late, and fails halfway
  late.crashAt(1)
  expect(await late.deliver()).toBe('retry')
  late.crashAt(null)
  late.runAt(new Date(PAID.getTime() + 86_400_000 + 3_600_000)) // Stripe redelivers an hour after that
  expect(await late.deliver()).toBe('done')

  expect(readNegocioGrant(late.metadata)?.expires_at).toBe(readNegocioGrant(prompt.metadata)?.expires_at)
  expect(readTiendaGrant(late.metadata)?.expires_at).toBe(readTiendaGrant(prompt.metadata)?.expires_at)
  expect(readTiendaGrant(late.metadata)?.expires_at).toBe('2028-02-10T12:00:00.000Z')
})

test('the request is dated from the event and keyed by the session', () => {
  expect(packageGrantRequest({ sku: 'negocio_anual', shopId: 's', sessionId: 'cs_1', eventCreatedSec: EVENT_CREATED })).toEqual({
    sku: 'negocio_anual', shopId: 's', paymentId: 'cs_1', now: PAID,
  })
  // No event time: no date, and the plan seam falls back to now (never a made-up instant).
  expect(packageGrantRequest({ sku: 'negocio_anual', shopId: 's', sessionId: 'cs_1' })).toEqual({ sku: 'negocio_anual', shopId: 's', paymentId: 'cs_1' })
  const src = readFileSync('lib/promoter-package-server.ts', 'utf8')
  expect(src).toContain('applyPackageGrants(packageGrantRequest({ sku, shopId, sessionId: session.id, eventCreatedSec }), PACKAGE_GRANT_DEPS)')
})

test("the merchant's yearly plan payment is dated from its event too, the grant and the shares alike", () => {
  const webhook = readFileSync('lib/negocio-webhook.ts', 'utf8')
  const yearly = webhook.slice(webhook.indexOf('export async function handlePlanOneTimeComplete'), webhook.indexOf('function syncDeps('))
  expect(yearly).toContain('const paidAt = paymentInstant(completedAt) ?? new Date()')
  expect(yearly).toContain('now: paidAt }, PLAN_PAYMENT_DB)')
  expect(yearly).toContain('paymentRef: session.id, paidAt }')
  expect(readFileSync('app/api/webhooks/stripe/route.ts', 'utf8')).toContain('await handlePlanOneTimeComplete(session, sessionPlan, event.created)')
})
