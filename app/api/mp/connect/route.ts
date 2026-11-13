/**
 * GET    /api/mp/connect            — start MercadoPago Marketplace OAuth for the current seller
 * DELETE /api/mp/connect            — disconnect the seller's MP account
 *
 * Mirrors /api/stripe/connect. Seller-direct payouts via MP split payments.
 */
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { buildMpAuthorizationUrl, generateMpPkce } from '@/lib/mercadopago-connect'
import { syncMedusaSellerProfile } from '@/lib/medusa-seller-sync'
import { resolveOrigin, publicUrl } from '@/lib/request-origin'

export async function GET(req: NextRequest) {
  const { userId } = await auth()
  if (!userId) return NextResponse.redirect(publicUrl('/sign-in'))

  const errorRedirect = (reason: string) =>
    NextResponse.redirect(publicUrl(`/shop/manage/settings/pagos?mp=error&reason=${encodeURIComponent(reason)}#mercadopago`))

  const { data: shop } = await db
    .from('marketplace_shops')
    .select('id')
    .eq('clerk_user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!shop) return NextResponse.redirect(publicUrl('/sell'))

  try {
    // resolveOrigin() already strips a trailing slash, so the redirect_uri
    // byte-matches the value sent at token exchange AND the one registered
    // in the MP app (a mismatch → invalid_grant).
    const origin = resolveOrigin({ siteUrl: process.env.NEXT_PUBLIC_SITE_URL, host: req.headers.get('host') })
    const state = randomUUID()
    const { verifier, challenge } = generateMpPkce()
    const url = buildMpAuthorizationUrl({ state, redirectUri: `${origin}/api/mp/connect/callback`, codeChallenge: challenge })
    const res = NextResponse.redirect(url)
    // Stash the PKCE verifier for the callback (single browser, same domain).
    // SameSite=Lax so it survives the top-level redirect back from MercadoPago.
    res.cookies.set('mp_pkce_verifier', verifier, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 600,
      path: '/api/mp/connect',
    })
    // Onboarding three-doors S7 — the ONLY change this story makes to the OAuth
    // glue: remember where to send the seller back (the cobros wizard vs the
    // classic settings page), via the same cookie pattern as the PKCE verifier.
    // Absent, the round-trip is byte-identical to before this story.
    if (req.nextUrl.searchParams.get('redirect_to') === 'wizard') {
      res.cookies.set('mp_return_to', 'wizard', {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 600,
        path: '/api/mp/connect',
      })
    }
    return res
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[mp/connect] failed to build auth URL:', msg)
    return errorRedirect(msg)
  }
}

export async function DELETE() {
  const { userId, getToken } = await auth()
  if (!userId) return NextResponse.json({ error: 'No autenticado.' }, { status: 401 })

  const { data: shop } = await db
    .from('marketplace_shops')
    .select('id, metadata')
    .eq('clerk_user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!shop) return NextResponse.json({ error: 'Tienda no encontrada.' }, { status: 404 })

  const meta = (shop.metadata ?? {}) as Record<string, unknown>
  const settings = (meta.settings ?? {}) as Record<string, unknown>
  const nextSettings = { ...settings, mercadopago: { connected: false, enabled: false } }

  await db.from('marketplace_shops')
    .update({ metadata: { ...meta, settings: nextSettings } })
    .eq('id', shop.id)

  try {
    await syncMedusaSellerProfile(await getToken(), { metadata: { settings: nextSettings } })
  } catch (e) {
    console.error('[mp/connect] disconnect Medusa sync failed (non-fatal):', e)
  }

  return NextResponse.json({ ok: true })
}
