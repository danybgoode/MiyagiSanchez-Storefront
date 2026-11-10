/**
 * The promoter's shares after the sale (epic 08 · plans-gratis-negocio S4.3 D13; plan-tienda-three-free-months S4.2,
 * D14): 10% of a year-2 renewal, of Plan Negocio (`negocio_renewal`) or of Plan Tienda (`tienda_renewal`).
 *
 * Called by the Stripe webhook on every plan payment the MERCHANT makes (a monthly invoice, or a yearly one-time
 * payment). If the shop's earliest package that opens this renewal's window (`RENEWAL_ANCHOR_SKUS`) was sold by a
 * promoter, and this payment falls in the 12 months after that package's paid time ends (`decideRenewalShare`,
 * `renewalWindowMonths`), it records an
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
import { accrueCommissionOutcome } from '@/lib/promoter'
import { accrualSettles } from '@/lib/promoter-commission'
import { runUpgradeShare } from '@/lib/promoter-upgrade-share'
import {
  NEGOCIO_PACKAGE_SKUS,
  RENEWAL_ANCHOR_SKUS,
  RENEWAL_SKU,
  TIENDA_RENEWAL_SKU,
  UPGRADE_SKU,
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
 * The accrual says what it amounted to (`accrueCommissionOutcome`): a real failure throws (pr-reviewer, #474), a share
 * the rules do not pay is done.
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
  // Settled = a commission row now exists, OR the rules say none is owed (a 0% rate, a self-referral, a promoter off
  // the track): both are done. Only a real read or write failure throws, so the webhook retries it (verifier, PR 486).
  const accrual = await accrueCommissionOutcome(attributionId)
  if (!accrualSettles(accrual)) throw new Error(`${input.sku} commission could not be recorded: ${accrual.kind === 'failed' ? accrual.error : ''}`)
  if (accrual.kind === 'will_not_accrue') console.info(`[promoter ${input.sku}] recorded, no commission owed: ${accrual.reason}`)
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
 *   1. the yearly one-time Plan Tienda checkout, where its grant write came back `written` OR `replay` (a redelivery
 *      after a failed share must still record it; the `payment_ref` key makes the second call add nothing):
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

export type UpgradeOutcome = 'recorded' | 'replay' | 'no_anchor' | 'outside_window' | 'superseded' | 'not_attributed' | 'failed'

/**
 * 20% of the FIRST Plan Negocio payment a shop makes within 12 months of a `tienda_anual` package (plan-tienda S4.3,
 * D14), to the promoter who sold that package. Called for every merchant Negocio payment (yearly one-time, every
 * monthly invoice): the decision (`decideUpgradeShare`) and the anchor-keyed `payment_ref` make every payment after
 * the first one collide and add nothing. Never called for a promoter's Negocio package — that is a package sale, not
 * an upgrade (see `recordNegocioPaymentShares`). Never throws; a failure alerts.
 */
export async function recordUpgradeShare(input: { shopId: string; paymentRef: string; grossCents: number; paidAt: Date }): Promise<UpgradeOutcome> {
  const { shopId, paymentRef, grossCents, paidAt } = input
  if (!shopId || !paymentRef || !(grossCents > 0)) return 'not_attributed'
  try {
    // Validate → claim → apply (lib/promoter-upgrade-share.ts): a Negocio package that lands between the check and the
    // share's row is seen by the re-check after the claim, and no 20% accrues.
    return await runUpgradeShare({ paidAt, grossCents }, {
      readAnchor: async () => {
        // The shop's LATEST paid tienda_anual attribution. A repeat sale by the SAME promoter updates that row in place
        // (`markAttributionPaid`, one row per promoter, shop and sku), keeping the FIRST sale's `created_at`: so the
        // window and the single share belong to that first sale, and a repeat sale by the same promoter opens neither.
        // A tienda_anual sold by ANOTHER promoter is its own row, its own window and its own share.
        const { data, error } = await db
          .from('marketplace_promoter_attributions')
          .select('id, promoter_id, created_at')
          .eq('seller_id', shopId)
          .eq('sku', 'tienda_anual')
          .eq('status', 'paid')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (error) throw new Error(`tienda_anual attribution read failed: ${error.message}`)
        const row = data as { id: string; promoter_id: string; created_at: string } | null
        return row ? { attributionId: row.id, promoterId: row.promoter_id, paidAt: new Date(row.created_at) } : null
      },
      negocioPackageAfter: async (after) => {
        const { data, error } = await db
          .from('marketplace_promoter_attributions')
          .select('id')
          .eq('seller_id', shopId)
          .in('sku', [...NEGOCIO_PACKAGE_SKUS])
          .eq('status', 'paid')
          .gt('created_at', after.toISOString())
          .limit(1)
          .maybeSingle()
        // Could not look ≠ none: refuse to decide rather than pay a share that a package may have superseded.
        if (error) throw new Error(`Negocio package read failed: ${error.message}`)
        return !!data
      },
      claim: async ({ promoterId, paymentRef: ref, grossCents: gross }) => {
        // `claimed` does not accrue: the accrual pays only `paid` rows. `ref` is the anchor's, not this payment's.
        const { data, error } = await db
          .from('marketplace_promoter_attributions')
          .insert({ promoter_id: promoterId, seller_id: shopId, sku: UPGRADE_SKU, gross_amount_cents: gross, cadence: 'upgrade', status: 'claimed', payment_ref: ref })
          .select('id, status')
          .maybeSingle()
        if (!error && data) return data as { id: string; status: string }
        if (error && error.code !== '23505') throw new Error(`negocio_upgrade claim failed: ${error.message}`)
        const { data: existing, error: readError } = await db.from('marketplace_promoter_attributions').select('id, status').eq('payment_ref', ref).maybeSingle()
        if (readError || !existing) throw new Error(`negocio_upgrade row exists by payment_ref but could not be read${readError ? `: ${readError.message}` : ''}`)
        return existing as { id: string; status: string }
      },
      voidClaim: async (id) => {
        const { error } = await db.from('marketplace_promoter_attributions').update({ status: 'void' }).eq('id', id).eq('status', 'claimed')
        if (error) throw new Error(`negocio_upgrade void failed: ${error.message}`)
      },
      confirmClaim: async (id) => {
        const { error } = await db.from('marketplace_promoter_attributions').update({ status: 'paid' }).eq('id', id).eq('status', 'claimed')
        if (error) throw new Error(`negocio_upgrade confirm failed: ${error.message}`)
        // Read back: the conditional write may have lost to a concurrent void or confirm; the row's state decides.
        const { data, error: readError } = await db.from('marketplace_promoter_attributions').select('status').eq('id', id).maybeSingle()
        if (readError || !data) throw new Error(`negocio_upgrade read-back failed${readError ? `: ${readError.message}` : ''}`)
        return (data as { status: string }).status
      },
      accrue: (id) => accrueCommissionOutcome(id),
    })
  } catch (e) {
    alertShareFailed(UPGRADE_SKU, shopId, paymentRef, e)
    return 'failed'
  }
}

/**
 * Every share a MERCHANT's own Plan Negocio payment can earn a promoter (D13, D14): the year-2 Negocio renewal and
 * the Tienda-to-Negocio upgrade. Called from the Negocio payment paths in lib/negocio-webhook.ts — the yearly one-time
 * checkout (only when its grant was `written`, and never for a checkout that carries a `promoter_sku`) and every paid
 * monthly invoice (the first one included) — and from nowhere else. A promoter's Negocio PACKAGE never calls it: a
 * promoter who sells a Negocio package to a Tienda shop they opened kept the package share; paying them 20% more of
 * their own sale would pay twice for one move up.
 */
export async function recordNegocioPaymentShares(input: { shopId: string; paymentRef: string; grossCents: number; paidAt: Date }): Promise<boolean> {
  // Both are always tried; false when either did not land (it alerted), so the webhook answers `retry` and the
  // redelivery records only the missing one — the other collides on its `payment_ref` and adds nothing.
  const renewal = await recordRenewalShare(input)
  const upgrade = await recordUpgradeShare(input)
  return renewal !== 'failed' && upgrade !== 'failed'
}
