/**
 * The I/O shell for the restore after a plan payment (epic 08 · plan-tienda-three-free-months S3.4, README D10).
 * Every decision is in `lib/plan-restore.ts`; this reads the shop, calls the Backend status route through the
 * admin's own transport (`changeSellerStatus`, reason `plan_paid`; the Backend relinks the catalog from its ledger),
 * and clears `plan_pause` afterwards with an `equals` guard on the value read.
 *
 * server-only.
 */
import 'server-only'
import { db } from '@/lib/supabase'
import { tg } from '@/lib/telegram'
import { medusaSellerIdOf } from '@/lib/admin/tenant-directory'
import { changeSellerStatus } from '@/lib/admin/tenant-status'
import { PLAN_RESTORE_REASON, planPauseClearArgs } from '@/lib/plan-pause'
import { restoreAfterPlanPaid, restoreOutcomeOf, type PlanRestoreDeps, type PlanRestoreOutcome } from '@/lib/plan-restore'

const RESTORE_DB: PlanRestoreDeps = {
  readMetadata: async (shopId) => {
    const { data, error } = await db.from('marketplace_shops').select('metadata').eq('id', shopId).maybeSingle()
    if (error) throw new Error(`shop read failed: ${error.message}`)
    return data ? ((data as { metadata: unknown }).metadata ?? {}) : null
  },
  activate: async (_shopId, metadata) => {
    const medusaSellerId = medusaSellerIdOf(metadata)
    if (!medusaSellerId) return { outcome: 'failed', detail: 'no medusa_seller_id' }
    return restoreOutcomeOf(await changeSellerStatus({ medusaSellerId, status: 'active', reason: PLAN_RESTORE_REASON }))
  },
  clearClaim: async (shopId, expected) => {
    const { data, error } = await db.rpc('merge_shop_metadata', planPauseClearArgs(shopId, expected))
    return !error && Array.isArray(data) && data.length === 1
  },
  alert: (m) => tg.alert(m),
}

/** Bring a shop paused for lack of a plan back, after a payment was recorded. Never throws. */
export function restorePlanPausedShop(shopId: string): Promise<PlanRestoreOutcome> {
  return restoreAfterPlanPaid(shopId, RESTORE_DB)
}
