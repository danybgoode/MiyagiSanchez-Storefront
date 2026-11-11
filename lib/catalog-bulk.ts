/**
 * Catalog bulk-action pipeline — catalog-management epic, Sprint 3 · Story 3.1.
 * server-only: calls the backend's bulk-stage/bulk-apply routes (Clerk JWT)
 * and persists staged batches into Supabase (`catalog_bulk_batches` /
 * `catalog_bulk_batch_items` / `catalog_bulk_audit_log`) — staging state is
 * operational/presentation, not commerce truth (AGENTS rule 2); the actual
 * product mutation happens in the backend via `updateSellerProduct()` or
 * (for `pause_activate`) `lib/listing-status.ts`'s `setListingStatus()`.
 */
import 'server-only'
import { db } from '@/lib/supabase'
import { isEnabled } from '@/lib/flags'
import { loadMirrorMetadata, FREE_EVENT_PRICE_UNVERIFIED_MESSAGE } from '@/lib/seller-products'
import { freeEventPatchRefusal } from '@/lib/evento-preset'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const PUB_KEY = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

const INTERNAL_SECRET = process.env.MEDUSA_INTERNAL_SECRET ?? ''

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

/** Service-to-service call for the MCP agent path (no Clerk JWT) — mirrors
 * `lib/seller-products.ts`'s `patchSellerProductViaInternal`. */
function internalFetch(path: string, body: unknown) {
  return fetch(`${MEDUSA_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
    body: JSON.stringify(body),
  })
}

export type BulkActionPayload =
  | { type: 'price_set'; price_cents: number }
  | { type: 'price_pct'; percent: number }
  | { type: 'pause_activate'; status: 'active' | 'paused' }
  | { type: 'publish_channel'; channel: 'miyagi' | 'ml'; enabled: boolean }
  | { type: 'category'; category_handle: string; category_label: string }
  | { type: 'collection_assign'; collection_ids: string[]; collection_labels: string[] }
  | { type: 'inventory_mode'; mode: 'tracked' | 'unlimited' | 'backorder'; dispatch_estimate?: string | null }
  | { type: 'delete' }
  // catalog-management S4 · Story 4.2 — mirrors the backend's own
  // BulkActionPayload addition. Each item's price is pre-computed by the
  // CALLER (BulkActionBar, via lib/profit.ts's solveForPrice + a live ML
  // fee-estimate fetch per selected product) — this type carries the
  // already-solved prices, not a formula to re-derive server-side.
  | { type: 'apply_suggested_price'; target_margin_pct: number; items: Array<{ id: string; price_cents: number }> }

export interface BulkFilterParams {
  q?: string
  category?: string
  channel?: 'miyagi' | 'ml'
  stock?: 'in_stock' | 'agotado' | 'unlimited'
  status?: 'activo' | 'agotado' | 'borrador' | 'pausado' | 'sobre_pedido'
  sort?: 'recent' | 'title' | 'price_asc' | 'price_desc'
}

export interface BulkDiffItem {
  id: string
  title: string
  before: Record<string, unknown>
  after: Record<string, unknown>
  patch: Record<string, unknown> | null
  valid: boolean
  error: string | null
  /** Only set for apply_suggested_price (S4 · 4.2) — new minus old Miyagi
   * price, for the confirm dialog's total. Undefined for every other type. */
  delta_cents?: number | null
}

export type StageResult =
  | { ok: true; batch_id: string; total: number; valid_count: number; invalid_count: number }
  | { ok: false; status: number; error: string }

/**
 * Stage a bulk action: resolve target products (via the backend, which
 * re-runs the SAME filter/sort logic the catalog table uses), persist the
 * batch + per-item diff into Supabase. Nothing is written to Medusa here.
 */
export async function stageBulkAction(
  ctx: { userId: string; clerkJwt: string },
  target: { filter?: BulkFilterParams; ids?: string[] },
  action: BulkActionPayload,
): Promise<StageResult> {
  const res = await medusaFetch('/store/sellers/me/products/bulk-stage', ctx.clerkJwt, {
    method: 'POST',
    body: JSON.stringify({ filter: target.filter ?? null, ids: target.ids ?? null, action }),
  })

  if (res.status === 423) return { ok: false, status: 423, error: 'Esta función aún no está disponible.' }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    return { ok: false, status: res.status, error: body.message ?? 'Error al preparar el lote.' }
  }

  const data = await res.json() as { total: number; valid_count: number; invalid_count: number; items: BulkDiffItem[] }

  const { data: batch, error: batchError } = await db
    .from('catalog_bulk_batches')
    .insert({
      seller_id: ctx.userId,
      actor_type: 'seller',
      actor_id: ctx.userId,
      action,
      status: 'ready',
      total_count: data.total,
      valid_count: data.valid_count,
      failed_count: 0,
      applied_count: 0,
    })
    .select('id')
    .single()

  if (batchError || !batch) return { ok: false, status: 500, error: 'Error al guardar el lote.' }

  if (data.items.length > 0) {
    const { error: itemsError } = await db.from('catalog_bulk_batch_items').insert(
      data.items.map((item) => ({
        batch_id: batch.id,
        product_id: item.id,
        title: item.title,
        before: item.before,
        after: item.after,
        patch: item.patch,
        valid: item.valid,
        error_message: item.error,
        status: 'pending',
        // Only include the key when THIS action type actually set it
        // (apply_suggested_price) — the other 7 types never populate
        // delta_cents, so their insert payload stays byte-identical to
        // before this column existed. This is deliberate: a Supabase INSERT
        // referencing an unknown column errors regardless of the value, so
        // if the delta_cents migration hasn't landed yet on a given
        // environment, every OTHER bulk action (including the already-live
        // catalog.bulk_enabled feature) must keep working unaffected by
        // this column's rollout — deploy order between the frontend and the
        // migration must not matter for them (cross-agent review catch).
        ...(item.delta_cents !== undefined ? { delta_cents: item.delta_cents } : {}),
      })),
    )
    if (itemsError) return { ok: false, status: 500, error: 'Error al guardar los productos del lote.' }
  }

  return { ok: true, batch_id: batch.id, total: data.total, valid_count: data.valid_count, invalid_count: data.invalid_count }
}

export interface StoredBatch {
  id: string
  seller_id: string
  action: BulkActionPayload
  status: string
  total_count: number
  valid_count: number
  applied_count: number
  failed_count: number
  created_at: string
}

export interface StoredBatchItem {
  id: string
  product_id: string
  title: string
  before: Record<string, unknown>
  after: Record<string, unknown>
  patch: Record<string, unknown> | null
  valid: boolean
  error_message: string | null
  status: 'pending' | 'applying' | 'applied' | 'failed'
  /** Only set for apply_suggested_price (S4 · 4.2) — see BulkDiffItem. */
  delta_cents?: number | null
}

/** Read a batch back (survives refresh — the Shopify failure mode). Returns
 * null if the batch doesn't exist OR belongs to a different seller (ownership
 * check, not just existence). */
export async function getBulkBatch(
  batchId: string,
  userId: string,
): Promise<{ batch: StoredBatch; items: StoredBatchItem[] } | null> {
  const { data: batch } = await db.from('catalog_bulk_batches').select('*').eq('id', batchId).maybeSingle()
  if (!batch || batch.seller_id !== userId) return null

  const { data: items } = await db
    .from('catalog_bulk_batch_items')
    .select('*')
    .eq('batch_id', batchId)
    .order('created_at', { ascending: true })

  return { batch: batch as StoredBatch, items: (items ?? []) as StoredBatchItem[] }
}

export type ApplyResult =
  | { ok: true; applied: number; failed: number; skipped: number }
  | { ok: false; status: number; error: string }

/**
 * Atomically claim this batch's pending, valid items — a single
 * UPDATE...WHERE status='pending' RETURNING flips them to 'applying' and
 * returns exactly the rows THIS call claimed. Two concurrent apply requests
 * on the same batch can never both claim the same item: Postgres' row-level
 * locking on the UPDATE serializes them, so the second request's WHERE
 * status='pending' simply matches nothing for any row the first already
 * claimed (closes a TOCTOU race a plain read-then-process-then-write
 * pattern would have — cross-agent review catch).
 */
async function claimPendingItems(batchId: string): Promise<StoredBatchItem[]> {
  const { data } = await db
    .from('catalog_bulk_batch_items')
    .update({ status: 'applying' })
    .eq('batch_id', batchId)
    .eq('status', 'pending')
    .eq('valid', true)
    .select('*')
  return (data ?? []) as StoredBatchItem[]
}

/**
 * A free Evento stays free in a bulk too: split the claimed rows into those that may be applied and
 * those whose price move is refused (reason attached). Only the affected rows are refused — the rest of
 * the batch proceeds. One metadata read for the whole batch, scoped by product id; if that read fails,
 * price rows are refused as unverifiable (never waved through).
 */
async function splitFreeEventPriceRefusals(
  pending: StoredBatchItem[],
): Promise<{ allowed: StoredBatchItem[]; refused: Array<{ item: StoredBatchItem; error: string }> }> {
  const touchesPrice = (item: StoredBatchItem) => {
    const patch = (item.patch ?? null) as { price_cents?: number | null; variant_prices?: Record<string, number> | null } | null
    return patch !== null && (patch.price_cents !== undefined || patch.variant_prices != null)
  }
  const priceRows = pending.filter(touchesPrice)
  if (priceRows.length === 0) return { allowed: pending, refused: [] }
  const meta = await loadMirrorMetadata(priceRows.map((i) => i.product_id))
  const allowed: StoredBatchItem[] = []
  const refused: Array<{ item: StoredBatchItem; error: string }> = []
  for (const item of pending) {
    if (!touchesPrice(item)) { allowed.push(item); continue }
    const error = meta
      ? freeEventPatchRefusal(meta.get(item.product_id) ?? null, item.patch as { price_cents?: number | null })
      : FREE_EVENT_PRICE_UNVERIFIED_MESSAGE
    if (error) refused.push({ item, error })
    else allowed.push(item)
  }
  return { allowed, refused }
}

/**
 * Apply a staged batch. Idempotent: an item already `applied` (or currently
 * being applied by a concurrent request) is skipped, never re-executed —
 * `claimPendingItems()` is what makes that atomic, not a plain filter over an
 * already-fetched read. Three action types need FRONTEND orchestration
 * (side effects that live outside `updateSellerProduct`) and are applied one
 * item at a time via the matching shared helper: `pause_activate` →
 * `setListingStatus()` (viability gate, metadata.paused, Supabase mirror, ML
 * close); `delete` → `deleteListing()` (Supabase mirror, ML close);
 * `publish_channel` targeting 'ml' → `toggleMlChannel()` (entitlement check,
 * ML publish/close reconcile). Every other action type (price,
 * `publish_channel` targeting 'miyagi', category, collection_assign,
 * inventory_mode) has no such side effects and goes through ONE call to the
 * backend's `bulk-apply` batch endpoint — never N sequential route calls
 * either way, since even the per-item frontend paths are in-process function
 * calls within this single request, not recursive HTTP round-trips.
 */
export async function applyBulkBatch(
  batchId: string,
  ctx: { userId: string; clerkJwt: string; actorType?: 'seller' | 'agent' },
): Promise<ApplyResult> {
  // Re-checked here (not just at stage time) — an already-staged batch must
  // not become applicable just because it was staged while the flag was ON;
  // the flag can flip OFF in between (cross-agent review catch: the generic
  // backend bulk-apply route already 423s on this, but the three
  // frontend-orchestrated action types below never reach that route, so
  // without this check they'd bypass the kill-switch entirely).
  if (!(await isEnabled('catalog.bulk_enabled'))) {
    return { ok: false, status: 423, error: 'Esta función aún no está disponible.' }
  }

  const found = await getBulkBatch(batchId, ctx.userId)
  if (!found) return { ok: false, status: 404, error: 'Lote no encontrado.' }
  const { batch, items } = found

  const alreadySettled = items.filter((i) => i.status === 'applied' || i.status === 'failed').length
  const claimed = await claimPendingItems(batchId)

  if (claimed.length === 0) {
    return { ok: true, applied: 0, failed: 0, skipped: alreadySettled }
  }

  await db.from('catalog_bulk_batches').update({ status: 'applying', updated_at: new Date().toISOString() }).eq('id', batchId)

  let applied = 0
  let failed = 0

  const actionType = batch.action.type
  const actorType = ctx.actorType ?? 'seller'

  // A free Evento keeps its $0 price: refuse just those rows (reported as failed with the reason).
  const { allowed: pending, refused } = await splitFreeEventPriceRefusals(claimed)
  for (const r of refused) {
    await recordItemResult(batchId, r.item, false, ctx.userId, actorType, actionType, r.error)
    failed++
  }

  if (batch.action.type === 'pause_activate') {
    const target = batch.action.status
    const { setListingStatus } = await import('@/lib/listing-status')
    for (const item of pending) {
      const result = await setListingStatus(item.product_id, target, { userId: ctx.userId, clerkJwt: ctx.clerkJwt })
      await recordItemResult(batchId, item, result.ok, ctx.userId, actorType, actionType, result.ok ? undefined : result.error)
      if (result.ok) applied++
      else failed++
    }
  } else if (batch.action.type === 'delete') {
    const { deleteListing } = await import('@/lib/listing-status')
    for (const item of pending) {
      const result = await deleteListing(item.product_id, { userId: ctx.userId, clerkJwt: ctx.clerkJwt })
      await recordItemResult(batchId, item, result.ok, ctx.userId, actorType, actionType, result.ok ? undefined : result.error)
      if (result.ok) applied++
      else failed++
    }
  } else if (batch.action.type === 'publish_channel' && batch.action.channel === 'ml') {
    const enabled = batch.action.enabled
    const { toggleMlChannel } = await import('@/lib/ml-channel-toggle')
    for (const item of pending) {
      const result = await toggleMlChannel(item.product_id, enabled, { userId: ctx.userId, clerkJwt: ctx.clerkJwt })
      await recordItemResult(batchId, item, result.ok, ctx.userId, actorType, actionType, result.ok ? undefined : result.error)
      if (result.ok) applied++
      else failed++
    }
  } else if (batch.action.type === 'apply_suggested_price') {
    // A 4th frontend-orchestrated branch (S4 · 4.2) — REQUIRED, not
    // optional: a {variant_id, price_cents} patch would otherwise fall into
    // the generic "everything else" bulk-apply call below and silently
    // Miyagi-only-apply, never pushing to Mercado Libre (the backend's
    // rejectOrchestrationOnlyPatch() also blocks this shape there as
    // defense in depth, but the real fix is routing it here first).
    const targetMarginPct = batch.action.target_margin_pct
    const { applySuggestedPriceItem } = await import('@/lib/profit-bulk-apply')
    for (const item of pending) {
      const patch = item.patch as { variant_id?: string; price_cents?: number } | null
      if (!patch?.variant_id || !Number.isInteger(patch.price_cents)) {
        await recordItemResult(batchId, item, false, ctx.userId, actorType, actionType, 'Lote inválido — falta variant_id o price_cents.')
        failed++
        continue
      }
      const result = await applySuggestedPriceItem(
        item.product_id,
        { variant_id: patch.variant_id, price_cents: patch.price_cents as number },
        targetMarginPct,
        { clerkJwt: ctx.clerkJwt },
      )
      await recordItemResult(batchId, item, result.ok, ctx.userId, actorType, actionType, result.ok ? undefined : result.error)
      if (result.ok) applied++
      else failed++
    }
  } else if (pending.length > 0) {
    const res = await medusaFetch('/store/sellers/me/products/bulk-apply', ctx.clerkJwt, {
      method: 'POST',
      body: JSON.stringify({ items: pending.map((i) => ({ id: i.product_id, patch: i.patch })) }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      await db.from('catalog_bulk_batches').update({ status: 'partially_failed', updated_at: new Date().toISOString() }).eq('id', batchId)
      return { ok: false, status: res.status, error: body.message ?? 'Error al aplicar el lote.' }
    }
    const { results } = await res.json() as { results: Array<{ id: string; ok: boolean; error?: string }> }
    const byId = new Map(results.map((r) => [r.id, r]))
    for (const item of pending) {
      const r = byId.get(item.product_id)
      const ok = r?.ok ?? false
      await recordItemResult(batchId, item, ok, ctx.userId, actorType, actionType, ok ? undefined : (r?.error ?? 'Error desconocido.'))
      if (ok) applied++
      else failed++
    }
  }

  await db
    .from('catalog_bulk_batches')
    .update({
      status: failed > 0 ? 'partially_failed' : 'applied',
      applied_count: applied,
      failed_count: failed,
      updated_at: new Date().toISOString(),
    })
    .eq('id', batchId)

  return { ok: true, applied, failed, skipped: alreadySettled }
}

async function recordItemResult(
  batchId: string,
  item: StoredBatchItem,
  ok: boolean,
  actorId: string,
  actorType: 'seller' | 'agent',
  actionType: string,
  error?: string,
): Promise<void> {
  await db
    .from('catalog_bulk_batch_items')
    .update({ status: ok ? 'applied' : 'failed', error_message: ok ? null : (error ?? null) })
    .eq('id', item.id)

  await db.from('catalog_bulk_audit_log').insert({
    batch_id: batchId,
    item_id: item.id,
    product_id: item.product_id,
    actor_type: actorType,
    actor_id: actorId,
    action: actionType,
    before: item.before,
    after: item.after,
    result: ok ? 'applied' : 'failed',
    error_message: ok ? null : (error ?? null),
  })
}

// ── MCP agent path (catalog-management epic, Sprint 3 · Story 3.3) ──────────
// The agent has no Clerk JWT — calls go through the shared-secret
// `/internal/seller-products/bulk-stage`/`bulk-apply` routes instead, keyed
// by shop slug (mirrors `lib/seller-products.ts`'s `patchSellerProductViaInternal`
// for the single-item MCP tools). Batches land in the SAME
// `catalog_bulk_batches` table as the web path — `seller_id` is the shop's
// `clerk_user_id` either way, so ownership/history is unified regardless of
// which actor staged the batch.

/** Action types that need FRONTEND-only orchestration the internal-secret
 * layer has no access to (Supabase mirror, ML cascade, checkout-viability
 * gate) — rejected for the agent path with a clear message rather than
 * silently skipping those side effects. Story 3.3 scope. */
function isAgentUnsupportedAction(action: BulkActionPayload): string | null {
  if (action.type === 'pause_activate') return 'Pausar/activar en bloque aún no está disponible por el agente — usa la app web.'
  if (action.type === 'delete') return 'Eliminar en bloque aún no está disponible por el agente — usa la app web.'
  if (action.type === 'publish_channel' && action.channel === 'ml') {
    return 'Publicar/ocultar en Mercado Libre en bloque aún no está disponible por el agente — usa la app web.'
  }
  // catalog-management S4 · Story 4.2 — no agent tool can compute a suggested
  // price (that math + the live ML fee-estimate lookup live in the web UI's
  // BulkActionBar, calling lib/profit.ts's solveForPrice — an MCP call has
  // no access to either). Deferred to a future sprint, not a scope cut of
  // the web flow.
  if (action.type === 'apply_suggested_price') {
    return 'El precio sugerido en bloque aún no está disponible por el agente — usa la app web.'
  }
  return null
}

export async function stageBulkActionAsAgent(
  shop: { id: string; clerk_user_id: string; slug: string | null },
  target: { filter?: BulkFilterParams; ids?: string[] },
  action: BulkActionPayload,
): Promise<StageResult> {
  if (!shop.slug) return { ok: false, status: 422, error: 'Tu tienda no tiene un identificador (slug) configurado.' }
  const unsupported = isAgentUnsupportedAction(action)
  if (unsupported) return { ok: false, status: 422, error: unsupported }

  const res = await internalFetch('/internal/seller-products/bulk-stage', {
    seller_slug: shop.slug,
    filter: target.filter ?? null,
    ids: target.ids ?? null,
    action,
  })

  if (res.status === 423) return { ok: false, status: 423, error: 'Esta función aún no está disponible.' }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    return { ok: false, status: res.status, error: body.message ?? 'Error al preparar el lote.' }
  }

  const data = await res.json() as { total: number; valid_count: number; invalid_count: number; items: BulkDiffItem[] }

  const { data: batch, error: batchError } = await db
    .from('catalog_bulk_batches')
    .insert({
      seller_id: shop.clerk_user_id,
      actor_type: 'agent',
      actor_id: shop.id,
      action,
      status: 'ready',
      total_count: data.total,
      valid_count: data.valid_count,
      failed_count: 0,
      applied_count: 0,
    })
    .select('id')
    .single()

  if (batchError || !batch) return { ok: false, status: 500, error: 'Error al guardar el lote.' }

  if (data.items.length > 0) {
    const { error: itemsError } = await db.from('catalog_bulk_batch_items').insert(
      data.items.map((item) => ({
        batch_id: batch.id,
        product_id: item.id,
        title: item.title,
        before: item.before,
        after: item.after,
        patch: item.patch,
        valid: item.valid,
        error_message: item.error,
        status: 'pending',
        // Only include the key when THIS action type actually set it
        // (apply_suggested_price) — the other 7 types never populate
        // delta_cents, so their insert payload stays byte-identical to
        // before this column existed. This is deliberate: a Supabase INSERT
        // referencing an unknown column errors regardless of the value, so
        // if the delta_cents migration hasn't landed yet on a given
        // environment, every OTHER bulk action (including the already-live
        // catalog.bulk_enabled feature) must keep working unaffected by
        // this column's rollout — deploy order between the frontend and the
        // migration must not matter for them (cross-agent review catch).
        ...(item.delta_cents !== undefined ? { delta_cents: item.delta_cents } : {}),
      })),
    )
    if (itemsError) return { ok: false, status: 500, error: 'Error al guardar los productos del lote.' }
  }

  return { ok: true, batch_id: batch.id, total: data.total, valid_count: data.valid_count, invalid_count: data.invalid_count }
}

/**
 * Apply a batch staged by (or for) this shop, as the agent actor. Same
 * idempotent-skip semantics as `applyBulkBatch()`. Only reachable for action
 * types `stageBulkActionAsAgent` would have staged (never `pause_activate`/
 * `delete`/`publish_channel(ml)`), so no special per-action branching is
 * needed here — every batch this function is ever asked to apply is already
 * a plain field-patch action, routed through the internal bulk-apply route.
 */
export async function applyBulkBatchAsAgent(
  batchId: string,
  shop: { id: string; clerk_user_id: string; slug: string | null },
): Promise<ApplyResult> {
  if (!(await isEnabled('catalog.bulk_enabled'))) {
    return { ok: false, status: 423, error: 'Esta función aún no está disponible.' }
  }
  if (!shop.slug) return { ok: false, status: 422, error: 'Tu tienda no tiene un identificador (slug) configurado.' }

  const found = await getBulkBatch(batchId, shop.clerk_user_id)
  if (!found) return { ok: false, status: 404, error: 'Lote no encontrado.' }
  const { batch, items } = found

  const unsupported = isAgentUnsupportedAction(batch.action)
  if (unsupported) return { ok: false, status: 422, error: unsupported }

  const alreadySettled = items.filter((i) => i.status === 'applied' || i.status === 'failed').length
  const claimed = await claimPendingItems(batchId)

  if (claimed.length === 0) {
    return { ok: true, applied: 0, failed: 0, skipped: alreadySettled }
  }

  await db.from('catalog_bulk_batches').update({ status: 'applying', updated_at: new Date().toISOString() }).eq('id', batchId)

  let applied = 0
  let failed = 0
  // A free Evento keeps its $0 price: refuse just those rows (reported as failed with the reason).
  const { allowed: pending, refused } = await splitFreeEventPriceRefusals(claimed)
  for (const r of refused) {
    await recordItemResult(batchId, r.item, false, shop.id, 'agent', batch.action.type, r.error)
    failed++
  }

  let results: Array<{ id: string; ok: boolean; error?: string }> = []
  if (pending.length > 0) {
    const res = await internalFetch('/internal/seller-products/bulk-apply', {
      seller_slug: shop.slug,
      items: pending.map((i) => ({ id: i.product_id, patch: i.patch })),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      await db.from('catalog_bulk_batches').update({ status: 'partially_failed', updated_at: new Date().toISOString() }).eq('id', batchId)
      return { ok: false, status: res.status, error: body.message ?? 'Error al aplicar el lote.' }
    }
    results = ((await res.json()) as { results: typeof results }).results
  }
  const byId = new Map(results.map((r) => [r.id, r]))
  for (const item of pending) {
    const r = byId.get(item.product_id)
    const ok = r?.ok ?? false
    await recordItemResult(batchId, item, ok, shop.id, 'agent', batch.action.type, ok ? undefined : (r?.error ?? 'Error desconocido.'))
    if (ok) applied++
    else failed++
  }

  await db
    .from('catalog_bulk_batches')
    .update({
      status: failed > 0 ? 'partially_failed' : 'applied',
      applied_count: applied,
      failed_count: failed,
      updated_at: new Date().toISOString(),
    })
    .eq('id', batchId)

  return { ok: true, applied, failed, skipped: alreadySettled }
}
