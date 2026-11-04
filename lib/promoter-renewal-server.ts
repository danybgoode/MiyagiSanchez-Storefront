/**
 * The promoter's 10% of a merchant's year-2 Negocio renewal (epic 08 · plans-gratis-negocio S4.3, README D13).
 *
 * Called by the Stripe webhook on every Negocio payment the MERCHANT makes (a monthly invoice, or a yearly one-time
 * payment). If the shop's first Negocio package was sold by a promoter, and this payment falls 12–24 months after that
 * first package payment (`isRenewalPayment`), it records a `negocio_renewal` attribution for that promoter — one per
 * payment, keyed by the Stripe payment id in `payment_ref` (unique since M1), so a replayed webhook finds its row and
 * adds nothing — and accrues the commission at the `negocio_renewal` rate (10%, seeded by M1) through the existing
 * accrual path. The admin settles it like any other commission.
 *
 * Best-effort: a failure here never blocks the merchant's own payment; it is logged and alerted.
 *
 * server-only.
 */
import 'server-only'
import { db } from '@/lib/supabase'
import { tg } from '@/lib/telegram'
import { accrueCommissionForAttribution } from '@/lib/promoter'
import { RENEWAL_SKU, isRenewalPayment, startsRenewalWindow } from '@/lib/promoter-packages'

export type RenewalOutcome = 'recorded' | 'replay' | 'not_attributed' | 'outside_window' | 'failed'

export async function recordRenewalShare(input: {
  shopId: string
  paymentRef: string
  grossCents: number
  paidAt: Date
}): Promise<RenewalOutcome> {
  const { shopId, paymentRef, grossCents, paidAt } = input
  if (!shopId || !paymentRef || !(grossCents > 0)) return 'not_attributed'
  try {
    const { data: first, error } = await db
      .from('marketplace_promoter_attributions')
      .select('promoter_id, sku, created_at')
      .eq('seller_id', shopId)
      .in('sku', ['negocio_anual', 'negocio_arranque'])
      .eq('status', 'paid')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(`attribution read failed: ${error.message}`)
    const row = first as { promoter_id: string; sku: string; created_at: string } | null
    if (!row || !startsRenewalWindow(row.sku)) return 'not_attributed'
    if (!isRenewalPayment(new Date(row.created_at), paidAt)) return 'outside_window'

    const { data: inserted, error: insertError } = await db
      .from('marketplace_promoter_attributions')
      .insert({
        promoter_id: row.promoter_id,
        seller_id: shopId,
        sku: RENEWAL_SKU,
        gross_amount_cents: grossCents,
        cadence: 'renewal',
        status: 'paid',
        payment_ref: paymentRef,
      })
      .select('id')
      .maybeSingle()
    if (insertError) {
      if (insertError.code === '23505') return 'replay' // this payment was already recorded
      throw new Error(`renewal attribution insert failed: ${insertError.message}`)
    }
    if (!inserted) throw new Error('renewal attribution insert returned no row')
    await accrueCommissionForAttribution((inserted as { id: string }).id)
    return 'recorded'
  } catch (e) {
    console.error('[promoter renewal] failed:', e)
    tg.alert(`⚠️ Comisión de renovación (10%) NO registrada — revisar.\nShop: ${shopId}\nPago: ${paymentRef}\nError: ${e instanceof Error ? e.message : String(e)}`)
    return 'failed'
  }
}
