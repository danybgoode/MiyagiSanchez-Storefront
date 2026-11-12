/**
 * Shared listing status-change orchestration — extracted from
 * `app/api/sell/listing/[id]/route.ts` PATCH (catalog-management epic,
 * Sprint 3 · Story 3.1) so the new bulk-apply path can pause/activate a
 * product WITHOUT bypassing the side effects that live here: the Sprint 1.3
 * `metadata.paused` fix (Medusa's native status alone can't tell "paused"
 * apart from "never-published draft"), the activation checkout-viability
 * gate, the Supabase `marketplace_listings` mirror, the pause → ML-close
 * cascade, and the launchpad first-publish notify. A bulk action that only
 * sent `{status}` straight to the backend would silently reintroduce the
 * pausado/borrador regression for every bulk-paused product — see the
 * Sprint 3 plan's "mid-build correction" note.
 *
 * server-only (calls Medusa with the caller's Clerk JWT).
 */
import 'server-only'
import { db } from '@/lib/supabase'
import { isEnabled } from '@/lib/flags'
import { closeMlProduct } from '@/lib/ml-publish-bridge'
import { notifyWriterOnPublish } from '@/lib/launchpad'
import { listingNotReadyRefusal, listingReadiness, ownerShopFacts, type ListingReadiness, type ReadinessMissing } from '@/lib/listing-readiness'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const PUB_KEY = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

function medusaFetch(path: string, clerkJwt: string, options?: RequestInit) {
  return fetch(`${MEDUSA_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-publishable-api-key': PUB_KEY,
      Authorization: `Bearer ${clerkJwt}`,
      ...(options?.headers ?? {}),
    },
  })
}

async function getShopSlug(userId: string): Promise<string | null> {
  const { data: shop } = await db
    .from('marketplace_shops')
    .select('slug')
    .eq('clerk_user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return shop?.slug ?? null
}

async function bestEffortCloseMl(userId: string, productId: string): Promise<void> {
  try {
    if (!(await isEnabled('ml.publish_enabled'))) return
    const slug = await getShopSlug(userId)
    if (slug) await closeMlProduct(slug, productId)
  } catch {
    /* never block the archive on a ML failure */
  }
}

/**
 * The listing's sale readiness for activation (listing-readiness S1.1/S1.2): the ONE rule in lib/listing-readiness.ts
 * over the OWNER's private facts. `null` = could not read (fail OPEN for publish — D3: an outage must not block a
 * merchant; buyer surfaces still re-derive readiness from the live shop).
 *
 * Reads the product through the OWNER route (`/store/sellers/me/products/:id`, any status). It used to read
 * `/store/listings/:id`, which only returns PUBLISHED products — so activating a draft, the one case this gate exists
 * for, got a 404 and was allowed through.
 */
export async function readListingReadiness(listingId: string, clerkJwt: string): Promise<ListingReadiness | null> {
  try {
    const [productRes, sellerRes] = await Promise.all([
      medusaFetch(`/store/sellers/me/products/${encodeURIComponent(listingId)}`, clerkJwt),
      medusaFetch('/store/sellers/me', clerkJwt),
    ])
    if (!productRes.ok || !sellerRes.ok) return null
    const product = await productRes.json() as { listing_type?: string; delivery_mode?: 'carrier' | 'arranged' | null }
    // An older backend does not send these fields: "could not read", not "a carrier product" — otherwise a service or
    // event draft would get a wrong 422 (fresh-review catch, PR 497). Fail open, per D3.
    if (typeof product.listing_type !== 'string') return null
    const { seller } = await sellerRes.json() as { seller: Record<string, unknown> }
    return listingReadiness({
      listingType: product.listing_type,
      deliveryMode: product.delivery_mode ?? null,
      shop: ownerShopFacts((seller?.metadata ?? null) as Record<string, unknown> | null),
    })
  } catch {
    return null
  }
}

export type ListingStatusTarget = 'active' | 'paused'
export type SetListingStatusResult =
  | { ok: true }
  | { ok: false; status: number; error: string; code?: 'LISTING_NOT_READY'; missing?: readonly ReadinessMissing[] }

/**
 * Flip a listing's status, with every side effect the single-row PATCH route
 * always ran: viability gate on activate, metadata.paused write, Supabase
 * mirror, ML-close cascade on pause, launchpad notify on activate. Callers:
 * the PATCH route itself (one item) and the bulk-apply loop (many items, one
 * per call — still in-process function calls, not a recursive HTTP
 * round-trip to this same route).
 */
export async function setListingStatus(
  id: string,
  target: ListingStatusTarget,
  ctx: { userId: string; clerkJwt: string },
  opts: { publishAsCatalog?: boolean } = {},
): Promise<SetListingStatusResult> {
  if (target === 'active') {
    // The merchant may activate a listing nobody can pay for online only by saying so (D4: «Solo catálogo» is a
    // choice, derived live — never stored). Without that, the refusal names what is missing.
    const readiness = await readListingReadiness(id, ctx.clerkJwt)
    const refusal = readiness ? listingNotReadyRefusal(readiness, opts.publishAsCatalog === true) : null
    if (refusal) return { ok: false, status: 422, error: refusal.error, code: refusal.code, missing: refusal.missing }
  }

  const medusaStatus = target === 'active' ? 'published' : 'draft'
  const res = await medusaFetch(`/store/sellers/me/products/${id}`, ctx.clerkJwt, {
    method: 'PATCH',
    body: JSON.stringify({ status: medusaStatus, metadata: { paused: target === 'paused' } }),
  })

  if (res.status === 403) return { ok: false, status: 403, error: 'No tienes permiso para modificar este anuncio.' }
  if (res.status === 404) return { ok: false, status: 404, error: 'Anuncio no encontrado.' }
  if (!res.ok) return { ok: false, status: 500, error: 'Error al actualizar el anuncio.' }

  await db
    .from('marketplace_listings')
    .update({ status: target, updated_at: new Date().toISOString() })
    .eq('medusa_product_id', id)

  if (target === 'paused') await bestEffortCloseMl(ctx.userId, id)
  if (target === 'active') await notifyWriterOnPublish(id).catch(() => {})

  return { ok: true }
}

export type DeleteListingResult = { ok: true } | { ok: false; status: number; error: string }

/**
 * Soft-delete a listing — extracted from the DELETE handler in
 * `app/api/sell/listing/[id]/route.ts` (catalog-management S3 · 3.2) so the
 * bulk `delete` action shares the exact same Supabase-mirror + ML-close
 * cascade as a single-row delete, instead of a raw backend call that would
 * skip both.
 */
export async function deleteListing(
  id: string,
  ctx: { userId: string; clerkJwt: string },
): Promise<DeleteListingResult> {
  const res = await medusaFetch(`/store/sellers/me/products/${id}`, ctx.clerkJwt, { method: 'DELETE' })

  if (res.status === 403) return { ok: false, status: 403, error: 'No tienes permiso para eliminar este anuncio.' }
  if (res.status === 404) return { ok: false, status: 404, error: 'Anuncio no encontrado.' }
  if (!res.ok) return { ok: false, status: 500, error: 'Error al eliminar el anuncio.' }

  await db
    .from('marketplace_listings')
    .update({ status: 'deleted', updated_at: new Date().toISOString() })
    .eq('medusa_product_id', id)

  await bestEffortCloseMl(ctx.userId, id)

  return { ok: true }
}
