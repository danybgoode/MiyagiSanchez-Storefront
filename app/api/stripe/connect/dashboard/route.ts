/**
 * GET /api/stripe/connect/dashboard
 *
 * Redirects the authenticated seller to their Stripe Express Dashboard.
 * Calls stripe.accounts.createLoginLink() which returns a one-time URL
 * that opens the seller's Express Dashboard directly.
 */
import { NextRequest, NextResponse } from 'next/server'
import { publicUrl } from '@/lib/request-origin'
import { currentUser } from '@clerk/nextjs/server'
import { stripe } from '@/lib/stripe'
import { db } from '@/lib/supabase'
import { getShopStripe } from '@/lib/stripe'

export async function GET(req: NextRequest) {
  // These are all internal redirects (never sent to a third party as a
  // callback/redirect_uri, unlike /connect and /connect/refresh) — resolve
  // them against the incoming request's own URL, which is always correct,
  // rather than the env/Host-header-derived origin this route never
  // actually needed (the fragile fallback that produced the 0.0.0.0
  // redirect Daniel hit lived in the OAuth-callback-building routes, not
  // here — this file just never needed `origin` in the first place).
  const user = await currentUser()
  if (!user) {
    return NextResponse.redirect(publicUrl('/sign-in', req))
  }

  // ── Fetch seller's shop ──────────────────────────────────────────────────
  const { data: shop } = await db
    .from('marketplace_shops')
    .select('id, metadata')
    .eq('clerk_user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!shop) {
    return NextResponse.redirect(publicUrl('/sell', req))
  }

  const stripeSettings = getShopStripe(shop.metadata as Record<string, unknown> | null)

  if (!stripeSettings.account_id) {
    return NextResponse.redirect(
      publicUrl('/shop/manage/settings?stripe=error&reason=No+hay+cuenta+Stripe+conectada.', req),
    )
  }

  try {
    const loginLink = await stripe.accounts.createLoginLink(stripeSettings.account_id)
    return NextResponse.redirect(loginLink.url)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Error al acceder al panel Stripe.'
    const url = publicUrl('/shop/manage/settings', req)
    url.searchParams.set('stripe', 'error')
    url.searchParams.set('reason', msg)
    return NextResponse.redirect(url)
  }
}
