/**
 * POST /api/sell/ml/subscribe
 *
 * Start a Stripe checkout for the ML-sync paid SKU (epic 03 · mercadolibre-sync,
 * Sprint 6). A faithful clone of the subdomain subscribe route. The PLATFORM is the
 * payee (no connected account, no 97% transfer). On payment the webhook activates a
 * Medusa Subscription (recurring) or writes a one-time `ml_sync_grant`, which flips
 * the ML-sync entitlement seam on (the sync toggle unlocks).
 *
 * Auth required (seller session) — checked BEFORE any plan/secret resolution.
 * Gated behind `ml.sync_enabled` (the whole ML-sync surface is dark until that flag
 * is on). Accepts an optional cadence (`recurring` default | `one_time`), interval
 * (`year` default | `month`), and promoter code. Returns `{ url }` to redirect to Stripe.
 */
import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { isEnabled } from '@/lib/flags'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { detectChannel } from '@/lib/channel'
import { startMlSyncCheckout } from '@/lib/ml-sync-subscription-checkout'
import { resolveMlSyncEntitlement } from '@/lib/ml-sync-entitlement-server'

export async function POST(req: NextRequest) {
  const user = await currentUser()
  if (!user) {
    return NextResponse.json({ error: 'Debes iniciar sesión.', code: 'AUTH_REQUIRED' }, { status: 401 })
  }

  // Dark-ship gate (auth-first, so anonymous is always 401 regardless of the flag).
  if (!(await isEnabled('ml.sync_enabled'))) {
    return NextResponse.json({ error: 'No disponible.' }, { status: 404 })
  }

  const rl = await checkRateLimit('checkout', getClientIp(req))
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Demasiados intentos. Espera un momento.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  let cadence: string | null = null
  let interval: string | null = null
  let promoterCode: string | null = null
  try {
    const body = (await req.json()) as { cadence?: unknown; interval?: unknown; promoterCode?: unknown }
    if (typeof body?.cadence === 'string') cadence = body.cadence
    if (typeof body?.interval === 'string') interval = body.interval
    if (typeof body?.promoterCode === 'string') promoterCode = body.promoterCode
  } catch {
    // No / empty body — recurring yearly checkout.
  }

  const { data: shop } = await db
    .from('marketplace_shops')
    .select('id, slug, metadata')
    .eq('clerk_user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!shop) {
    return NextResponse.json({ error: 'Tienda no encontrada.' }, { status: 404 })
  }

  // Already entitled (comp / live one-time grant / active subscription) ⇒ no buy.
  // `startMlSyncCheckout` short-circuits an active SUBSCRIPTION, but not a live GRANT
  // (a comp or a prepaid year) — this closes that double-charge gap uniformly via the
  // same entitlement seam the UI gates on. (cross-review #154.)
  const entitlement = await resolveMlSyncEntitlement(shop.metadata, { sellerClerkId: user.id, shopId: shop.id })
  if (entitlement.entitled) {
    return NextResponse.json(
      { error: 'Ya tienes la sincronización de Mercado Libre activa.', alreadyActive: true },
      { status: 409 },
    )
  }

  const result = await startMlSyncCheckout({
    shopId: shop.id,
    sellerClerkId: user.id,
    buyerEmail: user.emailAddresses?.[0]?.emailAddress,
    channel: detectChannel(req),
    cadence,
    interval,
    promoterCode,
  })

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.alreadyActive ? { alreadyActive: true } : {}) },
      { status: result.status },
    )
  }

  return NextResponse.json({ url: result.url })
}
