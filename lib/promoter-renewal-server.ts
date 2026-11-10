/**
 * The promoter's shares after the sale (epic 08 · plans-gratis-negocio S4.3 D13; plan-tienda-three-free-months S4.2,
 * D14): 10% of a year-2 renewal, of Plan Negocio (`negocio_renewal`) or of Plan Tienda (`tienda_renewal`).
 *
 * Called by the Stripe webhook on every plan payment the MERCHANT makes (a monthly invoice, or a yearly one-time
 * payment). If the shop's earliest package that opens this renewal's window (`RENEWAL_ANCHOR_SKUS`) was sold by a
 * promoter, and this payment falls 12–24 months after that package payment (`decideRenewalShare`), it records an
 * attribution of the renewal sku for that promoter — one per payment, keyed by the Stripe payment id in `payment_ref`
 * (unique since plans-gratis-negocio M1), so a replayed webhook finds its row and adds nothing — and accrues the
 * commission at that sku's rate (10%, seeded by the M1 migrations) through the existing accrual path. The admin
 * settles it like any other commission.
 *
 * Best-effort: a failure here never blocks the merchant's own payment; it is logged and alerted.
 *
 * server-only.
 */
import 'server-only'
import { db } from '@/lib/supabase'
import { tg } from '@/lib/telegram'
import { accrueCommissionForAttribution } from '@/lib/promoter'
import {
  RENEWAL_ANCHOR_SKUS,
  RENEWAL_SKU,
  TIENDA_RENEWAL_SKU,
  decideRenewalShare,
  type RenewalSku,
  type ShareSku,
} from '@/lib/promoter-packages'

export type RenewalOutcome = 'recorded' | 'replay' | 'not_attributed' | 'outside_window' | 'failed'

const SHARE_NAME: Record<ShareSku, string> = {
  negocio_renewal: 'renovación de Plan Negocio (10%)',
  tienda_renewal: 'renovación de Plan Tienda (10%)',
  negocio_upgrade: 'cambio de Plan Tienda a Plan Negocio (20%)',
}

/**
 * Record ONE share attribution under `paymentRef` and accrue it. A 23505 on `payment_ref` means this exact share was
 * already recorded: the (idempotent) accrual is re-run in case it was the step that failed, and `replay` is returned.
 * The commission row is then verified, because `accrueCommissionForAttribution` never throws (pr-reviewer, #474).
 * Shared by the renewals and the upgrade share; throws on any failure (the caller alerts).
 */
export async function recordShareAttribution(input: {
  sku: ShareSku
  promoterId: string
  shopId: string
  paymentRef: string
  grossCents: number
  cadence: string
}): Promise<'recorded' | 'replay'> {
  const { data: inserted, error: insertError } = await db
    .from('marketplace_promoter_attributions')
    .insert({
      promoter_id: input.promoterId,
      seller_id: input.shopId,
      sku: input.sku,
      gross_amount_cents: input.grossCents,
      cadence: input.cadence,
      status: 'paid',
      payment_ref: input.paymentRef,
    })
    .select('id')
    .maybeSingle()
  let attributionId: string
  let outcome: 'recorded' | 'replay' = 'recorded'
  if (insertError) {
    if (insertError.code !== '23505') throw new Error(`${input.sku} attribution insert failed: ${insertError.message}`)
    const { data: existing } = await db.from('marketplace_promoter_attributions').select('id').eq('payment_ref', input.paymentRef).maybeSingle()
    if (!existing) throw new Error(`${input.sku} attribution exists by payment_ref but could not be read`)
    attributionId = (existing as { id: string }).id
    outcome = 'replay'
  } else {
    if (!inserted) throw new Error(`${input.sku} attribution insert returned no row`)
    attributionId = (inserted as { id: string }).id
  }
  await accrueCommissionForAttribution(attributionId)
  const { data: commission, error: commissionError } = await db
    .from('marketplace_promoter_commissions')
    .select('id')
    .eq('attribution_id', attributionId)
    .maybeSingle()
  // Throw text kept from plans-gratis-negocio (e2e/promoter-packages.spec.ts pins it).
  if (commissionError || !commission) throw new Error('renewal commission did not accrue')
  return outcome
}

/** Alert a share that did not land: the merchant's payment stands, the promoter's share must be repaired by hand. */
export function alertShareFailed(sku: ShareSku, shopId: string, paymentRef: string, e: unknown): void {
  console.error(`[promoter ${sku}] failed:`, e)
  tg.alert(`⚠️ Comisión por ${SHARE_NAME[sku]} NO registrada — revisar.\nShop: ${shopId}\nPago: ${paymentRef}\nError: ${e instanceof Error ? e.message : String(e)}`)
}

/** The renewal share of `renewalSku` for one merchant payment. Never throws. */
export async function recordRenewalShareFor(
  renewalSku: RenewalSku,
  input: { shopId: string; paymentRef: string; grossCents: number; paidAt: Date },
): Promise<RenewalOutcome> {
  const { shopId, paymentRef, grossCents, paidAt } = input
  if (!shopId || !paymentRef || !(grossCents > 0)) return 'not_attributed'
  try {
    const { data: first, error } = await db
      .from('marketplace_promoter_attributions')
      .select('promoter_id, sku, created_at')
      .eq('seller_id', shopId)
      .in('sku', [...RENEWAL_ANCHOR_SKUS[renewalSku]])
      .eq('status', 'paid')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(`attribution read failed: ${error.message}`)
    const row = first as { promoter_id: string; sku: string; created_at: string } | null
    const decision = decideRenewalShare({ renewalSku, anchor: row ? { sku: row.sku, paidAt: new Date(row.created_at) } : null, paidAt })
    if (decision.action === 'skip' || !row) return decision.action === 'skip' ? decision.reason : 'not_attributed'
    return await recordShareAttribution({ sku: renewalSku, promoterId: row.promoter_id, shopId, paymentRef, grossCents, cadence: 'renewal' })
  } catch (e) {
    alertShareFailed(renewalSku, shopId, paymentRef, e)
    return 'failed'
  }
}

/** 10% of a merchant's year-2 Plan Negocio payment (plans-gratis-negocio D13). Signature unchanged for its callers. */
export function recordRenewalShare(input: { shopId: string; paymentRef: string; grossCents: number; paidAt: Date }): Promise<RenewalOutcome> {
  return recordRenewalShareFor(RENEWAL_SKU, input)
}

/**
 * 10% of a merchant's Plan Tienda payment in year 2 of the shop's first package (plan-tienda S4.2, D14).
 *
 * WIRING (the orchestrator, after rebasing on sprint 2, which owns the Plan Tienda payment paths): call this ONCE per
 * merchant Plan Tienda payment that was RECORDED — never for a replay, and never for a promoter package's Tienda grant
 * (that is a package sale, written by `applyPackageGrants`, not a merchant payment):
 *   1. the yearly one-time Plan Tienda checkout, where its grant write came back `written`:
 *      `{ shopId, paymentRef: session.id, amountCents: session.amount_total ?? 0, paidAt: new Date(completedAt * 1000) }`
 *      (the event's own timestamp, never processing time — Codex security, #474);
 *   2. every paid monthly Plan Tienda invoice, only when `invoice.amount_paid > 0` (a $0 free-period invoice is not a
 *      payment): `{ shopId, paymentRef: invoice.id, amountCents: invoice.amount_paid, paidAt: status_transitions.paid_at }`.
 * Never throws; a failure alerts.
 */
export function accrueTiendaPaymentShare(input: { shopId: string; paymentRef: string; amountCents: number; paidAt: Date }): Promise<RenewalOutcome> {
  return recordRenewalShareFor(TIENDA_RENEWAL_SKU, {
    shopId: input.shopId,
    paymentRef: input.paymentRef,
    grossCents: input.amountCents,
    paidAt: input.paidAt,
  })
}
