import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyEdit, EDIT_COPY, handleEditDraft, parseEditBody, type EditDeps } from '../lib/prompt-to-shop/edit'
import type { IdentityBlock } from '../lib/prompt-to-shop/blocks'

// Prompt-to-shop S2.4 — PATCH /api/p2s/drafts/[id], the canvas autosave (D15). Driven with fakes that write ONE
// trace; the 409 tests assert the write was ATTEMPTED with the read's `updated_at`, because "returns 409" alone
// would also pass for a handler that never wrote at all.

const DEVICE = '0b9e8c1e-3c2a-4d8e-9a51-6f1f2b3c4d5e'
const OTHER_DEVICE = '9c9c9c9c-3c2a-4d8e-9a51-6f1f2b3c4d5e'
const DRAFT = '7f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607'
const STAMP = '2026-10-28T12:00:00.123456+00:00'

const identity: IdentityBlock = {
  name: 'Tamales La Abuela', tagline: 'Tamales de masa madre', description: 'Hechos a mano.',
  accent_color: '#8a3b12', accent_alternates: ['#1f6f5c', '#2f4b8a', '#6b2f6b'], theme_preset: 'terracota',
}

function fakes(over: Partial<EditDeps> & { row?: Partial<{ identity: IdentityBlock | null; updatedAt: string }> | null; landed?: boolean } = {}) {
  const trace: string[] = []
  const writes: Array<{ expected: string; identity: IdentityBlock }> = []
  const deps: EditDeps = {
    read: async (id, device) => {
      trace.push('read')
      // Ownership is id AND device, as the SQL is: a different device reads nothing.
      if (id !== DRAFT || device !== DEVICE || over.row === null) return null
      return { identity, updatedAt: STAMP, ...over.row }
    },
    write: async (_id, _device, expected, next) => {
      trace.push('write')
      writes.push({ expected, identity: next })
      return over.landed ?? true
    },
    ...(over.read ? { read: over.read } : {}),
    ...(over.write ? { write: over.write } : {}),
  }
  return { deps, trace, writes }
}
const patch = (body: unknown, deps: EditDeps, over: { draftId?: string; deviceCookie?: string | null } = {}) =>
  handleEditDraft({ draftId: over.draftId ?? DRAFT, body, deviceCookie: over.deviceCookie === undefined ? DEVICE : over.deviceCookie }, deps)

test('a rename passes validateIdentity and is written, conditional on the updated_at it read', async () => {
  const { deps, trace, writes } = fakes()
  const res = await patch({ name: '  Tamales Doña Lupe  ' }, deps)
  expect(res.status).toBe(200)
  expect(res.status === 200 && res.body.identity.name).toBe('Tamales Doña Lupe')
  expect(trace).toEqual(['read', 'write'])
  expect(writes[0].expected).toBe(STAMP)
  expect(writes[0].identity).toMatchObject({ name: 'Tamales Doña Lupe', accent_color: '#8a3b12' })
})

test('a name the S1 validator refuses (empty, > 60) is a 400 and nothing is written', async () => {
  for (const name of ['   ', 'x'.repeat(61)]) {
    const { deps, trace } = fakes()
    const res = await patch({ name }, deps)
    expect(res.status, name).toBe(400)
    expect(trace, name).toEqual(['read'])
  }
})

test('picking an alternate accent SWAPS it with the old one, so the merchant can always go back', async () => {
  const { deps, writes } = fakes()
  const res = await patch({ accent_color: '#2f4b8a' }, deps)
  expect(res.status).toBe(200)
  expect(writes[0].identity.accent_color).toBe('#2f4b8a')
  expect(writes[0].identity.accent_alternates).toEqual(['#1f6f5c', '#8a3b12', '#6b2f6b'])
  // Round trip: picking the original again restores the original set.
  const back = applyEdit(writes[0].identity, { accent_color: '#8a3b12' })!
  expect(back.accent_color).toBe('#8a3b12')
  expect([...back.accent_alternates].sort()).toEqual([...identity.accent_alternates].sort())
})

test('an accent that is not the current colour or a stored alternate is refused — even a readable one', async () => {
  const { deps, trace } = fakes()
  expect((await patch({ accent_color: '#005500' }, deps)).status).toBe(400)
  expect((await patch({ accent_color: 'red' }, deps)).status).toBe(400)
  expect(trace).not.toContain('write')
})

test('name and accent can arrive together', () => {
  expect(applyEdit(identity, { name: 'Nueva', accent_color: '#1f6f5c' })).toMatchObject({ name: 'Nueva', accent_color: '#1f6f5c' })
})

test('the write losing the optimistic race is a 409 with the friendly message — not a 200, not a 500', async () => {
  const { deps, trace, writes } = fakes({ landed: false })
  const res = await patch({ name: 'Otra' }, deps)
  expect(res).toEqual({ status: 409, body: { error: EDIT_COPY.conflict, code: 'conflict' } })
  expect(trace).toEqual(['read', 'write'])
  expect(writes).toHaveLength(1)
})

test('a draft that is being regenerated (identity not landed yet) is a 409 and is never written', async () => {
  const { deps, trace } = fakes({ row: { identity: null } })
  expect(await patch({ name: 'Otra' }, deps)).toEqual({ status: 409, body: { error: EDIT_COPY.busy, code: 'busy' } })
  expect(trace).toEqual(['read'])
})

test('another device, a missing cookie, a malformed id and an unknown draft are all the same 404', async () => {
  const cases: Array<[string, Parameters<typeof patch>[2]]> = [
    ['other device', { deviceCookie: OTHER_DEVICE }],
    ['no cookie', { deviceCookie: null }],
    ['forged cookie', { deviceCookie: 'device:../../x' }],
    ['bad id', { draftId: 'not-a-uuid' }],
    ['unknown id', { draftId: '11111111-2222-4333-8444-555555555555' }],
  ]
  for (const [label, over] of cases) {
    const { deps, trace } = fakes()
    const res = await patch({ name: 'X' }, deps, over)
    expect(res, label).toEqual({ status: 404, body: { error: EDIT_COPY.notFound, code: 'notFound' } })
    expect(trace, label).not.toContain('write')
  }
})

test('the body takes exactly name and/or accent_color: an unknown key — a view token, a draft id — is a 400 before any read', async () => {
  for (const body of [{ name: 'X', view_token: DRAFT }, { view_token: DRAFT }, { draft_id: DRAFT, name: 'X' }, {}, [], null, 'x', { name: 5 }]) {
    const { deps, trace } = fakes()
    const res = await patch(body, deps)
    expect(res.status, JSON.stringify(body)).toBe(400)
    expect(trace, JSON.stringify(body)).toEqual([])
  }
  expect(parseEditBody({ name: 'X' })).toEqual({ name: 'X' })
})

test('a database that throws on the write is a 503, never a false «Guardado»', async () => {
  const { deps } = fakes({ write: async () => { throw new Error('db down') } })
  expect(await patch({ name: 'Otra' }, deps)).toEqual({ status: 503, body: { error: EDIT_COPY.unavailable, code: 'unavailable' } })
})

test('the real write is conditional on id, device, unclaimed, unexpired AND updated_at, and reads the row back', () => {
  const src = readFileSync(join(process.cwd(), 'lib', 'prompt-to-shop', 'server.ts'), 'utf8')
  const write = src.slice(src.indexOf('write: async (draftId, deviceId, expectedUpdatedAt, identity)'))
  for (const clause of [".eq('id', draftId)", ".eq('device_id', deviceId)", ".is('claimed_by', null)", ".gt('expires_at'", ".eq('updated_at', expectedUpdatedAt)", ".select('id')"]) {
    expect(write, clause).toContain(clause)
  }
  expect(write).toContain('data.length === 1')
})
