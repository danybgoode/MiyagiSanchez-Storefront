/**
 * Prompt-to-shop — the real I/O behind `ClaimDeps` (epic S3.2, D16). Every decision lives in `claim.ts`.
 *
 * `ensureShop` and `applyStoreConfig` are called IN-PROCESS with the caller's own Clerk token. Never `fetch()` our
 * own `/api/sell/*` routes from here: a server-side request carries no session cookie (team memory, PR 244).
 */

import 'server-only'
import { revalidateTag } from 'next/cache'
import { applyStoreConfig } from '@/lib/apply-config-manifest'
import { ensureShop } from '@/lib/ensure-shop'
import { db } from '@/lib/supabase'
import type { ClaimDeps, ClaimRow, SellerLookup } from './claim'
import type { DraftBlocks } from './view'
import { coerceBlocks } from './access'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const PUB_KEY = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

const CLAIM_COLUMNS = 'id, device_id, identity, words, claimed_by, claimed_seller_id, expires_at'

/** GET /store/sellers/me in three states. A 404 is "no shop"; anything else that is not a 200 is "could not tell". */
export async function lookupSeller(clerkJwt: string): Promise<SellerLookup> {
  try {
    const res = await fetch(`${MEDUSA_BASE}/store/sellers/me`, {
      headers: { 'Content-Type': 'application/json', 'x-publishable-api-key': PUB_KEY, Authorization: `Bearer ${clerkJwt}` },
      cache: 'no-store',
    })
    if (res.status === 404) return { state: 'absent' }
    if (!res.ok) return { state: 'unavailable' }
    const body = (await res.json().catch(() => null)) as { seller?: { id?: unknown; slug?: unknown } } | null
    const id = body?.seller?.id
    const slug = body?.seller?.slug
    return typeof id === 'string' && typeof slug === 'string' ? { state: 'present', seller: { id, slug } } : { state: 'unavailable' }
  } catch {
    return { state: 'unavailable' }
  }
}

export function claimDeps(userId: string, clerkJwt: string): ClaimDeps {
  return {
    findSeller: () => lookupSeller(clerkJwt),
    claim: async (draftId, deviceId, user) => {
      const now = new Date().toISOString()
      const { data, error } = await db
        .from('shop_drafts')
        .update({ claimed_by: user, claimed_at: now, updated_at: now })
        .eq('id', draftId)
        .eq('device_id', deviceId)
        .is('claimed_by', null)
        .gt('expires_at', now)
        // A draft whose name and colours have not landed cannot become a shop; leave it claimable.
        .not('identity', 'is', null)
        .select(CLAIM_COLUMNS)
      if (error) throw new Error(error.message)
      return Array.isArray(data) && data.length === 1 ? (data[0] as ClaimRow) : null
    },
    reread: async (draftId) => {
      const { data, error } = await db.from('shop_drafts').select(CLAIM_COLUMNS).eq('id', draftId).maybeSingle()
      if (error) throw new Error(error.message)
      return (data as ClaimRow | null) ?? null
    },
    ensureShop: (input) => ensureShop(userId, clerkJwt, input),
    applyConfig: (manifest) => applyStoreConfig(userId, clerkJwt, manifest),
    markSeller: async (draftId, user, sellerId) => {
      // The 201 that precedes this proves the seller came from this draft, so the marker also re-asserts the claim
      // if a racing tab released it in the meantime (that tab saw a 200 and could not tell whose seller it was).
      const { data, error } = await db
        .from('shop_drafts')
        .update({ claimed_by: user, claimed_seller_id: sellerId, updated_at: new Date().toISOString() })
        .eq('id', draftId)
        .is('claimed_seller_id', null)
        .or(`claimed_by.eq.${user},claimed_by.is.null`)
        .select('id')
      return !error && Array.isArray(data) && data.length === 1
    },
    release: async (draftId, user) => {
      const { data, error } = await db
        .from('shop_drafts')
        .update({ claimed_by: null, claimed_at: null, updated_at: new Date().toISOString() })
        .eq('id', draftId)
        .eq('claimed_by', user)
        .is('claimed_seller_id', null)
        .select('id')
      return !error && Array.isArray(data) && data.length === 1
    },
    log: (line) => console.error('[p2s] claim', JSON.stringify(line)),
    // Same tags settings-import busts: the public shop must show the new name and colours on the next view.
    revalidate: () => {
      revalidateTag('shops', 'default')
      revalidateTag('listings', 'default')
    },
    now: () => new Date(),
  }
}

/** A kept draft, for the owner's view on /sell/armar. Read by the CLAIMANT's id, never by device. */
export interface KeptDraft {
  id: string
  blocks: DraftBlocks
  /** Null while a keep is half finished; the page then resumes it. */
  sellerId: string | null
}

const KEPT_COLUMNS = 'id, identity, words, catalog, block_status, claimed_seller_id'

export async function findKeptDraft(userId: string, draftId: string | null): Promise<KeptDraft | null | 'unavailable'> {
  let query = db.from('shop_drafts').select(KEPT_COLUMNS).eq('claimed_by', userId)
  query = draftId ? query.eq('id', draftId) : query.order('claimed_at', { ascending: false }).limit(1)
  const { data, error } = await query.maybeSingle()
  if (error) return 'unavailable'
  if (!data) return null
  const row = data as { id: string; identity: unknown; words: unknown; catalog: unknown; block_status: unknown; claimed_seller_id: string | null }
  return { id: row.id, blocks: coerceBlocks(row), sellerId: row.claimed_seller_id }
}
