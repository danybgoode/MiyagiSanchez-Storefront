import { expect, test } from '@playwright/test'
import { TURNSTILE_VERIFY_URL, verifyTurnstile } from '../lib/prompt-to-shop/turnstile'

// Prompt-to-shop S1.4 — Turnstile fails CLOSED (epic D8). Every path that is not a positive answer from
// Cloudflare refuses; a missing secret is a refusal, never a pass.

const answering = (status: number, json: unknown) => {
  const calls: Array<{ url: string; body: string }> = []
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body) })
    return new Response(JSON.stringify(json), { status })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

test('a missing secret refuses without calling Cloudflare', async () => {
  const cf = answering(200, { success: true })
  expect(await verifyTurnstile({ secret: undefined, token: 'tok' }, cf)).toEqual({ ok: false, reason: 'not_configured' })
  expect(await verifyTurnstile({ secret: '   ', token: 'tok' }, cf)).toEqual({ ok: false, reason: 'not_configured' })
  expect(cf.calls).toHaveLength(0)
})

test('a missing or oversized token refuses without calling Cloudflare', async () => {
  const cf = answering(200, { success: true })
  for (const token of [undefined, '', 42, 'x'.repeat(2049)]) {
    expect(await verifyTurnstile({ secret: 's', token }, cf)).toEqual({ ok: false, reason: 'missing_token' })
  }
  expect(cf.calls).toHaveLength(0)
})

test('only success: true passes, and the secret, token and IP are sent', async () => {
  const cf = answering(200, { success: true })
  expect(await verifyTurnstile({ secret: 's3cret', token: 'tok', ip: '1.2.3.4' }, cf)).toEqual({ ok: true })
  expect(cf.calls[0].url).toBe(TURNSTILE_VERIFY_URL)
  expect(new URLSearchParams(cf.calls[0].body).get('remoteip')).toBe('1.2.3.4')
  expect(await verifyTurnstile({ secret: 's', token: 'tok' }, answering(200, { success: false }))).toEqual({ ok: false, reason: 'rejected' })
  expect(await verifyTurnstile({ secret: 's', token: 'tok' }, answering(200, { success: 'true' }))).toEqual({ ok: false, reason: 'rejected' })
})

test('Cloudflare down or answering garbage refuses', async () => {
  expect(await verifyTurnstile({ secret: 's', token: 'tok' }, answering(500, { success: true }))).toEqual({ ok: false, reason: 'unreachable' })
  const throwing = { fetch: (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch }
  expect(await verifyTurnstile({ secret: 's', token: 'tok' }, throwing)).toEqual({ ok: false, reason: 'unreachable' })
})
