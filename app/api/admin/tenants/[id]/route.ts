/**
 * Admin tenant entitlement — per-shop detail + grant/revoke (admin-consolidation
 * · S4.1; generalized to any paid SKU in mercadolibre-sync · S6). Clerk-gated via
 * `withAdmin`; the POST is audited for free (an `admin_audit_log` row on every
 * successful mutation).
 *
 *   GET  /api/admin/tenants/:id?sku=custom_domain|subdomain|ml_sync|envia
 *        — resolve the ONE shop's true entitlement for the chosen SKU (incl. the
 *          per-seller subscription lookup).
 *   POST /api/admin/tenants/:id  { action:'grant'|'revoke', note?, sku? }
 *        — write/clear the comp grant for the chosen SKU.
 *
 * `sku` defaults to `custom_domain` (back-compat with the S4 UI). Each Supabase-
 * mirror SKU stores its comp on a DISTINCT metadata key (`custom_domain_grant` /
 * `subdomain_grant` / `ml_sync_grant`), so granting one never leaks entitlement
 * to another. The grant shape is composed by `buildCompGrant` (byte-identical to
 * what each `readGrant` parses), and entitlement is re-resolved by the SKU's own
 * server composer.
 *
 * `envia` is the ONE exception to the Supabase-mirror storage above
 * (shipping-provider-expansion · Sprint 2): its grant lives on the MEDUSA
 * seller's own metadata, not `marketplace_shops`, because the money-path
 * routes that enforce it (quote + label seams) only ever resolve the Medusa
 * seller directly, with no Supabase access. Read/write for that one sku goes
 * through `lib/envia-grant.ts` → the backend's internal grant route, keyed
 * off `shop.metadata.medusa_seller_id` (the existing mirror→Medusa join key)
 * instead of a `marketplace_shops.metadata` column.
 */
import { NextRequest, NextResponse } from 'next/server'
import { withAdmin } from '@/lib/admin/guard'
import { db } from '@/lib/supabase'
import { buildCompGrant, readGrant, type DomainEntitlement, type DomainGrant } from '@/lib/domain-entitlement'
import { resolveDomainEntitlement } from '@/lib/domain-entitlement-server'
import { SUBDOMAIN_GRANT_KEY } from '@/lib/subdomain-entitlement'
import { resolveSubdomainEntitlement } from '@/lib/subdomain-entitlement-server'
import { ML_SYNC_GRANT_KEY } from '@/lib/ml-sync-entitlement'
import { resolveMlSyncEntitlement } from '@/lib/ml-sync-entitlement-server'
import { getEnviaGrant, setEnviaGrant } from '@/lib/envia-grant'

export const dynamic = 'force-dynamic'

type ShopRow = { id?: string; metadata: Record<string, unknown> | null; clerk_user_id: string | null }

const GRANT_SKUS = ['custom_domain', 'subdomain', 'ml_sync', 'envia'] as const
type GrantSku = (typeof GRANT_SKUS)[number]
/** The Supabase-mirror SKUs — `envia` is handled separately (see file header). */
type SupabaseGrantSku = Exclude<GrantSku, 'envia'>

/** The metadata key each Supabase-mirror SKU stores its durable grant on. */
const GRANT_KEY: Record<SupabaseGrantSku, string> = {
  custom_domain: 'custom_domain_grant',
  subdomain: SUBDOMAIN_GRANT_KEY,
  ml_sync: ML_SYNC_GRANT_KEY,
}

function isGrantSku(raw: unknown): raw is GrantSku {
  return (GRANT_SKUS as readonly string[]).includes(raw as string)
}

function isSupabaseGrantSku(sku: GrantSku): sku is SupabaseGrantSku {
  return sku !== 'envia'
}

/** GET (a read) may default a missing/unknown sku to custom_domain (back-compat). */
function asSku(raw: unknown): GrantSku {
  return isGrantSku(raw) ? raw : 'custom_domain'
}

/** Resolve the SKU's true entitlement (incl. the per-seller subscription). */
async function resolveForSku(sku: SupabaseGrantSku, metadata: unknown, sellerClerkId?: string, shopId?: string): Promise<DomainEntitlement> {
  // shopId: Negocio is per shop, and an admin may be looking at any of an owner's shops (plans-gratis-negocio D1).
  const opts = { sellerClerkId: sellerClerkId ?? undefined, shopId }
  if (sku === 'subdomain') return resolveSubdomainEntitlement(metadata, opts)
  if (sku === 'ml_sync') return resolveMlSyncEntitlement(metadata, opts)
  return resolveDomainEntitlement(metadata, opts)
}

/** Load the mirror row this action targets; null when it doesn't exist. */
async function loadShop(id: string): Promise<ShopRow | null> {
  const { data, error } = await db
    .from('marketplace_shops')
    .select('id, metadata, clerk_user_id')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    console.error('[admin/tenants/:id] shop read error:', error.message)
    return null
  }
  return (data as ShopRow | null) ?? null
}

function resolvedEnviaEntitlement(grant: DomainGrant | null) {
  return {
    sku: 'envia' as const,
    entitlementReason: grant ? ('comp' as const) : ('none' as const),
    entitled: Boolean(grant),
    grant,
  }
}

async function resolvedEntitlement(sku: GrantSku, shop: ShopRow) {
  if (!isSupabaseGrantSku(sku)) {
    const medusaSellerId = (shop.metadata as Record<string, unknown> | null)?.medusa_seller_id as string | undefined
    return resolvedEnviaEntitlement(await getEnviaGrant(medusaSellerId))
  }
  const ent = await resolveForSku(sku, shop.metadata, shop.clerk_user_id ?? undefined, shop.id)
  return {
    sku,
    entitlementReason: ent.reason,
    entitled: ent.entitled,
    grant: readGrant(shop.metadata, GRANT_KEY[sku]),
  }
}

type RouteCtx = { params: Promise<{ id: string }> }

export const GET = withAdmin<NextRequest, RouteCtx>(async (req, { params }) => {
  const { id } = await params
  const sku = asSku(new URL(req.url).searchParams.get('sku'))
  const shop = await loadShop(id)
  if (!shop) return NextResponse.json({ error: 'Tienda no encontrada.' }, { status: 404 })
  return NextResponse.json(await resolvedEntitlement(sku, shop))
})

export const POST = withAdmin<NextRequest, RouteCtx>(async (req, { params }) => {
  const { id } = await params

  let body: { action?: unknown; note?: unknown; sku?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Datos inválidos.' }, { status: 400 })
  }
  const action = body.action
  if (action !== 'grant' && action !== 'revoke') {
    return NextResponse.json({ error: 'Acción inválida (usa "grant" o "revoke").' }, { status: 400 })
  }
  const note = typeof body.note === 'string' ? body.note : undefined
  // A mutation rejects a bad SKU rather than silently defaulting (per LEARNINGS:
  // coerce a purchase, reject a mutation) — a typo must never grant the wrong SKU.
  // An ABSENT sku still defaults to custom_domain (back-compat with the S4 caller).
  if (body.sku !== undefined && !isGrantSku(body.sku)) {
    return NextResponse.json({ error: 'SKU inválido.' }, { status: 400 })
  }
  const sku = asSku(body.sku)

  const shop = await loadShop(id)
  if (!shop) return NextResponse.json({ error: 'Tienda no encontrada.' }, { status: 404 })

  if (!isSupabaseGrantSku(sku)) {
    const medusaSellerId = (shop.metadata as Record<string, unknown> | null)?.medusa_seller_id as string | undefined
    if (!medusaSellerId) {
      return NextResponse.json(
        { error: 'Esta tienda no tiene un vendedor de Medusa vinculado.' },
        { status: 409 },
      )
    }
    let grant: DomainGrant | null
    try {
      grant = await setEnviaGrant(medusaSellerId, action, note)
    } catch (err) {
      console.error('[admin/tenants/:id] envía grant write error:', err)
      return NextResponse.json({ error: 'No se pudo guardar la cortesía.' }, { status: 502 })
    }
    return NextResponse.json(resolvedEnviaEntitlement(grant))
  }

  const grantKey = GRANT_KEY[sku]

  // This action only manages the **comp**: revoking a `grandfather` grant (stamped at
  // cutover) would silently strip a different, permanent entitlement, so refuse it.
  // NOTE: read-modify-writes the whole `metadata` blob (the established pattern); the
  // load→write window is small and this is a rare manual admin action.
  const existing = readGrant(shop.metadata, grantKey)
  if (action === 'revoke' && existing?.type === 'grandfather') {
    return NextResponse.json(
      { error: 'No se puede revocar una concesión heredada (cutover) desde aquí.' },
      { status: 409 },
    )
  }

  const metadata: Record<string, unknown> = { ...(shop.metadata ?? {}) }
  if (action === 'grant') {
    metadata[grantKey] = buildCompGrant({ note })
  } else {
    delete metadata[grantKey]
  }

  // `.select()` so we can confirm a row actually matched — a 0-row update must not
  // be reported as success (and audited) as if it had landed.
  const { data: updated, error } = await db
    .from('marketplace_shops')
    .update({ metadata })
    .eq('id', id)
    .select('id')
    .maybeSingle()
  if (error) {
    console.error('[admin/tenants/:id] entitlement write error:', error.message)
    return NextResponse.json({ error: 'No se pudo guardar la cortesía.' }, { status: 502 })
  }
  if (!updated) {
    return NextResponse.json({ error: 'Tienda no encontrada.' }, { status: 404 })
  }

  // Reflect the real post-action state (re-resolve on the written metadata).
  return NextResponse.json(await resolvedEntitlement(sku, { ...shop, metadata }))
})
