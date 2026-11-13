import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { createAccountLink, getShopStripe } from '@/lib/stripe'
import { db } from '@/lib/supabase'
import { resolveOrigin, publicUrl } from '@/lib/request-origin'

// GET — Stripe redirects here if the onboarding link expires (or the seller
// clicks "Completar configuración" from Pagos.tsx, which passes account_id
// explicitly); we generate a fresh onboarding link.
export async function GET(req: NextRequest) {
  const { userId } = await auth()
  if (!userId) return NextResponse.redirect(publicUrl('/sign-in'))

  const errorRedirect = (reason: string) =>
    NextResponse.redirect(
      publicUrl(`/shop/manage/settings?stripe=error&reason=${encodeURIComponent(reason)}`),
    )

  const accountId = req.nextUrl.searchParams.get('account_id')
  if (!accountId) return NextResponse.redirect(publicUrl('/shop/manage/settings'))

  // Ownership check — account_id is caller-supplied (a query param), so an
  // authenticated user must not be able to mint a fresh Stripe onboarding
  // link (view/edit banking + KYC details) for another seller's account by
  // passing their account_id here. Only the requester's OWN shop's stored
  // account_id is a valid target.
  const { data: shop } = await db
    .from('marketplace_shops')
    .select('metadata')
    .eq('clerk_user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  const stripeSettings = getShopStripe((shop?.metadata as Record<string, unknown> | null) ?? null)
  if (!shop || accountId !== stripeSettings.account_id) {
    return errorRedirect('No tienes permiso para esta cuenta de Stripe.')
  }

  let origin: string
  try {
    origin = resolveOrigin({ siteUrl: process.env.NEXT_PUBLIC_SITE_URL, host: req.headers.get('host') })
  } catch (e) {
    return errorRedirect(e instanceof Error ? e.message : 'origin_unresolvable')
  }

  try {
    const url = await createAccountLink(accountId, origin)
    return NextResponse.redirect(url)
  } catch (e) {
    return errorRedirect(e instanceof Error ? e.message : 'account_link_failed')
  }
}
