/**
 * POST   /api/sell/shop/domain  — save custom domain + provision on Vercel
 * GET    /api/sell/shop/domain  — check DNS verification status
 * DELETE /api/sell/shop/domain  — remove custom domain
 *
 * All endpoints require auth. The shop must belong to the authenticated user.
 */

import { NextRequest, NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { currentUser } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { SHOP_DOMAINS_TAG } from '@/lib/custom-domain'
import {
  addDomainToProject,
  getDomainStatus,
  getDomainConfig,
  removeDomainFromProject,
  DomainConflictError,
} from '@/lib/cloudflare-domains'
import { CNAME_TARGET } from '@/lib/domain-utils'
import { resolveDomainEntitlement } from '@/lib/domain-entitlement-server'
import dns from 'dns/promises'

// ── helpers ──────────────────────────────────────────────────────────────────

async function getShopForUser(clerkUserId: string) {
  const { data } = await db
    .from('marketplace_shops')
    .select('id, slug, custom_domain, custom_domain_verified, custom_domain_vercel_ok, metadata')
    .eq('clerk_user_id', clerkUserId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return data
}

/**
 * Custom-domain paywall gate (epic: custom-domain-paywall, S1). Connecting a
 * domain is a premium SKU — when the rollout flag is on and the shop is not
 * entitled (no grandfather/comp grant, no active subscription), refuse with 402
 * before any Vercel/Cloudflare/DB write. Returns a 402 NextResponse to short-
 * circuit, or null when the shop may proceed. Applied to the connect/provision
 * paths only; DELETE (removal) is intentionally always allowed — it moves away
 * from the gated state and is the escape hatch a lapsed seller needs.
 */
async function paywallBlock(metadata: unknown, sellerClerkId: string, shopId: string): Promise<NextResponse | null> {
  const ent = await resolveDomainEntitlement(metadata, { sellerClerkId, shopId })
  if (ent.entitled) return null
  return NextResponse.json(
    { error: 'El dominio propio es una función premium. Conéctalo desde Catálogo → Canales.', paywall: true },
    { status: 402 },
  )
}

/**
 * Live DNS check: does `domain` actually resolve to our fallback-origin
 * hostname right now? Apex domains rely on registrar-side CNAME-flattening,
 * so they have no CNAME at the wire level — check A-record overlap with the
 * fallback origin's current resolution instead. `cname_current` is passed in
 * (already resolved by the caller for its own diagnostic use) so this never
 * re-does that lookup.
 */
async function resolvesToFallbackOrigin(domain: string, cname_current: string | null): Promise<boolean> {
  if (cname_current === CNAME_TARGET) return true
  try {
    const [domainIps, fallbackOriginIps] = await Promise.all([
      dns.resolve4(domain),
      dns.resolve4(CNAME_TARGET),
    ])
    return domainIps.some(ip => fallbackOriginIps.includes(ip))
  } catch {
    return false // no A record yet, or the fallback origin itself is unreachable
  }
}

/**
 * Server-side "is this domain live?" check.
 *
 * Two conditions must BOTH hold for `dns_ok`:
 *  1. Cloudflare's custom-hostname config (`misconfigured === false`) — proves
 *     ownership is verified AND SSL is issued.
 *  2. The domain's OWN live DNS actually resolves to our fallback origin.
 * Condition 1 alone is not enough: Cloudflare for SaaS custom hostnames can
 * reach `active` via TXT ownership validation BEFORE the seller's DNS ever
 * points at us (Sprint 4 Story 4.3's whole pre-provisioning design relies on
 * exactly this) — unlike Vercel's config endpoint, which only ever reported
 * `misconfigured: false` once DNS genuinely pointed at Vercel. Conflating the
 * two would tell a seller "live!" while their DNS still serves from
 * elsewhere. We surface a `hint` so the seller knows exactly what to fix:
 *  - `proxied` — domain is behind a proxy (Cloudflare "orange cloud" on the
 *    SELLER's own zone); must be DNS-only for our provider to issue the cert.
 * If Cloudflare's config endpoint is unreachable, condition 2 alone decides,
 * so the status poll never hard-fails.
 */
async function checkDns(
  domain: string,
): Promise<{ dns_ok: boolean; cname_current: string | null; hint: string | null }> {
  let cname_current: string | null = null
  try {
    const records = await dns.resolveCname(domain)
    cname_current = records[0] ?? null
  } catch {
    // No CNAME (a flattened apex has none at the wire level) or domain doesn't exist yet.
  }

  const pointsAtUs = await resolvesToFallbackOrigin(domain, cname_current)

  try {
    const cfg = await getDomainConfig(domain)
    if (!cfg.misconfigured && pointsAtUs) return { dns_ok: true, cname_current, hint: null }
    // Resolves to us but behind a proxy → cert can't be issued. Tell them why.
    if (cfg.configuredBy === 'http') return { dns_ok: false, cname_current, hint: 'proxied' }
    return { dns_ok: false, cname_current, hint: null }
  } catch {
    // Cloudflare config unreachable — the live DNS check alone decides.
    return { dns_ok: pointsAtUs, cname_current, hint: null }
  }
}

// ── POST — save domain & provision on Vercel ─────────────────────────────────

export async function POST(req: NextRequest) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'No autenticado.' }, { status: 401 })

  let body: { domain: string }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Datos inválidos.' }, { status: 400 })
  }

  const raw = (body.domain ?? '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')   // strip protocol if pasted
    .replace(/\/.*$/, '')          // strip path
  if (!raw || raw.length < 4) {
    return NextResponse.json({ error: 'Dominio inválido.' }, { status: 400 })
  }
  // Basic domain format validation
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(raw)) {
    return NextResponse.json({ error: 'Formato de dominio inválido.' }, { status: 400 })
  }

  const shop = await getShopForUser(user.id)
  if (!shop) return NextResponse.json({ error: 'Tienda no encontrada.' }, { status: 404 })

  // Paywall: refuse to connect a domain for a non-entitled shop (flag on).
  const blocked = await paywallBlock(shop.metadata, user.id, shop.id)
  if (blocked) return blocked

  // Check if another shop already claimed this domain
  const { data: existing } = await db
    .from('marketplace_shops')
    .select('id')
    .eq('custom_domain', raw)
    .neq('id', shop.id)
    .maybeSingle()
  if (existing) {
    return NextResponse.json({ error: 'Este dominio ya está en uso por otra tienda.' }, { status: 409 })
  }

  // Register domain on Vercel project
  let vercelStatus
  try {
    vercelStatus = await addDomainToProject(raw)
  } catch (err) {
    // Domain already registered to a different Vercel account/project → clear 409.
    if (err instanceof DomainConflictError) {
      return NextResponse.json(
        { error: 'Este dominio ya está en uso. Si es tuyo, contáctanos para liberarlo.' },
        { status: 409 },
      )
    }
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[domain] Vercel addDomain failed:', msg)
    return NextResponse.json({ error: 'Error al registrar el dominio en Vercel.', detail: msg }, { status: 502 })
  }

  // Save to DB
  await db
    .from('marketplace_shops')
    .update({
      custom_domain: raw,
      custom_domain_vercel_ok: true,
      custom_domain_verified: vercelStatus.verified,
    })
    .eq('id', shop.id)

  // Bust the platform-side reverse lookup so the new domain starts redirecting /
  // canonicalising the moment it's verified (and so a replace clears the old one).
  revalidateTag(SHOP_DOMAINS_TAG, 'default')

  // Replace flow: the new domain is now saved, so release the previous one from
  // Vercel to avoid orphaned domains on the project. Best-effort — never block.
  const previous = shop.custom_domain
  if (previous && previous !== raw) {
    try {
      await removeDomainFromProject(previous)
    } catch (err) {
      console.error('[domain] Vercel removeDomain (replace) failed:', err)
    }
  }

  return NextResponse.json({
    domain: raw,
    verified: vercelStatus.verified,
    cname_target: vercelStatus.cname_target,
    verification: vercelStatus.verification,
  })
}

// ── GET — check DNS + Vercel verification status ──────────────────────────────

export async function GET(req: NextRequest) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'No autenticado.' }, { status: 401 })

  const shop = await getShopForUser(user.id)
  if (!shop) return NextResponse.json({ error: 'Tienda no encontrada.' }, { status: 404 })

  const domain = shop.custom_domain
  if (!domain) return NextResponse.json({ domain: null, verified: false })

  // Check Vercel's view of the domain
  let vercelStatus
  try {
    vercelStatus = await getDomainStatus(domain)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[domain] Vercel getDomainStatus failed:', msg)
    return NextResponse.json({ error: 'Error al verificar el dominio.', detail: msg }, { status: 502 })
  }

  // Live DNS lookup — this is the only source of truth for "live".
  // Vercel's `verified` field just means "domain is registered on the project"
  // (and, once true, that the SSL cert is issued) — NOT that DNS is live. Only
  // update DB when our own lookup confirms the domain points at us.
  const { dns_ok, cname_current, hint } = await checkDns(domain)

  if (dns_ok && !shop.custom_domain_verified) {
    // DNS just went live — mark verified in DB
    await db
      .from('marketplace_shops')
      .update({ custom_domain_verified: true })
      .eq('id', shop.id)
    revalidateTag(SHOP_DOMAINS_TAG, 'default')
  } else if (!dns_ok && shop.custom_domain_verified) {
    // DNS was live but is no longer pointing to us (seller changed registrar etc.)
    await db
      .from('marketplace_shops')
      .update({ custom_domain_verified: false })
      .eq('id', shop.id)
    revalidateTag(SHOP_DOMAINS_TAG, 'default')
  }

  return NextResponse.json({
    domain,
    verified: vercelStatus.verified,
    dns_ok,
    cname_target: vercelStatus.cname_target,
    cname_current,
    hint,
    verification: vercelStatus.verification,
  })
}

// ── DELETE — remove domain ───────────────────────────────────────────────────

export async function DELETE(_req: NextRequest) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'No autenticado.' }, { status: 401 })

  const shop = await getShopForUser(user.id)
  if (!shop) return NextResponse.json({ error: 'Tienda no encontrada.' }, { status: 404 })

  const domain = shop.custom_domain
  if (!domain) return NextResponse.json({ ok: true })

  try {
    await removeDomainFromProject(domain)
  } catch (err) {
    // Log but don't block — always clear from DB even if Vercel call fails
    console.error('[domain] Vercel removeDomain failed:', err)
  }

  await db
    .from('marketplace_shops')
    .update({
      custom_domain: null,
      custom_domain_verified: false,
      custom_domain_vercel_ok: false,
    })
    .eq('id', shop.id)

  // Instant fail-safe: drop the reverse lookup so the platform stops redirecting
  // to the now-disconnected domain right away (no stale 308 to a dead host).
  revalidateTag(SHOP_DOMAINS_TAG, 'default')

  return NextResponse.json({ ok: true })
}
