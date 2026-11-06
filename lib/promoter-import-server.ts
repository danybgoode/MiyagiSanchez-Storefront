/**
 * lib/promoter-import-server.ts — the promoter's request preamble shared by the import routes (promoter-panel D2/D3):
 * the flags, the session, the bound promoter, the per-promoter rate limit, the shop, and the ownership guard (D1).
 * One preamble, so no import route can skip a step.
 */
import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { isEnabled } from '@/lib/flags'
import { checkRateLimit } from '@/lib/ratelimit'
import { getPromoterByClerkId } from '@/lib/promoter'
import { resolveTargetShop, type TargetShop } from '@/lib/promoter-server'
import { promoterShopEditAccess } from '@/lib/promoter-shop-access'
import { shopEditRefusal } from '@/lib/promoter-close'

export type PromoterImportContext = {
  userId: string
  promoter: { id: string; code: string }
  shop: TargetShop
  body: Record<string, unknown>
}

export async function promoterImportPreamble(
  req: NextRequest,
  opts: { needsConnector: boolean },
): Promise<{ ok: true; ctx: PromoterImportContext } | { ok: false; response: NextResponse }> {
  const fail = (status: number, error: string) => ({ ok: false as const, response: NextResponse.json({ ok: false, error }, { status }) })
  if (!(await isEnabled('promoter.enabled'))) return fail(404, 'No disponible.')
  if (opts.needsConnector && !(await isEnabled('migrations.connector_enabled'))) return fail(404, 'No disponible.')

  const user = await currentUser().catch(() => null)
  if (!user) return fail(401, 'No autorizado')
  const promoter = await getPromoterByClerkId(user.id)
  if (!promoter) return fail(403, 'Pon tu código de promotor primero.')

  const rl = await checkRateLimit('supply_import', `promoter:${promoter.id}`)
  if (!rl.allowed) return fail(429, 'Vas muy rápido. Espera un momento.')

  let body: Record<string, unknown> = {}
  try {
    const parsed: unknown = await req.json()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
  } catch { /* validated by the caller */ }

  const shopId = typeof body.shopId === 'string' ? body.shopId : undefined
  const slug = typeof body.slug === 'string' ? body.slug : undefined
  if (!shopId && !slug) return fail(400, 'Falta la tienda.')
  const shop = await resolveTargetShop({ shopId, slug })
  if (!shop) return fail(404, 'Tienda no encontrada.')

  const refusal = shopEditRefusal(await promoterShopEditAccess({ promoter, shop }))
  if (refusal) return fail(refusal.status, refusal.error)

  return { ok: true, ctx: { userId: user.id, promoter, shop, body } }
}
