/**
 * GET /api/sell/shop/domain/cloudflare/oauth/start
 *
 * Initiates a Cloudflare OAuth flow in a popup window.
 * This allows sellers to authorize Miyagi Sánchez to manage their DNS
 * without manually copying API tokens.
 *
 * ⚠️  SETUP REQUIRED: Register a Cloudflare OAuth application at
 *     https://dash.cloudflare.com/profile/oauth-apps
 *     Then set these env vars:
 *       CLOUDFLARE_CLIENT_ID=your_client_id
 *       CLOUDFLARE_CLIENT_SECRET=your_client_secret
 *       NEXT_PUBLIC_SITE_URL=https://miyagisanchez.com
 *
 * When those env vars are present, this route redirects to Cloudflare OAuth.
 * Without them, it returns a 501 scaffold response — the UI falls back to
 * the manual API token flow.
 */

import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { resolveDomainEntitlement } from '@/lib/domain-entitlement-server'
import { resolveOrigin } from '@/lib/request-origin'
import crypto from 'crypto'

const CF_OAUTH_AUTHORIZE = 'https://dash.cloudflare.com/oauth2/auth'

export async function GET(req: NextRequest) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'No autenticado.' }, { status: 401 })

  // Paywall: don't send a non-entitled seller into the OAuth flow (it would only
  // 402 at the callback). The callback gate is the real guarantee; this is UX.
  const { data: shop } = await db
    .from('marketplace_shops')
    .select('id, metadata')
    .eq('clerk_user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  const ent = await resolveDomainEntitlement(
    (shop as unknown as { metadata?: unknown } | null)?.metadata,
    { sellerClerkId: user.id, shopId: (shop as unknown as { id?: string } | null)?.id },
  )
  if (!ent.entitled) {
    return NextResponse.json(
      { error: 'El dominio propio es una función premium.', paywall: true },
      { status: 402 },
    )
  }

  const clientId = process.env.CLOUDFLARE_CLIENT_ID
  if (!clientId) {
    // OAuth app not registered yet — signal the UI to show the token form instead
    return NextResponse.json(
      { error: 'cloudflare_oauth_not_configured', message: 'OAuth not set up yet — use token flow.' },
      { status: 501 },
    )
  }

  let siteUrl: string
  try {
    siteUrl = resolveOrigin({ siteUrl: process.env.NEXT_PUBLIC_SITE_URL, host: req.headers.get('host') })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'No se pudo iniciar la conexión con Cloudflare.' },
      { status: 500 },
    )
  }
  const redirectUri = `${siteUrl}/api/sell/shop/domain/cloudflare/oauth/callback`

  // CSRF state token — store in a short-lived cookie, validated in callback
  const state = crypto.randomBytes(16).toString('hex')

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    // Zone DNS Edit scope — minimum required permissions
    scope: 'zone.dns:edit',
    state,
  })

  const response = NextResponse.redirect(`${CF_OAUTH_AUTHORIZE}?${params}`)
  response.cookies.set('cf_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600, // 10 minutes
    path: '/',
  })
  // Store clerk user id in cookie so callback can associate token with shop
  response.cookies.set('cf_oauth_user', user.id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  })

  return response
}
