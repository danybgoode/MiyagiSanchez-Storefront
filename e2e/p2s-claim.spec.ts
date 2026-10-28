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

function world(opts: { expired?: boolean; noIdentity?: boolean; claimedBy?: string; sellers?: Record<string, { id: string; slug: string }>; failApplyOnce?: boolean; failShopOnce?: boolean; failMarkOnce?: boolean; sellerLookup?: 'unavailable'; shopAppearsAt?: 'ensureShop' } = {}) {
  const trace: string[] = []
  const manifests: unknown[] = []
  const logs: Array<Record<string, unknown>> = []
  let appear = opts.shopAppearsAt === 'ensureShop'
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
      // A shop made between the lookup and the create (another tab, the wizard, an agent).
      if (appear) { appear = false; sellers[userId] = { id: 'sel_elsewhere', slug: 'hecha-a-mano' } }
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
      // The real WHERE: id, no seller yet, and the draft is this user's or released.
      if (id !== row.id || row.claimed_seller_id !== null || (row.claimed_by !== user && row.claimed_by !== null)) return false
      row.claimed_by = user
      row.claimed_seller_id = sellerId
      return true
    },
    release: async (id, user) => {
      trace.push('release')
      if (id !== row.id || row.claimed_by !== user || row.claimed_seller_id !== null) return false
      row.claimed_by = null
      return true
    },
    log: (line) => { logs.push(line) },
    revalidate: () => { trace.push('revalidate') },
    now: () => NOW,
  })
  return { trace, manifests, logs, row, sellers, deps }
}

const keep = (w: World, who: { userId?: string | null; device?: string | null; draftId?: string } = {}) =>
  claimAndApply(
    { draftId: who.draftId ?? DRAFT, deviceCookie: who.device === undefined ? DEVICE : who.device, userId: who.userId === undefined ? USER : who.userId },
    w.deps(who.userId ?? USER),
  )

test('one owner: seller looked up, then the claim, then the shop, the marker, then the config — in that order', async () => {
  const w = world()
  const res = await keep(w)
  expect(res).toEqual({ kind: 'kept', draftId: DRAFT, shopSlug: identity.name.toLowerCase().replace(/\s+/g, '-'), resumed: false, configApplied: true })
  expect(w.trace).toEqual(['findSeller', 'claim', 'ensureShop', 'welcome', 'markSeller', 'applyConfig', 'revalidate'])
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

test('two tabs racing: one seller, one welcome, ONE config apply, and the draft ends marked with that seller', async () => {
  const w = world()
  const [a, b] = await Promise.all([keep(w), keep(w)])
  // One tab created the seller and kept it; the other either saw it finished or saw a 200 and applied nothing.
  expect([a.kind, b.kind]).toContain('kept')
  for (const res of [a, b]) expect(['kept', 'has_shop']).toContain(res.kind)
  expect(Object.keys(w.sellers)).toEqual([USER])
  expect(w.trace.filter((e) => e === 'welcome')).toHaveLength(1)
  expect(w.trace.filter((e) => e === 'applyConfig')).toHaveLength(1)
  expect(w.row).toMatchObject({ claimed_by: USER, claimed_seller_id: 'sel_1' })
})

test('a shop that appears between the lookup and the create (ensureShop 200) gets NOTHING applied, and the claim is released', async () => {
  const w = world({ shopAppearsAt: 'ensureShop' })
  const res = await keep(w)
  expect(res).toEqual({ kind: 'has_shop', shopSlug: 'hecha-a-mano' })
  expect(w.trace).toEqual(['findSeller', 'claim', 'ensureShop', 'release'])
  expect(w.manifests).toEqual([])
  expect(w.row).toMatchObject({ claimed_by: null, claimed_seller_id: null })
})

test('resume with a shop that this draft did not make: zero apply, released, «Ya tienes una tienda»', async () => {
  // The keep stopped before its seller existed; the user then built a shop by hand.
  const w = world({ claimedBy: USER, sellers: { [USER]: { id: 'sel_hand', slug: 'a-mano' } } })
  const res = await keep(w)
  expect(res).toEqual({ kind: 'has_shop', shopSlug: 'a-mano' })
  expect(w.trace).toEqual(['findSeller', 'reread', 'release'])
  expect(w.manifests).toEqual([])
  expect(w.row.claimed_by).toBeNull()
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

test('claim lands, the create fails, the user then builds a shop by hand: the next keep applies NOTHING to it', async () => {
  // The verifier's executed scenario. Same class: draft X half-kept, draft Y became the shop, X revisited.
  const w = world({ failShopOnce: true })
  expect(await keep(w)).toEqual({ kind: 'retry', message: CLAIM_RETRY.shop })
  expect(w.row.claimed_by).toBe(USER)
  w.sellers[USER] = { id: 'sel_manual', slug: 'hecha-a-mano' }
  const before = w.trace.length
  expect(await keep(w)).toEqual({ kind: 'has_shop', shopSlug: 'hecha-a-mano' })
  expect(w.trace.slice(before)).toEqual(['findSeller', 'reread', 'release'])
  expect(w.trace.filter((e) => e === 'applyConfig')).toHaveLength(0)
  // Released: the draft is this phone's again (the owner canvas reads `claimed_by IS NULL`).
  expect(w.row).toMatchObject({ claimed_by: null, claimed_seller_id: null })
})

test('partial failure: the shop create failed after the claim — the same user re-entering finishes it, once', async () => {
  const w = world({ failShopOnce: true })
  expect(await keep(w)).toEqual({ kind: 'retry', message: CLAIM_RETRY.shop })
  expect(w.row.claimed_by).toBe(USER)
  expect(w.row.claimed_seller_id).toBeNull()
  const before = w.trace.length
  const res = await keep(w)
  expect(res).toMatchObject({ kind: 'kept', resumed: true, configApplied: true })
  expect(w.trace.slice(before)).toEqual(['findSeller', 'claim', 'reread', 'ensureShop', 'welcome', 'markSeller', 'applyConfig', 'revalidate'])
  expect(w.trace.filter((e) => e === 'welcome')).toHaveLength(1)
})

test('the config failed after the 201: still kept (marker set, configApplied false), and a reload applies nothing again', async () => {
  const w = world({ failApplyOnce: true })
  expect(await keep(w)).toMatchObject({ kind: 'kept', resumed: false, configApplied: false })
  expect(w.row.claimed_seller_id).toBe('sel_1')
  expect(w.logs).toEqual([{ event: 'claim_config_failed', draft: DRAFT, seller: 'sel_1' }])
  const before = w.trace.length
  expect(await keep(w)).toMatchObject({ kind: 'kept', resumed: true })
  expect(w.trace.slice(before)).toEqual(['findSeller', 'reread'])
  expect(w.trace.filter((e) => e === 'applyConfig')).toHaveLength(1)
  expect(w.trace.filter((e) => e === 'welcome')).toHaveLength(1)
})

test('the marker did not land after the 201: the fresh shop still gets its config, and it is logged, not hidden', async () => {
  const w = world({ failMarkOnce: true })
  expect(await keep(w)).toMatchObject({ kind: 'kept', configApplied: true })
  expect(w.logs).toEqual([{ event: 'claim_mark_failed', draft: DRAFT, seller: 'sel_1' }])
  // Without the marker nothing proves the shop came from this draft, so a later visit applies nothing to it.
  const before = w.trace.length
  expect(await keep(w)).toEqual({ kind: 'has_shop', shopSlug: w.sellers[USER].slug })
  expect(w.trace.slice(before)).toEqual(['findSeller', 'reread', 'release'])
  expect(w.trace.filter((e) => e === 'applyConfig')).toHaveLength(1)
  expect(Object.keys(w.sellers)).toEqual([USER])
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

test('the claim is ONE conditional write, read back; the marker and the release are conditional and read back', () => {
  const server = read('lib/prompt-to-shop/claim-server.ts')
  const claim = server.slice(server.indexOf('claim: async'), server.indexOf('reread:'))
  for (const clause of [".eq('id', draftId)", ".eq('device_id', deviceId)", ".is('claimed_by', null)", ".gt('expires_at', now)", ".not('identity', 'is', null)", '.select(CLAIM_COLUMNS)']) {
    expect(claim, clause).toContain(clause)
  }
  expect(claim).toContain('data.length === 1')
  const mark = server.slice(server.indexOf('markSeller: async'), server.indexOf('release: async'))
  for (const clause of [".eq('id', draftId)", ".is('claimed_seller_id', null)", '.or(`claimed_by.eq.${user},claimed_by.is.null`)', ".select('id')"]) expect(mark, clause).toContain(clause)
  const release = server.slice(server.indexOf('release: async'), server.indexOf('log:'))
  for (const clause of ['claimed_by: null', 'claimed_at: null', ".eq('id', draftId)", ".eq('claimed_by', user)", ".is('claimed_seller_id', null)", ".select('id')", 'data.length === 1']) expect(release, clause).toContain(clause)
  expect(server).toContain("revalidateTag('shops', 'default')")
})

test('the claim route reads the device cookie and the Clerk session, and nothing from the query string or headers', () => {
  const src = read('app/api/p2s/claim/[id]/route.ts')
  expect(src).toContain('DEVICE_COOKIE')
  expect(src).toContain('await auth()')
  expect(src).not.toMatch(/searchParams|nextUrl|headers\.get|\.headers\[|req\.json/)
})
