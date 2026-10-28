import { expect, test } from '@playwright/test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { controlsFor, resolveOwnerPage, resolveViewerPage, viewHref, type ReadDeps, type OwnedDraftRow, type SharedDraftRow } from '../lib/prompt-to-shop/access'
import { handleEditDraft, type EditDeps } from '../lib/prompt-to-shop/edit'
import { handleCreateDraft, type DraftsDeps } from '../lib/prompt-to-shop/handler'
import { fallbackCatalog, fallbackIdentity, fallbackWords } from '../lib/prompt-to-shop/blocks'

// Prompt-to-shop S2.5 — the view-only link (D15, HIGH risk). The rule: a request that carries ONLY a view token can
// look, and nothing else. Held three ways: (1) behaviourally, with fakes that resolve rows the way the SQL does
// (a re-run / an edit / a read each keyed on what the real query is keyed on); (2) structurally, a source sweep
// proving no mutating path mentions the token at all; (3) at the page seam, via a pure `controlsFor`.

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const DEVICE = '0b9e8c1e-3c2a-4d8e-9a51-6f1f2b3c4d5e'
const DRAFT = '7f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607'
const TOKEN = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const STAMP = '2026-10-28T12:00:00.123456+00:00'
const identity = fallbackIdentity('Vendo tamales')

/** A one-row database: ownership is id AND device; viewing is the token alone. Exactly the real WHERE clauses. */
function db() {
  const row: OwnedDraftRow & { device_id: string } = {
    id: DRAFT, device_id: DEVICE, view_token: TOKEN, identity, words: fallbackWords(identity), catalog: fallbackCatalog(),
    block_status: { identity: 'ok', words: 'ok', catalog: 'ok' }, versions_used: 1, updated_at: STAMP,
  }
  const trace: string[] = []
  const reads: ReadDeps = {
    findOwned: async (id, device) => { trace.push('findOwned'); return id === row.id && device === row.device_id ? row : null },
    findByViewToken: async (token): Promise<SharedDraftRow | null> => { trace.push('findByViewToken'); return token === row.view_token ? { identity: row.identity, words: row.words, catalog: row.catalog, block_status: row.block_status } : null },
  }
  const edits: EditDeps = {
    read: async (id, device) => { trace.push('edit.read'); return id === row.id && device === row.device_id ? { identity, updatedAt: STAMP } : null },
    write: async () => { trace.push('edit.write'); return true },
  }
  const drafts = (): DraftsDeps => ({
    verifyTurnstile: async () => { trace.push('turnstile'); return { ok: true } },
    burstAllowed: async () => { trace.push('burst'); return true },
    spend: async () => { trace.push('spend'); return { data: { ok: true, reason: null, versions_used: 2 }, error: null } },
    findOwnedDraft: async (id, device) => { trace.push('find'); return id === row.id && device === row.device_id ? { id: row.id, description: 'x' } : null },
    createDraft: async () => { trace.push('create'); return { id: row.id, description: 'x' } },
    startVersion: async () => { trace.push('version'); return true },
    saveBlock: async () => { trace.push('save'); return true },
    refund: async () => { trace.push('refund') },
    callModel: async () => { trace.push('model'); return { ok: false } },
    modelConfigured: true,
    newDeviceId: () => '55555555-5555-4555-8555-555555555555',
  })
  return { trace, reads, edits, drafts }
}

test('a view token opens the shop read-only: no controls, and nothing in the result can be used to change it', async () => {
  const { reads } = db()
  const res = await resolveViewerPage({ token: TOKEN }, reads)
  expect(res.kind).toBe('ok')
  if (res.kind !== 'ok') return
  expect(res.access).toEqual({ kind: 'viewer' })
  expect(controlsFor(res.access)).toEqual([])
  // The viewer's result carries the shop's content and NO identifier an edit, a version or a claim could be built from.
  const wire = JSON.stringify(res)
  for (const secret of [DRAFT, DEVICE, TOKEN]) expect(wire).not.toContain(secret)
  expect(res.blocks.identity?.name).toBe(identity.name)
})

test('the owner has the five controls; they are the ONLY controls that exist', async () => {
  const { reads } = db()
  const res = await resolveOwnerPage({ id: DRAFT, deviceCookie: DEVICE }, reads)
  expect(res.kind).toBe('ok')
  if (res.kind !== 'ok') return
  expect(controlsFor(res.access)).toEqual(['rename', 'accent', 'version', 'share', 'keep'])
  expect(res.viewToken).toBe(TOKEN)
  expect(viewHref(res.viewToken)).toBe(`/p2s/v/${TOKEN}`)
})

test('a view token cannot open the OWNER route — as the id, or as the device cookie', async () => {
  const { reads } = db()
  expect(await resolveOwnerPage({ id: TOKEN, deviceCookie: DEVICE }, reads)).toEqual({ kind: 'gone' })
  expect(await resolveOwnerPage({ id: DRAFT, deviceCookie: TOKEN }, reads)).toEqual({ kind: 'gone' })
  expect(await resolveOwnerPage({ id: DRAFT, deviceCookie: undefined }, reads)).toEqual({ kind: 'gone' })
  // …and the draft id is not a view token either.
  expect(await resolveViewerPage({ token: DRAFT }, reads)).toEqual({ kind: 'gone' })
  expect(await resolveViewerPage({ token: 'not-a-uuid' }, reads)).toEqual({ kind: 'gone' })
})

test('a request with only the view token cannot EDIT: every shape of it is refused and nothing is written', async () => {
  const shapes: Array<[string, Parameters<typeof handleEditDraft>[0]]> = [
    ['token as the draft id', { draftId: TOKEN, body: { name: 'Hackeado' }, deviceCookie: DEVICE }],
    ['token as the device cookie', { draftId: DRAFT, body: { name: 'Hackeado' }, deviceCookie: TOKEN }],
    ['no cookie at all', { draftId: DRAFT, body: { name: 'Hackeado' }, deviceCookie: undefined }],
    ['token smuggled in the body', { draftId: DRAFT, body: { name: 'Hackeado', view_token: TOKEN }, deviceCookie: undefined }],
    ['token as the only body field', { draftId: DRAFT, body: { view_token: TOKEN }, deviceCookie: undefined }],
  ]
  for (const [label, input] of shapes) {
    const { trace, edits } = db()
    const res = await handleEditDraft(input, edits)
    expect([400, 404], label).toContain(res.status)
    expect(trace, label).not.toContain('edit.write')
  }
})

test('a request with only the view token cannot make a VERSION: no spend, no model, no draft touched', async () => {
  const shapes: Array<[string, { body: unknown; deviceCookie: string | undefined }]> = [
    ['token as the draft id', { body: { draft_id: TOKEN, turnstile_token: 't' }, deviceCookie: DEVICE }],
    ['token as the device cookie', { body: { draft_id: DRAFT, turnstile_token: 't' }, deviceCookie: TOKEN }],
    ['a viewer with their own device', { body: { draft_id: DRAFT, view_token: TOKEN, turnstile_token: 't' }, deviceCookie: '66666666-6666-4666-8666-666666666666' }],
    ['no cookie', { body: { draft_id: DRAFT, view_token: TOKEN, turnstile_token: 't' }, deviceCookie: undefined }],
  ]
  for (const [label, input] of shapes) {
    const { trace, drafts } = db()
    const res = await handleCreateDraft(input, drafts())
    expect(res, label).toMatchObject({ kind: 'refuse', status: 404 })
    expect(trace, label).toEqual(['turnstile', 'burst', 'find'])
    for (const effect of ['spend', 'version', 'create', 'model', 'save']) expect(trace, `${label}: ${effect}`).not.toContain(effect)
  }
})

test('no route that claims, versions or edits exists for a view token: the token appears in NO mutating source file', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  const TOKEN_WORD = /view_token|(?<![A-Za-z])viewToken|[A-Za-z]ViewToken|(?<![A-Za-z])ViewToken|(?<![A-Za-z])view-token/
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = join(dir, name)
      if (name === 'node_modules' || name === '.next') continue
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel)
      else if (/\.(ts|tsx)$/.test(name) && TOKEN_WORD.test(strip(read(rel)))) hits.push(relative('.', rel))
    }
  }
  for (const dir of ['app', 'lib']) walk(dir)
  hits.push(...(TOKEN_WORD.test(strip(read('middleware.ts'))) ? ['middleware.ts'] : []))
  // The WHOLE allow-list: the pure resolution + the one database reader + the two pages that hand it to them.
  expect(hits.sort()).toEqual([
    'app/(shell)/p2s/[id]/page.tsx',
    'lib/prompt-to-shop/access.ts',
    'lib/prompt-to-shop/read.ts',
  ])
  // The sweep can fail: a mutating module that grew a token branch would be caught by the same pattern.
  expect(TOKEN_WORD.test(strip('const t = body.view_token'))).toBe(true)
  expect(TOKEN_WORD.test(strip('findByViewToken(x)'))).toBe(true)
  expect(TOKEN_WORD.test(strip('// view_token only in a comment'))).toBe(false)
  expect(TOKEN_WORD.test(strip('const p = previewToken'))).toBe(false)
})

test('the mutating routes read the device cookie and nothing else: no query string, no header, no token', () => {
  for (const file of ['app/api/p2s/drafts/route.ts', 'app/api/p2s/drafts/[id]/route.ts']) {
    const src = read(file)
    expect(src, file).toContain('DEVICE_COOKIE')
    expect(src, file).not.toMatch(/searchParams|nextUrl|headers\.get|\.headers\[/)
  }
})

test('the view-only page imports no editing component, reads no cookie, and passes no toolbar', () => {
  const page = read('app/(shell)/p2s/v/[token]/page.tsx').replace(/\/\*[\s\S]*?\*\//g, '')
  expect(page).toContain('resolveViewerPage')
  expect(page).toContain('mode="viewer"')
  expect(page).not.toMatch(/OwnerCanvas|TakingShape|TurnstileWidget|toolbar|cookies\(|DEVICE_COOKIE|handleEditDraft|handleCreateDraft/)
  expect(page).toContain("export const dynamic = 'force-dynamic'")
  expect(page).toContain('robots: { index: false, follow: false }')
  // The owner page, by contrast, takes its controls from the pure function and nowhere else.
  const owner = read('app/(shell)/p2s/[id]/page.tsx')
  expect(owner).toContain('controls={controlsFor(resolved.access)}')
})

test('the viewer read selects content only, never filters on claim (a kept draft still shows), and expires with the draft', () => {
  const src = read('lib/prompt-to-shop/read.ts')
  const shared = src.slice(src.indexOf('findByViewToken'))
  const columns = src.match(/SHARED_COLUMNS = '([^']+)'/)![1]
  expect(columns.split(',').map((c) => c.trim())).toEqual(['identity', 'words', 'catalog', 'block_status'])
  expect(shared).toContain(".eq('view_token', token)")
  expect(shared).toContain(".gt('expires_at'")
  expect(shared).not.toContain('claimed_by')
  // The owner read is the one that is conditional on id, device AND not-claimed.
  const owned = src.slice(src.indexOf('findOwned'), src.indexOf('findByViewToken'))
  for (const clause of [".eq('id', draftId)", ".eq('device_id', deviceId)", ".is('claimed_by', null)", ".gt('expires_at'"]) expect(owned, clause).toContain(clause)
})

test('the share button copies the view-only path the server built, and shows no other way to the draft', () => {
  const owner = read('app/(shell)/p2s/_components/OwnerCanvas.tsx')
  expect(owner).toContain('${window.location.origin}${shareHref}')
  expect(read('app/(shell)/p2s/[id]/page.tsx')).toContain('shareHref={viewHref(resolved.viewToken)}')
  expect(viewHref(TOKEN)).toMatch(/^\/p2s\/v\/[0-9a-f-]{36}$/)
})
