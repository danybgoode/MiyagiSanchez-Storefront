import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { applyResponse, dismiss, emptyQueue, enqueue, needsAttention, nextToSend, pendingCount, sanitizeEntries, backoffMs } from '../lib/in-person/sale-queue'
import { isOversold, oversoldLines, oversoldSummary } from '../lib/in-person/oversold'

/** In-person sales · Sprint 3 — offline cash queue, worker scope, oversell flag. */

const T0 = 1_800_000_000_000
const lines = [{ variant_id: 'var_1', quantity: 2 }]
const mk = (id = 'c1', now = T0) => enqueue(emptyQueue(), { client_id: id, lines, tendered_cents: 50000, total_cents: 24000 }, now)
const OK = { status: 201, hasOrder: true }

test.describe('sale-queue', () => {
  test('enqueue freezes id, payload and sold_at; the same id twice is one entry', () => {
    const q = mk('c1')
    expect(q.entries[0]).toMatchObject({ client_id: 'c1', lines, tendered_cents: 50000, sold_at: new Date(T0).toISOString(), status: 'pending', uncertain: false })
    const again = enqueue(q, { client_id: 'c1', lines: [{ variant_id: 'other', quantity: 9 }], tendered_cents: null, total_cents: 1 }, T0 + 5000)
    expect(again.entries).toHaveLength(1)
    expect(again.entries[0].lines).toEqual(lines)
    expect(again.entries[0].sold_at).toBe(new Date(T0).toISOString())
  })

  test('ack removes the entry ONLY on a returned order', () => {
    const q = mk()
    expect(applyResponse(q, 'c1', OK, T0).queue.entries).toHaveLength(0)
    // 200 without an order id is not an ack
    expect(applyResponse(q, 'c1', { status: 200, hasOrder: false }, T0).queue.entries).toHaveLength(1)
  })

  test('uncertain outcomes keep the entry, mark it uncertain and back off', () => {
    for (const res of [{ status: null }, { status: 502, code: 'BACKEND_UNREACHABLE' }, { status: 503, code: 'RETRY_SAME_ID' }, { status: 409, code: 'IN_PROGRESS' }, { status: 400 }]) {
      const { queue } = applyResponse(mk(), 'c1', res, T0)
      expect(queue.entries[0]).toMatchObject({ status: 'pending', uncertain: true, attempts: 1 })
      expect(queue.entries[0].next_attempt_at).toBe(T0 + backoffMs(1))
      expect(nextToSend(queue, T0)).toBeNull()
      expect(nextToSend(queue, T0 + backoffMs(1))?.client_id).toBe('c1')
    }
    expect(backoffMs(2)).toBe(backoffMs(1) * 2)
    expect(backoffMs(99)).toBeLessThanOrEqual(5 * 60_000)
  })

  test('a definite refusal parks the sale in needs_attention, never deletes it', () => {
    const { queue, verdict } = applyResponse(mk(), 'c1', { status: 422, code: 'VARIANT_NOT_OWNED', message: 'No es tuyo' }, T0)
    expect(verdict).toBe('refused')
    expect(needsAttention(queue)).toHaveLength(1)
    expect(needsAttention(queue)[0].message).toBe('No es tuyo')
    expect(pendingCount(queue)).toBe(0)
    expect(nextToSend(queue, T0 + 10 ** 9)).toBeNull()
  })

  test('sticky rule: an entry that was ever uncertain is not parked by a pre-claim refusal', () => {
    const afterFlake = applyResponse(mk(), 'c1', { status: null }, T0).queue
    const r = applyResponse(afterFlake, 'c1', { status: 401, code: 'UNAUTHENTICATED' }, T0 + 10 ** 6)
    expect(r.verdict).toBe('uncertain')
    expect(r.queue.entries[0].status).toBe('pending')
    // but a post-claim refusal does park it
    expect(applyResponse(afterFlake, 'c1', { status: 409, code: 'SALE_CLOSED' }, T0 + 10 ** 6).queue.entries[0].status).toBe('needs_attention')
  })

  test('a flaky reconnect resending the same entry twice sends the SAME client_id and payload', () => {
    let q = mk('c1')
    const first = nextToSend(q, T0)!
    q = applyResponse(q, 'c1', { status: null }, T0).queue
    const second = nextToSend(q, T0 + backoffMs(1))!
    expect(second.client_id).toBe(first.client_id)
    expect({ l: second.lines, t: second.tendered_cents, s: second.sold_at }).toEqual({ l: first.lines, t: first.tendered_cents, s: first.sold_at })
    // the backend answers the replay with the order: one ack, queue empty, nothing re-enqueued
    q = applyResponse(q, 'c1', OK, T0 + 9999).queue
    expect(q.entries).toHaveLength(0)
    expect(applyResponse(q, 'c1', OK, T0).queue.entries).toHaveLength(0)
  })

  test('send order is oldest first; dismiss only removes parked entries; sanitize drops junk', () => {
    let q = mk('a', T0)
    q = enqueue(q, { client_id: 'b', lines, tendered_cents: null, total_cents: 1 }, T0 + 1)
    expect(nextToSend(q, T0 + 1)?.client_id).toBe('a')
    expect(dismiss(q, 'a').entries).toHaveLength(2)
    const parked = applyResponse(q, 'a', { status: 422, code: 'EMPTY_SALE' }, T0).queue
    expect(dismiss(parked, 'a').entries.map((e) => e.client_id)).toEqual(['b'])
    expect(sanitizeEntries([q.entries[0], { client_id: 1 }, null, 'x'])).toHaveLength(1)
    expect(sanitizeEntries(undefined)).toEqual([])
  })
})

test.describe('counter service-worker scope', () => {
  const src = readFileSync(path.resolve(import.meta.dirname, '../public/counter-scope.js'), 'utf8')
  const fakeSelf: { shouldHandleCounterRequest?: (...a: unknown[]) => boolean } = {}
  new Function('self', src)(fakeSelf)
  const handle = fakeSelf.shouldHandleCounterRequest!
  const O = 'https://miyagisanchez.com'
  const PAGE = `${O}/shop/manage/en-persona`

  test('answers the counter navigation and that page\'s own same-origin GET assets', () => {
    expect(handle(PAGE, '', 'navigate', O, 'GET')).toBe(true)
    expect(handle(`${PAGE}/`, '', 'navigate', O, 'GET')).toBe(true)
    expect(handle(`${O}/_next/static/chunks/a.js`, PAGE, 'no-cors', O, 'GET')).toBe(true)
    expect(handle(`${PAGE}?_rsc=1`, PAGE, 'cors', O, 'GET')).toBe(true)
  })
  test('the negation: other pages, other pages\' assets, API calls, cross-origin, non-GET, no referrer', () => {
    expect(handle(`${O}/shop/manage/orders`, '', 'navigate', O, 'GET')).toBe(false)
    expect(handle(`${O}/`, '', 'navigate', O, 'GET')).toBe(false)
    expect(handle(`${O}/shop/manage/en-persona-other`, '', 'navigate', O, 'GET')).toBe(false)
    expect(handle(`${O}/_next/static/chunks/a.js`, `${O}/shop/manage/orders`, 'no-cors', O, 'GET')).toBe(false)
    expect(handle(`${O}/api/shop/en-persona/sales/abc`, PAGE, 'cors', O, 'GET')).toBe(false)
    expect(handle(`${O}/api/anything`, `${O}/l/1`, 'cors', O, 'GET')).toBe(false)
    expect(handle('https://cdn.example.com/x.js', PAGE, 'no-cors', O, 'GET')).toBe(false)
    expect(handle(`${O}/api/shop/en-persona/sales`, PAGE, 'cors', O, 'POST')).toBe(false)
    expect(handle(`${O}/_next/static/a.js`, '', 'no-cors', O, 'GET')).toBe(false)
    expect(handle(`${O}/_next/static/a.js`, 'https://evil.example/shop/manage/en-persona', 'no-cors', O, 'GET')).toBe(false)
    expect(handle('not a url', PAGE, 'navigate', O, 'GET')).toBe(false)
  })
  test('sw.js defers to the helper and answers nothing else itself', () => {
    const sw = readFileSync(path.resolve(import.meta.dirname, '../public/sw.js'), 'utf8')
    expect(sw).toContain("importScripts('/counter-scope.js')")
    expect(sw).toMatch(/shouldHandleCounterRequest\([^)]*\)\) return/)
    expect(sw).toContain("addEventListener('push'")
    expect(sw).toContain("addEventListener('notificationclick'")
  })
})

test.describe('oversold flag', () => {
  const raw = [{ variant_id: 'v1', quantity: 3, decrement: 1, shortfall: 2 }, { variant_id: 'v2', quantity: 1, decrement: 0, shortfall: 1 }]
  test('flags only a non-empty valid list; summarises short units', () => {
    expect(isOversold(raw)).toBe(true)
    expect(oversoldSummary(raw)).toBe('Faltaron 3 unidades en 2 productos.')
    expect(oversoldSummary([raw[1]])).toBe('Faltaron 1 unidad en 1 producto.')
    for (const none of [null, undefined, [], 'x', {}, [{ variant_id: 'v', quantity: 1, decrement: 1, shortfall: 0 }], [null]]) {
      expect(isOversold(none)).toBe(false)
      expect(oversoldSummary(none)).toBeNull()
    }
    expect(oversoldLines(raw)).toHaveLength(2)
  })
})
