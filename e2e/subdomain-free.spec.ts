/**
 * The subdomain is free and sold nowhere (epic 08 · plans-gratis-negocio S2.4, README D11, decision b).
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { planSubdomainCancellations, subdomainFreeEmail } from '../lib/subdomain-free-cancel'
import { parseArgs } from '../scripts/cancel-subdomain-subscriptions'

const sub = (over: Partial<Parameters<typeof planSubdomainCancellations>[0][number]>) => ({
  id: 'sub_1', status: 'active', cancel_at_period_end: false, metadata: { kind: 'subdomain' }, customerEmail: 'a@b.mx', ...over,
})

test('only live subdomain subscriptions are cancelled, and only when the owner can be emailed', () => {
  expect(planSubdomainCancellations([
    sub({ id: 'live' }),
    sub({ id: 'grace', status: 'past_due' }),
    sub({ id: 'theirs', cancel_at_period_end: true }),
    sub({ id: 'gone', status: 'canceled' }),
    sub({ id: 'other', metadata: { kind: 'ml_sync' } }),
    sub({ id: 'mute', customerEmail: null }),
  ]).map((d) => [d.id, d.action, d.why])).toEqual([
    ['live', 'cancel', 'live_subdomain'], ['grace', 'cancel', 'live_subdomain'], ['theirs', 'skip', 'already_ending'],
    ['gone', 'skip', 'not_live'], ['other', 'skip', 'not_subdomain'], ['mute', 'skip', 'no_email'],
  ])
})

test('the notice is retryable: ours-but-not-yet-emailed is notify; emailed is done; never twice', () => {
  const ours = { kind: 'subdomain', subdomain_free_cancel: '1' }
  expect(planSubdomainCancellations([sub({ id: 'owed', cancel_at_period_end: true, metadata: ours })])[0]).toMatchObject({ action: 'notify' })
  expect(planSubdomainCancellations([sub({ id: 'sent', cancel_at_period_end: true, metadata: { ...ours, subdomain_free_notice: '1' } })])[0]).toMatchObject({ action: 'skip', why: 'done' })
})

test('the email says it is free, when the paid period ends, and that nothing else is charged', () => {
  const m = subdomainFreeEmail({ periodEnd: new Date('2027-03-15T12:00:00Z') })
  expect(m.subject).toBe('Tu subdominio ahora es gratis')
  expect(m.text).toContain('15 de marzo de 2027')
  expect(m.text).toContain('no te volveremos a cobrar')
})

test('the script defaults to a dry run', () => {
  expect(parseArgs([])).toEqual({ ok: true, apply: false })
  expect(parseArgs(['--apply'])).toEqual({ ok: true, apply: true })
  expect(parseArgs(['--yes']).ok).toBe(false)
})

test('nothing sells the subdomain: the buy routes answer 410 and the promoter picker no longer offers it', () => {
  for (const p of ['app/api/sell/shop/subdomain/subscribe/route.ts', 'app/api/sell/shop/subdomain/switch/route.ts', 'app/api/promoter/close/subdomain/route.ts']) {
    const src = readFileSync(p, 'utf8')
    expect(src).toContain('status: 410')
    expect(src).not.toContain('Checkout')
  }
  expect(readFileSync('app/(shell)/promotor/cerrar/PromoterCloseClient.tsx', 'utf8')).not.toContain("id: 'subdomain'")
})
