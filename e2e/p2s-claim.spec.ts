import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { claimAndApply, manifestFrom, shopInputFrom, type ClaimDeps, type ClaimRow, type SellerLookup } from '../lib/prompt-to-shop/claim'
import { fallbackCatalog, fallbackIdentity, fallbackWords } from '../lib/prompt-to-shop/blocks'
import { CLAIM_RETRY } from '../lib/prompt-to-shop/copy'

// Prompt-to-shop S3.2 — the keep (D16, HIGH risk). The fakes below behave like the real queries: `claim` lands only
// when id AND device match, the draft is unclaimed, unexpired and has an identity (the SQL WHERE); `ensureShop` is
// create-or-get per user (the backend's lock), and it sends the welcome only on a CREATE (the 201 path into the
// reserve-once delivery). Every effect is recorded in one trace, and the specs assert its ORDER, not only the answer.

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const DRAFT = '7f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607'
const DEVICE = '0b9e8c1e-3c2a-4d8e-9a51-6f1f2b3c4d5e'
const OTHER_DEVICE = '66666666-6666-4666-8666-666666666666'
const USER = 'user_owner'
const OTHER_USER = 'user_stranger'
const NOW = new Date('2026-10-28T12:00:00Z')
const identity = { ...fallbackIdentity('Vendo tamales de masa madre en Puebla'), city: 'Puebla', state: 'Puebla' }
const words = fallbackWords(identity)

type World = ReturnType<typeof world>

function world(opts: { expired?: boolean; noIdentity?: boolean; claimedBy?: string; sellers?: Record<string, { id: string; slug: string }>; failApplyOnce?: boolean; failShopOnce?: boolean; failMarkOnce?: boolean; sellerLookup?: 'unavailable' } = {}) {
  const trace: string[] = []
  const manifests: unknown[] = []
  const row: ClaimRow & { catalog: unknown } = {
    id: DRAFT,
    device_id: DEVICE,
    identity: opts.noIdentity ? null : identity,
    words,
    catalog: fallbackCatalog(),
    claimed_by: opts.claimedBy ?? null,
    claimed_seller_id: null,
    expires_at: opts.expired ? '2026-10-27T12:00:00Z' : '2026-11-03T12:00:00Z',
  }
  const sellers: Record<string, { id: string; slug: string }> = { ...(opts.sellers ?? {}) }
  let failApply = !!opts.failApplyOnce
  let failShop = !!opts.failShopOnce
  let failMark = !!opts.failMarkOnce
  const snapshot = (): ClaimRow => ({ ...row })

  const deps = (userId: string): ClaimDeps => ({
    findSeller: async (): Promise<SellerLookup> => {
      trace.push('findSeller')
      if (opts.sellerLookup === 'unavailable') return { state: 'unavailable' }
      return sellers[userId] ? { state: 'present', seller: sellers[userId] } : { state: 'absent' }
    },
    claim: async (id, device, user) => {
      trace.push('claim')
      const ok = id === row.id && device === row.device_id && row.claimed_by === null && new Date(row.expires_at) > NOW && row.identity !== null
      if (!ok) return null
      row.claimed_by = user
      return snapshot()
    },
    reread: async (id) => {
      trace.push('reread')
      return id === row.id ? snapshot() : null
    },
    ensureShop: async (input) => {
      trace.push('ensureShop')
      if (failShop) { failShop = false; return { ok: false, status: 500, error: 'down' } }
      const existing = sellers[userId]
      if (existing) return { ok: true, status: 200, shopSlug: existing.slug, sellerId: existing.id }
      const created = { id: `sel_${Object.keys(sellers).length + 1}`, slug: (input.name ?? 'tienda').toLowerCase().replace(/\s+/g, '-') }
      sellers[userId] = created
      trace.push('welcome')
      return { ok: true, status: 201, shopSlug: created.slug, sellerId: created.id }
    },
    applyConfig: async (manifest) => {
      trace.push('applyConfig')
      manifests.push(manifest)
      if (failApply) { failApply = false; return { ok: false, error: 'down' } }
      return { ok: true }
    },
    markSeller: async (id, user, sellerId) => {
      trace.push('markSeller')
      if (failMark) { failMark = false; return false }
      if (id !== row.id || row.claimed_by !== user) return false
      row.claimed_seller_id = sellerId
      return true
    },
    revalidate: () => { trace.push('revalidate') },
    now: () => NOW,
  })
  return { trace, manifests, row, sellers, deps }
}

const keep = (w: World, who: { userId?: string | null; device?: string | null; draftId?: string } = {}) =>
  claimAndApply(
    { draftId: who.draftId ?? DRAFT, deviceCookie: who.device === undefined ? DEVICE : who.device, userId: who.userId === undefined ? USER : who.userId },
    w.deps(who.userId ?? USER),
  )

test('one owner: seller looked up, then the claim, then the shop, the config and the done marker — in that order', async () => {
  const w = world()
  const res = await keep(w)
  expect(res).toEqual({ kind: 'kept', draftId: DRAFT, shopSlug: identity.name.toLowerCase().replace(/\s+/g, '-'), resumed: false })
  expect(w.trace).toEqual(['findSeller', 'claim', 'ensureShop', 'welcome', 'applyConfig', 'markSeller', 'revalidate'])
  expect(w.row.claimed_by).toBe(USER)
  expect(w.row.claimed_seller_id).toBe('sel_1')
})

test('a reload or a second tab returns the SAME shop: no second seller, no second welcome, nothing re-applied', async () => {
  const w = world()
  await keep(w)
  const first = w.trace.length
  const again = await keep(w)
  const third = await keep(w)
  expect(again).toMatchObject({ kind: 'kept', shopSlug: w.sellers[USER].slug, resumed: true })
  expect(third).toMatchObject({ kind: 'kept', shopSlug: w.sellers[USER].slug, resumed: true })
  // A finished keep is read, never redone: the seller exists, so no claim is even attempted.
  expect(w.trace.slice(first)).toEqual(['findSeller', 'reread', 'findSeller', 'reread'])
  expect(Object.keys(w.sellers)).toEqual([USER])
  expect(w.trace.filter((e) => e === 'welcome')).toHaveLength(1)
  expect(w.trace.filter((e) => e === 'applyConfig')).toHaveLength(1)
})

test('two tabs racing: the loser resumes the winner’s keep and converges on one seller and one welcome', async () => {
  const w = world()
  // Tab B claims first; tab A's claim then matches nothing and the re-read shows the draft is A's own user's.
  const [a, b] = await Promise.all([keep(w), keep(w)])
  expect(a.kind).toBe('kept')
  expect(b.kind).toBe('kept')
  expect(Object.keys(w.sellers)).toEqual([USER])
  expect(w.trace.filter((e) => e === 'welcome')).toHaveLength(1)
  expect(w.trace.filter((e) => e === 'claim').length).toBeGreaterThanOrEqual(1)
  expect(w.row.claimed_seller_id).toBe('sel_1')
})

test('another phone holding the link is refused with ZERO apply calls', async () => {
  const w = world()
  const res = await keep(w, { device: OTHER_DEVICE })
  expect(res).toEqual({ kind: 'other_phone' })
  expect(w.trace).toEqual(['findSeller', 'claim', 'reread'])
  expect(w.row.claimed_by).toBeNull()
})

test('no device cookie at all: no claim is attempted, and the answer is the same refusal', async () => {
  const w = world()
  expect(await keep(w, { device: null })).toEqual({ kind: 'other_phone' })
  expect(w.trace).toEqual(['findSeller', 'reread'])
})

test('claim before apply: a draft another account kept is refused, even from the phone that made it, and nothing is applied', async () => {
  const w = world({ claimedBy: OTHER_USER })
  const res = await keep(w)
  expect(res).toEqual({ kind: 'other_phone' })
  expect(w.trace).toEqual(['findSeller', 'claim', 'reread'])
  for (const effect of ['ensureShop', 'applyConfig', 'markSeller', 'welcome', 'revalidate']) expect(w.trace).not.toContain(effect)
  expect(w.row.claimed_by).toBe(OTHER_USER)
})

test('an expired draft is refused and stays unclaimed', async () => {
  const w = world({ expired: true })
  expect(await keep(w)).toEqual({ kind: 'other_phone' })
  expect(w.trace).toEqual(['findSeller', 'claim', 'reread'])
  expect(w.row.claimed_by).toBeNull()
})

test('a missing or malformed draft id is the same refusal; a malformed one touches nothing', async () => {
  const missing = world()
  expect(await keep(missing, { draftId: '11111111-1111-4111-8111-111111111111' })).toEqual({ kind: 'other_phone' })
  const bad = world()
  expect(await keep(bad, { draftId: 'not-a-draft' })).toEqual({ kind: 'other_phone' })
  expect(bad.trace).toEqual([])
})

test('signed out never reaches the database', async () => {
  const w = world()
  expect(await keep(w, { userId: null })).toEqual({ kind: 'signed_out' })
  expect(w.trace).toEqual([])
})

test('a user who ALREADY has a shop is not claimed onto: no claim, no apply, the existing shop untouched', async () => {
  const w = world({ sellers: { [USER]: { id: 'sel_old', slug: 'mi-tienda-de-antes' } } })
  const res = await keep(w)
  expect(res).toEqual({ kind: 'has_shop', shopSlug: 'mi-tienda-de-antes' })
  expect(w.trace).toEqual(['findSeller', 'reread'])
  expect(w.row.claimed_by).toBeNull()
  expect(w.manifests).toEqual([])
})

test('a seller lookup that could not answer is not read as "no shop": nothing is claimed', async () => {
  const w = world({ sellerLookup: 'unavailable' })
  expect(await keep(w)).toEqual({ kind: 'retry', message: CLAIM_RETRY.lookup })
  expect(w.trace).toEqual(['findSeller'])
})

test('a draft whose name has not landed yet is not claimed; it stays claimable', async () => {
  const w = world({ noIdentity: true })
  expect(await keep(w)).toEqual({ kind: 'incomplete', draftId: DRAFT })
  expect(w.trace).toEqual(['findSeller', 'claim', 'reread'])
  expect(w.row.claimed_by).toBeNull()
})

test('partial failure: the shop create failed after the claim — the same user re-entering finishes it, once', async () => {
  const w = world({ failShopOnce: true })
  expect(await keep(w)).toEqual({ kind: 'retry', message: CLAIM_RETRY.shop })
  expect(w.row.claimed_by).toBe(USER)
  expect(w.row.claimed_seller_id).toBeNull()
  const before = w.trace.length
  const res = await keep(w)
  expect(res).toMatchObject({ kind: 'kept', resumed: true })
  expect(w.trace.slice(before)).toEqual(['findSeller', 'claim', 'reread', 'ensureShop', 'welcome', 'applyConfig', 'markSeller', 'revalidate'])
  expect(w.trace.filter((e) => e === 'welcome')).toHaveLength(1)
})

test('partial failure: the config failed after the shop was created — the retry re-applies, with no second seller or welcome', async () => {
  const w = world({ failApplyOnce: true })
  expect(await keep(w)).toEqual({ kind: 'retry', message: CLAIM_RETRY.config })
  expect(w.row.claimed_seller_id).toBeNull()
  const before = w.trace.length
  expect(await keep(w)).toMatchObject({ kind: 'kept', resumed: true })
  // The seller exists now, so no claim; the re-read shows the half-finished keep is this user's, and it resumes.
  expect(w.trace.slice(before)).toEqual(['findSeller', 'reread', 'ensureShop', 'applyConfig', 'markSeller', 'revalidate'])
  expect(Object.keys(w.sellers)).toEqual([USER])
  expect(w.trace.filter((e) => e === 'welcome')).toHaveLength(1)
})

test('partial failure: the done marker did not land — the retry finishes without a second seller', async () => {
  const w = world({ failMarkOnce: true })
  expect(await keep(w)).toEqual({ kind: 'retry', message: CLAIM_RETRY.save })
  expect(await keep(w)).toMatchObject({ kind: 'kept', resumed: true })
  expect(w.row.claimed_seller_id).toBe('sel_1')
  expect(w.trace.filter((e) => e === 'welcome')).toHaveLength(1)
  // revalidate runs only once the keep is really done.
  expect(w.trace.filter((e) => e === 'revalidate')).toHaveLength(1)
})

test('examples never reach Medusa: the only apply is a profile manifest, and no product or import effect exists', async () => {
  const w = world()
  await keep(w)
  expect(w.manifests).toHaveLength(1)
  const manifest = w.manifests[0] as Record<string, unknown>
  expect(Object.keys(manifest)).toEqual(['profile'])
  const wire = JSON.stringify(manifest)
  for (const example of fallbackCatalog()) expect(wire).not.toContain(example.title)
  expect(wire).not.toMatch(/catalog|products|support|price/)
  expect(w.trace.some((e) => /import|product/i.test(e))).toBe(false)
  // The manifest carries the identity and the words the merchant saw.
  expect(manifestFrom(identity, words)).toEqual({
    profile: {
      name: identity.name, tagline: identity.tagline, description: identity.description, state: 'Puebla', city: 'Puebla',
      accent_color: identity.accent_color, theme_preset: identity.theme_preset, announcement: { text: words.announcement, link: null },
    },
  })
  // No slug is sent: the backend derives a free one from the name.
  expect(shopInputFrom(identity)).toEqual({ name: identity.name, description: identity.description, state: 'Puebla', city: 'Puebla' })
})

test('the keep module graph cannot reach a product path, and calls the shop logic in-process, never over HTTP', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  const files = ['lib/prompt-to-shop/claim.ts', 'lib/prompt-to-shop/claim-server.ts', 'app/api/p2s/claim/[id]/route.ts']
  for (const file of files) {
    const src = strip(read(file))
    expect(src, file).not.toMatch(/catalog-import|seller-products|\/api\/sell\/(import|shop|settings-import)|createProduct|ensureSupportProduct|support_product/)
  }
  const server = strip(read('lib/prompt-to-shop/claim-server.ts'))
  // The only HTTP call is the read-only seller lookup straight to Medusa; ensureShop and applyStoreConfig are imported.
  expect([...server.matchAll(/fetch\(/g)]).toHaveLength(1)
  expect(server).toContain('/store/sellers/me')
  expect(server).toContain("import { ensureShop } from '@/lib/ensure-shop'")
  expect(server).toContain("import { applyStoreConfig } from '@/lib/apply-config-manifest'")
})

test('the claim is ONE conditional write, read back; the done marker is conditional on the claimant', () => {
  const server = read('lib/prompt-to-shop/claim-server.ts')
  const claim = server.slice(server.indexOf('claim: async'), server.indexOf('reread:'))
  for (const clause of [".eq('id', draftId)", ".eq('device_id', deviceId)", ".is('claimed_by', null)", ".gt('expires_at', now)", ".not('identity', 'is', null)", '.select(CLAIM_COLUMNS)']) {
    expect(claim, clause).toContain(clause)
  }
  expect(claim).toContain('data.length === 1')
  const mark = server.slice(server.indexOf('markSeller: async'), server.indexOf('revalidate:'))
  for (const clause of [".eq('id', draftId)", ".eq('claimed_by', user)", ".select('id')"]) expect(mark, clause).toContain(clause)
  expect(server).toContain("revalidateTag('shops', 'default')")
})

test('the claim route reads the device cookie and the Clerk session, and nothing from the query string or headers', () => {
  const src = read('app/api/p2s/claim/[id]/route.ts')
  expect(src).toContain('DEVICE_COOKIE')
  expect(src).toContain('await auth()')
  expect(src).not.toMatch(/searchParams|nextUrl|headers\.get|\.headers\[|req\.json/)
})
