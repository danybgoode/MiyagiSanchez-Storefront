import { db } from '@/lib/supabase'
import { cancelScheduledEmail } from '@/lib/email'
import { orderedByDirectPayment } from '@/lib/offers'

function isUuid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value)
}

export async function resolveMarketplaceListingId(listingId?: string | null): Promise<string | null> {
  if (!listingId) return null

  const { data: byMedusa } = await db
    .from('marketplace_listings')
    .select('id')
    .eq('medusa_product_id', listingId)
    .maybeSingle()
  if (byMedusa?.id) return byMedusa.id

  if (!isUuid(listingId)) return null
  const { data: byId } = await db
    .from('marketplace_listings')
    .select('id')
    .eq('id', listingId)
    .maybeSingle()
  return byId?.id ?? null
}

export async function markListingPurchased({
  listingId,
  offerId,
}: {
  listingId?: string | null
  offerId?: string | null
}) {
  let mirrorListingId = await resolveMarketplaceListingId(listingId)

  if (offerId) {
    const { data: paidOffer } = await db
      .from('marketplace_offers')
      .select('listing_id, scheduled_reminder_ids')
      .eq('id', offerId)
      .maybeSingle()

    if (paidOffer?.listing_id) mirrorListingId = paidOffer.listing_id

    await db.from('marketplace_offers').update({ status: 'paid' }).eq('id', offerId)

    const reminders = (paidOffer?.scheduled_reminder_ids ?? {}) as Record<string, string>
    if (reminders.buyer_payment_expiry) {
      cancelScheduledEmail(reminders.buyer_payment_expiry).catch(() => {})
    }
  }

  if (!mirrorListingId) return

  let competingOffers = db.from('marketplace_offers')
    .update({ status: 'declined' })
    .eq('listing_id', mirrorListingId)
    .in('status', ['pending', 'countered', 'accepted'])
  if (offerId) competingOffers = competingOffers.neq('id', offerId)
  await competingOffers

  await db.from('marketplace_listings')
    .update({ status: 'sold' })
    .eq('id', mirrorListingId)
}

/**
 * A buyer ordered an accepted offer by Pago directo: the money arrives off-platform, so the offer stays
 * `accepted`, but the «your payment window closes» email scheduled at accept time must not reach someone
 * who already ordered (fresh review, PR 506). Cancels it only when the backend's permanent reservation is
 * really there — the reservation, not the caller, says the offer was ordered. Best-effort: logged, never thrown.
 */
export async function cancelPaymentReminderForDirectOrder(offerId: string): Promise<void> {
  try {
    const { data } = await db
      .from('marketplace_offers')
      .select('checkout_reserved_at, scheduled_reminder_ids')
      .eq('id', offerId)
      .maybeSingle()
    if (!data || !orderedByDirectPayment(data)) return
    const reminderId = ((data.scheduled_reminder_ids ?? {}) as Record<string, string>).buyer_payment_expiry
    if (reminderId) await cancelScheduledEmail(reminderId)
  } catch (e) {
    console.error('[offer-state] could not cancel the payment reminder for a direct-payment order', offerId, e)
  }
}
