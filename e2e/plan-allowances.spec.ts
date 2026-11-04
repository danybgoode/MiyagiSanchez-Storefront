/**
 * AI allowances by plan (epic 08 · plans-gratis-negocio S2.2, README D8).
 *
 * The AI that costs money grows with the plan and is never switched off: over the month's chat allowance a buyer is
 * offered «Déjale tu pregunta a la tienda» (an unanswered answer), never an error, and the model is not called.
 */
import { test, expect } from '@playwright/test'
import { PLAN_ALLOWANCES, allowanceFor } from '../lib/plan-allowances'
import { CHAT_COPY, handleShopChat, type ChatDeps } from '../lib/shop-chat/handler'
import type { ChatShop } from '../lib/shop-chat/core'

const NOW = Date.parse('2026-11-04T12:00:00Z')
const shop: ChatShop = { slug: 'tamales-rosa', name: 'Tamales Rosa', description: 'Tamales.', location: null, metadata: {} }

function deps(over: Partial<ChatDeps> = {}) {
  const trace: string[] = []
  const d: ChatDeps = {
    rateAllowed: async () => true,
    readShop: async () => ({ shop, products: [] }),
    verifyTurnstile: async () => true,
    spend: async (s, c) => { trace.push(`day:${s}:${c}`); return true },
    callModel: async () => { trace.push('model'); return { ok: true, text: JSON.stringify({ answer: 'Sí.', answered: true }) } },
    secret: 's',
    now: () => NOW,
    ...over,
  }
  return { d, trace }
}
const ask = { messages: [{ role: 'user', text: '¿Tienen de rajas?' }], turnstile_token: 'ok' }

test('allowances: Gratis gets some, the trial and Negocio get more; an unknown plan gets Gratis', () => {
  expect(PLAN_ALLOWANCES.gratis.chatAnswersPerMonth).toBeLessThan(PLAN_ALLOWANCES.negocio.chatAnswersPerMonth)
  expect(PLAN_ALLOWANCES.gratis.photosPerMonth).toBeLessThan(PLAN_ALLOWANCES.negocio.photosPerMonth)
  expect(allowanceFor('trial')).toEqual(PLAN_ALLOWANCES.negocio)
  expect(allowanceFor(null)).toEqual(PLAN_ALLOWANCES.gratis)
  expect(allowanceFor(undefined)).toEqual(PLAN_ALLOWANCES.gratis)
})

test('over the monthly allowance: an unanswered answer that offers the leave form — no model call', async () => {
  const { d, trace } = deps({
    monthlyCap: async () => 50,
    spendMonth: async (s, c) => { trace.push(`month:${s}:${c}`); return false },
  })
  const r = await handleShopChat({ slug: 'tamales-rosa', body: ask }, d)
  expect(r.status).toBe(200)
  if (r.status !== 200) return
  expect(r.body).toMatchObject({ answer: CHAT_COPY.allowance, answered: false })
  expect(r.body.chat_token).toBeTruthy()
  // The daily checks run first (a daily refusal must never use up a monthly answer), then the month refuses.
  expect(trace.filter((t) => t.startsWith('month:'))).toEqual(['month:shop_chat:month:shop:tamales-rosa:50'])
  expect(trace).not.toContain('model')
})

test('within the allowance: the day first, then the month, then the model', async () => {
  const { d, trace } = deps({
    monthlyCap: async () => 1000,
    spendMonth: async (s, c) => { trace.push(`month:${s}:${c}`); return true },
  })
  const r = await handleShopChat({ slug: 'tamales-rosa', body: ask }, d)
  expect(r.status).toBe(200)
  const month = trace.indexOf('month:shop_chat:month:shop:tamales-rosa:1000')
  expect(trace.findIndex((t) => t.startsWith('day:'))).toBeLessThan(month)
  expect(trace.indexOf('model')).toBeGreaterThan(month)
})

test('a plan that cannot be read spends against Gratis\'s allowance (fail closed)', async () => {
  const caps: number[] = []
  const { d } = deps({ monthlyCap: async () => null, spendMonth: async (_s, c) => { caps.push(c); return true } })
  await handleShopChat({ slug: 'tamales-rosa', body: ask }, d)
  expect(caps).toEqual([PLAN_ALLOWANCES.gratis.chatAnswersPerMonth])
})

test('agents spend from the SAME monthly subject as the widget: the allowance is the shop\'s', async () => {
  const subjects: string[] = []
  const { d } = deps({ audience: 'agent', monthlyCap: async () => 50, spendMonth: async (s) => { subjects.push(s); return true } })
  await handleShopChat({ slug: 'tamales-rosa', body: ask }, d)
  expect(subjects).toEqual(['shop_chat:month:shop:tamales-rosa'])
})

test('a daily refusal never uses up a monthly answer (Codex, #472)', async () => {
  const months: string[] = []
  const { d } = deps({ spend: async () => false, monthlyCap: async () => 50, spendMonth: async (s) => { months.push(s); return true } })
  const r = await handleShopChat({ slug: 'tamales-rosa', body: ask }, d)
  expect(r.status).toBe(429)
  expect(months).toEqual([])
})
