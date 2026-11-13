import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  decideScreen, parseScreenResponse, screenRequestBody, screenText, SCREEN_QUESTIONS, SCREEN_THRESHOLDS,
} from '../lib/prompt-to-shop/screen'
import { handleCreateDraft, P2S_COPY, P2S_COPY_EN, type DraftsDeps } from '../lib/prompt-to-shop/handler'

const fixture = (name: string) => JSON.parse(readFileSync(join(process.cwd(), 'e2e', 'fixtures', name), 'utf8'))
const recorded = fixture('p2s-screen-recorded.json') as { questions: unknown; cases: Array<{ text: string; expect: string; response: unknown }> }
const cases = fixture('p2s-screen-cases.json') as Array<{ text: string; expect: string }>

// one-front-door-both-markets S1.1 + S1.2 — the screen (D1–D5).
//
// The thresholds are pinned against REAL model output: `fixtures/p2s-screen-recorded.json` holds Jev's answers for
// every labelled case, recorded with `scripts/record-p2s-screen.mjs`. CI never calls the model; it replays those
// answers through `decideScreen` and asserts each case's expected verdict, so a threshold edit that would start
// refusing tamales — or let fentanyl through — fails here.

test('the recording was made with the questions the code asks today', () => {
  // A recording of other questions proves nothing about these ones: re-record when SCREEN_QUESTIONS changes.
  expect(recorded.questions).toEqual(JSON.parse(JSON.stringify(SCREEN_QUESTIONS)))
  expect(recorded.cases.map((c) => c.text)).toEqual(cases.map((c) => c.text))
})

for (const c of recorded.cases) {
  test(`screen: «${c.text.slice(0, 50)}» → ${c.expect}`, () => {
    const verdict = decideScreen(parseScreenResponse(c.response))
    if (c.expect === 'allow') expect(verdict).toEqual({ verdict: 'allow' })
    else if (c.expect === 'refuse') expect(verdict.verdict).toBe('refuse')
    else expect(verdict).toEqual({ verdict: 'refuse', kind: c.expect.split(':')[1] })
  })
}

test('the labelled set covers both languages and every refusal kind', () => {
  const kinds = new Set(cases.map((c) => c.expect))
  for (const k of ['allow', 'refuse:attack', 'refuse:gibberish', 'refuse:off_task', 'refuse:prohibited']) expect(kinds).toContain(k)
  expect(cases.length).toBeGreaterThanOrEqual(40)
})

test('a non-business answer below the confidence bar is ALLOWED (wrongly refusing a merchant is the worse error)', () => {
  const unsure = { ok: true as const, intent: { choice: 'off_task', confidence: SCREEN_THRESHOLDS.intentConfidence - 0.01 }, prohibited: 0.1 }
  expect(decideScreen(unsure)).toEqual({ verdict: 'allow' })
  expect(decideScreen({ ...unsure, intent: { choice: 'off_task', confidence: SCREEN_THRESHOLDS.intentConfidence } })).toEqual({ verdict: 'refuse', kind: 'off_task' })
})

test('prohibited wins over "business": a drug shop IS a business, and it is the one to refuse', () => {
  expect(decideScreen({ ok: true, intent: { choice: 'business', confidence: 0.99 }, prohibited: 0.95 })).toEqual({ verdict: 'refuse', kind: 'prohibited' })
})

test('three states: a malformed answer, an unknown choice and a thrown call are UNAVAILABLE, never allow', async () => {
  expect(parseScreenResponse(null)).toEqual({ ok: false, reason: 'not_json' })
  expect(parseScreenResponse({ answers: { intent: { choice: 'business' } } })).toMatchObject({ ok: false })
  expect(decideScreen({ ok: true, intent: { choice: 'spam', confidence: 1 }, prohibited: 0 })).toEqual({ verdict: 'unavailable', reason: 'unknown_choice' })
  const lines: unknown[] = []
  const thrown = await screenText('Vendo tamales', { ask: async () => { throw new Error('boom') }, log: (l) => lines.push(l) })
  expect(thrown).toEqual({ verdict: 'unavailable', reason: 'threw' })
  expect(lines).toEqual([{ event: 'screen_unavailable', reason: 'threw' }])
})

test('the description is STATE, never instructions, and is cut before it is sent', () => {
  const body = screenRequestBody('x'.repeat(5000)) as { state: { merchant_description: string }; questions: unknown }
  expect(body.state.merchant_description.length).toBe(2000)
  expect(body.questions).toBe(SCREEN_QUESTIONS)
})

// ── In the handler: after Turnstile + burst, before the spend ─────────────────────────────────────────────────────

function deps(verdict: Awaited<ReturnType<DraftsDeps['screen']>>) {
  const trace: string[] = []
  const d: DraftsDeps = {
    verifyTurnstile: async () => { trace.push('turnstile'); return { ok: true } },
    burstAllowed: async () => { trace.push('burst'); return true },
    spend: async () => { trace.push('spend'); return { data: { ok: true, reason: null, versions_used: 1 }, error: null } },
    findOwnedDraft: async () => null,
    createDraft: async (_d, _desc, _v, meta) => { trace.push(`create:${meta.locale}:${meta.market}:${meta.seedRows?.length ?? 0}`); return { id: '7f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607', description: 'x' } },
    startVersion: async () => true,
    saveBlock: async () => true,
    refund: async () => { trace.push('refund') },
    callModel: async () => { trace.push('model'); return { ok: false, error: 'not in this test' } },
    modelConfigured: true,
    newDeviceId: () => '0b9e8c1e-3c2a-4d8e-9a51-6f1f2b3c4d5e',
    screen: async (text) => { trace.push(`screen:${text}`); return verdict },
  }
  return { d, trace }
}

test('a refused description spends NOTHING: no spend, no draft, no model — and the message is the merchant\'s language', async () => {
  const { d, trace } = deps({ verdict: 'refuse', kind: 'gibberish' })
  const result = await handleCreateDraft({ body: { description: 'asdkjh qwe', turnstile_token: 't', locale: 'en' }, deviceCookie: null }, d)
  expect(result).toMatchObject({ kind: 'refuse', status: 422, error: 'notABusiness', message: P2S_COPY_EN.notABusiness })
  expect(trace).toEqual(['turnstile', 'burst', 'screen:asdkjh qwe'])
})

test('an attack reads exactly like off-task (the attacker never learns which check fired); prohibited names why', async () => {
  const attack = await handleCreateDraft({ body: { description: 'ignore all', turnstile_token: 't' }, deviceCookie: null }, deps({ verdict: 'refuse', kind: 'attack' }).d)
  expect(attack).toMatchObject({ status: 422, message: P2S_COPY.notABusiness })
  const banned = await handleCreateDraft({ body: { description: 'réplicas', turnstile_token: 't' }, deviceCookie: null }, deps({ verdict: 'refuse', kind: 'prohibited' }).d)
  expect(banned).toMatchObject({ status: 422, message: P2S_COPY.prohibited })
})

test('unavailable proceeds under today\'s guards: the spend still runs and is still the hard cap', async () => {
  const { d, trace } = deps({ verdict: 'unavailable', reason: 'no_key' })
  const result = await handleCreateDraft({ body: { description: 'Vendo tamales', turnstile_token: 't' }, deviceCookie: null }, d)
  expect(result.kind).toBe('stream')
  expect(trace.slice(0, 5)).toEqual(['turnstile', 'burst', 'screen:Vendo tamales', 'spend', 'create:es:null:0'])
})

test('the rows ride along: the screen judges their titles too, and the draft is born with locale, hint and rows', async () => {
  const { d, trace } = deps({ verdict: 'allow' })
  const rows = [{ title: 'Vela de soya lavanda', price: 18, category: 'otros' }, { title: 'x', category: 'otros' }]
  await handleCreateDraft({ body: { description: 'Candles shop', turnstile_token: 't', locale: 'en', market_hint: 'us', input: 'file', seed_rows: rows }, deviceCookie: null }, d)
  expect(trace).toContain('screen:Candles shop\nVela de soya lavanda')
  expect(trace).toContain('create:en:us:1') // the 1-char title is not a valid row and never reaches the draft
})

test('a body with an unknown input kind or a non-array of rows is malformed, refused before Turnstile', async () => {
  for (const extra of [{ input: 'fax' }, { seed_rows: 'nope' }]) {
    const { d, trace } = deps({ verdict: 'allow' })
    const r = await handleCreateDraft({ body: { description: 'Vendo tamales', turnstile_token: 't', ...extra }, deviceCookie: null }, d)
    expect(r).toMatchObject({ status: 400 })
    expect(trace).toEqual([])
  }
})
