/**
 * GET /api/mp/connect/callback
 *
 * MercadoPago redirects here after the seller authorizes the marketplace app.
 * Exchanges the code for the seller's tokens and stores them in
 * marketplace_shops.metadata.settings.mercadopago (synced to the Medusa seller).
 *
 * Mirrors /api/stripe/connect/return.
 */
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { exchangeMpCode, mpSettingsFromToken, getShopMercadoPago } from '@/lib/mercadopago-connect'
import { syncMedusaSellerProfile } from '@/lib/medusa-seller-sync'
import { resolveOrigin, publicUrl } from '@/lib/request-origin'

export async function GET(req: NextRequest) {
  const { userId, getToken } = await auth()
  if (!userId) return NextResponse.redirect(publicUrl('/sign-in', req))

  // Onboarding three-doors S7 — the ONLY change to this callback: read where the
  // GET handler stashed the return destination, so the wizard's out-and-back
  // lands the seller back on its own resume-banner step instead of the classic
  // settings page. Token exchange/storage below is completely unchanged.
  const returnToWizard = req.cookies.get('mp_return_to')?.value === 'wizard'
  const clearReturnCookie = (res: NextResponse) => {
    res.cookies.set('mp_return_to', '', { maxAge: 0, path: '/api/mp/connect' })
    return res
  }

  const errorRedirect = (reason: string) =>
    clearReturnCookie(NextResponse.redirect(
      returnToWizard
        ? publicUrl(`/shop/manage/settings/pagos/wizard?mp=error&reason=${encodeURIComponent(reason)}`, req)
        : publicUrl(`/shop/manage/settings/pagos?mp=error&reason=${encodeURIComponent(reason)}#mercadopago`, req),
    ))

  const code = req.nextUrl.searchParams.get('code')
  const oauthError = req.nextUrl.searchParams.get('error')
  if (oauthError) return errorRedirect(oauthError)
  if (!code) return errorRedirect('missing_code')

  const { data: shop } = await db
    .from('marketplace_shops')
    .select('id, metadata')
    .eq('clerk_user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!shop) return NextResponse.redirect(publicUrl('/sell', req))

  // Must byte-match the redirect_uri used at authorization AND registered in MP
  // (trailing slash → invalid_grant) — resolveOrigin() strips one defensively.
  let origin: string
  try {
    origin = resolveOrigin({ siteUrl: process.env.NEXT_PUBLIC_SITE_URL, host: req.headers.get('host') })
  } catch (e) {
    return errorRedirect(e instanceof Error ? e.message : 'origin_unresolvable')
  }
  const redirectUri = `${origin}/api/mp/connect/callback`

  const codeVerifier = req.cookies.get('mp_pkce_verifier')?.value
  if (!codeVerifier) return errorRedirect('pkce_verifier_missing')

  try {
    const token = await exchangeMpCode({ code, redirectUri, codeVerifier })

    const meta = (shop.metadata ?? {}) as Record<string, unknown>
    const settings = (meta.settings ?? {}) as Record<string, unknown>
    const prev = getShopMercadoPago(shop.metadata as Record<string, unknown> | null)
    const nextSettings = { ...settings, mercadopago: mpSettingsFromToken(token, prev) }

    await db.from('marketplace_shops')
      .update({ metadata: { ...meta, settings: nextSettings } })
      .eq('id', shop.id)

    try {
      await syncMedusaSellerProfile(await getToken(), { metadata: { settings: nextSettings } })
    } catch (e) {
      console.error('[mp/connect/callback] Medusa seller sync failed (non-fatal):', e)
    }

    const res = NextResponse.redirect(
      returnToWizard
        ? publicUrl('/shop/manage/settings/pagos/wizard?mp=connected', req)
        : publicUrl('/shop/manage/settings/pagos?mp=connected#mercadopago', req),
    )
    res.cookies.set('mp_pkce_verifier', '', { maxAge: 0, path: '/api/mp/connect' })
    res.cookies.set('mp_return_to', '', { maxAge: 0, path: '/api/mp/connect' })
    return res
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[mp/connect/callback] token exchange failed:', msg, 'redirect_uri=', redirectUri)
    // Surface MP's actual error (e.g. invalid_grant / invalid_client) for diagnosis.
    return errorRedirect(`exchange_failed: ${msg}`.slice(0, 350))
  }
}
