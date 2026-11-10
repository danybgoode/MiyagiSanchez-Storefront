/**
 * A promoter pays the platform its share of a package BY CARD (epic 08 · plans-gratis-negocio S4.2, README D12 as
 * amended: settled at source). The promoter collected the full price in person; the card pays exactly the
 * platform's share (price − the promoter's rate). The webhook then writes the package's grants (plan-tienda D11:
 * Negocio, and for `tienda_anual` Tienda after it, dated from the payment day) and records the attribution as paid
 * with the full list price, accruing nothing — the promoter already kept their part.
 *
 * Card only, and the grant is written only for a `paid` session, so a delayed method can never give Negocio away.
 *
 * server-only.
 */
import 'server-only'
import type Stripe from 'stripe'
import { createOneTimeCheckout } from '@/lib/stripe-subscriptions'
import { tg } from '@/lib/telegram'
import { db } from '@/lib/supabase'
import { markAttributionPaid } from '@/lib/promoter'
import { notifyMerchantCloseReceipt } from '@/lib/promoter-close-notify'
import { applyNegocioPayment, applyTiendaPayment } from '@/lib/negocio-webhook'
import { PACKAGES, applyPackageGrants, isPackageSku, packageSplit, type PackageGrantDeps, type PackageSku } from '@/lib/promoter-packages'
import { formatReceiptAmount } from '@/lib/promoter-receipt'
import { runPackageSteps } from '@/lib/promoter-package-steps'
import type { PlanWebhookOutcome } from '@/lib/plan-subscription-sync'

export const PROMOTER_PACKAGE_CHECKOUT_KIND = 'promoter_package'

function canonicalOrigin(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com'
}

export async function startPackageCardCheckout(input: {
  sku: PackageSku
  ratePct: number
  promoterId: string
  shopId: string
  buyerEmail?: string
}): Promise<string> {
  const split = packageSplit(input.sku, input.ratePct)
  const origin = canonicalOrigin()
  return createOneTimeCheckout({
    amountCents: split.payPlatformCents,
    currency: 'MXN',
    productName: `${PACKAGES[input.sku].label} — parte de Miyagi Sánchez`,
    successUrl: `${origin}/promotor/cerrar?paquete=pagado`,
    cancelUrl: `${origin}/promotor/cerrar?paquete=cancelado`,
    metadata: {
      kind: PROMOTER_PACKAGE_CHECKOUT_KIND,
      promoter_sku: input.sku,
      promoter_id: input.promoterId,
      shop_id: input.shopId,
      gross_cents: String(split.chargeCents),
      paid_by_promoter: '1',
    },
    buyerEmail: input.buyerEmail,
    paymentMethodTypes: ['card'],
  })
}

/** Is this package's attribution already paid? Three states: true, false, or a THROW when it could not be read — "could
 *  not look" must never become "not paid", which would send the merchant a second receipt. */
async function packageAlreadyPaid(input: { promoterId: string; shopId: string; sku: PackageSku }): Promise<boolean> {
  const { data, error } = await db
    .from('marketplace_promoter_attributions')
    .select('status')
    .eq('promoter_id', input.promoterId)
    .eq('seller_id', input.shopId)
    .eq('sku', input.sku)
    .is('payment_ref', null)
    .maybeSingle()
  if (error) throw new Error(`package attribution read failed: ${error.message}`)
  return (data as { status?: string } | null)?.status === 'paid'
}

/**
 * Record the package attribution; true when it landed. A row that does not land is ALERTED (pr-reviewer, #474): it
 * anchors the promoter's renewal and upgrade shares, and markAttributionPaid never throws.
 */
export async function recordPackageAttribution(input: { promoterId: string; shopId: string; sku: PackageSku; gross: number; sessionId: string }): Promise<boolean> {
  const r = await markAttributionPaid({ promoterId: input.promoterId, sellerId: input.shopId, sku: input.sku, grossAmountCents: input.gross, cadence: 'one_time', skipAccrual: true })
  if (r !== 'recorded') {
    tg.alert(`🚨 Paquete ${input.sku} cobrado pero la atribución del promotor NO se registró — Stripe lo reintentará; si sigue, reparar a mano (de ella dependen la renovación y el cambio de plan).\nShop: ${input.shopId}\nPromotor: ${input.promoterId}\nPago: ${input.sessionId}`)
  }
  return r === 'recorded'
}

/** The plan seam's two appliers, as `applyPackageGrants` takes them. */
export const PACKAGE_GRANT_DEPS: PackageGrantDeps = {
  apply: (plan, input) => (plan === 'negocio' ? applyNegocioPayment(input) : applyTiendaPayment(input)),
}

export async function handlePromoterPackageComplete(session: Stripe.Checkout.Session): Promise<PlanWebhookOutcome> {
  const sku = session.metadata?.promoter_sku
  const shopId = session.metadata?.shop_id
  const promoterId = session.metadata?.promoter_id
  const gross = Number(session.metadata?.gross_cents)
  // `final`: the same session carries the same facts on every delivery, so no retry can fix these. Said once.
  if (session.payment_status !== 'paid') {
    tg.alert(`⚠️ Paquete de promotor: sesión completada SIN pago (${session.payment_status}) — no se activó.\nSession: ${session.id}`)
    return 'final'
  }
  // A RETIRED package is still honoured here: the sale route refuses it (410) before any checkout is created, so a
  // retired session can only be one opened before the retirement, and that money was already taken (D11).
  if (!isPackageSku(sku) || !shopId || !promoterId || !Number.isInteger(gross) || gross <= 0) {
    console.error('[promoter package] bad metadata:', session.id)
    tg.alert(`🚨 Paquete de promotor PAGADO con datos inválidos — revisar.\nSession: ${session.id}`)
    return 'final'
  }
  // The order and why each step may or may not repeat: lib/promoter-package-steps.ts.
  return runPackageSteps({
    applyGrants: () => applyPackageGrants({ sku, shopId, paymentId: session.id }, PACKAGE_GRANT_DEPS),
    onGrantFailed: (e) => {
      console.error('[promoter package] grant write failed:', e)
      tg.alert(
        `🚨 Paquete de promotor PAGADO pero el plan NO quedó completo — Stripe lo reintentará y completa solo lo que falta; si sigue, reparar a mano.\nShop: ${shopId}\nSession: ${session.id}\n` +
        `Error: ${e instanceof Error ? e.message : String(e)}`,
      )
    },
    alreadyPaid: () => packageAlreadyPaid({ promoterId, shopId, sku }),
    // Settled at source: the promoter kept their part, so nothing accrues; the attribution records the full price.
    attribution: () => recordPackageAttribution({ promoterId, shopId, sku, gross, sessionId: session.id }),
    oneTime: async (kind) => {
      if (kind === 'comp') {
        // Refused at sale start, so only a race gets here: the promoter paid for a shop that already has Negocio.
        tg.alert(`⚠️ Paquete ${PACKAGES[sku].label} pagado en una tienda que ya tenía Negocio sin costo — revisar reembolso.\nShop: ${shopId}\nSession: ${session.id}`)
        return
      }
      notifyMerchantCloseReceipt({
        shopId,
        promoterId,
        items: [{ label: PACKAGES[sku].summary, amountMxn: formatReceiptAmount(gross) }],
      }).catch((e) => console.error('[promoter package] receipt failed:', e))
      tg.alert(`✅ Paquete ${PACKAGES[sku].label} pagado por el promotor — ${packageGrantsLine(sku)}\nShop: ${shopId}`)
    },
  })
}

/** «Negocio 3 meses + Tienda 12 meses» for the operator's alert. */
export function packageGrantsLine(sku: PackageSku): string {
  const grants = PACKAGES[sku].grants
  return grants.length ? grants.map((g) => `${g.plan === 'negocio' ? 'Negocio' : 'Tienda'} ${g.months} meses`).join(' + ') : 'sin plan'
}
