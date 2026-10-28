import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PUBLISH_COPY } from '../lib/prompt-to-shop/copy'
import { handlePublish, planPublish, type ActivateResult, type PublishDeps, type PublishListing } from '../lib/prompt-to-shop/publish'

// Prompt-to-shop S5.2 — «Publicar». It touches REAL products only (the merchant's own Medusa drafts), never an
// example (examples are not Medusa products), never a paused or deleted product, and it goes through the catalog's
// own activate (`setListingStatus`) one product at a time. Every effect lands in one trace; the specs assert ORDER.

const ROOT = process.cwd()
const DRAFT = '7f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607'
const OWNER = { kind: 'ok' as const, draftId: DRAFT, sellerId: 'sel_01', shopName: 'Tamales' }

function harness(opts: {
  listings?: PublishListing[] | null
  deleted?: string[]
  owner?: Awaited<ReturnType<PublishDeps['resolveOwner']>>
  activate?: (id: string) => ActivateResult
} = {}) {
  const trace: string[] = []
  const deps: PublishDeps = {
    resolveOwner: async () => { trace.push('owner'); return opts.owner ?? OWNER },
    listProducts: async () => { trace.push('list'); return opts.listings === undefined ? [] : opts.listings },
    deletedIds: async () => { trace.push('deleted'); return new Set(opts.deleted ?? []) },
    activate: async (id) => { trace.push(`activate:${id}`); return opts.activate ? opts.activate(id) : { ok: true } },
    log: () => {},
  }
  return { trace, deps }
}

test('the plan is the unpublished real products only: not paused, not live, not deleted', () => {
  const listings: PublishListing[] = [
    { id: 'prod_a', status: 'draft' },
    { id: 'prod_b', status: 'active' },
    { id: 'prod_c', status: 'paused' },
    { id: 'prod_d', status: 'draft' },
    { id: 'prod_e', status: 'proposed' },
  ]
  expect(planPublish(listings, new Set())).toEqual(['prod_a', 'prod_d'])
  expect(planPublish(listings, new Set(['prod_d']))).toEqual(['prod_a'])
})

test('order: owner → products → plan → one activation at a time, and only the planned ones', async () => {
  const { trace, deps } = harness({ listings: [{ id: 'prod_a', status: 'draft' }, { id: 'prod_b', status: 'active' }, { id: 'prod_c', status: 'paused' }, { id: 'prod_d', status: 'draft' }] })
  const r = await handlePublish(deps)
  expect(trace).toEqual(['owner', 'list', 'deleted', 'activate:prod_a', 'activate:prod_d'])
  expect(r).toEqual({ status: 200, body: { ok: true, published: 2, live: 3, message: PUBLISH_COPY.done(3) } })
})

test('examples are never published: they are not in the product list, so nothing names them', async () => {
  // The kept draft still carries examples in its catalog; «Publicar» reads Medusa's list, which has none of them.
  const { trace, deps } = harness({ listings: [{ id: 'prod_real', status: 'draft' }] })
  await handlePublish(deps)
  expect(trace.filter((t) => t.startsWith('activate:'))).toEqual(['activate:prod_real'])
  const src = readFileSync(join(ROOT, 'lib/prompt-to-shop/publish.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  expect(src).not.toMatch(/catalog|example/i)
})

test('the route activates through the catalog\'s own in-process function, never over HTTP', () => {
  const route = readFileSync(join(ROOT, 'app/api/p2s/publish/route.ts'), 'utf8')
  expect(route).toContain("setListingStatus(productId, 'active', { userId, clerkJwt })")
  expect(route).toContain('resolvePhotoOwner(userId, clerkJwt)')
  expect(route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')).not.toMatch(/fetch\(/)
})

test('the first viability refusal stops the run: one reason, no further writes', async () => {
  const { trace, deps } = harness({
    listings: [{ id: 'p1', status: 'draft' }, { id: 'p2', status: 'draft' }, { id: 'p3', status: 'draft' }],
    activate: (id) => (id === 'p2' ? { ok: false, status: 422, error: 'Configura un método de pago.' } : { ok: true }),
  })
  const r = await handlePublish(deps)
  expect(trace).toEqual(['owner', 'list', 'deleted', 'activate:p1', 'activate:p2'])
  expect(r).toEqual({ status: 422, body: { ok: false, error: 'blocked', message: 'Configura un método de pago.', published: 1 } })
})

test('another failure skips that product and carries on; all failing is a failure', async () => {
  const some = harness({ listings: [{ id: 'p1', status: 'draft' }, { id: 'p2', status: 'draft' }], activate: (id) => (id === 'p1' ? { ok: false, status: 500, error: 'x' } : { ok: true }) })
  const r1 = await handlePublish(some.deps)
  expect(some.trace).toEqual(['owner', 'list', 'deleted', 'activate:p1', 'activate:p2'])
  expect(r1.body).toEqual({ ok: true, published: 1, live: 1, message: PUBLISH_COPY.partial(1, 1) })

  const none = harness({ listings: [{ id: 'p1', status: 'draft' }], activate: () => ({ ok: false, status: 500, error: 'x' }) })
  expect((await handlePublish(none.deps)).status).toBe(502)
})

test('no owner, an unreadable list or nothing of their own writes nothing', async () => {
  const noShop = harness({ owner: { kind: 'none' } })
  expect((await handlePublish(noShop.deps)).status).toBe(404)
  expect(noShop.trace).toEqual(['owner'])

  const down = harness({ owner: { kind: 'unavailable' } })
  expect((await handlePublish(down.deps)).status).toBe(503)
  expect(down.trace).toEqual(['owner'])

  const unread = harness({ listings: null })
  expect((await handlePublish(unread.deps)).body).toMatchObject({ ok: false, error: 'unavailable' })
  expect(unread.trace).toEqual(['owner', 'list'])

  const empty = harness({ listings: [] })
  expect((await handlePublish(empty.deps))).toEqual({ status: 409, body: { ok: false, error: 'needs_product', message: PUBLISH_COPY.needsProduct } })
  expect(empty.trace).not.toContain('activate')
})

test('a second tap after everything is live is a quiet success, not a second write', async () => {
  const { trace, deps } = harness({ listings: [{ id: 'p1', status: 'active' }, { id: 'p2', status: 'paused' }] })
  expect(await handlePublish(deps)).toEqual({ status: 200, body: { ok: true, published: 0, live: 1, message: PUBLISH_COPY.done(1) } })
  expect(trace.some((t) => t.startsWith('activate:'))).toBe(false)
})
