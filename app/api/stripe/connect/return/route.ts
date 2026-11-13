import { NextRequest, NextResponse } from 'next/server'
import { publicUrl } from '@/lib/request-origin'
import { auth } from '@clerk/nextjs/server'
import { stripe, getShopStripe } from '@/lib/stripe'
import { db } from '@/lib/supabase'
import { syncMedusaSellerProfile } from '@/lib/medusa-seller-sync'

// GET — Stripe redirects here after seller completes onboarding
export async function GET(req: NextRequest) {
  const { userId, getToken } = await auth()
  if (!userId) return NextResponse.redirect(publicUrl('/sign-in', req))

  const requestedAccountId = req.nextUrl.searchParams.get('account_id')

  const { data: shop } = await db
    .from('marketplace_shops')
    .select('id, metadata')
    .eq('clerk_user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!shop) return NextResponse.redirect(publicUrl('/sell', req))

  const existingBeforeUpdate = getShopStripe(shop.metadata as Record<string, unknown> | null)

  // Ownership check — account_id is caller-supplied (a query param echoed
  // back from Stripe's return_url), so an authenticated user must not be
  // able to attach another seller's real, connected account_id to their OWN
  // shop by crafting this URL (which would misroute this shop's future
  // Stripe payouts to that other account). `/api/stripe/connect` ALWAYS
  // persists a shop's account_id BEFORE redirecting to Stripe onboarding —
  // there is no legitimate case where this route is hit for a shop with no
  // stored account_id yet, so an empty `existingBeforeUpdate.account_id` is
  // NOT treated as "first connection, trust the param" (that would let an
  // attacker with a fresh shop plant a victim's account_id on their first
  // hit). Only an exact match to the already-stored value is ever trusted.
  const accountId =
    requestedAccountId && requestedAccountId === existingBeforeUpdate.account_id
      ? requestedAccountId
      : existingBeforeUpdate.account_id ?? null

  // ── Check actual account capabilities from Stripe ─────────────────────────
  let chargesEnabled = false
  let detailsSubmitted = false

  if (accountId) {
    try {
      const account = await stripe.accounts.retrieve(accountId)
      chargesEnabled = account.charges_enabled ?? false
      detailsSubmitted = account.details_submitted ?? false
    } catch {
      // account not found — ignore, will retry on refresh
    }
  }

  // ── Persist updated stripe status ─────────────────────────────────────────
  const meta = (shop.metadata ?? {}) as Record<string, unknown>
  const settings = (meta.settings ?? {}) as Record<string, unknown>
  const nextSettings = {
    ...settings,
    stripe: {
      ...existingBeforeUpdate,
      account_id: accountId ?? existingBeforeUpdate.account_id,
      charges_enabled: chargesEnabled,
      details_submitted: detailsSubmitted,
      onboarding_complete: chargesEnabled && detailsSubmitted,
    },
  }

  await db.from('marketplace_shops').update({
    metadata: {
      ...meta,
      settings: nextSettings,
    },
  }).eq('id', shop.id)

  try {
    await syncMedusaSellerProfile(await getToken(), { metadata: { settings: nextSettings } })
  } catch (e) {
    console.error('[stripe/connect/return] Medusa seller sync failed (non-fatal):', e)
  }

  const status = chargesEnabled ? 'connected' : 'pending'
  return NextResponse.redirect(publicUrl(`/shop/manage/settings?stripe=${status}`, req))
}
