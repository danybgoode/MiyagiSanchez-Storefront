/**
 * POST /api/sell/shop/domain/cloudflare
 *
 * One-click Cloudflare DNS automation for the "own channel" feature.
 * The tenant provides only a Cloudflare API token (Zone DNS Edit scope).
 * We auto-detect their Zone ID via GET /zones?name={domain} — no Zone ID entry needed.
 *
 * The token is NEVER stored — used once and discarded.
 */

import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { dnsRecordFor } from '@/lib/domain-utils'
import { getDomainConfig } from '@/lib/cloudflare-domains'
import { resolveDomainEntitlement } from '@/lib/domain-entitlement-server'

const CF_API = 'https://api.cloudflare.com/client/v4'

async function cfGet(path: string, token: string) {
  const res = await fetch(`${CF_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  })
  return res
}

async function cfPost(path: string, token: string, body: unknown) {
  const res = await fetch(`${CF_API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res
}

async function cfDelete(path: string, token: string) {
  const res = await fetch(`${CF_API}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  return res
}

export async function POST(req: NextRequest) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'No autenticado.' }, { status: 401 })

  let body: { cf_token?: string }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Datos inválidos.' }, { status: 400 })
  }

  const cf_token = body.cf_token?.trim()
  if (!cf_token) {
    return NextResponse.json({ error: 'API Token de Cloudflare requerido.' }, { status: 400 })
  }

  // Verify the shop belongs to this user and get the saved domain
  const { data: shop } = await db
    .from('marketplace_shops')
    .select('id, custom_domain, metadata')
    .eq('clerk_user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!shop) return NextResponse.json({ error: 'Tienda no encontrada.' }, { status: 404 })

  // Paywall: provisioning DNS for a custom domain is a premium SKU (flag on).
  const ent = await resolveDomainEntitlement(
    (shop as unknown as { metadata: unknown }).metadata,
    { sellerClerkId: user.id, shopId: (shop as unknown as { id: string }).id },
  )
  if (!ent.entitled) {
    return NextResponse.json(
      { error: 'El dominio propio es una función premium. Conéctalo desde Catálogo → Canales.', paywall: true },
      { status: 402 },
    )
  }

  const domain = (shop as unknown as { custom_domain: string | null }).custom_domain
  if (!domain) {
    return NextResponse.json({ error: 'Primero guarda tu dominio personalizado.' }, { status: 400 })
  }

  // ── Step 1: Auto-detect Zone ID ───────────────────────────────────────────
  // Extract root domain for zone lookup
  const parts = domain.split('.')
  const rootDomain = parts.length > 2 ? parts.slice(-2).join('.') : domain

  const zonesRes = await cfGet(`/zones?name=${encodeURIComponent(rootDomain)}&status=active`, cf_token)
  const zonesData = await zonesRes.json() as {
    success?: boolean
    result?: Array<{ id: string; name: string }>
    errors?: Array<{ message: string }>
  }

  if (!zonesRes.ok || !zonesData.success) {
    const cfError = zonesData.errors?.[0]?.message ?? `Cloudflare error ${zonesRes.status}`
    console.error('[domain/cloudflare] Zone lookup failed:', cfError)
    // Give a friendly error — most likely the token is wrong or has wrong scope
    return NextResponse.json({
      error: `No pudimos verificar tu token de Cloudflare. Asegúrate de que el token tenga el permiso Zone · DNS · Edit.`,
    }, { status: 401 })
  }

  const zone = zonesData.result?.[0]
  if (!zone) {
    return NextResponse.json({
      error: `No encontramos la zona "${rootDomain}" en tu cuenta de Cloudflare. Verifica que este dominio esté en tu cuenta y el token tenga acceso a él.`,
    }, { status: 404 })
  }

  const zoneId = zone.id

  // ── Step 2: Decide the correct record ───────────────────────────────────
  // Both apex and subdomain now recommend a CNAME to the fallback-origin
  // hostname (Cloudflare for SaaS has no fixed apex A-record IP the way
  // Vercel did — apex relies on the registrar's own CNAME-flattening/ALIAS
  // support). `dnsRecordFor` is the single source of that decision, shared
  // with the UI so the seller sees the same record we write.
  const record = dnsRecordFor(domain)

  // Prefer the provider's live recommended value when reachable; fall back
  // to the static target from domain-utils otherwise.
  let content = record.value
  try {
    const cfg = await getDomainConfig(domain)
    if (record.type === 'A' && cfg.recommendedIPv4[0]) content = cfg.recommendedIPv4[0]
    if (record.type === 'CNAME' && cfg.recommendedCNAME) content = cfg.recommendedCNAME
  } catch {
    // Provider config unreachable — keep the static fallback from domain-utils.
  }

  // ── Step 3: Remove conflicting A/AAAA/CNAME records on this name ──────────
  // (A previous run may have written the wrong type, or the zone may carry a
  // stale AAAA from before this domain was ever pointed at us — a CNAME can't
  // coexist with ANY other record type at the same name, so clear all three.)
  for (const t of ['A', 'AAAA', 'CNAME'] as const) {
    try {
      const listRes = await cfGet(
        `/zones/${zoneId}/dns_records?type=${t}&name=${encodeURIComponent(domain)}`,
        cf_token,
      )
      const listData = await listRes.json() as { result?: Array<{ id: string }> }
      for (const existing of listData.result ?? []) {
        await cfDelete(`/zones/${zoneId}/dns_records/${existing.id}`, cf_token)
      }
    } catch {
      // Non-fatal — continue to create
    }
  }

  // ── Step 4: Create the record (CNAME, apex or subdomain) ─────────────────
  // `name: domain` is the full FQDN; for an apex this is the zone root.
  const createRes = await cfPost(`/zones/${zoneId}/dns_records`, cf_token, {
    type: record.type,
    name: domain,
    content,
    ttl: 1,       // 1 = automatic TTL
    proxied: false, // Must be DNS-only — Cloudflare for SaaS custom-hostname routing
                    // works via normal DNS resolution + SNI matching at our edge; a
                    // seller-side proxy would double-hop instead of resolving through.
  })

  const createData = await createRes.json() as {
    success?: boolean
    errors?: Array<{ message: string }>
  }

  if (!createRes.ok || !createData.success) {
    const cfError = createData.errors?.[0]?.message ?? `Cloudflare error ${createRes.status}`
    console.error('[domain/cloudflare] Create record failed:', cfError)
    return NextResponse.json({ error: `Error de Cloudflare: ${cfError}` }, { status: 502 })
  }

  return NextResponse.json({
    ok: true,
    message: `Registro ${record.type} creado en Cloudflare.`,
    record_type: record.type,
    zone_id: zoneId,
    zone_name: zone.name,
  })
}
