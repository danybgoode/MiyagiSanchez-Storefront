/**
 * POST /api/admin/promoter/transfers/:id/approve
 *
 * Claims a `reported` transfer (atomic `reported → approved`), THEN activates the
 * SKU via the existing grant writer + marks the attribution paid — settled at
 * source, so this NEVER accrues a commission ledger row (the promoter already
 * kept it out of the cash they collected). Rolls the claim back to `reported` if
 * activation fails, so a transient failure is retryable, not a permanent
 * "approved but nothing happened" dead end. Notifies the promoter by email.
 *
 * Auth: Clerk admin session (via withAdmin). Promoter Funnel v2 · Sprint 4 (US-4.2).
 */
import { tg } from '@/lib/telegram'
import { NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { withAdmin } from '@/lib/admin/guard'
import { claimPromoterTransferForApproval, releasePromoterTransferClaim } from '@/lib/promoter-transfers'
import { activatePromoterOneTimeGrant } from '@/lib/promoter-grant-server'
import { markAttributionPaid, getPromoterById } from '@/lib/promoter'
import { resolveTargetShop } from '@/lib/promoter-server'
import { TRANSFER_SKU_LABEL } from '@/lib/promoter-transfer'
import { getSellerEmail, sendPromoterTransferApproved } from '@/lib/email'
import { notifyMerchantCloseReceipt } from '@/lib/promoter-close-notify'

export const dynamic = 'force-dynamic'

export const POST = withAdmin(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const admin = await currentUser().catch(() => null)

  const claimed = await claimPromoterTransferForApproval(id, admin?.id ?? null)
  if (!claimed.ok) {
    return NextResponse.json({ error: claimed.reason }, { status: claimed.reason === 'not_found' ? 404 : 409 })
  }
  const transfer = claimed.transfer

  const shop = await resolveTargetShop({ shopId: transfer.seller_id })
  const activated = await activatePromoterOneTimeGrant({
    sku: transfer.sku,
    shopId: transfer.seller_id,
    promoterId: transfer.promoter_id,
    sellerClerkId: shop?.clerkUserId ?? '',
    // The transfer's own id: a retried approval adds a package's Negocio months once (plans-gratis-negocio D12).
    paymentId: `transfer:${transfer.id}`,
  })
  if (!activated.ok) {
    await releasePromoterTransferClaim(id)
    return NextResponse.json({ error: activated.error }, { status: 502 })
  }

  const attributed = await markAttributionPaid({
    promoterId: transfer.promoter_id,
    sellerId: transfer.seller_id,
    sku: transfer.sku,
    grossAmountCents: transfer.gross_amount_cents,
    cadence: 'one_time',
    skipAccrual: true, // settled at source — never an accrued commission row
  })
  if (attributed !== 'recorded') {
    // It anchors a package's year-2 renewal share, and markAttributionPaid never throws (pr-reviewer, #474).
    tg.alert(`🚨 Transferencia aprobada pero la atribución del promotor NO se registró — reparar a mano.\nTransfer: ${transfer.id}\nShop: ${transfer.seller_id}`)
  }

  // Sprint 5 (US-5.5) — the merchant receipt, one per completed close.
  notifyMerchantCloseReceipt({
    shopId: transfer.seller_id,
    promoterId: transfer.promoter_id,
    items: [{
      label: TRANSFER_SKU_LABEL[transfer.sku],
      amountMxn: `$${(transfer.gross_amount_cents / 100).toFixed(2)} MXN`,
    }],
  }).catch((e) => console.error('[promoter-transfers] merchant receipt failed:', e))

  const promoter = await getPromoterById(transfer.promoter_id)
  if (promoter?.clerk_user_id) {
    const email = await getSellerEmail(promoter.clerk_user_id)
    if (email) {
      sendPromoterTransferApproved({
        to: email,
        skuLabel: TRANSFER_SKU_LABEL[transfer.sku],
        owedMxn: `$${(transfer.owed_cents / 100).toFixed(2)} MXN`,
      }).catch((e) => console.error('[promoter-transfers] approved email failed:', e))
    }
  }

  return NextResponse.json({ ok: true, transfer })
})
