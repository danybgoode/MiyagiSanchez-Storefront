/**
 * Paying during the free trial, and managing the monthly plan (Daniel, 2026-11-05).
 *
 * "If I pay right now what happens? Is it applied after my 30 days?" — yes: paying early never throws the remaining
 * free days away. The yearly payment's 12 months start when the trial ends; the monthly subscription's first charge
 * waits for the trial's end (Stripe needs it at least 48 h away). And a monthly subscriber can open Stripe's page to
 * change the card or cancel, scoped to their OWN shop and user.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { NEGOCIO_GRANT_KEY, NEGOCIO_TRIAL_KEY, addMonthsClamped, decideNegocioPayment, type PlanState } from '../lib/plan'
import { STRIPE_MIN_TRIAL_SECONDS, monthlyFirstChargeAt } from '../lib/negocio-checkout-rules'
import { isSafeSearchValue, pickNegocioSubscription, startNegocioManage, type NegocioSubscriptionLike } from '../lib/negocio-manage'

const NOW = new Date('2026-11-10T12:00:00Z')
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000)
const trialMeta = (endsInDays: number) => ({
  [NEGOCIO_TRIAL_KEY]: { started_at: days(endsInDays - 30).toISOString(), expires_at: days(endsInDays).toISOString() },
})

test.describe('a yearly payment during the trial starts when the trial ends', () => {
  test('12 months counted from the trial end, never from today', () => {
    const d = decideNegocioPayment(trialMeta(12), { paymentId: 'cs_1', months: 12, now: NOW })
    expect(d.action).toBe('write')
    if (d.action !== 'write') return
    expect(d.grant.expires_at).toBe(addMonthsClamped(days(12), 12).toISOString())
    // `granted_at` still records when the payment happened.
    expect(d.grant.granted_at).toBe(NOW.toISOString())
  })

  test('an ended trial does not delay anything: 12 months from today', () => {
    const d = decideNegocioPayment(trialMeta(-3), { paymentId: 'cs_1', months: 12, now: NOW })
    if (d.action !== 'write') throw new Error('expected a write')
    expect(d.grant.expires_at).toBe(addMonthsClamped(NOW, 12).toISOString())
  })

  test('a renewal adds after the LATER of a live paid term and a live trial', () => {
    const paidUntil = days(40)
    const meta = { ...trialMeta(12), [NEGOCIO_GRANT_KEY]: { type: 'one_time', granted_at: NOW.toISOString(), expires_at: paidUntil.toISOString() } }
    const d = decideNegocioPayment(meta, { paymentId: 'cs_2', months: 12, now: NOW })
    if (d.action !== 'write') throw new Error('expected a write')
    expect(d.grant.expires_at).toBe(addMonthsClamped(paidUntil, 12).toISOString())
  })
})

test.describe('a monthly subscription during the trial first charges when the trial ends', () => {
  const trial = (endsInDays: number): PlanState => ({ plan: 'trial', reason: 'trial', endsAt: days(endsInDays).toISOString() })
  const sec = (d: Date) => Math.floor(d.getTime() / 1000)

  test('the first charge is the trial end', () => {
    expect(monthlyFirstChargeAt(trial(12), NOW)).toBe(sec(days(12)))
  })

  test('a trial ending within 48 h is rounded up to what Stripe accepts (a little longer free, never shorter)', () => {
    expect(monthlyFirstChargeAt(trial(1), NOW)).toBe(sec(NOW) + STRIPE_MIN_TRIAL_SECONDS)
    expect(STRIPE_MIN_TRIAL_SECONDS).toBeGreaterThan(48 * 3600)
  })

  test('no trial, no wait: Gratis and an ended trial charge today', () => {
    for (const plan of [{ plan: 'gratis', reason: 'none', endsAt: null }, { plan: 'gratis', reason: 'trial_ended', endsAt: null }] as PlanState[]) {
      expect(monthlyFirstChargeAt(plan, NOW)).toBeNull()
    }
  })

  test('the checkout passes it to Stripe as subscription_data.trial_end', () => {
    const checkout = readFileSync('lib/negocio-checkout.ts', 'utf8')
    expect(checkout).toContain('trialEnd: monthlyFirstChargeAt(plan)')
    const stripe = readFileSync('lib/stripe-subscriptions.ts', 'utf8')
    expect(stripe).toContain('trial_end: trialEnd')
  })
})

test('the $0 invoice that opens a free period is not a payment: it returns before any status flip or renewal share', () => {
  const src = readFileSync('lib/negocio-webhook.ts', 'utf8')
  const body = src.slice(src.indexOf('export async function handleNegocioInvoicePaid'))
  const guard = body.indexOf('(invoice.amount_paid ?? 0) <= 0) return')
  expect(guard).toBeGreaterThan(-1)
  expect(guard).toBeLessThan(body.indexOf('handleNegocioSubscriptionChanged('))
  expect(guard).toBeLessThan(body.indexOf('recordRenewalShare('))
})

test.describe('managing the monthly plan: only your own shop, only your own user', () => {
  const sub = (over: Partial<NegocioSubscriptionLike> = {}): NegocioSubscriptionLike => ({
    id: 'sub_1', status: 'active', customer: 'cus_1', created: 100,
    metadata: { kind: 'negocio', shop_id: 'shop-1', seller_clerk_id: 'user_1' },
    ...over,
  })

  test('picks this shop and user, newest first, with its customer', () => {
    const picked = pickNegocioSubscription([sub({ id: 'old', created: 1 }), sub({ id: 'new', created: 9, customer: { id: 'cus_9' } })], 'shop-1', 'user_1')
    expect(picked).toEqual({ subscriptionId: 'new', customerId: 'cus_9' })
  })

  test('another shop, another user, another kind or a cancelled one is never picked', () => {
    const others = [
      sub({ metadata: { kind: 'negocio', shop_id: 'shop-2', seller_clerk_id: 'user_1' } }),
      sub({ metadata: { kind: 'negocio', shop_id: 'shop-1', seller_clerk_id: 'user_2' } }),
      sub({ metadata: { kind: 'subdomain', shop_id: 'shop-1', seller_clerk_id: 'user_1' } }),
      sub({ status: 'canceled' }),
      sub({ customer: null }),
    ]
    expect(pickNegocioSubscription(others, 'shop-1', 'user_1')).toBeNull()
  })

  test('a trialing or past-due subscription can still be managed', () => {
    expect(pickNegocioSubscription([sub({ status: 'trialing' })], 'shop-1', 'user_1')).not.toBeNull()
    expect(pickNegocioSubscription([sub({ status: 'past_due' })], 'shop-1', 'user_1')).not.toBeNull()
  })

  test('the search query never carries a quote: an unsafe shop id is refused before any Stripe call', async () => {
    expect(isSafeSearchValue("shop' OR metadata['kind']:'x")).toBe(false)
    expect(isSafeSearchValue('3f1c2a9e-0b1d-4c2e-9a7f-5d6e7f8a9b0c')).toBe(true)
    let searched = false
    const out = await startNegocioManage(
      { shopId: "x' OR 'a", sellerClerkId: 'user_1', returnUrl: 'https://miyagisanchez.com/shop/manage/negocio' },
      { searchSubscriptions: async () => { searched = true; return [] }, createPortal: async () => 'https://billing.stripe.com/x' },
    )
    expect(out).toMatchObject({ ok: false, status: 400 })
    expect(searched).toBe(false)
  })

  test('found → the portal URL; not found → 404; Stripe down → 503 (never a portal for someone else)', async () => {
    const deps = (subs: NegocioSubscriptionLike[], portal = async () => 'https://billing.stripe.com/p') => ({
      searchSubscriptions: async () => subs,
      createPortal: portal,
    })
    const input = { shopId: 'shop-1', sellerClerkId: 'user_1', returnUrl: 'https://miyagisanchez.com/shop/manage/negocio' }
    expect(await startNegocioManage(input, deps([sub()]))).toEqual({ ok: true, url: 'https://billing.stripe.com/p' })
    expect(await startNegocioManage(input, deps([sub({ metadata: { kind: 'negocio', shop_id: 'shop-1', seller_clerk_id: 'user_2' } })]))).toMatchObject({ ok: false, status: 404 })
    expect(await startNegocioManage(input, { searchSubscriptions: async () => { throw new Error('down') }, createPortal: async () => 'x' })).toMatchObject({ ok: false, status: 503 })
    expect(await startNegocioManage(input, deps([sub()], async () => { throw new Error('no portal config') }))).toMatchObject({ ok: false, status: 503 })
  })

  test('the route reads the shop from the session, never from the body', () => {
    const route = readFileSync('app/api/sell/negocio/manage/route.ts', 'utf8')
    expect(route).toContain('readOwnedShop(user.id)')
    expect(route).not.toContain('req.json()')
    expect(route.indexOf('currentUser()')).toBeGreaterThan(-1)
    expect(route.indexOf('currentUser()')).toBeLessThan(route.indexOf('readOwnedShop('))
  })
})
