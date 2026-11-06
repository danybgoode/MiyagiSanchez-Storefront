/**
 * POST /api/promoter/close/migration — a bound promoter charges the `migration`
 * SKU on a MERCHANT'S behalf (epic 03 · platform-migrations, Sprint 2 ·
 * US-2.1/US-2.2). A clone of `/api/promoter/close/ml-sync`'s shape, with one
 * load-bearing difference: the charge amount is NEVER read from the request
 * body — `lib/migration-checkout.ts#resolveMigrationCharge` is the sole
 * source (a stored quote's total, or the admin flat price), so a close can
 * never charge an amount that differs from what the merchant saw ("the API is
 * the guarantee, the UI is courtesy").
 *
 * `paymentMethod: 'transfer'` (behind `promoter.transfer_enabled`) starts a
 * net-remittance close instead of Stripe — same resolved amount, nothing
 * activates until admin approval.
 */
import { promoterMayCloseShop } from '@/lib/promoter-shop-access'
import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { isEnabled } from '@/lib/flags'
import { getPromoterByClerkId } from '@/lib/promoter'
import { resolveTargetShop } from '@/lib/promoter-server'
import { startMigrationCheckout, resolveMigrationCharge } from '@/lib/migration-checkout'
import { startPromoterTransferClose } from '@/lib/promoter-transfers'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (!(await isEnabled('promoter.enabled')) || !(await isEnabled('migrations.connector_enabled'))) {
    return NextResponse.json({ ok: false }, { status: 404 })
  }

  const user = await currentUser().catch(() => null)
  if (!user) return NextResponse.json({ ok: false, error: 'No autorizado' }, { status: 401 })

  const rl = await checkRateLimit('checkout', getClientIp(req))
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: 'Demasiados intentos. Espera un momento.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  const promoter = await getPromoterByClerkId(user.id)
  if (!promoter) {
    return NextResponse.json({ ok: false, error: 'Vincula tu código de promotor primero.' }, { status: 403 })
  }

  // Intentionally NO amount/price field is ever read from `body` — the tamper
  // case (a client sending one anyway) has nothing to act on downstream.
  let body: { shopId?: string; slug?: string; quoteId?: string; paymentMethod?: string; transferMethod?: string } = {}
  try { body = await req.json() } catch { /* validated below */ }

  const shop = await resolveTargetShop({ shopId: body.shopId, slug: body.slug })
  if (!shop) return NextResponse.json({ ok: false, error: 'Tienda no encontrada.' }, { status: 404 })
  // The same rule as a package close (pr-reviewer, #480): only a shop this promoter opened or holds a relationship for,
  // never their own. Before this any promoter could start a migration charge on any shop.
  if (!(await promoterMayCloseShop({ promoter, shop }))) {
    return NextResponse.json({ ok: false, error: 'Solo puedes cobrar en las tiendas que tú abriste.' }, { status: 403 })
  }

  if (body.paymentMethod === 'transfer') {
    if (!(await isEnabled('promoter.transfer_enabled'))) {
      return NextResponse.json({ ok: false }, { status: 404 })
    }
    const charge = await resolveMigrationCharge({ shopId: shop.id, quoteId: body.quoteId })
    if (!charge.ok) return NextResponse.json({ ok: false, error: charge.error }, { status: charge.status })

    const transferResult = await startPromoterTransferClose({
      promoter,
      sku: 'migration',
      basePriceCents: charge.amountCents,
      sellerId: shop.id,
      transferMethod: body.transferMethod,
    })
    if (!transferResult.ok) return NextResponse.json({ ok: false, error: transferResult.error }, { status: transferResult.status })
    return NextResponse.json({ ok: true, transfer: transferResult.transfer })
  }

  const result = await startMigrationCheckout({
    shopId: shop.id,
    sellerClerkId: shop.clerkUserId ?? '',
    quoteId: body.quoteId,
    buyerEmail: user.emailAddresses?.[0]?.emailAddress,
    promoterId: promoter.id,
    paidByPromoter: true,
  })

  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status })
  return NextResponse.json({ ok: true, url: result.url })
}
