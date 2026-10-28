import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSseFrames, patchDraft, runDraftRequest } from '../lib/prompt-to-shop/client'
import { NARRATION, SHAPING_COPY } from '../lib/prompt-to-shop/copy'
import { sseFrame } from '../lib/prompt-to-shop/handler'
import type { BlockEvent } from '../lib/prompt-to-shop/planner'

// Prompt-to-shop S2.3 — the taking-shape screen's stream reader (epic D11). EventSource cannot POST, so the browser
// reads the SSE body itself; the parse is pure and the fetch is injected.

const DRAFT = '7f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607'
const identity = { key: 'identity', status: 'ok', data: { name: 'Tamales La Abuela' } } as unknown as BlockEvent
const words = { key: 'words', status: 'fallback', data: { headline: 'Hola' } } as unknown as BlockEvent
const enc = new TextEncoder()

/** A response whose body yields the given chunks one pull at a time, recording when each is handed out. */
function streamed(chunks: string[], trace: string[]): Response {
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) return controller.close()
      trace.push(`chunk${i}`)
      controller.enqueue(enc.encode(chunks[i++]))
    },
  }, { highWaterMark: 0 }) // pull only when the reader asks, so the trace shows what the reader had at each moment
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

test('frames split across chunks are reassembled; the unfinished tail waits', () => {
  const whole = sseFrame('block', identity) + sseFrame('done', { draft_id: DRAFT, versions_left: 2 })
  const cut = Math.floor(whole.length / 3)
  const first = parseSseFrames(whole.slice(0, cut))
  expect(first.frames).toEqual([])
  const second = parseSseFrames(first.rest + whole.slice(cut))
  expect(second.frames.map((f) => f.event)).toEqual(['block', 'done'])
  expect(second.rest).toBe('')
})

test('CRLF framing, a malformed frame and an unknown event are tolerated, not fatal', () => {
  const raw = 'event: block\r\ndata: {"key":"identity"}\r\n\r\nevent: block\ndata: {not json\n\nevent: ping\ndata: {}\n\n' + sseFrame('done', { draft_id: DRAFT, versions_left: 1 })
  expect(parseSseFrames(raw).frames.map((f) => f.event)).toEqual(['block', 'done'])
})

test('a block is handed to the screen as soon as ITS chunk arrives, before the stream ends', async () => {
  const trace: string[] = []
  const res = streamed([sseFrame('block', identity), sseFrame('block', words), sseFrame('done', { draft_id: DRAFT, versions_left: 2 })], trace)
  const outcome = await runDraftRequest(
    { description: 'x', turnstile_token: 't' },
    (e) => trace.push(`block:${e.key}`),
    { fetch: async () => res },
  )
  expect(outcome).toEqual({ kind: 'done', draftId: DRAFT, versionsLeft: 2 })
  // Each block surfaced before the NEXT chunk was even requested: the narration fills progressively.
  expect(trace.indexOf('block:identity')).toBeLessThan(trace.indexOf('chunk1'))
  expect(trace.indexOf('block:words')).toBeLessThan(trace.indexOf('chunk2'))
})

test('a refusal shows the server\'s message VERBATIM and carries its code', async () => {
  const message = 'Ya usaste tus 3 versiones. Quédate con la que más te guste.'
  const res = new Response(JSON.stringify({ error: message, code: 'allowance' }), { status: 429, headers: { 'Content-Type': 'application/json' } })
  const blocks: string[] = []
  const outcome = await runDraftRequest({ draft_id: DRAFT, turnstile_token: 't' }, (e) => blocks.push(e.key), { fetch: async () => res })
  expect(outcome).toEqual({ kind: 'refused', message, code: 'allowance' })
  expect(blocks).toEqual([])
})

test('a refusal with no usable body, a thrown fetch and a stream that dies are all plain failures', async () => {
  const noBody = await runDraftRequest({ description: 'x', turnstile_token: 't' }, () => {}, { fetch: async () => new Response('<html>', { status: 502 }) })
  expect(noBody).toEqual({ kind: 'refused', message: SHAPING_COPY.broken, code: undefined })
  const thrown = await runDraftRequest({ description: 'x', turnstile_token: 't' }, () => {}, { fetch: async () => { throw new TypeError('offline') } })
  expect(thrown).toEqual({ kind: 'failed', message: SHAPING_COPY.broken })
  // Two blocks arrive, then the connection ends without `done`: that is NOT a finished shop.
  const cut = await runDraftRequest({ description: 'x', turnstile_token: 't' }, () => {}, { fetch: async () => streamed([sseFrame('block', identity)], []) })
  expect(cut).toEqual({ kind: 'failed', message: SHAPING_COPY.broken })
})

test('a server `error` event ends the run with its message', async () => {
  const res = streamed([sseFrame('block', identity), sseFrame('error', { message: 'No pudimos armar tu tienda ahora. Inténtalo de nuevo en un momento.' })], [])
  const seen: string[] = []
  const outcome = await runDraftRequest({ description: 'x', turnstile_token: 't' }, (e) => seen.push(e.key), { fetch: async () => res })
  expect(outcome).toEqual({ kind: 'failed', message: 'No pudimos armar tu tienda ahora. Inténtalo de nuevo en un momento.' })
  expect(seen).toEqual(['identity'])
})

test('the request is a same-origin JSON POST carrying the one-shot token', async () => {
  let seen: { url: string; init: RequestInit } | null = null
  await runDraftRequest({ description: 'x', turnstile_token: 'tok' }, () => {}, {
    fetch: async (url, init) => { seen = { url: String(url), init: init! }; return streamed([sseFrame('done', { draft_id: DRAFT, versions_left: 2 })], []) },
  })
  expect(seen!.url).toBe('/api/p2s/drafts')
  expect(seen!.init.method).toBe('POST')
  expect(seen!.init.credentials).toBe('same-origin')
  expect(JSON.parse(String(seen!.init.body))).toEqual({ description: 'x', turnstile_token: 'tok' })
})

test('narration: four lines in the contract\'s order, name and colours both come from the identity block', () => {
  expect(NARRATION.map((n) => n.label)).toEqual(['Nombre', 'Colores', 'Textos', 'Productos de ejemplo'])
  expect(NARRATION.map((n) => n.key)).toEqual(['identity', 'identity', 'words', 'catalog'])
})

test('the screen reads the stream itself (no EventSource), starts once, and rides the real canvas', () => {
  const src = readFileSync(join(process.cwd(), 'app', '(shell)', 'p2s', '_components', 'TakingShape.tsx'), 'utf8')
  expect(src).not.toContain('EventSource')
  expect(src).toContain('runDraftRequest(')
  // Two dev mounts must not mean two spent versions.
  expect(src).toContain('if (started.current) return')
  expect(src).toContain('<ShopCanvas view={view} mode="shaping" />')
  expect(src).toContain('router.push(`/p2s/${outcome.draftId}`)')
  // A pending line renders before any block lands: the narration does not wait for the network.
  expect(src).toContain('`${line.label}…`')
})

test('an autosave is a same-origin JSON PATCH to the draft, and success hands back the stored identity', async () => {
  let seen: { url: string; init: RequestInit } | null = null
  const identity = { name: 'Nueva' }
  const out = await patchDraft(DRAFT, { name: 'Nueva' }, {
    fetch: async (url, init) => { seen = { url: String(url), init: init! }; return new Response(JSON.stringify({ ok: true, identity }), { status: 200 }) },
  })
  expect(out).toEqual({ ok: true, identity })
  expect(seen!.url).toBe(`/api/p2s/drafts/${DRAFT}`)
  expect(seen!.init.method).toBe('PATCH')
  expect(seen!.init.credentials).toBe('same-origin')
  expect(JSON.parse(String(seen!.init.body))).toEqual({ name: 'Nueva' })
})

test('a rejected or lost autosave is a failure carrying the server\'s own message — never a silent «Guardado»', async () => {
  const conflict = 'Tu tienda cambió mientras guardábamos. Recarga la página para ver la última versión.'
  const rejected = await patchDraft(DRAFT, { name: 'X' }, { fetch: async () => new Response(JSON.stringify({ error: conflict, code: 'conflict' }), { status: 409 }) })
  expect(rejected).toEqual({ ok: false, status: 409, message: conflict })
  // A 200 whose body does not confirm the save is not a save.
  const unconfirmed = await patchDraft(DRAFT, { name: 'X' }, { fetch: async () => new Response('{}', { status: 200 }) })
  expect(unconfirmed.ok).toBe(false)
  const noOk = await patchDraft(DRAFT, { name: 'X' }, { fetch: async () => new Response(JSON.stringify({ identity: { name: 'X' } }), { status: 200 }) })
  expect(noOk.ok).toBe(false)
  const offline = await patchDraft(DRAFT, { name: 'X' }, { fetch: async () => { throw new TypeError('offline') } })
  expect(offline).toMatchObject({ ok: false, status: 0 })
})
