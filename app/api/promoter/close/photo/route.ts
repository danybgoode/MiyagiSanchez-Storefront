/**
 * POST /api/promoter/close/photo  { shopId | slug, imageUrl }
 *
 * A bound promoter turns a photo they just uploaded into a suggested product card for the shop they are opening
 * (epic 08 · plans-gratis-negocio S5.1, README D14). The answer only FILLS the workspace form; publishing still goes
 * through `/api/promoter/close/listing`. Both routes write only to a shop this promoter opened (or holds a
 * relationship for) that nobody has claimed (`promoterShopEditAccess`, promoter-panel D1); only the shop's NAME reaches
 * the model.
 *
 * Auth: Clerk session + a bound promoter. Allowance: the promoter's own daily vision budget (fails closed).
 */
import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { isEnabled } from '@/lib/flags'
import { checkRateLimit } from '@/lib/ratelimit'
import { db } from '@/lib/supabase'
import { getPromoterByClerkId } from '@/lib/promoter'
import { resolveTargetShop } from '@/lib/promoter-server'
import { promoterShopEditAccess } from '@/lib/promoter-shop-access'
import { shopEditRefusal } from '@/lib/promoter-close'
import { budgetPeriod } from '@/lib/prompt-to-shop/allowance'
import { photoHosts, fetchOwnImage } from '@/lib/prompt-to-shop/photo-server'
import { callModelBody, MODEL_CONFIGURED } from '@/lib/prompt-to-shop/server'
import { PROMOTER_PHOTO_ANALYSES_PER_DAY, promoterPhotoSubject, suggestFromPhoto } from '@/lib/promoter-photo'

export const dynamic = 'force-dynamic'

const VISION_TIMEOUT_MS = 25_000

export async function POST(req: NextRequest) {
  if (!(await isEnabled('promoter.enabled'))) return NextResponse.json({ ok: false }, { status: 404 })
  const user = await currentUser().catch(() => null)
  if (!user) return NextResponse.json({ ok: false, error: 'No autorizado' }, { status: 401 })
  const promoter = await getPromoterByClerkId(user.id)
  if (!promoter) return NextResponse.json({ ok: false, error: 'Vincula tu código de promotor primero.' }, { status: 403 })

  let raw: unknown = null
  try { raw = await req.json() } catch { /* validated below */ }
  const body = (raw && typeof raw === 'object' ? raw : {}) as { shopId?: unknown; slug?: unknown; imageUrl?: unknown }
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined)
  // A non-string id is a bad request, never a 500 from `.trim()` downstream (pr-reviewer nit, #475).
  if ((body.shopId !== undefined && !text(body.shopId)) || (body.slug !== undefined && !text(body.slug))) {
    return NextResponse.json({ ok: false, error: 'Tienda no válida.' }, { status: 400 })
  }
  const shop = await resolveTargetShop({ shopId: text(body.shopId), slug: text(body.slug) })
  if (!shop) return NextResponse.json({ ok: false, error: 'Tienda no encontrada.' }, { status: 404 })
  // Same rule as the package close (Codex security, #474): only a shop this promoter opened or holds a relationship with.
  // Same rule as adding a product (promoter-panel D1): opened by this promoter and not yet claimed.
  const refusal = shopEditRefusal(await promoterShopEditAccess({ promoter, shop }))
  if (refusal) return NextResponse.json({ ok: false, error: refusal.error }, { status: refusal.status })

  const result = await suggestFromPhoto(
    { promoterClerkId: user.id, imageUrl: body.imageUrl, shopName: shop.name ?? null },
    {
      hosts: photoHosts(),
      burstAllowed: async () => (await checkRateLimit('p2s_photo', `promoter:${promoter.id}`)).allowed,
      spend: async () => {
        const { data, error } = await db.rpc('spend_ai_allowance', {
          p_subject: promoterPhotoSubject(promoter.id),
          p_kind: 'daily_budget',
          p_period: budgetPeriod(new Date()),
          p_cap: PROMOTER_PHOTO_ANALYSES_PER_DAY,
        })
        return { data, error }
      },
      modelConfigured: MODEL_CONFIGURED,
      fetchImage: fetchOwnImage,
      callModel: (request) => callModelBody(request as unknown as Record<string, unknown>, VISION_TIMEOUT_MS),
    },
  )
  return NextResponse.json(result.body, { status: result.status })
}
