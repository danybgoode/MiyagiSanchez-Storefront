/**
 * One catalog row → one Medusa product for the signed-in seller — the logic behind `POST /api/sell/import`, shared.
 *
 * Extracted (prompt-to-shop S4.2) so the photo → product confirm creates its product IN-PROCESS with the caller's
 * own Clerk token, the same way the importer does. Never `fetch()` our own `/api/sell/import` from the server: a
 * server-side request carries no session cookie (team memory, PR 244: 32 days of silent failures).
 *
 * `buildCreateBody` is pure and is the importer's body verbatim; `createSellerProduct` is the thin Medusa call with
 * `fetch` injected.
 */

import type { CatalogImportRow } from './catalog-import'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const PUB_KEY = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

const isStockable = (lt?: string) => (lt ?? 'product') === 'product'

export interface CreateBodyExtras {
  /** Medusa's initial status. The backend defaults to `published`; the importer leaves it unset (unchanged). */
  status?: 'draft' | 'published'
  /** Medusa handles are GLOBALLY unique, so a handle derived from an idempotency key makes a repeat create fail. */
  handle?: string
  /** Merged over the importer's `{ external_id }`. */
  metadata?: Record<string, unknown>
}

export function buildCreateBody(row: CatalogImportRow, images: Array<{ url: string; alt?: string }>, extras: CreateBodyExtras = {}) {
  const listingType = row.listing_type ?? 'product'
  const priceCents = row.price != null ? Math.round(row.price * 100) : null
  const location = [row.city?.trim(), row.state?.trim()].filter(Boolean).join(', ') || null
  return {
    title: row.title.trim(),
    description: row.description?.trim() || null,
    price_cents: priceCents,
    currency: row.currency ?? 'MXN',
    condition: listingType === 'product' ? (row.condition ?? null) : null,
    listing_type: listingType,
    category: row.category,
    state: row.state || null,
    municipio: row.city || null,
    location,
    quantity: isStockable(listingType) ? Math.max(1, Math.floor(row.quantity ?? 1)) : 1,
    weight_grams: row.weight_grams ?? null,
    images,
    metadata: { external_id: row.external_id ?? null, ...(extras.metadata ?? {}) },
    ...(extras.status ? { status: extras.status } : {}),
    ...(extras.handle ? { handle: extras.handle } : {}),
    // Unit cost (COGS) in centavos → the created variant's private metadata
    // (profit-analyzer S1 · US-1). Pesos → centavos, same convention as price.
    ...(row.unit_cost != null ? { unit_cost_cents: Math.round(row.unit_cost * 100) } : {}),
    // Autos vehicle specs + financing/trust (cars-vertical S2.3) — assembled
    // by stageRow() into row.attrs, mirroring the backend's own non-empty
    // guard (seller-product-create.ts only writes attrs when non-empty).
    ...(row.attrs && Object.keys(row.attrs).length > 0 ? { attrs: row.attrs } : {}),
  }
}

export type CreateProductResult =
  | { ok: true; productId: string }
  | { ok: false; status: number; message: string | null }

/** `POST /store/sellers/me/products` as the seller. A 2xx without a product id is a failure, not a success. */
export async function createSellerProduct(
  clerkJwt: string,
  body: ReturnType<typeof buildCreateBody>,
  deps: { fetch: typeof fetch } = { fetch: (...args) => fetch(...args) },
): Promise<CreateProductResult> {
  const res = await deps.fetch(`${MEDUSA_BASE}/store/sellers/me/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-publishable-api-key': PUB_KEY, Authorization: `Bearer ${clerkJwt}` },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as { product_id?: string; message?: string }
  if (!res.ok || !data.product_id) return { ok: false, status: res.status, message: data.message ?? null }
  return { ok: true, productId: data.product_id }
}
