/**
 * POST /api/promoter/close/receipt  { shopId, sku }
 *
 * «Sí, ya me pagó» (promoter-panel S4.1, D10). The promoter says the owner just paid them for a package. This mints the
 * merchant's receipt link (`/recibo/<token>`), returns a WhatsApp link to the owner's number with the message from the
 * locale, and emails the receipt when the owner left an email, all in the same call.
 *
 * Why: the merchant handed over cash and got nothing; the only receipt went out when OUR share settled, days later by
 * transfer and often to the promoter. The receipt page reads its status live, so the same link turns «Activo» later.
 *
 * Auth: Clerk session + a bound promoter + `promoterMayCloseShop` (only a shop they opened or hold a relationship with),
 * like every `/api/promoter/close/*` route. Nothing in the body sets an amount: it is the package's own list price.
 */
import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { isEnabled } from '@/lib/flags'
import { getPromoterByClerkId } from '@/lib/promoter'
import { resolveTargetShop } from '@/lib/promoter-server'
import { promoterMayCloseShop } from '@/lib/promoter-shop-access'
import { PACKAGES, RETIRED_PACKAGE_MESSAGE, isPackageSku, isRetiredPackageSku, packagePriceMxn } from '@/lib/promoter-packages'
import { fillTemplate, formatReceiptAmount, formatReceiptDate, receiptWhatsappUrl, signReceiptToken } from '@/lib/promoter-receipt'
import { readReceiptRecipient, receiptSecret } from '@/lib/promoter-receipt-server'
import { sendPromoterReceipt } from '@/lib/email'
import { getOverriddenDictionary } from '@/lib/copy-overrides'
import { SITE_ORIGIN } from '@/lib/market-seo'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (!(await isEnabled('promoter.enabled'))) return NextResponse.json({ ok: false }, { status: 404 })

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
  if (!promoter) return NextResponse.json({ ok: false, error: 'Vincula tu código de promotor primero.' }, { status: 403 })

  let body: { shopId?: string; sku?: string } = {}
  try { body = await req.json() } catch { /* validated below */ }
  if (!isPackageSku(body.sku)) return NextResponse.json({ ok: false, error: 'Elige qué le vendiste.' }, { status: 400 })
  // A new receipt records a new sale, and a retired package is no longer sold (plan-tienda D11). Receipts already
  // issued for one still open: `verifyReceiptToken` accepts every package in the vocabulary.
  if (isRetiredPackageSku(body.sku)) return NextResponse.json({ ok: false, error: RETIRED_PACKAGE_MESSAGE }, { status: 410 })
  const sku = body.sku

  const shop = await resolveTargetShop({ shopId: body.shopId })
  if (!shop) return NextResponse.json({ ok: false, error: 'Tienda no encontrada.' }, { status: 404 })
  // A receipt names the promoter as the one who was paid: only for a shop they opened or hold a relationship with.
  if (!(await promoterMayCloseShop({ promoter: { ...promoter, clerk_user_id: user.id }, shop }))) {
    return NextResponse.json({ ok: false, error: 'Solo puedes dar recibos de tiendas que abriste tú.' }, { status: 403 })
  }

  const secret = receiptSecret()
  if (!secret) return NextResponse.json({ ok: false, error: 'Configuración incompleta en el servidor.' }, { status: 500 })

  const amountCents = packagePriceMxn(sku) * 100
  const issuedAt = new Date().toISOString()
  const token = signReceiptToken({ shopId: shop.id, sku, promoterId: promoter.id, amountCents, issuedAt }, secret)
  const receiptUrl = `${SITE_ORIGIN}/recibo/${token}`

  const copy = (await getOverriddenDictionary('es')).promotorPanel
  const recipient = await readReceiptRecipient({ shopId: shop.id, promoterId: promoter.id, shopMetadata: shop.metadata })
  const values = {
    dueno: recipient.ownerName?.trim() || shop.name,
    promotor: promoter.name?.trim() || promoter.code,
    codigo: promoter.code,
    monto: formatReceiptAmount(amountCents),
    opcion: PACKAGES[sku].label,
    negocio: shop.name,
    fecha: formatReceiptDate(issuedAt),
    enlace: receiptUrl,
  }
  const whatsappUrl = receiptWhatsappUrl({ whatsappE164: recipient.whatsappE164, template: copy.cobra.whatsappMessage, values })

  let emailed = false
  if (recipient.email) {
    const r = await sendPromoterReceipt({
      to: recipient.email,
      subject: fillTemplate(copy.recibo.emailSubject, values),
      heading: fillTemplate(copy.recibo.title, values),
      lines: [fillTemplate(copy.recibo.paid, values), fillTemplate(copy.recibo.for, values)],
      ctaLabel: copy.recibo.emailCta,
      receiptUrl,
      idempotencyKey: `promoter-receipt/${shop.id}/${sku}`,
    }).catch(() => ({ ok: false as const }))
    emailed = r.ok
  }

  return NextResponse.json({ ok: true, receiptUrl, whatsappUrl, emailed })
}
