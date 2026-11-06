/**
 * lib/promoter-receipt-server.ts — the I/O half of «El recibo del negocio» (promoter-panel S4.1, D10). The decisions
 * live in `lib/promoter-receipt.ts`; this file only reads what they need.
 *
 * The status reads LIVE on every visit: the attribution turns `paid` when our share lands (card webhook, or the admin
 * approving a transfer), so the same link reads «Pendiente» today and «Activo» tomorrow without a second message.
 *
 * Three states, never two: a read that fails is `unavailable`, never «Pendiente». Telling a merchant their payment is
 * still being confirmed because WE could not read the table would be a confident falsehood.
 */
import 'server-only'
import { db } from '@/lib/supabase'
import { getPromoterById } from '@/lib/promoter'
import { readNegocioGrant } from '@/lib/plan'
import { resolveTargetShop } from '@/lib/promoter-server'
import { receiptStatus, type ReceiptPayload, type ReceiptStatus } from '@/lib/promoter-receipt'

export function receiptSecret(): string | null {
  return process.env.CLAIM_JWT_SECRET || null
}

export type ReceiptView = {
  shopName: string
  promoterName: string | null
  promoterCode: string
  status: ReceiptStatus | { kind: 'unavailable' }
}

/** Everything the receipt page shows, or null when the shop or the promoter no longer exists (the page then 404s). */
export async function readReceiptView(payload: ReceiptPayload): Promise<ReceiptView | null> {
  const [shop, promoter] = await Promise.all([resolveTargetShop({ shopId: payload.shopId }), getPromoterById(payload.promoterId)])
  if (!shop || !promoter) return null

  const [attribution, transfer] = await Promise.all([
    db
      .from('marketplace_promoter_attributions')
      .select('status')
      .eq('promoter_id', payload.promoterId)
      .eq('seller_id', payload.shopId)
      .eq('sku', payload.sku)
      .is('payment_ref', null)
      .maybeSingle(),
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

  const base = { shopName: shop.name, promoterName: promoter.name ?? null, promoterCode: promoter.code }
  if (attribution.error || transfer.error) return { ...base, status: { kind: 'unavailable' } }
  return {
    ...base,
    status: receiptStatus({
      sku: payload.sku,
      attributionPaid: (attribution.data as { status?: string } | null)?.status === 'paid',
      transferStatus: (transfer.data as { status?: string } | null)?.status ?? null,
      negocioEndsAt: readNegocioGrant(shop.metadata)?.expires_at ?? null,
    }),
  }
}

/**
 * Who receives the receipt: the owner's WhatsApp and name from the promoter's OWN relationship row for this shop, and
 * an email from the shop (captured at setup) or that row. A failed read is `null`: the promoter still gets the link to
 * copy, and the panel says there is no WhatsApp saved.
 */
export async function readReceiptRecipient(input: { shopId: string; promoterId: string; shopMetadata: Record<string, unknown> }): Promise<{
  whatsappE164: string | null
  ownerName: string | null
  email: string | null
}> {
  const { data, error } = await db
    .from('merchant_relationships')
    .select('whatsapp_e164, contact_name, email_normalized')
    .eq('promoter_id', input.promoterId)
    .eq('shop_id', input.shopId)
    .limit(1)
    .maybeSingle()
  const row = error ? null : (data as { whatsapp_e164: string | null; contact_name: string | null; email_normalized: string | null } | null)
  const shopEmail = typeof input.shopMetadata.merchant_email === 'string' && input.shopMetadata.merchant_email.includes('@') ? input.shopMetadata.merchant_email : null
  return { whatsappE164: row?.whatsapp_e164 ?? null, ownerName: row?.contact_name ?? null, email: shopEmail ?? row?.email_normalized ?? null }
}
