/**
 * POST /api/promoter/import/shopify  { shopId | slug, batchId }
 *
 * The confirm after `/preview`: imports up to 150 staged products into the shop the promoter opened (epic 08 ·
 * promoter-panel D2/D4). Same rule as a typed product for private vs published (`resolvePromoterListingStatus`), the
 * same internal creation path (`importApprovedItems` with a `resolveSeller` that names this shop), and one consent
 * invalidation for the whole batch. A bigger catalog reports `overCap`; the rest is the paid migration, or the
 * merchant's own free import after the claim.
 *
 * The batch must have been staged for THIS shop (`connected_shop_id`), so a batch id from another shop is refused.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/supabase'
import { importApprovedItems } from '@/lib/supply-import'
import { refreshBatchCounts, type SupplyItem } from '@/lib/supply'
import { importCapPlan } from '@/lib/promoter-panel'
import { promoterImportPreamble } from '@/lib/promoter-import-server'
import { afterPromoterProductsAdded, resolvePromoterListingStatus } from '@/lib/promoter-listing-server'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  const pre = await promoterImportPreamble(req, { needsConnector: true })
  if (!pre.ok) return pre.response
  const { shop, body, promoter, userId } = pre.ctx

  const batchId = typeof body.batchId === 'string' ? body.batchId : ''
  if (!batchId) return NextResponse.json({ ok: false, error: 'Busca primero sus productos.' }, { status: 422 })

  const { data: batch } = await db.from('supply_batches').select('*').eq('id', batchId).maybeSingle()
  if (!batch) return NextResponse.json({ ok: false, error: 'No encontramos esa búsqueda. Búscalos otra vez.' }, { status: 404 })
  const settings = (batch.acquisition_settings ?? {}) as Record<string, unknown>
  if (batch.source_platform !== 'shopify' || settings.connected_shop_id !== shop.id) {
    return NextResponse.json({ ok: false, error: 'Esa búsqueda es de otra tienda.' }, { status: 403 })
  }

  const { data: all } = await db
    .from('supply_items')
    .select('*')
    .eq('batch_id', batch.id)
    .not('status', 'in', '("imported","duplicate")')
    .order('created_at', { ascending: true })
    .limit(2000)
  const pending = (all ?? []) as SupplyItem[]
  const plan = importCapPlan(pending.length)
  const items = pending.slice(0, plan.take)
  if (items.length === 0) return NextResponse.json({ ok: true, imported: 0, duplicate: 0, failed: 0, overCap: 0 })

  const status = await resolvePromoterListingStatus({ shop, promoterCode: promoter.code, clerkUserId: userId })
  if (!status.ok) return NextResponse.json({ ok: false, error: status.error }, { status: status.status })

  await db.from('supply_batches').update({ status: 'importing', error_message: null }).eq('id', batch.id)
  const { imported, duplicate, failed } = await importApprovedItems(items, {
    targetStatus: status.privatePreview ? 'draft' : 'published',
    // Into the shop the promoter opened — never a new unclaimed seller.
    resolveSeller: async () => ({ sellerSlug: shop.slug, mirrorId: shop.id }),
  })

  await refreshBatchCounts(batch.id)
  await db.from('supply_batches').update({
    status: failed > 0 ? 'failed' : 'imported',
    imported_at: new Date().toISOString(),
    error_message: failed > 0 ? `${failed} producto(s) fallaron durante la importación` : null,
  }).eq('id', batch.id)

  if (imported > 0) await afterPromoterProductsAdded(shop.id, status.privatePreview)
  return NextResponse.json({ ok: true, imported, duplicate, failed, overCap: plan.overCap })
}
