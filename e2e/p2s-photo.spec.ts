import { expect, test } from '@playwright/test'
import { P2S_LIMITS, decidePhotoSpend, photosLeft, photosLeftCopy } from '../lib/prompt-to-shop/allowance'
import { fallbackCatalog } from '../lib/prompt-to-shop/blocks'
import { PHOTO_COPY } from '../lib/prompt-to-shop/copy'
import {
  analyzePhoto,
  buildPhotoRequest,
  confirmPhoto,
  finishMutation,
  isOwnPhotoUrl,
  readLedger,
  validateSuggestion,
  type AnalyzeDeps,
  type ConfirmDeps,
  type LedgerRow,
  type Mutation,
  type OwnerLookup,
} from '../lib/prompt-to-shop/photo'

// Prompt-to-shop S4.2 — photo → product (HIGH risk: it writes Medusa products and spends a paid allowance).
//
// The fakes behave like the real I/O: `mutate` is the optimistic conditional write on the kept draft (it re-reads and
// re-decides on every call, and two calls never interleave inside one write — Postgres' row lock), `spend` is
// `spend_ai_allowance` (the new count, or NULL at the cap), `createProduct` is the Medusa create with a globally
// unique handle. Every effect lands in ONE trace and the specs assert its ORDER, not only the answer
// (LEARNINGS → assert the ordering).

const USER = 'user_owner'
const R2 = 'https://pub-0123abcd.r2.dev'
const SUPABASE = 'https://abcdefgh.supabase.co'
const HOSTS = { r2PublicUrl: R2, supabaseUrl: SUPABASE }
const PHOTO = `${R2}/listing-images/${USER}/1730000000000-abc123.jpg`
const NONCE = '11111111-2222-4333-8444-555555555555'
const NONCE_2 = '99999999-2222-4333-8444-555555555555'
const DRAFT = '7f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607'
const SELLER = 'sel_01'
const CARD = { title: 'Vela de soya con lavanda', description: 'Vela en frasco de vidrio, 200 g.', category: 'hogar', price: 180 }

// ── The photo URL ────────────────────────────────────────────────────────────────────────────────────────────────

test('only a photo THIS user uploaded to OUR storage is accepted', () => {
  expect(isOwnPhotoUrl(PHOTO, HOSTS, USER)).toBe(true)
  expect(isOwnPhotoUrl(`${SUPABASE}/storage/v1/object/public/listing-images/${USER}/a.jpg`, HOSTS, USER)).toBe(true)
  // A base path on the R2 public URL is honoured.
  expect(isOwnPhotoUrl(`https://cdn.example.mx/img/listing-images/${USER}/a.jpg`, { r2PublicUrl: 'https://cdn.example.mx/img/' }, USER)).toBe(true)
})

test('photo host validation refuses foreign URLs, other users, and every way around the prefix', () => {
  const refused = [
    'https://evil.example.com/listing-images/user_owner/a.jpg',
    `https://pub-0123abcd.r2.dev.evil.com/listing-images/${USER}/a.jpg`,
    `http://pub-0123abcd.r2.dev/listing-images/${USER}/a.jpg`,
    `https://pub-0123abcd.r2.dev:8443/listing-images/${USER}/a.jpg`,
    `https://x:y@pub-0123abcd.r2.dev/listing-images/${USER}/a.jpg`,
    `${R2}/listing-images/user_stranger/a.jpg`,
    `${R2}/listing-images/${USER}/../user_stranger/a.jpg`,
    `${R2}/listing-images/${USER}/%2e%2e/user_stranger/a.jpg`,
    `${R2}/listing-images/${USER}/%2E%2E/user_stranger/a.jpg`,
    `${R2}/listing-images/${USER}%2fa.jpg`,
    `${R2}/listing-images/${USER}/a%2Fb.jpg`,
    `${R2}/listing-images/${USER}/a%5cb.jpg`,
    `${R2}/listing-images/${USER}/a%5Cb.jpg`,
    `${R2}/listing-images/${USER}/a\\b.jpg`,
    `${R2}/listing-images/${USER}/a.%2ejpg`,
    `${R2}/listing-images/${USER}/`,
    `${R2}/listing-images/${USER}x/a.jpg`,
    `${SUPABASE}/storage/v1/object/sign/listing-images/${USER}/a.jpg`,
    'file:///etc/passwd',
    'http://169.254.169.254/latest/meta-data/',
    '',
  ]
  for (const url of refused) expect(isOwnPhotoUrl(url, HOSTS, USER), url).toBe(false)
  expect(isOwnPhotoUrl(42, HOSTS, USER)).toBe(false)
  // No configured host means nothing is ours.
  expect(isOwnPhotoUrl(PHOTO, {}, USER)).toBe(false)
  // A user id that could itself climb a path is refused outright.
  expect(isOwnPhotoUrl(`${R2}/listing-images/a/b/x.jpg`, HOSTS, 'a/b')).toBe(false)
})

// ── The suggestion ───────────────────────────────────────────────────────────────────────────────────────────────

test('a suggestion is validated by validateRows plus the enum and a price', () => {
  expect(validateSuggestion(CARD)).toEqual({ ok: true, suggestion: CARD })
  expect(validateSuggestion({ ...CARD, category: 'joyeria' }).ok).toBe(false)
  expect(validateSuggestion({ ...CARD, price: 0 }).ok).toBe(false)
  expect(validateSuggestion({ ...CARD, price: '180' }).ok).toBe(false)
  expect(validateSuggestion({ ...CARD, title: 'Vela' }).ok).toBe(false)
  expect(validateSuggestion(null).ok).toBe(false)
})

test('the vision request sends the photo inline with the generation call shape (minimal thinking, ≥ 2048 tokens)', () => {
  const body = buildPhotoRequest({ mimeType: 'image/jpeg', base64: 'AAAA' }, 'Velas Luz')
  expect(body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } })
  expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' })
  expect(body.generationConfig.maxOutputTokens as number).toBeGreaterThanOrEqual(2048)
  expect(body.generationConfig.responseMimeType).toBe('application/json')
})

// ── Analyse ──────────────────────────────────────────────────────────────────────────────────────────────────────

function analyzeWorld(opts: { owner?: OwnerLookup; burst?: boolean; used?: number | null; model?: Array<string | null>; configured?: boolean; image?: boolean; analysesToday?: number; analysisError?: boolean; analysisThrows?: boolean } = {}) {
  const trace: string[] = []
  let analyses = opts.analysesToday ?? 0
  const replies = [...(opts.model ?? [JSON.stringify(CARD)])]
  const deps: AnalyzeDeps = {
    resolveOwner: async () => { trace.push('owner'); return opts.owner ?? { kind: 'ok', draftId: DRAFT, sellerId: SELLER, shopName: 'Velas Luz' } },
    burstAllowed: async () => { trace.push('burst'); return opts.burst ?? true },
    photosUsed: async () => { trace.push('photosUsed'); return opts.used === undefined ? 3 : opts.used },
    spendAnalysis: async () => {
      trace.push('spendAnalysis')
      if (opts.analysisThrows) throw new Error('network')
      if (opts.analysisError) return { data: null, error: { message: 'boom' } }
      if (analyses >= P2S_LIMITS.photoAnalysesPerDay) return { data: null, error: null }
      analyses += 1
      return { data: analyses, error: null }
    },
    fetchImage: async (url) => { trace.push(`fetchImage:${url === PHOTO}`); return opts.image === false ? null : { mimeType: 'image/jpeg', base64: 'AAAA' } },
    modelConfigured: opts.configured ?? true,
    callModel: async () => { trace.push('model'); const r = replies.shift(); return r === null || r === undefined ? { ok: false, error: '500' } : { ok: true, text: r } },
  }
  return { trace, deps }
}

test('analysis: validate → owner → burst → allowance read → our image → model, and a valid card comes back', async () => {
  const w = analyzeWorld()
  const out = await analyzePhoto({ userId: USER, body: { image_url: PHOTO }, hosts: HOSTS }, w.deps)
  expect(out).toEqual({ status: 200, body: { ok: true, suggestion: CARD, photos_left: P2S_LIMITS.photosPerMonth - 3 } })
  expect(w.trace).toEqual(['owner', 'burst', 'photosUsed', 'spendAnalysis', 'fetchImage:true', 'model'])
})

test('analysis: the daily cap is spent BEFORE the vision call, and at the cap there is no model call', async () => {
  const w = analyzeWorld({ analysesToday: P2S_LIMITS.photoAnalysesPerDay })
  const out = await analyzePhoto({ userId: USER, body: { image_url: PHOTO }, hosts: HOSTS }, w.deps)
  expect(out).toEqual({ status: 429, body: { ok: false, code: 'analysis_daily', error: 'Ya revisamos muchas fotos hoy. Vuelve mañana.' } })
  expect(w.trace).toEqual(['owner', 'burst', 'photosUsed', 'spendAnalysis'])
  expect(P2S_LIMITS.photoAnalysesPerDay).toBe(40)
})

test('analysis: a daily-cap RPC error or throw fails CLOSED — no image fetch, no model call', async () => {
  for (const opts of [{ analysisError: true }, { analysisThrows: true }]) {
    const w = analyzeWorld(opts)
    const out = await analyzePhoto({ userId: USER, body: { image_url: PHOTO }, hosts: HOSTS }, w.deps)
    expect(out.status).toBe(503)
    expect(w.trace).toEqual(['owner', 'burst', 'photosUsed', 'spendAnalysis'])
  }
})

test('analysis: a foreign URL is refused before ANY effect — no owner lookup, no fetch, no model', async () => {
  const w = analyzeWorld()
  const out = await analyzePhoto({ userId: USER, body: { image_url: 'https://evil.example.com/x.jpg' }, hosts: HOSTS }, w.deps)
  expect(out.status).toBe(400)
  expect(w.trace).toEqual([])
})

test('analysis: a non-owner is refused with no model call', async () => {
  const w = analyzeWorld({ owner: { kind: 'none' } })
  const out = await analyzePhoto({ userId: USER, body: { image_url: PHOTO }, hosts: HOSTS }, w.deps)
  expect(out.status).toBe(403)
  expect(w.trace).toEqual(['owner'])
})

test('analysis: at the monthly cap it refuses with the sprint copy BEFORE paying for a vision call', async () => {
  const w = analyzeWorld({ used: P2S_LIMITS.photosPerMonth })
  const out = await analyzePhoto({ userId: USER, body: { image_url: PHOTO }, hosts: HOSTS }, w.deps)
  expect(out).toEqual({ status: 429, body: { ok: false, code: 'allowance', error: 'Te quedan 0 fotos este mes; vuelven el 1' } })
  expect(w.trace).not.toContain('model')
  expect(w.trace).not.toContain('fetchImage:true')
})

test('analysis: a burst refusal makes no model call', async () => {
  const w = analyzeWorld({ burst: false })
  expect((await analyzePhoto({ userId: USER, body: { image_url: PHOTO }, hosts: HOSTS }, w.deps)).status).toBe(429)
  expect(w.trace).toEqual(['owner', 'burst'])
})

test('analysis: the 41st analysis of the day is refused even when the burst limiter lets everything through', async () => {
  const w = analyzeWorld({ analysesToday: 0, model: Array(P2S_LIMITS.photoAnalysesPerDay + 5).fill(JSON.stringify(CARD)) })
  for (let i = 0; i < P2S_LIMITS.photoAnalysesPerDay; i++) {
    expect((await analyzePhoto({ userId: USER, body: { image_url: PHOTO }, hosts: HOSTS }, w.deps)).status).toBe(200)
  }
  expect((await analyzePhoto({ userId: USER, body: { image_url: PHOTO }, hosts: HOSTS }, w.deps)).status).toBe(429)
  expect(w.trace.filter((t) => t === 'model')).toHaveLength(P2S_LIMITS.photoAnalysesPerDay)
})

test('analysis: invalid output → ONE retry → an empty card to fill in, never a crash', async () => {
  const w = analyzeWorld({ model: ['{"title":"x"}', 'not json at all'] })
  const out = await analyzePhoto({ userId: USER, body: { image_url: PHOTO }, hosts: HOSTS }, w.deps)
  expect(out).toEqual({ status: 200, body: { ok: true, suggestion: null, message: PHOTO_COPY.fillYourself, photos_left: 17 } })
  expect(w.trace.filter((t) => t === 'model')).toHaveLength(2)
})

test('analysis: an invalid first answer is retried and a valid second one wins', async () => {
  const w = analyzeWorld({ model: [null, JSON.stringify(CARD)] })
  const out = await analyzePhoto({ userId: USER, body: { image_url: PHOTO }, hosts: HOSTS }, w.deps)
  expect(out.status === 200 && out.body.suggestion).toEqual(CARD)
})

test('analysis: no model credential or an unreadable image is the empty card, and a failed allowance read does not refuse', async () => {
  const unconfigured = analyzeWorld({ configured: false })
  const a = await analyzePhoto({ userId: USER, body: { image_url: PHOTO }, hosts: HOSTS }, unconfigured.deps)
  expect(a.status === 200 && a.body.suggestion).toBeNull()
  expect(unconfigured.trace).not.toContain('model')
  // No credential means no vision call, so nothing is spent against the daily cap.
  expect(unconfigured.trace).not.toContain('spendAnalysis')
  const noImage = analyzeWorld({ image: false, used: null })
  const b = await analyzePhoto({ userId: USER, body: { image_url: PHOTO }, hosts: HOSTS }, noImage.deps)
  expect(b.status === 200 && b.body).toMatchObject({ suggestion: null, photos_left: null })
  expect(noImage.trace).not.toContain('model')
})

// ── Confirm ──────────────────────────────────────────────────────────────────────────────────────────────────────

const EXAMPLES = fallbackCatalog()

function confirmWorld(opts: { owner?: OwnerLookup; used?: number; spendError?: boolean; spendThrows?: boolean; failCreate?: number; ledgerDown?: boolean; createLandsSilently?: boolean; failFinish?: number } = {}) {
  const trace: string[] = []
  const clock = { now: new Date('2026-10-28T12:00:00Z') }
  let failFinish = opts.failFinish ?? 0
  const row: LedgerRow = { catalog: EXAMPLES.map((e) => ({ ...e })), block_status: { identity: 'ok', words: 'ok', catalog: 'ok' }, updated_at: 't0' }
  let version = 0
  let used = opts.used ?? 0
  let failCreate = opts.failCreate ?? 0
  const products: Array<{ id: string; handle: string; nonce: string; image: string; status: 'draft'; title: string; catalogAtCreate: number }> = []

  const deps: ConfirmDeps = {
    resolveOwner: async () => { trace.push('owner'); return opts.owner ?? { kind: 'ok', draftId: DRAFT, sellerId: SELLER, shopName: 'Velas Luz' } },
    mutate: async <T>(draftId: string, fn: (r: LedgerRow) => Mutation<T>) => {
      if (opts.ledgerDown || draftId !== DRAFT) return { ok: false as const }
      // Synchronous read-decide-write: the real write is conditional on updated_at, so two callers cannot both land
      // on the same version; here they simply cannot interleave.
      const m = fn({ ...row, block_status: JSON.parse(JSON.stringify(row.block_status)), catalog: JSON.parse(JSON.stringify(row.catalog)) })
      const kind = (m.result as { kind?: string } | boolean | { exampleRemoved: boolean })
      const label = typeof kind === 'object' && kind && 'kind' in kind ? kind.kind : typeof kind === 'object' && kind && 'exampleRemoved' in kind ? 'finish' : String(kind)
      trace.push(`mutate:${label}`)
      // A finish whose write never lands (lost every race, or the process died before it).
      if (label === 'finish' && failFinish > 0) { failFinish -= 1; return { ok: false as const } }
      if (m.write) {
        if (m.write.block_status !== undefined) row.block_status = m.write.block_status
        if (m.write.catalog !== undefined) row.catalog = m.write.catalog
        row.updated_at = `t${++version}`
      }
      return { ok: true as const, result: m.result }
    },
    spend: async () => {
      trace.push('spend')
      if (opts.spendThrows) throw new Error('network')
      if (opts.spendError) return { data: null, error: { message: 'boom' } }
      if (used >= P2S_LIMITS.photosPerMonth) return { data: null, error: null }
      used += 1
      return { data: used, error: null }
    },
    findCreated: async (nonce) => { trace.push('findCreated'); return products.find((p) => p.nonce === nonce)?.id ?? null },
    createProduct: async (r, imageUrl, nonce) => {
      trace.push('createProduct')
      const handle = `p2s-${nonce}`
      if (products.some((p) => p.handle === handle)) return { ok: false, message: 'handle exists' }
      if (failCreate > 0) {
        failCreate -= 1
        if (opts.createLandsSilently) products.push({ id: `prod_${products.length + 1}`, handle, nonce, image: imageUrl, status: 'draft', title: r.title, catalogAtCreate: (row.catalog as unknown[]).length })
        return { ok: false, message: 'timeout' }
      }
      const id = `prod_${products.length + 1}`
      products.push({ id, handle, nonce, image: imageUrl, status: 'draft', title: r.title, catalogAtCreate: (row.catalog as unknown[]).length })
      return { ok: true, productId: id }
    },
    now: () => clock.now,
  }
  return { trace, deps, row, products, used: () => used, clock }
}

const body = (extra: Record<string, unknown> = {}) => ({ nonce: NONCE, image_url: PHOTO, card: CARD, replace: { index: 1, title: EXAMPLES[1].title }, ...extra })

test('one confirmation → one Medusa DRAFT product with the merchant photo, in the order validate → owner → reserve → spend → create → finish', async () => {
  const w = confirmWorld()
  const out = await confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, w.deps)
  expect(out).toEqual({ status: 200, body: { ok: true, product_id: 'prod_1', duplicate: false, example_removed: true, finished: true, photos_left: P2S_LIMITS.photosPerMonth - 1 } })
  expect(w.trace).toEqual(['owner', 'mutate:reserved', 'spend', 'createProduct', 'mutate:finish'])
  expect(w.products).toHaveLength(1)
  expect(w.products[0]).toMatchObject({ status: 'draft', image: PHOTO, handle: `p2s-${NONCE}`, title: CARD.title })
  expect(w.used()).toBe(1)
  expect(readLedger(w.row.block_status)[NONCE]).toMatchObject({ state: 'done', product_id: 'prod_1' })
})

test('the example is removed from the catalog only AFTER the product exists', async () => {
  const w = confirmWorld()
  await confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, w.deps)
  // At create time every example was still in the draft …
  expect(w.products[0].catalogAtCreate).toBe(EXAMPLES.length)
  // … and afterwards exactly the replaced one is gone.
  const titles = (w.row.catalog as Array<{ title: string }>).map((r) => r.title)
  expect(titles).toEqual(EXAMPLES.filter((_, i) => i !== 1).map((e) => e.title))
  // A failed create removes nothing.
  const failed = confirmWorld({ failCreate: 1 })
  await confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, failed.deps)
  expect((failed.row.catalog as unknown[]).length).toBe(EXAMPLES.length)
})

test('a double confirm creates ONE product and spends ONE photo — sequential and concurrent', async () => {
  const seq = confirmWorld()
  await confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, seq.deps)
  const again = await confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, seq.deps)
  expect(again).toEqual({ status: 200, body: { ok: true, product_id: 'prod_1', duplicate: true, example_removed: false, finished: true, photos_left: null } })
  expect(seq.products).toHaveLength(1)
  expect(seq.used()).toBe(1)
  expect(seq.trace.filter((t) => t === 'spend')).toHaveLength(1)

  const conc = confirmWorld()
  const [a, b] = await Promise.all([
    confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, conc.deps),
    confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, conc.deps),
  ])
  expect(conc.products).toHaveLength(1)
  expect(conc.used()).toBe(1)
  expect([a.status, b.status].sort()).toEqual([200, 409])
})

test('the 21st photo of the month is refused with ZERO product calls, and its reservation is released', async () => {
  const w = confirmWorld({ used: P2S_LIMITS.photosPerMonth })
  const out = await confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, w.deps)
  expect(out).toEqual({ status: 429, body: { ok: false, code: 'allowance', error: 'Te quedan 0 fotos este mes; vuelven el 1' } })
  expect(w.trace).toEqual(['owner', 'mutate:reserved', 'spend', 'mutate:true'])
  expect(w.trace).not.toContain('createProduct')
  expect(w.products).toHaveLength(0)
  expect(readLedger(w.row.block_status)[NONCE]).toBeUndefined()
  expect((w.row.catalog as unknown[]).length).toBe(EXAMPLES.length)
})

test('a spend error refuses (fails CLOSED) and creates nothing — an RPC error and a thrown call alike', async () => {
  for (const opts of [{ spendError: true }, { spendThrows: true }]) {
    const w = confirmWorld(opts)
    const out = await confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, w.deps)
    expect(out.status).toBe(503)
    expect(w.trace).not.toContain('createProduct')
    expect(w.products).toHaveLength(0)
  }
})

test('a non-owner is refused before any write, spend or product call', async () => {
  for (const owner of [{ kind: 'none' } as const, { kind: 'unavailable' } as const]) {
    const w = confirmWorld({ owner })
    const out = await confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, w.deps)
    expect(out.status).toBe(owner.kind === 'none' ? 403 : 503)
    expect(w.trace).toEqual(['owner'])
  }
})

test('a foreign photo URL or an invalid card is refused before the owner lookup', async () => {
  for (const extra of [{ image_url: 'https://evil.example.com/x.jpg' }, { image_url: `${R2}/listing-images/user_stranger/a.jpg` }, { card: { ...CARD, price: 0 } }, { nonce: 'not-a-uuid' }, { replace: { index: -1, title: 'x' } }]) {
    const w = confirmWorld()
    const out = await confirmPhoto({ userId: USER, body: body(extra), hosts: HOSTS }, w.deps)
    expect(out.status, JSON.stringify(extra)).toBe(400)
    expect(w.trace).toEqual([])
  }
})

test('a ledger that cannot be written refuses before the spend', async () => {
  const w = confirmWorld({ ledgerDown: true })
  const out = await confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, w.deps)
  expect(out.status).toBe(503)
  expect(w.trace).toEqual(['owner'])
  expect(w.used()).toBe(0)
})

test('a failed create keeps the photo PAID: the retry with the same nonce creates once and does not spend again', async () => {
  const w = confirmWorld({ failCreate: 1 })
  const first = await confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, w.deps)
  expect(first.status).toBe(502)
  expect(readLedger(w.row.block_status)[NONCE]?.state).toBe('paid')
  const retry = await confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, w.deps)
  expect(retry.status).toBe(200)
  expect(w.used()).toBe(1)
  expect(w.trace.filter((t) => t === 'spend')).toHaveLength(1)
  expect(w.products).toHaveLength(1)
})

test('a create that landed but lost its answer is found on retry, not created twice', async () => {
  const w = confirmWorld({ failCreate: 1, createLandsSilently: true })
  await confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, w.deps)
  const retry = await confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, w.deps)
  expect(retry).toMatchObject({ status: 200, body: { product_id: 'prod_1', duplicate: true, example_removed: true } })
  expect(w.products).toHaveLength(1)
  expect(w.trace.filter((t) => t === 'createProduct')).toHaveLength(1)
})

test('a finish that does not land says so (finished:false), and the retry with the same nonce finishes it', async () => {
  const w = confirmWorld({ failFinish: 1 })
  const first = await confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, w.deps)
  expect(first).toMatchObject({ status: 200, body: { ok: true, product_id: 'prod_1', finished: false, example_removed: false } })
  expect(readLedger(w.row.block_status)[NONCE]?.state).toBe('pending')
  // Immediately, not after a timeout: the product is found by its nonce and finished.
  const retry = await confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, w.deps)
  expect(retry).toMatchObject({ status: 200, body: { product_id: 'prod_1', finished: true, example_removed: true } })
  expect(w.trace.slice(-3)).toEqual(['mutate:existing', 'findCreated', 'mutate:finish'])
  expect(w.products).toHaveLength(1)
  expect(w.used()).toBe(1)
  expect(readLedger(w.row.block_status)[NONCE]).toMatchObject({ state: 'done', product_id: 'prod_1' })
  expect((w.row.catalog as unknown[]).length).toBe(EXAMPLES.length - 1)
})

test('a FRESH pending entry with no product behind it is a live request: 409, nothing spent or created', async () => {
  const w = confirmWorld({ failFinish: 1 })
  await confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, w.deps)
  // Same entry, but the product is not there (say the create died): a fresh pending is a live request.
  w.products.length = 0
  const fresh = await confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, w.deps)
  expect(fresh.status).toBe(409)
  expect(w.trace.slice(-2)).toEqual(['mutate:existing', 'findCreated'])
})

test('a STALE pending with no product is taken over and goes through the spend again — once, even when two retries race', async () => {
  const w = confirmWorld({ failCreate: 0 })
  // Plant a pending entry from a request that died 2 minutes ago, before (or after — unknown) its spend.
  w.row.block_status = { identity: 'ok', photo_confirms: { [NONCE]: { state: 'pending', at: '2026-10-28T11:58:00.000Z' } } }
  const [a, b] = await Promise.all([
    confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, w.deps),
    confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, w.deps),
  ])
  expect([a.status, b.status].sort()).toEqual([200, 409])
  expect(w.products).toHaveLength(1)
  expect(w.used()).toBe(1)
  const order = w.trace.filter((t) => ['findCreated', 'mutate:true', 'spend', 'createProduct', 'mutate:finish'].includes(t))
  expect(order.indexOf('mutate:true')).toBeLessThan(order.indexOf('spend'))
  expect(order.indexOf('spend')).toBeLessThan(order.indexOf('createProduct'))
  expect(readLedger(w.row.block_status)[NONCE]?.state).toBe('done')
})

test('a stale pending whose product DID land is finished without spending again', async () => {
  const w = confirmWorld()
  w.row.block_status = { photo_confirms: { [NONCE]: { state: 'pending', at: '2026-10-28T11:58:00.000Z' } } }
  w.products.push({ id: 'prod_9', handle: `p2s-${NONCE}`, nonce: NONCE, image: PHOTO, status: 'draft', title: CARD.title, catalogAtCreate: EXAMPLES.length })
  const out = await confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, w.deps)
  expect(out).toMatchObject({ status: 200, body: { product_id: 'prod_9', finished: true, example_removed: true } })
  expect(w.trace).not.toContain('spend')
  expect(w.trace).not.toContain('createProduct')
})

test('two different suggestions are two products and two photos', async () => {
  const w = confirmWorld()
  await confirmPhoto({ userId: USER, body: body(), hosts: HOSTS }, w.deps)
  await confirmPhoto({ userId: USER, body: body({ nonce: NONCE_2, replace: null }), hosts: HOSTS }, w.deps)
  expect(w.products).toHaveLength(2)
  expect(w.used()).toBe(2)
})

test('finish removes the example by index AND title; a stale index falls back to the title; a missing one removes nothing', () => {
  const row: LedgerRow = { catalog: EXAMPLES, block_status: {}, updated_at: 't' }
  const now = new Date('2026-10-28T12:00:00Z')
  const exact = finishMutation(row, NONCE, 'prod_1', { index: 2, title: EXAMPLES[2].title }, now)
  expect((exact.write?.catalog as unknown[]).length).toBe(EXAMPLES.length - 1)
  const stale = finishMutation(row, NONCE, 'prod_1', { index: 0, title: EXAMPLES[3].title }, now)
  expect((stale.write?.catalog as Array<{ title: string }>).map((r) => r.title)).not.toContain(EXAMPLES[3].title)
  expect((stale.write?.catalog as Array<{ title: string }>).map((r) => r.title)).toContain(EXAMPLES[0].title)
  const gone = finishMutation(row, NONCE, 'prod_1', { index: 0, title: 'Ya no existe' }, now)
  expect(gone.write?.catalog).toBeUndefined()
  expect(gone.result.exampleRemoved).toBe(false)
  // A nonce already done touches nothing — a second finish must not remove a second same-titled example.
  const twice = finishMutation({ ...row, block_status: exact.write?.block_status }, NONCE, 'prod_1', { index: 2, title: EXAMPLES[2].title }, now)
  expect(twice.write).toBeNull()
  // The block keys survive the ledger write: coerceBlocks still reads them.
  expect((exact.write?.block_status as Record<string, unknown>).photo_confirms).toBeTruthy()
})

// ── The allowance answer ─────────────────────────────────────────────────────────────────────────────────────────

test('the photo spend answer fails CLOSED on anything but a count in 1..cap', () => {
  expect(decidePhotoSpend({ data: 1, error: null })).toEqual({ ok: true, used: 1, left: 19 })
  expect(decidePhotoSpend({ data: 20, error: null })).toEqual({ ok: true, used: 20, left: 0 })
  expect(decidePhotoSpend({ data: null, error: null })).toEqual({ ok: false, reason: 'allowance' })
  for (const bad of [{ data: 21, error: null }, { data: 0, error: null }, { data: '3', error: null }, { data: undefined, error: null }, { data: 3, error: { message: 'x' } }]) {
    expect(decidePhotoSpend(bad)).toEqual({ ok: false, reason: 'unavailable' })
  }
  expect(photosLeftCopy(0)).toBe('Te quedan 0 fotos este mes; vuelven el 1')
  expect(photosLeftCopy(1)).toBe('Te queda 1 foto este mes')
  expect(photosLeftCopy(7)).toBe('Te quedan 7 fotos este mes')
  expect(photosLeft(null)).toBeNull()
  expect(photosLeft(25)).toBe(0)
  expect(P2S_LIMITS.photosPerMonth).toBe(20)
})
