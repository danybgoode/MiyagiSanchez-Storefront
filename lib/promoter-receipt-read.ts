/**
 * lib/promoter-receipt-read.ts — what the receipt page reads, with the database INJECTED (promoter-panel S4.1, D10).
 * No `server-only`, no supabase import: a spec hands it a fake query builder and asserts the exact filters and how
 * each failure maps to a state (pr-reviewer, #483: source-text specs could not see a dropped filter).
 *
 * Three states, never two, at every read:
 * - a row confirmed missing (the shop or the promoter is gone) → `null`, and the page answers 404;
 * - a read that FAILED → the receipt still renders from the signed token, with «unavailable» as its status. A merchant
 *   opening their receipt during a database blip must not be told it does not exist (pr-reviewer, #483).
 *
 * The promoter is read by id with NO program-track filter: a promoter later moved to another track must not turn every
 * receipt they ever issued into a 404.
 */
import { receiptStatus, type ReceiptPayload, type ReceiptStatus } from './promoter-receipt'
import { readNegocioGrant, readTiendaGrant } from './plan'

type Result = { data: unknown; error: unknown }
/** The slice of the supabase-js builder these reads use. */
export interface ReceiptQuery {
  select(columns: string): ReceiptQuery
  eq(column: string, value: string): ReceiptQuery
  is(column: string, value: null): ReceiptQuery
  order(column: string, opts: { ascending: boolean }): ReceiptQuery
  limit(n: number): ReceiptQuery
  maybeSingle(): PromiseLike<Result>
}
export interface ReceiptDb { from(table: string): ReceiptQuery }

export type ReceiptView = {
  shopName: string | null
  promoterName: string | null
  promoterCode: string | null
  status: ReceiptStatus | { kind: 'unavailable' }
}

export async function readReceiptViewWith(db: ReceiptDb, payload: ReceiptPayload, now: Date): Promise<ReceiptView | null> {
  const [shop, promoter, attribution, transfer] = await Promise.all([
    db.from('marketplace_shops').select('name, metadata').eq('id', payload.shopId).maybeSingle(),
    db.from('marketplace_promoters').select('name, code').eq('id', payload.promoterId).maybeSingle(),
    // One row per (promoter, shop, package): the partial unique index covers `payment_ref IS NULL`; renewals carry a
    // payment_ref and another sku, so they never answer here.
    db
      .from('marketplace_promoter_attributions')
      .select('status')
      .eq('promoter_id', payload.promoterId)
      .eq('seller_id', payload.shopId)
      .eq('sku', payload.sku)
      .is('payment_ref', null)
      .maybeSingle(),
    // The LATEST transfer for this package decides «Pendiente»: a repeat sale being confirmed now must never read as
    // the earlier sale's «Activo» (pr-reviewer, #483).
    db
      .from('marketplace_promoter_transfers')
      .select('status')
      .eq('promoter_id', payload.promoterId)
      .eq('seller_id', payload.shopId)
      .eq('sku', payload.sku)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  // Confirmed absence only: an error is not "missing".
  if ((!shop.error && !shop.data) || (!promoter.error && !promoter.data)) return null

  const s = (shop.data ?? null) as { name?: string | null; metadata?: unknown } | null
  const p = (promoter.data ?? null) as { name?: string | null; code?: string | null } | null
  const base = { shopName: s?.name ?? null, promoterName: p?.name ?? null, promoterCode: p?.code ?? null }
  if (shop.error || promoter.error || attribution.error || transfer.error) return { ...base, status: { kind: 'unavailable' } }

  return {
    ...base,
    status: receiptStatus({
      sku: payload.sku,
      attributionPaid: (attribution.data as { status?: string } | null)?.status === 'paid',
      transferStatus: (transfer.data as { status?: string } | null)?.status ?? null,
      negocioEndsAt: readNegocioGrant(s?.metadata)?.expires_at ?? null,
      tiendaEndsAt: readTiendaGrant(s?.metadata)?.expires_at ?? null,
      now,
    }),
  }
}
