/**
 * Frontend bridge for agent-driven listing management (Seller Agent Operations
 * · Sprint 2). Reads listings from the Supabase mirror (all statuses, scoped by
 * shop) and writes through the backend internal route (which an agent token
 * can't reach directly — it's the service-to-service path holding the shared
 * secret). The backend re-verifies ownership by seller slug; we also verify here
 * against the mirror (defense in depth).
 */

import { db } from './supabase'
import { formatOfferAmount } from './offers'
import { freeEventPriceRefusal } from './evento-preset'
import { listingReadiness, ownerShopFacts, readinessMessage, type DeliveryMode } from './listing-readiness'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const INTERNAL_SECRET = process.env.MEDUSA_INTERNAL_SECRET ?? ''

export interface AgentListingView {
  product_id: string
  title: string
  price: string | null
  status: string
  listing_type: string
}

/** A draft product as the consent-preview surface needs it — Medusa-authoritative. */
export interface DraftListingView {
  id: string
  title: string
  price_cents: number | null
  currency: string
  image_url: string | null
}

/**
 * Read a seller's DRAFT products from Medusa (authoritative), via the backend
 * internal route `GET /internal/seller-products/drafts`. Founding merchant
 * consent-safe previews reads the proposal from here rather than the Supabase
 * mirror, per Daniel's Sprint-1 decision (2026-07-21) — Medusa owns commerce, and
 * a mirror can drift from what activation will actually publish.
 *
 * Returns null on ANY failure (secret unset, network, non-200) so the caller can
 * fail closed — a consent surface must never render a partial/empty proposal that
 * a merchant might approve.
 */
export async function listShopDraftsViaInternal(
  sellerSlug: string,
): Promise<DraftListingView[] | null> {
  if (!INTERNAL_SECRET) return null
  try {
    const res = await fetch(
      `${MEDUSA_BASE}/internal/seller-products/drafts?seller_slug=${encodeURIComponent(sellerSlug)}`,
      { headers: { 'x-internal-secret': INTERNAL_SECRET }, cache: 'no-store' },
    )
    if (!res.ok) return null
    const data = (await res.json()) as {
      products?: Array<{
        id?: string
        title?: string
        price_cents?: number | null
        currency?: string | null
        images?: Array<{ url?: string | null }> | null
      }>
    }
    return (data.products ?? []).map((p) => ({
      id: String(p.id ?? ''),
      title: String(p.title ?? ''),
      price_cents: typeof p.price_cents === 'number' ? p.price_cents : null,
      currency: String(p.currency ?? 'MXN'),
      image_url: (Array.isArray(p.images) ? p.images[0]?.url : null) ?? null,
    }))
  } catch {
    return null
  }
}

/** List a shop's listings (all non-deleted statuses) from the mirror. */
export async function listShopListings(shopId: string): Promise<AgentListingView[]> {
  const { data } = await db
    .from('marketplace_listings')
    .select('medusa_product_id, title, price_cents, currency, status, listing_type')
    .eq('shop_id', shopId)
    .neq('status', 'deleted')
    .order('created_at', { ascending: false })
    .limit(100)

  return (data ?? [])
    .filter((r) => r.medusa_product_id)
    .map((r) => ({
      product_id: r.medusa_product_id as string,
      title: r.title as string,
      price: r.price_cents != null ? formatOfferAmount(r.price_cents as number, (r.currency as string) ?? 'MXN') : null,
      status: r.status as string,
      listing_type: r.listing_type as string,
    }))
}

/** Confirm a product belongs to this shop (via the mirror). Returns its type, or null. */
export async function shopOwnsProduct(shopId: string, productId: string): Promise<{ listing_type: string } | null> {
  const { data } = await db
    .from('marketplace_listings')
    .select('listing_type')
    .eq('shop_id', shopId)
    .eq('medusa_product_id', productId)
    .maybeSingle()
  return data ? { listing_type: data.listing_type as string } : null
}

/**
 * The mirror metadata of the given products, keyed by product id — THE one read behind every
 * "a free Evento stays free" check outside the edit PUT (MCP update_listing / apply_price, the profit
 * apply-price route, catalog bulk). Scoped by product id. Returns null when the read FAILED: the caller
 * must refuse a price move then (unknown is not "not an Evento").
 */
export async function loadMirrorMetadata(productIds: string[]): Promise<Map<string, Record<string, unknown> | null> | null> {
  const out = new Map<string, Record<string, unknown> | null>()
  if (productIds.length === 0) return out
  const { data, error } = await db
    .from('marketplace_listings')
    .select('medusa_product_id, metadata')
    .in('medusa_product_id', productIds)
  if (error) return null
  for (const r of (data ?? []) as Array<{ medusa_product_id: string; metadata: Record<string, unknown> | null }>) {
    out.set(r.medusa_product_id, r.metadata ?? null)
  }
  return out
}

export const FREE_EVENT_PRICE_UNVERIFIED_MESSAGE = 'No se pudo verificar si este anuncio es un evento gratis. Intenta de nuevo.'

/** Refusal message for moving ONE product's price to `nextPriceCents`, or null when allowed. */
export async function freeEventPriceBlock(productId: string, nextPriceCents: number | null | undefined): Promise<string | null> {
  if (nextPriceCents === undefined) return null
  const meta = await loadMirrorMetadata([productId])
  if (!meta) return FREE_EVENT_PRICE_UNVERIFIED_MESSAGE
  return freeEventPriceRefusal(meta.get(productId) ?? null, nextPriceCents)
}

export interface SellerProductPatch {
  title?: string
  description?: string | null
  price_cents?: number | null
  quantity?: number | null
  status?: 'published' | 'draft'
  /** Full replacement set of seller-owned collection ids (own-shop-premium-presentation S2). */
  collection_ids?: string[]
  // Opciones — priced option dimensions + per-variant quantity tiers
  // (mcp-parity-core S2). The backend internal route passes the full
  // SellerProductUpdateBody through to the shared updateSellerProduct, so the
  // contract + real validation (mutual-exclusivity, restructure guards, tier
  // ladder) live there; this bridge only names the fields.
  option_dimensions?: Array<{ title: string; values: string[] }>
  /** Per-combination price in cents, keyed by sorted "Title:Value|Title:Value". */
  variant_prices?: Record<string, number>
  /** Explicit variant to target for variant_tiers on a multi-variant product. */
  variant_id?: string
  variant_tiers?: Array<{ min_quantity: number; max_quantity: number | null; amount: number }>
}

/** PATCH the product through the backend internal route (x-internal-secret). */
export async function patchSellerProductViaInternal(
  sellerSlug: string,
  productId: string,
  body: SellerProductPatch,
): Promise<{ ok: boolean; status: number; error?: string }> {
  if (!INTERNAL_SECRET) return { ok: false, status: 500, error: 'Internal secret not configured.' }
  try {
    const res = await fetch(`${MEDUSA_BASE}/internal/seller-products/${productId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify({ seller_slug: sellerSlug, ...body }),
    })
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { message?: string }
      return { ok: false, status: res.status, error: d.message ?? `Error ${res.status}` }
    }
    return { ok: true, status: 200 }
  } catch (e) {
    return { ok: false, status: 500, error: String(e) }
  }
}

export interface SellerProductCreate {
  title: string
  description?: string | null
  price_cents?: number | null
  currency?: string
  condition?: string | null
  listing_type?: string
  category?: string
  state?: string | null
  municipio?: string | null
  location?: string | null
  quantity?: number | null
  weight_grams?: number | null
  status?: 'published' | 'draft'
  images?: Array<{ url: string; alt?: string }>
  metadata?: Record<string, unknown>
  /** Type/category-specific attrs (e.g. autos make/model/year, financing, inspection,
   *  warranty) — mirrors the internal backend route's own `attrs` body field, which
   *  flows straight into product `metadata.attrs`. */
  attrs?: Record<string, unknown>
}

/** Create a product through the backend internal route (x-internal-secret). The
 *  agent token can't reach Medusa directly, so this is the service-to-service
 *  door (sibling of patchSellerProductViaInternal). Returns the new product id. */
export async function createSellerProductViaInternal(
  sellerSlug: string,
  body: SellerProductCreate,
): Promise<{ ok: boolean; status: number; product_id?: string; error?: string }> {
  if (!INTERNAL_SECRET) return { ok: false, status: 500, error: 'Internal secret not configured.' }
  try {
    const res = await fetch(`${MEDUSA_BASE}/internal/seller-products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify({ seller_slug: sellerSlug, ...body }),
    })
    const d = (await res.json().catch(() => ({}))) as { product_id?: string; message?: string }
    if (!res.ok || !d.product_id) {
      return { ok: false, status: res.status, error: d.message ?? `Error ${res.status}` }
    }
    return { ok: true, status: res.status, product_id: d.product_id }
  } catch (e) {
    return { ok: false, status: 500, error: String(e) }
  }
}

export interface SellerCollectionCreated {
  id: string
  handle: string
  name: string
  sort_order: number
}

/** Create a collection through the backend internal route (x-internal-secret).
 *  Sibling of createSellerProductViaInternal — the agent token can't reach
 *  Medusa directly, so this is the service-to-service door the
 *  `create_collection` MCP tool calls. */
export async function createSellerCollectionViaInternal(
  sellerSlug: string,
  name: string,
): Promise<{ ok: boolean; status: number; collection?: SellerCollectionCreated; error?: string }> {
  if (!INTERNAL_SECRET) return { ok: false, status: 500, error: 'Internal secret not configured.' }
  try {
    const res = await fetch(`${MEDUSA_BASE}/internal/seller-collections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify({ seller_slug: sellerSlug, name }),
    })
    const d = (await res.json().catch(() => ({}))) as { collection?: SellerCollectionCreated; message?: string }
    if (!res.ok || !d.collection) {
      return { ok: false, status: res.status, error: d.message ?? `Error ${res.status}` }
    }
    return { ok: true, status: res.status, collection: d.collection }
  } catch (e) {
    return { ok: false, status: 500, error: String(e) }
  }
}

/** Soft-delete the product through the backend internal route (x-internal-secret).
 *  Sibling of patchSellerProductViaInternal — the exact same native Medusa
 *  soft-delete the portal DELETE runs (order line-items keep resolving, which
 *  is why no order-linked refusal guard exists on this path — parity by
 *  design; mcp-parity-core S3.1). */
export async function deleteSellerProductViaInternal(
  sellerSlug: string,
  productId: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  if (!INTERNAL_SECRET) return { ok: false, status: 500, error: 'Internal secret not configured.' }
  try {
    const res = await fetch(
      `${MEDUSA_BASE}/internal/seller-products/${productId}?seller_slug=${encodeURIComponent(sellerSlug)}`,
      {
        method: 'DELETE',
        headers: { 'x-internal-secret': INTERNAL_SECRET },
      },
    )
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { message?: string }
      return { ok: false, status: res.status, error: d.message ?? `Error ${res.status}` }
    }
    return { ok: true, status: 200 }
  } catch (e) {
    return { ok: false, status: 500, error: String(e) }
  }
}

export interface ApplyPriceViaInternalResult {
  ok: boolean
  status: number
  error?: string
  /** The backend's honest partial-state body on success ({ miyagi, ml, ... }). */
  body?: Record<string, unknown>
}

/** Apply a variant price through the backend internal route (x-internal-secret).
 *  Sibling of patchSellerProductViaInternal — same pipeline as the portal's
 *  one-click Apply (ownership → Miyagi write → conditional ML push →
 *  price_apply activity log; mcp-parity-core S3.2). */
export async function applySellerPriceViaInternal(
  sellerSlug: string,
  input: { product_id: string; variant_id: string; new_price_cents: number; target_margin_pct?: number },
): Promise<ApplyPriceViaInternalResult> {
  if (!INTERNAL_SECRET) return { ok: false, status: 500, error: 'Internal secret not configured.' }
  try {
    const res = await fetch(`${MEDUSA_BASE}/internal/profit/apply-price`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify({ seller_slug: sellerSlug, ...input }),
      cache: 'no-store',
    })
    const d = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return { ok: false, status: res.status, error: (d.message as string) ?? `Error ${res.status}` }
    }
    return { ok: true, status: res.status, body: d }
  } catch (e) {
    return { ok: false, status: 500, error: String(e) }
  }
}

/** Provision (or reuse) the shop's hidden support product through the backend
 *  internal route (x-internal-secret) — the same reuse-first core the Clerk
 *  portal path uses (backend _utils/support-product-ensure.ts). Idempotent;
 *  re-stamps settings.support.support_product_id server-side
 *  (mcp-parity-core S4.1). */
export async function ensureSupportProductViaInternal(
  sellerSlug: string,
): Promise<{ ok: boolean; status: number; product_id?: string; reused?: boolean; error?: string }> {
  if (!INTERNAL_SECRET) return { ok: false, status: 500, error: 'Internal secret not configured.' }
  try {
    const res = await fetch(`${MEDUSA_BASE}/internal/support-product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify({ seller_slug: sellerSlug }),
      cache: 'no-store',
    })
    const d = (await res.json().catch(() => ({}))) as { product_id?: string; reused?: boolean; message?: string }
    if (!res.ok || !d.product_id) {
      return { ok: false, status: res.status, error: d.message ?? `Error ${res.status}` }
    }
    return { ok: true, status: res.status, product_id: d.product_id, reused: d.reused === true }
  } catch (e) {
    return { ok: false, status: 500, error: String(e) }
  }
}

/** Rename a collection through the backend internal route (x-internal-secret).
 *  Sibling of createSellerCollectionViaInternal — same shared
 *  renameSellerCollection logic the Clerk-authed portal PATCH runs, ownership
 *  re-checked backend-side (mcp-parity-config S1.1). */
export async function renameSellerCollectionViaInternal(
  sellerSlug: string,
  collectionId: string,
  name: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  if (!INTERNAL_SECRET) return { ok: false, status: 500, error: 'Internal secret not configured.' }
  try {
    const res = await fetch(`${MEDUSA_BASE}/internal/seller-collections/${collectionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify({ seller_slug: sellerSlug, name }),
    })
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { message?: string }
      return { ok: false, status: res.status, error: d.message ?? `Error ${res.status}` }
    }
    return { ok: true, status: 200 }
  } catch (e) {
    return { ok: false, status: 500, error: String(e) }
  }
}

/** Delete a collection through the backend internal route (x-internal-secret).
 *  Same shared deleteSellerCollection the portal DELETE runs — removes the
 *  category + its links only, NEVER the member products (mcp-parity-config S1.1). */
export async function deleteSellerCollectionViaInternal(
  sellerSlug: string,
  collectionId: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  if (!INTERNAL_SECRET) return { ok: false, status: 500, error: 'Internal secret not configured.' }
  try {
    const res = await fetch(
      `${MEDUSA_BASE}/internal/seller-collections/${collectionId}?seller_slug=${encodeURIComponent(sellerSlug)}`,
      { method: 'DELETE', headers: { 'x-internal-secret': INTERNAL_SECRET } },
    )
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { message?: string }
      return { ok: false, status: res.status, error: d.message ?? `Error ${res.status}` }
    }
    return { ok: true, status: 200 }
  } catch (e) {
    return { ok: false, status: 500, error: String(e) }
  }
}

/** Reorder collections through the backend internal route (x-internal-secret).
 *  Same shared reorderSellerCollections the portal PATCH runs — including the
 *  full-set guard (every owned collection exactly once) (mcp-parity-config S1.2). */
export async function reorderSellerCollectionsViaInternal(
  sellerSlug: string,
  orderedIds: string[],
): Promise<{ ok: boolean; status: number; error?: string }> {
  if (!INTERNAL_SECRET) return { ok: false, status: 500, error: 'Internal secret not configured.' }
  try {
    const res = await fetch(`${MEDUSA_BASE}/internal/seller-collections/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify({ seller_slug: sellerSlug, ordered_ids: orderedIds }),
    })
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { message?: string }
      return { ok: false, status: res.status, error: d.message ?? `Error ${res.status}` }
    }
    return { ok: true, status: 200 }
  } catch (e) {
    return { ok: false, status: 500, error: String(e) }
  }
}

/** Change the seller's slug through the backend internal route
 *  (x-internal-secret). Medusa owns uniqueness (409) exactly as the portal's
 *  Clerk-JWT PATCH /store/sellers/me does; the caller must have already run
 *  lib/slug.ts validateSlug (format + reserved words) and computed the alias
 *  history via buildSlugAliasHistory (mcp-parity-config S2.1). */
export async function patchSellerSlugViaInternal(
  sellerSlug: string,
  newSlug: string,
  previousSlugs: Array<{ slug: string; until: string }>,
  previousSlugKeys: string[],
): Promise<{ ok: boolean; status: number; error?: string }> {
  if (!INTERNAL_SECRET) return { ok: false, status: 500, error: 'Internal secret not configured.' }
  try {
    const res = await fetch(`${MEDUSA_BASE}/internal/sellers/slug`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify({
        seller_slug: sellerSlug,
        new_slug: newSlug,
        previous_slugs: previousSlugs,
        previous_slug_keys: previousSlugKeys,
      }),
    })
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { message?: string }
      return { ok: false, status: res.status, error: d.message ?? `Error ${res.status}` }
    }
    return { ok: true, status: 200 }
  } catch (e) {
    return { ok: false, status: 500, error: String(e) }
  }
}

/**
 * Returns a plain-language reason a product listing can't be activated, or null if it's OK. The MCP door's adapter
 * over the ONE rule in `lib/listing-readiness.ts` (epic listing-readiness S1.1): the same owner facts and message the
 * portal's activation gate uses. This copy used to ignore arranged delivery and cash, and knew only v1 Stripe.
 */
export function listingActivationBlock(
  shopMeta: Record<string, unknown> | null,
  listingType: string,
  deliveryMode?: DeliveryMode,
): string | null {
  return readinessMessage(listingReadiness({ listingType, deliveryMode, shop: ownerShopFacts(shopMeta) }))
}
