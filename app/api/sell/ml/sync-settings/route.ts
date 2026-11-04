import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { isEnabled } from '@/lib/flags'
import { resolveMlSyncEntitlement } from '@/lib/ml-sync-entitlement-server'
import { getSellerSyncEnabled, setSellerSyncEnabled } from '@/lib/ml-sync-settings'

/**
 * GET/POST /api/sell/ml/sync-settings — the seller-facing two-way ML stock-sync
 * enable (epic 03 · mercadolibre-sync S5 · US-14). S4 shipped the enable
 * backend-only; this gives it a Clerk-authed, entitlement-GATED surface.
 *
 * Order at every entry point is auth → flag → entitlement: anonymous is always 401
 * (auth precedes the flag, so the guard holds in both flag states — mirrors the
 * sibling ml/publish route), the route 404s until `ml.sync_enabled` is on, and
 * ENABLING is blocked (403 + upsell) unless the shop is entitled to the ML-sync
 * SKU. DISABLING is never gated — a seller can always turn sync off.
 *
 * Fail-safe: `ml.sync_paywall_enabled` defaults OFF ⇒ every connected seller is
 * entitled, so an already-enabled tester keeps working when the gate is off.
 */
export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'No autenticado.' }, { status: 401 })

  if (!(await isEnabled('ml.sync_enabled'))) {
    return NextResponse.json({ error: 'No disponible.' }, { status: 404 })
  }

  const { data: shop } = await db
    .from('marketplace_shops')
    .select('id, slug, metadata')
    .eq('clerk_user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!shop?.slug) return NextResponse.json({ error: 'Tienda no encontrada.' }, { status: 404 })

  const [entitlement, syncEnabled] = await Promise.all([
    resolveMlSyncEntitlement(shop.metadata, { sellerClerkId: userId, shopId: shop.id }),
    getSellerSyncEnabled(shop.slug),
  ])
  return NextResponse.json({
    sync_enabled: syncEnabled,
    entitled: entitlement.entitled,
    reason: entitlement.reason,
  })
}

export async function POST(req: NextRequest) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'No autenticado.' }, { status: 401 })

  if (!(await isEnabled('ml.sync_enabled'))) {
    return NextResponse.json({ error: 'No disponible.' }, { status: 404 })
  }

  const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null
  if (typeof body?.enabled !== 'boolean') {
    return NextResponse.json({ error: 'El valor "enabled" debe ser booleano.' }, { status: 422 })
  }
  const enabled = body.enabled

  const { data: shop } = await db
    .from('marketplace_shops')
    .select('id, slug, metadata')
    .eq('clerk_user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!shop?.slug) return NextResponse.json({ error: 'Tienda no encontrada.' }, { status: 404 })

  // Gate ENABLING only — disabling is always allowed (a seller can always stop sync).
  if (enabled) {
    const entitlement = await resolveMlSyncEntitlement(shop.metadata, { sellerClerkId: userId, shopId: shop.id })
    if (!entitlement.entitled) {
      return NextResponse.json(
        {
          error: 'La sincronización con Mercado Libre es una función de pago.',
          code: 'ML_SYNC_NOT_ENTITLED',
          upsell: true,
        },
        { status: 403 },
      )
    }
  }

  const result = await setSellerSyncEnabled(shop.slug, enabled)
  if (!result.ok) {
    if (result.reason === 'not_connected') {
      return NextResponse.json({ error: 'Conecta tu cuenta de Mercado Libre primero.' }, { status: 409 })
    }
    return NextResponse.json({ error: 'No pudimos actualizar la sincronización. Intenta de nuevo.' }, { status: 502 })
  }
  return NextResponse.json({ ok: true, sync_enabled: result.sync_enabled })
}
