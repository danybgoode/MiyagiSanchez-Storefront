/**
 * Prompt-to-shop — the real I/O behind photo → product (epic S4.2). Every decision lives in `photo.ts`.
 *
 * The product is created IN-PROCESS through `lib/seller-product-create.ts` (the importer's own create path) with the
 * caller's Clerk token. Never `fetch()` our own `/api/sell/import`: a server-side request has no session cookie.
 */

import 'server-only'
import { db } from '@/lib/supabase'
import { checkRateLimit } from '@/lib/ratelimit'
import { buildCreateBody, createSellerProduct } from '@/lib/seller-product-create'
import { P2S_LIMITS, budgetPeriod, monthPeriod, photoAnalysisSubject, userSubject } from './allowance'
import { findKeptDraft, lookupSeller } from './claim-server'
import {
  CREATE_TIMEOUT_MS,
  PHOTO_MAX_BYTES,
  PHOTO_MIME,
  SPEND_TIMEOUT_MS,
  type AnalyzeDeps,
  type ConfirmDeps,
  type LedgerRow,
  type Mutation,
  type OwnerLookup,
  type PhotoHosts,
} from './photo'
import { MODEL_CONFIGURED, MODEL_VIA, callModelBody } from './server'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const PUB_KEY = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''
const IMAGE_TIMEOUT_MS = 10_000
/** A vision call on a phone photo is slower than a text block. Still bounded: a hung call becomes a retry. */
const VISION_TIMEOUT_MS = 20_000
/** Optimistic-write attempts before a ledger write reports `unavailable`. Two taps race at most once. */
const MUTATE_ATTEMPTS = 3

export function photoHosts(): PhotoHosts {
  return { r2PublicUrl: process.env.R2_PUBLIC_URL ?? null, supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? null }
}

/** The signed-in user's kept draft, and proof that their Medusa seller IS the shop that draft became. */
export async function resolvePhotoOwner(userId: string, clerkJwt: string): Promise<OwnerLookup> {
  const kept = await findKeptDraft(userId, null)
  if (kept === 'unavailable') return { kind: 'unavailable' }
  if (!kept || !kept.sellerId) return { kind: 'none' }
  const seller = await lookupSeller(clerkJwt)
  if (seller.state === 'unavailable') return { kind: 'unavailable' }
  if (seller.state === 'absent' || seller.seller.id !== kept.sellerId) return { kind: 'none' }
  return { kind: 'ok', draftId: kept.id, sellerId: kept.sellerId, shopName: kept.blocks.identity?.name ?? null }
}

/** This month's photos used: a read of the ledger row. `null` when the read failed (three states, never "0"). */
export async function photosUsedThisMonth(userId: string, now: Date = new Date()): Promise<number | null> {
  const { data, error } = await db
    .from('ai_allowance')
    // Aliased: a bare `count` in a PostgREST select can be read as the aggregate rather than the column.
    .select('used:count')
    .eq('subject', userSubject(userId))
    .eq('kind', 'photo')
    .eq('period', monthPeriod(now))
    .maybeSingle()
  if (error) return null
  const count = (data as { used?: unknown } | null)?.used
  return data === null ? 0 : typeof count === 'number' ? count : null
}

/**
 * Our own bucket's bytes, for the model. The URL was validated by `isOwnPhotoUrl` before this runs; `redirect:
 * 'error'` keeps it that way (a 3xx from an allowed host would otherwise be followed anywhere — the /api/img rule).
 */
async function fetchOwnImage(url: string): Promise<{ mimeType: string; base64: string } | null> {
  try {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) })
    if (!res.ok || !res.body) return null
    const mimeType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!(PHOTO_MIME as readonly string[]).includes(mimeType)) return null
    if (Number(res.headers.get('content-length') ?? '0') > PHOTO_MAX_BYTES) return null
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > PHOTO_MAX_BYTES) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
    return { mimeType, base64: Buffer.concat(chunks).toString('base64') }
  } catch {
    return null
  }
}

function log(line: Record<string, unknown>) {
  console.info('[p2s]', JSON.stringify({ via: MODEL_VIA, ...line }))
}

export function analyzeDeps(userId: string, clerkJwt: string): AnalyzeDeps {
  return {
    resolveOwner: () => resolvePhotoOwner(userId, clerkJwt),
    burstAllowed: async () => (await checkRateLimit('p2s_photo', userId)).allowed,
    photosUsed: () => photosUsedThisMonth(userId),
    // The existing D4 RPC on its own subject: no migration, and the same fail-closed single conditional write.
    spendAnalysis: async () => {
      const { data, error } = await db.rpc('spend_ai_allowance', {
        p_subject: photoAnalysisSubject(userId),
        p_kind: 'daily_budget',
        p_period: budgetPeriod(new Date()),
        p_cap: P2S_LIMITS.photoAnalysesPerDay,
      })
      return { data, error }
    },
    fetchImage: fetchOwnImage,
    modelConfigured: MODEL_CONFIGURED,
    callModel: async (body) => {
      const r = await callModelBody(body, VISION_TIMEOUT_MS)
      log({ step: 'photo_model', ok: r.ok, prompt_tokens: r.promptTokens ?? null, output_tokens: r.outputTokens ?? null })
      return r
    },
    log,
  }
}

const LEDGER_COLUMNS = 'catalog, block_status, updated_at'

/**
 * The new `updated_at`, strictly later than the one read. The write is guarded by `updated_at` equality, so a write
 * that stamped the SAME millisecond as the value it replaced would let a second writer holding that value through.
 */
function nextStamp(seen: string): string {
  const prev = Date.parse(seen)
  return new Date(Number.isFinite(prev) ? Math.max(Date.now(), prev + 1) : Date.now()).toISOString()
}

/**
 * One ledger mutation as an optimistic, conditional write on the kept draft: lands only while `updated_at` is what
 * the read saw, scoped to the claimant, and `.select()`s the row back — supabase-js reports no error for an UPDATE
 * that matched nothing, so "no error" is not "written". A lost race re-reads and re-decides.
 */
async function mutateKept<T>(userId: string, draftId: string, fn: (row: LedgerRow) => Mutation<T>): Promise<{ ok: true; result: T } | { ok: false }> {
  for (let attempt = 0; attempt < MUTATE_ATTEMPTS; attempt++) {
    const { data, error } = await db
      .from('shop_drafts')
      .select(LEDGER_COLUMNS)
      .eq('id', draftId)
      .eq('claimed_by', userId)
      .not('claimed_seller_id', 'is', null)
      .maybeSingle()
    if (error || !data) return { ok: false }
    const row = data as LedgerRow
    const m = fn(row)
    if (!m.write) return { ok: true, result: m.result }
    const { data: written, error: writeError } = await db
      .from('shop_drafts')
      .update({ ...m.write, updated_at: nextStamp(row.updated_at) })
      .eq('id', draftId)
      .eq('claimed_by', userId)
      .eq('updated_at', row.updated_at)
      .select('id')
    if (writeError) return { ok: false }
    if (Array.isArray(written) && written.length === 1) return { ok: true, result: m.result }
  }
  return { ok: false }
}

interface SellerListing {
  id: string
  title: string
  price_cents: number | null
  currency: string | null
  status: string
  images?: Array<{ url: string }>
  metadata?: Record<string, unknown> | null
}

const PAGE = 200
/** 10 pages = 2,000 products, the backend's own query ceiling. Past it the answer is "could not tell", not "none". */
const MAX_PAGES = 10

async function productsPage(clerkJwt: string, offset: number): Promise<{ listings: SellerListing[]; count: number } | null> {
  try {
    const res = await fetch(`${MEDUSA_BASE}/store/sellers/me/products?limit=${PAGE}&offset=${offset}`, {
      headers: { 'Content-Type': 'application/json', 'x-publishable-api-key': PUB_KEY, Authorization: `Bearer ${clerkJwt}` },
      cache: 'no-store',
    })
    if (!res.ok) return null
    const data = (await res.json().catch(() => null)) as { listings?: SellerListing[]; count?: number } | null
    if (!Array.isArray(data?.listings)) return null
    return { listings: data.listings, count: typeof data.count === 'number' ? data.count : data.listings.length }
  } catch {
    return null
  }
}

/** The seller's own Medusa products (drafts included), first page — the canvas and «Publicar». `null` = could not
 *  read, never "none". */
export async function listOwnProducts(clerkJwt: string): Promise<SellerListing[] | null> {
  return (await productsPage(clerkJwt, 0))?.listings ?? null
}

/**
 * The product a nonce created, by `metadata.p2s_nonce`. The seller products endpoint filters by title (`q`), id,
 * category, channel, stock and status — NOT by handle or metadata — and a title search would miss a card the
 * merchant edited between tries, so this pages through the whole list (`limit`/`offset`, backend-capped at 200).
 */
async function findByNonce(clerkJwt: string, nonce: string): Promise<string | null | 'unavailable'> {
  for (let page = 0; page < MAX_PAGES; page++) {
    const got = await productsPage(clerkJwt, page * PAGE)
    if (!got) return 'unavailable'
    const hit = got.listings.find((l) => l.metadata?.p2s_nonce === nonce)
    if (hit) return hit.id
    if (got.listings.length < PAGE || (page + 1) * PAGE >= got.count) return null
  }
  return 'unavailable'
}

export function confirmDeps(userId: string, clerkJwt: string): ConfirmDeps {
  return {
    resolveOwner: () => resolvePhotoOwner(userId, clerkJwt),
    mutate: (draftId, fn) => mutateKept(userId, draftId, fn),
    spend: async () => {
      // Bounded (SPEND_TIMEOUT_MS) so a `pending` entry can never outlive the takeover window while still live. An
      // abort reads as an error → refused and released; if the RPC committed anyway, one photo is lost (the
      // accepted worst case), never a double product.
      const { data, error } = await db.rpc('spend_ai_allowance', {
        p_subject: userSubject(userId),
        p_kind: 'photo',
        p_period: monthPeriod(new Date()),
        p_cap: P2S_LIMITS.photosPerMonth,
      }).abortSignal(AbortSignal.timeout(SPEND_TIMEOUT_MS))
      return { data, error }
    },
    findCreated: (nonce) => findByNonce(clerkJwt, nonce),
    createProduct: (row, imageUrl, nonce) =>
      createSellerProduct(
        clerkJwt,
        buildCreateBody(row, [{ url: imageUrl, alt: row.title }], {
          status: 'draft',
          // Medusa handles are globally unique: a second create for the same suggestion fails instead of duplicating.
          handle: `p2s-${nonce}`,
          metadata: { p2s_nonce: nonce, created_via: 'p2s_photo' },
        }),
        undefined,
        { timeoutMs: CREATE_TIMEOUT_MS },
      ),
    log,
    now: () => new Date(),
  }
}
