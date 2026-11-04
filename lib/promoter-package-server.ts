/**
 * A promoter pays the platform its share of a package BY CARD (epic 08 · plans-gratis-negocio S4.2, README D12 as
 * amended: settled at source). The promoter collected the full price in person; the card pays exactly the
 * platform's share (price − the promoter's rate). The webhook then adds the package's months of Negocio (none for the
 * free-plan setup) and records the attribution as paid with the full list price, accruing nothing — the promoter
 * already kept their part.
 *
 * Card only, and the grant is written only for a `paid` session, so a delayed method can never give Negocio away.
 *
 * server-only.
 */
import 'server-only'
import type Stripe from 'stripe'
import { createOneTimeCheckout } from '@/lib/stripe-subscriptions'
import { tg } from '@/lib/telegram'
import { markAttributionPaid } from '@/lib/promoter'
import { notifyMerchantCloseReceipt } from '@/lib/promoter-close-notify'
import { applyNegocioPayment } from '@/lib/negocio-webhook'
import { PACKAGES, isPackageSku, packageSplit, type PackageSku } from '@/lib/promoter-packages'

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

export async function handlePromoterPackageComplete(session: Stripe.Checkout.Session): Promise<void> {
  const sku = session.metadata?.promoter_sku
  const shopId = session.metadata?.shop_id
  const promoterId = session.metadata?.promoter_id
  const gross = Number(session.metadata?.gross_cents)
  if (session.payment_status !== 'paid') {
    tg.alert(`⚠️ Paquete de promotor: sesión completada SIN pago (${session.payment_status}) — no se activó.\nSession: ${session.id}`)
    return
  }
  if (!isPackageSku(sku) || !shopId || !promoterId || !Number.isInteger(gross) || gross <= 0) {
    console.error('[promoter package] bad metadata:', session.id)
    tg.alert(`🚨 Paquete de promotor PAGADO con datos inválidos — revisar.\nSession: ${session.id}`)
    return
  }
  const months = PACKAGES[sku].negocioMonths
  if (months > 0) {
    try {
      const outcome = await applyNegocioPayment({ shopId, paymentId: session.id, months, note: `promoter ${sku}` })
      if (outcome === 'replay') {
        // The grant was already counted, but the attribution may not have landed on the first delivery (Codex, #474):
        // re-record it — markAttributionPaid is idempotent — and send no second receipt or alert.
        await markAttributionPaid({ promoterId, sellerId: shopId, sku, grossAmountCents: gross, cadence: 'one_time', skipAccrual: true })
        return
      }
    } catch (e) {
      console.error('[promoter package] grant write failed:', e)
      tg.alert(
        `🚨 Paquete de promotor PAGADO pero Negocio NO activado — reparar a mano.\nShop: ${shopId}\nSession: ${session.id}\n` +
        `Error: ${e instanceof Error ? e.message : String(e)}`,
      )
      return
    }
  }
  // Settled at source: the promoter kept their part, so nothing accrues; the attribution records the full price.
  await markAttributionPaid({ promoterId, sellerId: shopId, sku, grossAmountCents: gross, cadence: 'one_time', skipAccrual: true })
  notifyMerchantCloseReceipt({
    shopId,
    promoterId,
    items: [{ label: PACKAGES[sku].summary, amountMxn: `$${(gross / 100).toLocaleString('en-US')} MXN` }],
  }).catch((e) => console.error('[promoter package] receipt failed:', e))
  tg.alert(`✅ Paquete ${PACKAGES[sku].label} pagado por el promotor${months ? ` — Negocio ${months} meses` : ''}\nShop: ${shopId}`)
}
