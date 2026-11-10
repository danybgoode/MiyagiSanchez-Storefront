/**
 * The I/O shell for the pause job (epic 08 · plan-tienda-three-free-months S3.3, README D9). Every decision is in
 * `lib/plan-pause.ts`; this file reads, writes and calls, and nothing else.
 *
 *   readPage         — owned shops (`clerk_user_id` set), ordered by `created_at` then `id` so paging is stable.
 *   readPlan         — `resolvePlan` on a FRESH read of the shop's metadata: uncached (it reads Medusa Commerce
 *                      directly, never the slug cache), and a failure is null, never "unpaid".
 *   readMarket       — the shop's Medusa seller, read FRESH from `/store/sellers/:slug` (`readShopFresh`, no cache),
 *                      trusted only when its id equals the mirror's `medusa_seller_id`, and validated against the
 *                      market registry (`readPublicSellerMarket`) — the same projection and identity check the admin
 *                      directory uses (lib/admin/tenant-directory-server.ts). `marketplace_shops` has no market
 *                      column; the market is Medusa's (`seller.market_code`, from its operating market). Anything
 *                      unreadable is `unknown`, which never pauses.
 *   readSellerStatus — the Backend's `GET /internal/sellers/:id/status`, through the admin's own client.
 *   claim            — `merge_shop_metadata_guards` (`planPauseClaimArgs`), counted only when the returned row
 *                      carries exactly the claim written.
 *   pause            — `POST /internal/sellers/:id/status { status: 'paused', reason: 'plan_unpaid' }` through
 *                      `changeSellerStatus`, the same transport the admin uses.
 *   release          — `merge_shop_metadata` with an `equals` guard on the claim written (`planPauseClearArgs`).
 *   readClaim        — `plan_pause` read fresh, for the settle step (lib/plan-pause.ts explains the race).
 *   unpause          — the same status route with `active`, reason `plan_paid`: the settle step's undo.
 *   restoreClaim     — puts the claim back only where none is (guard absent, then json_null).
 *
 * server-only.
 */
import 'server-only'
import { db } from '@/lib/supabase'
import { tg } from '@/lib/telegram'
import { readPlanLegacyState } from '@/lib/plan'
import { resolvePlan } from '@/lib/plan-server'
import { DEFAULT_PAGE_SIZE } from '@/lib/paged-read'
import { readShopFresh } from '@/lib/listings'
import { readPublicSellerMarket } from '@/lib/owned-market'
import { medusaSellerIdOf } from '@/lib/admin/tenant-directory'
import { changeSellerStatus, readSellerStatus } from '@/lib/admin/tenant-status'
import {
  PLAN_PAUSE_REASON,
  claimLanded,
  planPauseClaimArgs,
  planPauseClearArgs,
  unpauseOutcomeOf,
  PLAN_PAUSE_KEY,
  PLAN_RESTORE_REASON,
  planPauseMarketOf,
  pauseOutcomeOf,
  type PauseCandidate,
  type PlanPauseMarket,
  type PlanPauseDeps,
  type SellerStatusFact,
} from '@/lib/plan-pause'

/** Read a shop's metadata fresh; null = could not read (or no such shop). */
async function freshMetadata(shopId: string): Promise<{ metadata: unknown } | null> {
  const { data, error } = await db.from('marketplace_shops').select('metadata').eq('id', shopId).maybeSingle()
  if (error || !data) return null
  return { metadata: (data as { metadata: unknown }).metadata }
}

/** A shop's market from its Medusa seller (see the header). Shared with the notices' shell. Never throws. */
export async function readShopMarket(slug: string | null, metadata: unknown): Promise<PlanPauseMarket> {
  const expectedId = medusaSellerIdOf(metadata)
  if (!slug || !expectedId) return 'unknown'
  const read = await readShopFresh(slug).catch(() => null)
  if (!read || read.state !== 'resolved') return 'unknown'
  // A seller with another id is not this shop's: its market says nothing about it.
  if (read.shop.id !== expectedId) return 'unknown'
  return planPauseMarketOf(readPublicSellerMarket(read.shop)?.market_code)
}

export function planPauseDeps(): PlanPauseDeps {
  return {
    pageSize: DEFAULT_PAGE_SIZE,
    readPage: async (from, to) => {
      const { data, error } = await db
        .from('marketplace_shops')
        .select('id, slug, name, clerk_user_id, metadata')
        .not('clerk_user_id', 'is', null)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
      if (error || !Array.isArray(data)) return null
      return data as PauseCandidate[]
    },
    readPlan: async (shop) => {
      const fresh = await freshMetadata(shop.id)
      if (!fresh || !shop.clerk_user_id) return null
      const plan = await resolvePlan(fresh.metadata, { sellerClerkId: shop.clerk_user_id, shopId: shop.id })
      return plan.reason === 'unavailable' ? null : plan
    },
    readLegacy: readPlanLegacyState,
    readMarket: (shop) => readShopMarket(shop.slug, shop.metadata),
    readSellerStatus: async (shop): Promise<SellerStatusFact> => {
      const read = await readSellerStatus(medusaSellerIdOf(shop.metadata))
      if (read.state === 'resolved') return read.status
      if (read.state === 'unavailable') return 'unavailable'
      return 'no_seller'
    },
    claim: async (shop, claim) => {
      // Guarded on what was read WITH THE PAGE — the same metadata the decision used.
      const { data, error } = await db.rpc('merge_shop_metadata_guards', planPauseClaimArgs(shop.id, shop.metadata, claim))
      if (error || !Array.isArray(data) || data.length !== 1) return false
      return claimLanded((data[0] as { metadata: unknown }).metadata, claim)
    },
    pause: async (shop) => {
      const medusaSellerId = medusaSellerIdOf(shop.metadata)
      if (!medusaSellerId) return { outcome: 'failed', detail: 'no medusa_seller_id' }
      return pauseOutcomeOf(await changeSellerStatus({ medusaSellerId, status: 'paused', reason: PLAN_PAUSE_REASON }))
    },
    release: async (shop, claim) => {
      const { data, error } = await db.rpc('merge_shop_metadata', planPauseClearArgs(shop.id, claim))
      return !error && Array.isArray(data) && data.length === 1
    },
    readClaim: async (shop) => {
      const fresh = await freshMetadata(shop.id)
      if (!fresh) return 'unavailable'
      const meta = fresh.metadata && typeof fresh.metadata === 'object' ? (fresh.metadata as Record<string, unknown>) : {}
      return meta[PLAN_PAUSE_KEY] ?? null
    },
    unpause: async (shop) => {
      const medusaSellerId = medusaSellerIdOf(shop.metadata)
      if (!medusaSellerId) return { outcome: 'failed', detail: 'no medusa_seller_id' }
      return unpauseOutcomeOf(await changeSellerStatus({ medusaSellerId, status: 'active', reason: PLAN_RESTORE_REASON }))
    },
    restoreClaim: async (shop, claim) => {
      // Only where no claim is: absent, or the JSON null a release leaves. Never over another value.
      for (const mode of ['absent', 'json_null'] as const) {
        const { data, error } = await db.rpc('merge_shop_metadata', { p_shop_id: shop.id, p_patch: { [PLAN_PAUSE_KEY]: claim }, p_guard_key: PLAN_PAUSE_KEY, p_guard_mode: mode, p_expected: null })
        if (!error && Array.isArray(data) && data.length === 1) return true
      }
      return false
    },
    alert: (m) => tg.alert(m),
    now: () => new Date(),
  }
}
