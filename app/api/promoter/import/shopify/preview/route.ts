/**
 * POST /api/promoter/import/shopify/preview  { shopId | slug, domain }
 *
 * A promoter brings a Shopify merchant's catalog into the shop they just opened (epic 08 · promoter-panel D2). This
 * step reads the public store and stages it (`stageShopifyBatch`, SSRF-guarded centrally), and answers how many
 * products it found, a few examples, and how many fall over the 150 the panel imports (D4). Nothing is created yet.
 *
 * Gated by `promoter.enabled` + `migrations.connector_enabled`, a bound promoter, a per-promoter rate limit, and the
 * ownership guard (D1): only a shop this promoter opened that nobody has claimed.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/supabase'
import { isPublicDomainShape } from '@/lib/ssrf-guard'
import { stageShopifyBatch } from '@/lib/shopify-import-bridge'
import { importCapPlan } from '@/lib/promoter-panel'
import { promoterImportPreamble } from '@/lib/promoter-import-server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const pre = await promoterImportPreamble(req, { needsConnector: true })
  if (!pre.ok) return pre.response
  const { shop, body } = pre.ctx

  const domain = typeof body.domain === 'string' ? body.domain.trim() : ''
  if (!domain || !isPublicDomainShape(domain)) {
    return NextResponse.json({ ok: false, error: 'Escribe la dirección de su tienda, por ejemplo mitienda.com.' }, { status: 422 })
  }

  const staged = await stageShopifyBatch({ id: shop.id, slug: shop.slug }, domain)
  if (!staged.ok) {
    return NextResponse.json({ ok: false, error: 'No pudimos leer esa tienda. Revisa la dirección con el dueño.' }, { status: staged.status })
  }

  const { data: sample } = await db
    .from('supply_items')
    .select('listing_title, price_cents, images')
    .eq('batch_id', staged.batchId)
    .order('created_at', { ascending: true })
    .limit(5)

  const plan = importCapPlan(staged.itemCount)
  return NextResponse.json({
    ok: true,
    batchId: staged.batchId,
    total: staged.itemCount,
    take: plan.take,
    overCap: plan.overCap,
    sample: ((sample ?? []) as Array<{ listing_title: string | null; price_cents: number | null; images: Array<{ url: string }> | null }>).map((row) => ({
      title: row.listing_title ?? '',
      priceCents: row.price_cents,
      image: Array.isArray(row.images) && row.images[0]?.url ? row.images[0].url : null,
    })),
  })
}
