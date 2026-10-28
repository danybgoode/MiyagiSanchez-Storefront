import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { handleCreateDraft, parseDraftsBody, P2S_COPY, sseFrame, type DraftsDeps } from '../lib/prompt-to-shop/handler'
import type { BlockEvent } from '../lib/prompt-to-shop/planner'

// Prompt-to-shop S1.3 + S1.4 — POST /api/p2s/drafts, driven with fakes (epic D7, D8, D11, D12).
//
// Every fake writes to ONE trace, and the refusal tests assert the trace, not only the status: a refusal that
// came after a model call would return the same status and still have spent the money.

const DEVICE = '0b9e8c1e-3c2a-4d8e-9a51-6f1f2b3c4d5e'
const DRAFT = '7f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607'
const DESCRIPTION = 'Vendo tamales de masa madre en Puebla, por pedido'

const goodText = {
  identity: JSON.stringify({ name: 'Tamales La Abuela', tagline: 'Tamales de masa madre', description: 'Hechos a mano.', accent_color: '#8a3b12', accent_alternates: ['#1f6f5c', '#2f4b8a', '#6b2f6b'], theme_preset: 'terracota' }),
  words: JSON.stringify({ announcement: 'Pedidos con un día de anticipación.', headline: 'Como los de casa', about: 'Somos una familia poblana.' }),
  catalog: JSON.stringify({ products: [1, 2, 3, 4].map((n) => ({ title: `Tamal número ${n}`, price: 30 + n, category: 'otros' })) }),
}

type Spend = { data: unknown; error: unknown }

function fakes(over: Partial<DraftsDeps> & { spendAnswer?: Spend; turnstileOk?: boolean } = {}) {
  const trace: string[] = []
  const deps: DraftsDeps = {
    verifyTurnstile: async () => { trace.push('turnstile'); return over.turnstileOk === false ? { ok: false, reason: 'rejected' } : { ok: true } },
    burstAllowed: async () => { trace.push('burst'); return true },
    spend: async () => { trace.push('spend'); return over.spendAnswer ?? { data: { ok: true, reason: null, versions_used: 1 }, error: null } },
    findOwnedDraft: async (id) => { trace.push('find'); return id === DRAFT ? { id: DRAFT, description: DESCRIPTION } : null },
    createDraft: async () => { trace.push('create'); return { id: DRAFT, description: DESCRIPTION } },
    startVersion: async () => { trace.push('version'); return true },
    saveBlock: async (_id, _dev, version, e: BlockEvent) => { trace.push(`save:${e.key}@${version}`); return true },
    refund: async () => { trace.push('refund') },
    callModel: async (req) => { trace.push(`model:${req.block}`); return { ok: true, text: goodText[req.block] } },
    modelConfigured: true,
    newDeviceId: () => DEVICE,
    ...over,
  }
  return { deps, trace }
}

async function drain(result: Awaited<ReturnType<typeof handleCreateDraft>>) {
  const events: Array<{ event: string; data: unknown }> = []
  if (result.kind === 'stream') await result.run((event, data) => events.push({ event, data }))
  return events
}

const body = { description: DESCRIPTION, turnstile_token: 'tok' }

test('a new draft streams exactly three blocks and done, each saved before it is sent', async () => {
  const { deps, trace } = fakes()
  const result = await handleCreateDraft({ body, deviceCookie: undefined }, deps)
  expect(result.kind).toBe('stream')
  expect(result.mintedDevice).toBe(true)
  expect(result.deviceId).toBe(DEVICE)
  const events = await drain(result)
  expect(events.map((e) => e.event)).toEqual(['block', 'block', 'block', 'done'])
  expect(events.slice(0, 3).map((e) => (e.data as BlockEvent).key)).toEqual(['identity', 'words', 'catalog'])
  expect(events[3].data).toEqual({ draft_id: DRAFT, versions_left: 2 })
  expect(trace).toEqual([
    'turnstile', 'burst', 'spend', 'create',
    'model:identity', 'save:identity@1', 'model:words', 'save:words@1', 'model:catalog', 'save:catalog@1',
  ])
})

test('a 4th version is refused with the allowance message and NO model call', async () => {
  const { deps, trace } = fakes({ spendAnswer: { data: { ok: false, reason: 'allowance', versions_used: 3 }, error: null } })
  const result = await handleCreateDraft({ body: { draft_id: DRAFT, turnstile_token: 'tok' }, deviceCookie: DEVICE }, deps)
  expect(result).toMatchObject({ kind: 'refuse', status: 429, message: P2S_COPY.allowance, mintedDevice: false })
  expect(trace).toEqual(['turnstile', 'burst', 'find', 'spend'])
})

test('an exhausted budget closes the box with the come-back-tomorrow message, no model call', async () => {
  const { deps, trace } = fakes({ spendAnswer: { data: { ok: false, reason: 'budget', versions_used: 0 }, error: null } })
  const result = await handleCreateDraft({ body, deviceCookie: DEVICE }, deps)
  expect(result).toMatchObject({ kind: 'refuse', status: 503, message: 'Hoy ya armamos muchas tiendas. Vuelve mañana o déjanos tu correo.' })
  expect(trace).toEqual(['turnstile', 'burst', 'spend'])
})

test('a failed Turnstile refuses before anything else, and creates no draft', async () => {
  const { deps, trace } = fakes({ turnstileOk: false })
  const result = await handleCreateDraft({ body: { description: DESCRIPTION }, deviceCookie: DEVICE }, deps)
  expect(result).toMatchObject({ kind: 'refuse', status: 403, message: P2S_COPY.verify })
  expect(trace).toEqual(['turnstile'])
})

test('a spend the database could not answer refuses (fails closed)', async () => {
  const { deps, trace } = fakes({ spendAnswer: { data: null, error: { message: 'timeout' } } })
  const result = await handleCreateDraft({ body, deviceCookie: DEVICE }, deps)
  expect(result).toMatchObject({ kind: 'refuse', status: 503, error: 'unavailable' })
  expect(trace).toEqual(['turnstile', 'burst', 'spend'])
})

test('no model configured refuses BEFORE an allowance is spent', async () => {
  const { deps, trace } = fakes({ modelConfigured: false })
  const result = await handleCreateDraft({ body, deviceCookie: DEVICE }, deps)
  expect(result).toMatchObject({ kind: 'refuse', status: 503 })
  expect(trace).toEqual(['turnstile', 'burst'])
})

test('a burst-limited device is refused before the spend', async () => {
  const { deps, trace } = fakes({ burstAllowed: async () => { trace.push('burst'); return false } })
  const result = await handleCreateDraft({ body, deviceCookie: DEVICE }, deps)
  expect(result).toMatchObject({ kind: 'refuse', status: 429, error: 'rateLimited' })
  expect(trace).toEqual(['turnstile', 'burst'])
})

test('a re-run of a draft this device does not own costs nothing', async () => {
  const { deps, trace } = fakes()
  const other = '11111111-2222-4333-8444-555555555555'
  const result = await handleCreateDraft({ body: { draft_id: other, turnstile_token: 'tok' }, deviceCookie: DEVICE }, deps)
  expect(result).toMatchObject({ kind: 'refuse', status: 404 })
  expect(trace).toEqual(['turnstile', 'burst', 'find'])
})

test('a new version re-runs the same draft and spends one', async () => {
  const { deps, trace } = fakes({ spendAnswer: { data: { ok: true, reason: null, versions_used: 2 }, error: null } })
  const result = await handleCreateDraft({ body: { draft_id: DRAFT, turnstile_token: 'tok' }, deviceCookie: DEVICE }, deps)
  const events = await drain(result)
  expect(events.at(-1)).toEqual({ event: 'done', data: { draft_id: DRAFT, versions_left: 1 } })
  expect(trace.slice(0, 5)).toEqual(['turnstile', 'burst', 'find', 'spend', 'version'])
  expect(trace).not.toContain('create')
})

test('a forged or malformed cookie is replaced, never trusted', async () => {
  const { deps } = fakes()
  const result = await handleCreateDraft({ body, deviceCookie: 'device:../../admin' }, deps)
  expect(result.mintedDevice).toBe(true)
  expect(result.deviceId).toBe(DEVICE)
})

test('a failed save ends the stream with an error, not a done', async () => {
  const { deps } = fakes({ saveBlock: async (_i, _d, _v, e) => e.key === 'identity' })
  const events = await drain(await handleCreateDraft({ body, deviceCookie: DEVICE }, deps))
  expect(events.map((e) => e.event)).toEqual(['block', 'error'])
})

test('a draft write that fails AFTER the spend refunds it, and never reaches the model', async () => {
  const create = fakes({ createDraft: async () => null })
  const created = await handleCreateDraft({ body, deviceCookie: DEVICE }, create.deps)
  expect(created).toMatchObject({ kind: 'refuse', status: 503, error: 'unavailable' })
  expect(create.trace).toEqual(['turnstile', 'burst', 'spend', 'refund'])

  const rerun = fakes({ startVersion: async () => false })
  await handleCreateDraft({ body: { draft_id: DRAFT, turnstile_token: 'tok' }, deviceCookie: DEVICE }, rerun.deps)
  expect(rerun.trace).toEqual(['turnstile', 'burst', 'find', 'spend', 'refund'])
})

test('a refused request never refunds what it never spent', async () => {
  const { deps, trace } = fakes({ spendAnswer: { data: { ok: false, reason: 'allowance', versions_used: 3 }, error: null } })
  await handleCreateDraft({ body, deviceCookie: DEVICE }, deps)
  expect(trace).not.toContain('refund')
})

test('a phone that hangs up mid-stream still gets every block saved', async () => {
  const { deps, trace } = fakes()
  const result = await handleCreateDraft({ body, deviceCookie: DEVICE }, deps)
  if (result.kind !== 'stream') throw new Error('expected a stream')
  let sent = 0
  // After the first frame the controller is closed: every later send throws, as ReadableStream does.
  await expect(result.run(() => { if (sent++ > 0) throw new TypeError('Invalid state: Controller is already closed') })).resolves.toBeUndefined()
  expect(trace.filter((t) => t.startsWith('save:'))).toEqual(['save:identity@1', 'save:words@1', 'save:catalog@1'])
})

test('a re-run saves under ITS version, so a superseded run cannot write into the newer one', async () => {
  const { deps, trace } = fakes({ spendAnswer: { data: { ok: true, reason: null, versions_used: 3 }, error: null } })
  await drain(await handleCreateDraft({ body: { draft_id: DRAFT, turnstile_token: 'tok' }, deviceCookie: DEVICE }, deps))
  expect(trace.filter((t) => t.startsWith('save:'))).toEqual(['save:identity@3', 'save:words@3', 'save:catalog@3'])
})

test('every function in the migration is revoked from anon and authenticated, not only PUBLIC', () => {
  // Supabase grants EXECUTE on new public functions to anon/authenticated directly; revoking PUBLIC leaves the
  // budget spendable with the browser's anon key. Found by the S1 verifier on a local PG.
  const sql = readFileSync(join(process.cwd(), 'supabase', 'migrations', '20261027120000_prompt_to_shop_drafts.sql'), 'utf8')
  const fns = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1])
  expect(fns.sort()).toEqual(['refund_p2s_generation', 'save_p2s_block', 'spend_ai_allowance', 'spend_p2s_generation'])
  for (const fn of fns) {
    expect(sql, fn).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`))
    expect(sql, fn).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO service_role;`))
  }
  for (const table of ['shop_drafts', 'ai_allowance']) {
    expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`)
    expect(sql).toContain(`REVOKE ALL ON public.${table} FROM anon, authenticated;`)
  }
})

test('body rules: 1–500 characters, a uuid draft id, one of the two', () => {
  expect(parseDraftsBody({ description: 'x'.repeat(500) })).not.toBeNull()
  expect(parseDraftsBody({ description: 'x'.repeat(501) })).toBeNull()
  expect(parseDraftsBody({ description: '   ' })).toBeNull()
  expect(parseDraftsBody({})).toBeNull()
  expect(parseDraftsBody({ draft_id: 'not-a-uuid' })).toBeNull()
  expect(parseDraftsBody({ draft_id: DRAFT })).toMatchObject({ draftId: DRAFT, description: null })
  expect(parseDraftsBody([DESCRIPTION])).toBeNull()
})

test('an SSE frame keeps model newlines inside one data line', () => {
  expect(sseFrame('block', { text: 'a\nb' })).toBe('event: block\ndata: {"text":"a\\nb"}\n\n')
})

test('the route stays dynamic, private, and out of Medusa', () => {
  const route = readFileSync(join(process.cwd(), 'app', 'api', 'p2s', 'drafts', 'route.ts'), 'utf8')
  expect(route).toContain("export const dynamic = 'force-dynamic'")
  expect(route).toContain("'private, no-store'")
  expect(route).toContain('HttpOnly; Secure; SameSite=Lax')
  // The draft is not commerce until S3.2 claims it: no Medusa client anywhere in the rail.
  for (const file of ['handler.ts', 'planner.ts', 'blocks.ts', 'prompts.ts', 'server.ts', 'allowance.ts', 'turnstile.ts']) {
    const src = readFileSync(join(process.cwd(), 'lib', 'prompt-to-shop', file), 'utf8')
    expect(src, file).not.toMatch(/lib\/medusa|@medusajs/)
  }
  expect(route).not.toMatch(/lib\/medusa|@medusajs/)
})
