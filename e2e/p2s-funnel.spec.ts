import { expect, test } from '@playwright/test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { P2S_FUNNEL_EVENTS, SESSION_SCOPE, fireFunnelOnce, funnelKey, type FunnelDeps, type FunnelStorage } from '../lib/prompt-to-shop/funnel'

// Prompt-to-shop S5.3 — the seven funnel steps, each counted ONCE per draft (the describe submit once per tab).
// The guard is structural: an in-memory set for the page and sessionStorage for the tab, the key recorded BEFORE
// the push. The specs drive the real function with an injected storage and pusher, and record the order.

const ROOT = process.cwd()
const DRAFT = '7f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607'
const OTHER = '11111111-2222-4333-8444-555555555555'

function memoryStorage(trace: string[]): FunnelStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    get: (k) => { trace.push(`get:${k}`); return data.get(k) ?? null },
    set: (k, v) => { trace.push(`set:${k}`); data.set(k, v) },
  }
}

function deps(trace: string[], storage: FunnelStorage | null, seen = new Set<string>()): FunnelDeps {
  return { seen, storage, push: (name) => { trace.push(`push:${name}`) } }
}

test('the seven steps, in journey order', () => {
  expect(P2S_FUNNEL_EVENTS).toEqual([
    'p2s_describe_submitted',
    'p2s_preview_rendered',
    'p2s_version_requested',
    'p2s_kept',
    'p2s_real_product_added',
    'p2s_payments_connected',
    'p2s_published',
  ])
})

test('every step fires once per draft, however many times it is reached — key recorded before the push', () => {
  for (const event of P2S_FUNNEL_EVENTS) {
    const trace: string[] = []
    const d = deps(trace, memoryStorage(trace))
    expect(fireFunnelOnce(event, DRAFT, {}, d), event).toBe(true)
    expect(fireFunnelOnce(event, DRAFT, {}, d), event).toBe(false)
    expect(fireFunnelOnce(event, DRAFT, {}, d), event).toBe(false)
    const key = funnelKey(event, DRAFT)
    expect(trace, event).toEqual([`get:${key}`, `set:${key}`, `push:${event}`])
  }
})

test('a reload (a fresh page, the same tab) does not count again; a second draft is a second funnel', () => {
  const trace: string[] = []
  const storage = memoryStorage(trace)
  expect(fireFunnelOnce('p2s_kept', DRAFT, {}, deps(trace, storage))).toBe(true)
  // New page: the memory is empty, the tab's storage is not.
  expect(fireFunnelOnce('p2s_kept', DRAFT, {}, deps(trace, storage))).toBe(false)
  expect(fireFunnelOnce('p2s_kept', OTHER, {}, deps(trace, storage))).toBe(true)
  expect(trace.filter((t) => t.startsWith('push:'))).toEqual(['push:p2s_kept', 'push:p2s_kept'])
})

test('with storage blocked or throwing, the page still counts each step once', () => {
  const trace: string[] = []
  const throwing: FunnelStorage = { get: () => { throw new Error('denied') }, set: () => { throw new Error('denied') } }
  const seen = new Set<string>()
  for (const storage of [null, throwing]) {
    expect(fireFunnelOnce('p2s_published', DRAFT, {}, deps(trace, storage, seen))).toBe(storage === null)
  }
  expect(fireFunnelOnce('p2s_published', DRAFT, {}, deps(trace, throwing, seen))).toBe(false)
  expect(trace).toEqual(['push:p2s_published'])
})

test('the step before a draft exists is tab-scoped and carries no draft id', () => {
  const pushed: Array<[string, Record<string, unknown>]> = []
  const d: FunnelDeps = { seen: new Set(), storage: null, push: (n, p) => { pushed.push([n, p]) } }
  fireFunnelOnce('p2s_describe_submitted', SESSION_SCOPE, { chars: 40 }, d)
  fireFunnelOnce('p2s_describe_submitted', SESSION_SCOPE, { chars: 41 }, d)
  fireFunnelOnce('p2s_kept', DRAFT, {}, d)
  expect(pushed).toEqual([['p2s_describe_submitted', { draft_id: null, chars: 40 }], ['p2s_kept', { draft_id: DRAFT }]])
})

function filesBelow(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`
    return statSync(join(ROOT, rel)).isDirectory() ? filesBelow(rel) : /\.tsx?$/.test(name) ? [rel] : []
  })
}

test('every step is wired: each event name is fired by trackFunnel somewhere, and through pushAnalyticsEvent', () => {
  const sources = filesBelow('app').map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n')
  for (const event of P2S_FUNNEL_EVENTS) expect(sources, event).toContain(`trackFunnel('${event}'`)
  const funnel = readFileSync(join(ROOT, 'lib/prompt-to-shop/funnel.ts'), 'utf8')
  expect(funnel).toContain("import { pushAnalyticsEvent } from '../analytics-events'")
  // No step bypasses the guard with a raw push of its own name.
  for (const event of P2S_FUNNEL_EVENTS) expect(sources, event).not.toContain(`pushAnalyticsEvent('${event}'`)
})
