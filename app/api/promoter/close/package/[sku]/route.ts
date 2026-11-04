/**
 * POST /api/promoter/close/package/<sku>  { shopId | slug, paymentMethod: 'transfer' | 'card', transferMethod? }
 *
 * A bound promoter closes one of the three packages on a merchant's shop (epic 08 · plans-gratis-negocio S4.2, D12):
 * `negocio_anual` (setup + 12 months of Negocio), `negocio_arranque` (setup + 3 months), `setup_gratis` (setup on the
 * free plan). The promoter collected the package price in person and sends the platform only its share:
 *   - `transfer` → a pending SPEI/DiMo/CoDi transfer of (price − the promoter's rate), approved by the admin, which then
 *     adds the months of Negocio (`activatePromoterOneTimeGrant`);
 *   - `card`     → a card checkout for exactly that share; the webhook adds the months
 *     (`handlePromoterPackageComplete`).
 * Either way the price is the package's own list price (no promoter discount, no clamp) and nothing accrues.
 *
 * Auth: Clerk session + a bound promoter, like every `/api/promoter/close/*` route. Nothing in the body sets a price.
 */
import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { isEnabled } from '@/lib/flags'
import { getCommissionRates, getPromoterByClerkId } from '@/lib/promoter'
import { resolveTargetShop } from '@/lib/promoter-server'
import { startPromoterTransferClose } from '@/lib/promoter-transfers'
import { PACKAGES, isPackageSku } from '@/lib/promoter-packages'
import { startPackageCardCheckout } from '@/lib/promoter-package-server'
import { promoterMayCloseShop } from '@/lib/promoter-shop-access'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ sku: string }> }) {
  if (!(await isEnabled('promoter.enabled'))) return NextResponse.json({ ok: false }, { status: 404 })

  const user = await currentUser().catch(() => null)
  if (!user) return NextResponse.json({ ok: false, error: 'No autorizado' }, { status: 401 })

  const { sku } = await params
  if (!isPackageSku(sku)) return NextResponse.json({ ok: false, error: 'Paquete no válido.' }, { status: 404 })

  const rl = await checkRateLimit('checkout', getClientIp(req))
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: 'Demasiados intentos. Espera un momento.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  const promoter = await getPromoterByClerkId(user.id)
  if (!promoter) return NextResponse.json({ ok: false, error: 'Vincula tu código de promotor primero.' }, { status: 403 })

  let body: { shopId?: string; slug?: string; paymentMethod?: string; transferMethod?: string } = {}
  try { body = await req.json() } catch { /* validated below */ }
  const shop = await resolveTargetShop({ shopId: body.shopId, slug: body.slug })
  if (!shop) return NextResponse.json({ ok: false, error: 'Tienda no encontrada.' }, { status: 404 })
  // Only a shop this promoter opened or holds a relationship with (Codex security, #474): a package grants Negocio and
  // makes the promoter the renewal beneficiary, so it can never be attached to someone else's shop.
  if (!(await promoterMayCloseShop({ promoter, shop }))) {
    return NextResponse.json({ ok: false, error: 'Solo puedes cerrar paquetes en tiendas que abriste tú.' }, { status: 403 })
  }

  if (body.paymentMethod === 'transfer') {
    if (!(await isEnabled('promoter.transfer_enabled'))) return NextResponse.json({ ok: false }, { status: 404 })
    const result = await startPromoterTransferClose({
      promoter,
      sku,
      basePriceCents: PACKAGES[sku].priceMxn * 100,
      sellerId: shop.id,
      transferMethod: body.transferMethod,
    })
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status })
    return NextResponse.json({ ok: true, transfer: result.transfer })
  }

  const rates = await getCommissionRates()
  try {
    const url = await startPackageCardCheckout({
      sku,
      ratePct: rates[sku] ?? 0,
      promoterId: promoter.id,
      shopId: shop.id,
      buyerEmail: user.emailAddresses?.[0]?.emailAddress,
    })
    return NextResponse.json({ ok: true, url })
  } catch (e) {
    console.error('[promoter package] checkout failed:', e)
    return NextResponse.json({ ok: false, error: 'No se pudo iniciar el pago.' }, { status: 502 })
  }
}
