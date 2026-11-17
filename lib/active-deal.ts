import { db } from '@/lib/supabase'
import { effectivePaymentDeadline, type Offer } from '@/lib/offers'

export type ActiveDealStatus =
  | 'none'
  | 'pending'
  | 'countered'
  | 'accepted_unpaid'
  | 'paid'
  | 'expired'

export interface ActiveDeal {
  status: ActiveDealStatus
  offerId: string
  conversationId: string | null
  originalPriceCents: number | null
  dealPriceCents: number | null
  currency: string
  expiresAt: string | null
}

function isUuid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value)
}

async function resolveListingMirror(listingId: string, failOnError: boolean) {
  const { data: byMedusa, error: byMedusaError } = await db
    .from('marketplace_listings')
    .select('id, price_cents, currency')
    .eq('medusa_product_id', listingId)
    .maybeSingle()
  if (failOnError && byMedusaError) throw byMedusaError
  if (byMedusa) return byMedusa as { id: string; price_cents: number | null; currency: string | null }

  if (!isUuid(listingId)) return null
  const { data: byId, error: byIdError } = await db
    .from('marketplace_listings')
    .select('id, price_cents, currency')
    .eq('id', listingId)
    .maybeSingle()
  if (failOnError && byIdError) throw byIdError
  return byId as { id: string; price_cents: number | null; currency: string | null } | null
}

export async function getActiveDealForBuyer(
  listingId: string,
  buyerClerkUserId?: string | null,
  { failOnError = false }: { failOnError?: boolean } = {},
): Promise<ActiveDeal | null> {
  if (!buyerClerkUserId) return null

  const mirror = await resolveListingMirror(listingId, failOnError)
  if (!mirror) return null

  const { data: offer, error: offerError } = await db
    .from('marketplace_offers')
    .select('*')
    .eq('listing_id', mirror.id)
    .eq('buyer_clerk_user_id', buyerClerkUserId)
    .in('status', ['pending', 'countered', 'accepted', 'paid'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (failOnError && offerError) throw offerError

  if (!offer) return null

  const typedOffer = offer as Offer
  const { data: conv, error: conversationError } = await db
    .from('marketplace_conversations')
    .select('id')
    .eq('listing_id', mirror.id)
    .eq('buyer_clerk_user_id', buyerClerkUserId)
    .maybeSingle()
  if (failOnError && conversationError) throw conversationError

  const now = Date.now()
  let status: ActiveDealStatus
  let expiresAt: string | null = null
  let dealPriceCents: number | null = null

  if (typedOffer.status === 'pending') {
    status = new Date(typedOffer.expires_at).getTime() < now ? 'expired' : 'pending'
    expiresAt = typedOffer.expires_at
    dealPriceCents = typedOffer.offer_amount_cents
  } else if (typedOffer.status === 'countered') {
    status = typedOffer.counter_expires_at && new Date(typedOffer.counter_expires_at).getTime() < now ? 'expired' : 'countered'
    expiresAt = typedOffer.counter_expires_at
    dealPriceCents = typedOffer.counter_amount_cents
  } else if (typedOffer.status === 'accepted') {
    // An offer the buyer already ORDERED by direct payment has no deadline left (lib/offers.ts).
    const deadline = effectivePaymentDeadline(typedOffer as Offer & { checkout_reserved_at?: string | null })
    status = deadline && new Date(deadline).getTime() < now ? 'expired' : 'accepted_unpaid'
    expiresAt = deadline
    dealPriceCents = typedOffer.counter_amount_cents ?? typedOffer.offer_amount_cents
  } else {
    status = 'paid'
    dealPriceCents = typedOffer.counter_amount_cents ?? typedOffer.offer_amount_cents
  }

  return {
    status,
    offerId: typedOffer.id,
    conversationId: conv?.id ?? null,
    originalPriceCents: mirror.price_cents,
    dealPriceCents,
    currency: mirror.currency ?? 'MXN',
    expiresAt,
  }
}
