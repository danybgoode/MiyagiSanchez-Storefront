/**
 * POST /api/sell/negocio/checkout  { cadence: 'month' | 'year' }
 *
 * The signed-in owner buys Negocio for their own shop (epic 08 · plans-gratis-negocio S1.3, README D3). Returns
 * `{ ok: true, url }` (a Stripe Checkout URL) or `{ ok: false, error }` with the refusal's status.
 *
 * Auth first: anonymous is always 401. The shop is the caller's own (by `clerk_user_id`); nothing in the body names a
 * shop or a price — the cadence is the only input, and every amount comes from `lib/negocio-pricing.ts`. The refusal
 * rules (already on Negocio, a yearly grant blocking monthly, an unreadable subscription) live in the pure
 * `decideNegocioCheckout`.
 */
import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { readOwnedShop } from '@/lib/plan-server'
import { coerceNegocioCadence, startNegocioCheckout } from '@/lib/negocio-checkout'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Debes iniciar sesión.' }, { status: 401 })

  const rl = await checkRateLimit('checkout', getClientIp(req))
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: 'Demasiados intentos. Espera un momento.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  let cadence = null as ReturnType<typeof coerceNegocioCadence>
  try {
    cadence = coerceNegocioCadence(((await req.json()) as { cadence?: unknown })?.cadence)
  } catch {
    // fall through to the 400 below
  }
  if (!cadence) return NextResponse.json({ ok: false, error: 'Elige pago mensual o anual.' }, { status: 400 })

  let shop
  try {
    shop = await readOwnedShop(user.id)
  } catch {
    return NextResponse.json({ ok: false, error: 'No pudimos leer tu tienda. Intenta de nuevo.' }, { status: 503 })
  }
  if (!shop) return NextResponse.json({ ok: false, error: 'Tienda no encontrada.' }, { status: 404 })

  try {
    const result = await startNegocioCheckout({
      shopId: shop.id,
      shopMetadata: shop.metadata,
      sellerClerkId: user.id,
      buyerEmail: user.primaryEmailAddress?.emailAddress,
      cadence,
    })
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status })
    return NextResponse.json({ ok: true, url: result.url })
  } catch (e) {
    console.error('[negocio checkout] failed:', e)
    return NextResponse.json({ ok: false, error: 'No se pudo iniciar el pago. Intenta de nuevo.' }, { status: 502 })
  }
}
