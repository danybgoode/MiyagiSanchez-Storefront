import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { applyResponse, dismiss, emptyQueue, enqueue, needsAttention, nextToSend, pendingCount, sanitizeEntries, backoffMs, diffQueues, retryParked, wakeAll, QUEUE_PARK_CODES } from '../lib/in-person/sale-queue'
import { cacheOwnerAction } from '../lib/in-person/counter-cache'
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
    expect(verdict).toBe('parked')
    expect(needsAttention(queue)).toHaveLength(1)
    expect(needsAttention(queue)[0].message).toBe('No es tuyo')
    expect(pendingCount(queue)).toBe(0)
    expect(nextToSend(queue, T0 + 10 ** 9)).toBeNull()
  })

  test('a transient refusal is retried later, never parked (an expired session must not park a whole queue)', () => {
    for (const res of [
      { status: 401, code: 'UNAUTHENTICATED' }, { status: 409, code: 'seller_not_active' }, { status: 404, code: 'SELLER_NOT_FOUND' },
      { status: 503, code: 'MX_COMMERCE_UNCONFIGURED' }, { status: 503, code: 'RETRY_SAME_ID' }, { status: 409, code: 'IN_PROGRESS' },
      { status: 500 }, { status: 400 }, { status: null },
    ]) {
      const r = applyResponse(mk(), 'c1', res, T0)
      expect(r.verdict, JSON.stringify(res)).toBe('retry')
      expect(r.queue.entries[0].status).toBe('pending')
    }
    // a whole queue hit by the same 401 stays pending
    let q = enqueue(mk('a'), { client_id: 'b', lines, tendered_cents: null, total_cents: 1 }, T0)
    for (const id of ['a', 'b']) q = applyResponse(q, id, { status: 401, code: 'UNAUTHENTICATED' }, T0).queue
    expect(needsAttention(q)).toHaveLength(0)
  })

  test('only never-succeed codes park, and they are exactly the agreed list', () => {
    expect([...QUEUE_PARK_CODES].sort()).toEqual([
      'CLIENT_ID_REUSED', 'EMPTY_SALE', 'INVALID_BODY', 'INVALID_CLIENT_ID', 'INVALID_EMAIL', 'INVALID_KIND', 'INVALID_LINE', 'INVALID_QUANTITY',
      'INVALID_SOLD_AT', 'INVALID_TENDERED', 'IN_PERSON_MX_ONLY', 'KIND_NOT_AVAILABLE', 'OFFLINE_NOT_CASH', 'SALE_CLOSED', 'TENDERED_NOT_CASH',
      'TENDERED_SHORT', 'TOO_MANY_LINES', 'VARIANT_NOT_OWNED',
    ].sort())
  })

  test('«Reintentar» puts a parked sale back to pending, due now, same payload; wakeAll makes everything due', () => {
    const parked = applyResponse(mk(), 'c1', { status: 422, code: 'EMPTY_SALE' }, T0).queue
    const back = retryParked(parked, 'c1', T0 + 50)
    expect(back.entries[0]).toMatchObject({ status: 'pending', next_attempt_at: T0 + 50, message: null, client_id: 'c1', lines })
    expect(retryParked(mk(), 'c1', T0 + 50).entries[0].next_attempt_at).toBe(T0) // pending entries untouched
    const backedOff = applyResponse(mk(), 'c1', { status: null }, T0).queue
    expect(nextToSend(backedOff, T0 + 1)).toBeNull()
    expect(nextToSend(wakeAll(backedOff, T0 + 1), T0 + 1)?.client_id).toBe('c1')
  })

  test('diffQueues yields per-entry writes, so a store is never cleared and rewritten', () => {
    const a = mk('a'); const ab = enqueue(a, { client_id: 'b', lines, tendered_cents: null, total_cents: 1 }, T0)
    expect(diffQueues(a, ab)).toEqual({ put: [ab.entries[1]], remove: [] })
    expect(diffQueues(ab, a)).toEqual({ put: [], remove: ['b'] })
    expect(diffQueues(ab, ab)).toEqual({ put: [], remove: [] })
    const changed = applyResponse(ab, 'a', { status: null }, T0).queue
    expect(diffQueues(ab, changed).put.map((e) => e.client_id)).toEqual(['a'])
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
    expect(handle(PAGE, PAGE, 'cors', O, 'GET')).toBe(true)
  })
  test('the negation: other pages, other pages\' assets, API calls, cross-origin, non-GET, no referrer', () => {
    expect(handle(`${O}/shop/manage/orders`, '', 'navigate', O, 'GET')).toBe(false)
    expect(handle(`${O}/`, '', 'navigate', O, 'GET')).toBe(false)
    expect(handle(`${O}/shop/manage/en-persona-other`, '', 'navigate', O, 'GET')).toBe(false)
    expect(handle(`${O}/_next/static/chunks/a.js`, `${O}/shop/manage/orders`, 'no-cors', O, 'GET')).toBe(false)
    expect(handle(`${O}/api/shop/en-persona/sales/abc`, PAGE, 'cors', O, 'GET')).toBe(false)
    expect(handle(`${O}/api/anything`, `${O}/l/1`, 'cors', O, 'GET')).toBe(false)
    expect(handle(`${PAGE}?_rsc=1`, PAGE, 'cors', O, 'GET')).toBe(false)
    expect(handle(`${O}/_next/image?url=%2Fa.png&w=64&q=75`, PAGE, 'no-cors', O, 'GET')).toBe(false)
    expect(handle(`${O}/shop/manage/orders?_rsc=1`, PAGE, 'cors', O, 'GET')).toBe(false)
    expect(handle(`${O}/shop/manage/orders`, PAGE, 'cors', O, 'GET')).toBe(false)
    expect(handle('https://cdn.example.com/x.js', PAGE, 'no-cors', O, 'GET')).toBe(false)
    expect(handle(`${O}/api/shop/en-persona/sales`, PAGE, 'cors', O, 'POST')).toBe(false)
    expect(handle(`${O}/_next/static/a.js`, '', 'no-cors', O, 'GET')).toBe(false)
    expect(handle(`${O}/_next/static/a.js`, 'https://evil.example/shop/manage/en-persona', 'no-cors', O, 'GET')).toBe(false)
    expect(handle('not a url', PAGE, 'navigate', O, 'GET')).toBe(false)
  })
  test('the site-wide sw.js stays push-only; the counter has its own scoped worker', () => {
    const sw = readFileSync(path.resolve(import.meta.dirname, '../public/sw.js'), 'utf8')
    expect(sw).not.toContain("'fetch'")
    expect(sw).not.toContain('importScripts')
    expect(sw).toContain("addEventListener('push'")
    expect(sw).toContain("addEventListener('notificationclick'")
    const own = readFileSync(path.resolve(import.meta.dirname, '../public/counter-sw.js'), 'utf8')
    expect(own).toContain("importScripts('/counter-scope.js')")
    expect(own).toMatch(/shouldHandleCounterRequest\([^)]*\)\) return/)
    expect(own).toMatch(/const CACHE = 'ms-counter-v\d+'/)
    expect(own).toContain('caches.delete')
    const client = readFileSync(path.resolve(import.meta.dirname, '../app/(shell)/shop/manage/en-persona/CounterClient.tsx'), 'utf8')
    expect(client).toContain("register('/counter-sw.js', { scope: '/shop/manage/en-persona' })")
  })
  test('cache owner: a different seller on the same browser purges the counter cache', () => {
    expect(cacheOwnerAction('sel_1', 'sel_1')).toBe('keep')
    expect(cacheOwnerAction('sel_1', 'sel_2')).toBe('purge')
    expect(cacheOwnerAction(null, 'sel_2')).toBe('claim')
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
