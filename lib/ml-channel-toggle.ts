/**
 * Shared Mercado Libre channel-toggle orchestration — extracted from
 * `app/api/sell/listing/[id]/route.ts` (catalog-management epic, Sprint 3 ·
 * Story 3.2) so the bulk `publish_channel` action (channel: 'ml') reuses the
 * exact same entitlement check + reconcile cascade as a single-row toggle,
 * instead of a raw backend field patch that would skip the actual Mercado
 * Libre publish/close call entirely.
 *
 * server-only (calls Medusa with the caller's Clerk JWT).
 */
import 'server-only'
import { db } from '@/lib/supabase'
import { closeMlProduct, publishMlProduct } from '@/lib/ml-publish-bridge'
import { resolveMlSyncEntitlement } from '@/lib/ml-sync-entitlement-server'

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

export async function getShopSlug(userId: string): Promise<string | null> {
  const { data: shop } = await db
    .from('marketplace_shops')
    .select('slug')
    .eq('clerk_user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return shop?.slug ?? null
}

/**
 * `ml_sync` entitlement check for turning the ML toggle ON — defense in
 * depth alongside the backend's own gate inside `publishOrSyncProduct`.
 * Fails closed (not entitled) on any lookup error.
 */
export async function isMlSyncEntitled(userId: string): Promise<boolean> {
  try {
    const { data: shop } = await db
      .from('marketplace_shops')
      .select('id, metadata')
      .eq('clerk_user_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    const entitlement = await resolveMlSyncEntitlement(shop?.metadata, { sellerClerkId: userId, shopId: shop?.id })
    return entitlement.entitled
  } catch {
    return false
  }
}

/**
 * Reconcile the live ML listing right after a successful `ml_enabled`
 * toggle write. Never throws (the metadata write already succeeded
 * regardless of what ML does). Returns `needs_category: true` only when
 * turning ON hits a never-linked product with no category yet.
 */
export async function reconcileMlToggle(
  userId: string,
  productId: string,
  mlEnabled: boolean,
): Promise<{ needs_category?: boolean }> {
  try {
    const slug = await getShopSlug(userId)
    if (!slug) return {}
    if (!mlEnabled) {
      await closeMlProduct(slug, productId)
      return {}
    }
    const result = await publishMlProduct(slug, productId)
    return result.ok || result.reason !== 'no_category' ? {} : { needs_category: true }
  } catch {
    return {}
  }
}

export type ToggleMlChannelResult =
  | { ok: true; needs_category?: boolean }
  | { ok: false; status: number; error: string }

/**
 * Combined entitlement-check + single-field write + reconcile, for a bulk
 * `publish_channel` (channel: 'ml') action item — the single-row PUT handler
 * bundles `ml_enabled` with other edited fields in one PATCH and calls
 * `reconcileMlToggle` separately after; this does the same two steps for a
 * standalone ML-toggle-only change (no other fields in play).
 */
export async function toggleMlChannel(
  id: string,
  enabled: boolean,
  ctx: { userId: string; clerkJwt: string },
): Promise<ToggleMlChannelResult> {
  if (enabled && !(await isMlSyncEntitled(ctx.userId))) {
    return { ok: false, status: 402, error: 'Esta tienda no tiene el complemento de Mercado Libre habilitado.' }
  }

  const res = await medusaFetch(`/store/sellers/me/products/${id}`, ctx.clerkJwt, {
    method: 'PATCH',
    body: JSON.stringify({ ml_enabled: enabled }),
  })

  if (res.status === 403) return { ok: false, status: 403, error: 'No tienes permiso para modificar este anuncio.' }
  if (res.status === 404) return { ok: false, status: 404, error: 'Anuncio no encontrado.' }
  if (res.status === 423) return { ok: false, status: 423, error: 'Esta función aún no está disponible.' }
  if (!res.ok) return { ok: false, status: 500, error: 'Error al actualizar el anuncio.' }

  const { needs_category } = await reconcileMlToggle(ctx.userId, id, enabled)
  return { ok: true, needs_category }
}
