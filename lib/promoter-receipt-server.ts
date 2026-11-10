/**
 * lib/promoter-receipt-server.ts — the I/O half of «El recibo del negocio» (promoter-panel S4.1, D10). The decisions
 * live in `lib/promoter-receipt.ts`; this file only reads what they need.
 *
 * The status reads LIVE on every visit: the attribution turns `paid` when our share lands (card webhook, or the admin
 * approving a transfer), so the same link reads «Pendiente» today and «Activo» tomorrow without a second message.
 *
 * Three states, never two: a read that fails is `unavailable`, never «Pendiente» and never a 404. The decisions and
 * the queries live in `lib/promoter-receipt-read.ts`, testable with an injected database.
 */
import 'server-only'
import { db } from '@/lib/supabase'
import type { ReceiptPayload } from '@/lib/promoter-receipt'
import { readReceiptViewWith, type ReceiptDb, type ReceiptView } from '@/lib/promoter-receipt-read'

export function receiptSecret(): string | null {
  return process.env.CLAIM_JWT_SECRET || null
}

export type { ReceiptView } from '@/lib/promoter-receipt-read'

/** Everything the receipt page shows, or null when the shop or the promoter is confirmed gone (the page then 404s). */
export function readReceiptView(payload: ReceiptPayload): Promise<ReceiptView | null> {
  return readReceiptViewWith(db as unknown as ReceiptDb, payload, new Date())
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
