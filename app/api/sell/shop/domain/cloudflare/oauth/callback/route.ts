/**
 * GET /api/sell/shop/domain/cloudflare/oauth/callback
 *
 * Cloudflare OAuth callback. Exchanges the authorization code for an access
 * token, uses it to create the CNAME record, then closes the popup and
 * notifies the opener window.
 *
 * The access token is single-use — never stored beyond this request.
 *
 * ⚠️  Requires CLOUDFLARE_CLIENT_ID + CLOUDFLARE_CLIENT_SECRET env vars.
 *     See /oauth/start/route.ts for setup instructions.
 */

import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { db } from '@/lib/supabase'
import { resolveDomainEntitlement } from '@/lib/domain-entitlement-server'
import { CNAME_TARGET } from '@/lib/domain-utils'
import { resolveOrigin } from '@/lib/request-origin'

const CF_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token'
const CF_API = 'https://api.cloudflare.com/client/v4'

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  const cookieStore = await cookies()
  const expectedState = cookieStore.get('cf_oauth_state')?.value
  const clerkUserId   = cookieStore.get('cf_oauth_user')?.value

  // Helper: close popup with a message back to the opener
  function popupClose(status: 'success' | 'error', message: string) {
    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Cloudflare DNS</title></head>
<body>
<script>
  window.opener?.postMessage({ type: 'cf_oauth_result', status: '${status}', message: ${JSON.stringify(message)} }, '*');
  window.close();
</script>
<p>${message}</p>
</body>
</html>`
    return new NextResponse(html, { headers: { 'Content-Type': 'text/html' } })
  }

  if (error) return popupClose('error', `Cloudflare rechazó la autorización: ${error}`)
  if (!code) return popupClose('error', 'Código de autorización no recibido.')
  if (!state || state !== expectedState) return popupClose('error', 'State inválido. Intenta de nuevo.')
  if (!clerkUserId) return popupClose('error', 'Sesión expirada. Recarga la página.')

  const clientId     = process.env.CLOUDFLARE_CLIENT_ID
  const clientSecret = process.env.CLOUDFLARE_CLIENT_SECRET
  if (!clientId || !clientSecret) return popupClose('error', 'OAuth no configurado.')

  let siteUrl: string
  try {
    siteUrl = resolveOrigin({ siteUrl: process.env.NEXT_PUBLIC_SITE_URL, host: req.headers.get('host') })
  } catch (e) {
    return popupClose('error', e instanceof Error ? e.message : 'No se pudo determinar el origen de la solicitud.')
  }
  const redirectUri = `${siteUrl}/api/sell/shop/domain/cloudflare/oauth/callback`

  // ── Exchange code for token ───────────────────────────────────────────────
  const tokenRes = await fetch(CF_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      code,
    }),
  })

  const tokenData = await tokenRes.json() as { access_token?: string; error?: string }
  if (!tokenRes.ok || !tokenData.access_token) {
    return popupClose('error', `Error al obtener token: ${tokenData.error ?? tokenRes.status}`)
  }

  const accessToken = tokenData.access_token

  // ── Get shop domain ───────────────────────────────────────────────────────
  const { data: shop } = await db
    .from('marketplace_shops')
    .select('id, custom_domain, metadata')
    .eq('clerk_user_id', clerkUserId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  // Paywall: this is the real DNS-mutation boundary — refuse for a non-entitled
  // shop (flag on) before writing any Cloudflare record.
  const ent = await resolveDomainEntitlement(
    (shop as unknown as { metadata?: unknown } | null)?.metadata,
    { sellerClerkId: clerkUserId, shopId: (shop as unknown as { id?: string } | null)?.id },
  )
  if (!ent.entitled) return popupClose('error', 'El dominio propio es una función premium.')

  const domain = (shop as unknown as { custom_domain?: string | null } | null)?.custom_domain
  if (!domain) return popupClose('error', 'No encontramos tu dominio guardado. Guarda el dominio primero.')

  // ── Auto-detect zone ──────────────────────────────────────────────────────
  const parts = domain.split('.')
  const rootDomain = parts.length > 2 ? parts.slice(-2).join('.') : domain

  const zonesRes = await fetch(
    `${CF_API}/zones?name=${encodeURIComponent(rootDomain)}&status=active`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  const zonesData = await zonesRes.json() as { success?: boolean; result?: Array<{ id: string }> }
  const zoneId = zonesData.result?.[0]?.id
  if (!zoneId) return popupClose('error', `Zona "${rootDomain}" no encontrada en tu cuenta de Cloudflare.`)

  // ── Delete existing CNAME ─────────────────────────────────────────────────
  try {
    const listRes = await fetch(
      `${CF_API}/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(domain)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    const listData = await listRes.json() as { result?: Array<{ id: string }> }
    for (const r of listData.result ?? []) {
      await fetch(`${CF_API}/zones/${zoneId}/dns_records/${r.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      })
    }
  } catch { /* non-fatal */ }

  // ── Create CNAME ──────────────────────────────────────────────────────────
  const createRes = await fetch(`${CF_API}/zones/${zoneId}/dns_records`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'CNAME', name: '@', content: CNAME_TARGET, ttl: 1, proxied: false }),
  })
  const createData = await createRes.json() as { success?: boolean; errors?: Array<{ message: string }> }

  if (!createRes.ok || !createData.success) {
    const msg = createData.errors?.[0]?.message ?? `CF error ${createRes.status}`
    return popupClose('error', `Error al crear registro DNS: ${msg}`)
  }

  // Clear cookies
  const response = popupClose('success', '¡Registro CNAME creado! Comprobando propagación…')
  response.cookies.delete('cf_oauth_state')
  response.cookies.delete('cf_oauth_user')
  return response
}
