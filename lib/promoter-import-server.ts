/**
 * lib/promoter-import-server.ts — the promoter's request preamble shared by the import routes (promoter-panel D2/D3):
 * the flags, the session, the bound promoter, the per-promoter rate limit, the shop, and the ownership guard (D1).
 * One preamble, so no import route can skip a step.
 */
import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { isEnabled } from '@/lib/flags'
import { checkRateLimit } from '@/lib/ratelimit'
import { getPromoterByClerkId } from '@/lib/promoter'
import { resolveTargetShop, type TargetShop } from '@/lib/promoter-server'
import { promoterShopEditAccess } from '@/lib/promoter-shop-access'
import { shopEditRefusal } from '@/lib/promoter-close'
import { db } from '@/lib/supabase'
import { guardFor } from '@/lib/plan'
import { IMPORT_LOCK_KEY, importLockState } from '@/lib/promoter-panel'

export type PromoterImportContext = {
  userId: string
  promoter: { id: string; code: string }
  shop: TargetShop
  body: Record<string, unknown>
}

/**
 * Read a JSON body without ever holding more than `maxBytes` (Codex security, #480: `req.json()` buffered and parsed a
 * body of any size before the route could check it). A declared size over the cap is refused before reading; the
 * stream is counted as it arrives. `null` = too big or not JSON.
 */
export async function readJsonCapped(req: NextRequest, maxBytes: number): Promise<{ ok: true; value: unknown } | { ok: false; tooBig: boolean }> {
  const declared = Number(req.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, tooBig: true }
  const reader = req.body?.getReader()
  if (!reader) return { ok: false, tooBig: false }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) { await reader.cancel().catch(() => undefined); return { ok: false, tooBig: true } }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength }
  try { return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) } } catch { return { ok: false, tooBig: false } }
}

/** The largest import request: a catalog file of a few MB, as JSON text. */
export const MAX_IMPORT_BODY_BYTES = 4 * 1024 * 1024

export async function promoterImportPreamble(
  req: NextRequest,
  opts: { needsConnector: boolean },
): Promise<{ ok: true; ctx: PromoterImportContext } | { ok: false; response: NextResponse }> {
  const fail = (status: number, error: string) => ({ ok: false as const, response: NextResponse.json({ ok: false, error }, { status }) })
  if (!(await isEnabled('promoter.enabled'))) return fail(404, 'No disponible.')
  if (opts.needsConnector && !(await isEnabled('migrations.connector_enabled'))) return fail(404, 'No disponible.')

  const user = await currentUser().catch(() => null)
  if (!user) return fail(401, 'No autorizado')
  const promoter = await getPromoterByClerkId(user.id)
  if (!promoter) return fail(403, 'Pon tu código de promotor primero.')

  const rl = await checkRateLimit('supply_import', `promoter:${promoter.id}`)
  if (!rl.allowed) return fail(429, 'Vas muy rápido. Espera un momento.')

  let body: Record<string, unknown> = {}
  const read = await readJsonCapped(req, MAX_IMPORT_BODY_BYTES)
  if (!read.ok && read.tooBig) return fail(413, 'Ese archivo es demasiado grande. Pídele una lista más corta o la Migración con consultor.')
  if (read.ok && read.value && typeof read.value === 'object' && !Array.isArray(read.value)) body = read.value as Record<string, unknown>

  const shopId = typeof body.shopId === 'string' ? body.shopId : undefined
  const slug = typeof body.slug === 'string' ? body.slug : undefined
  if (!shopId && !slug) return fail(400, 'Falta la tienda.')
  const shop = await resolveTargetShop({ shopId, slug })
  if (!shop) return fail(404, 'Tienda no encontrada.')

  const refusal = shopEditRefusal(await promoterShopEditAccess({ promoter, shop }))
  if (refusal) return fail(refusal.status, refusal.error)

  return { ok: true, ctx: { userId: user.id, promoter, shop, body } }
}

export type ImportLock = { at: string; by: string }

/**
 * Claim the shop's import lock (one import at a time per shop — Codex security, #480). The write is guarded on exactly
 * what was read (absent, JSON null, or the stale lock it replaces), so of two simultaneous requests only one lands.
 * `busy` = another import is running; `unavailable` = the write could not be made (the caller answers 503).
 */
export async function claimShopImportLock(shop: TargetShop, promoterId: string): Promise<{ ok: true; lock: ImportLock } | { ok: false; reason: 'busy' | 'unavailable' }> {
  if (importLockState(shop.metadata) === 'busy') return { ok: false, reason: 'busy' }
  const guard = guardFor(shop.metadata, IMPORT_LOCK_KEY)
  const lock: ImportLock = { at: new Date().toISOString(), by: promoterId }
  const { data, error } = await db.rpc('merge_shop_metadata', {
    p_shop_id: shop.id,
    p_patch: { [IMPORT_LOCK_KEY]: lock },
    p_guard_key: IMPORT_LOCK_KEY,
    p_guard_mode: guard.mode,
    p_expected: guard.mode === 'equals' ? guard.expected : null,
  })
  if (error) return { ok: false, reason: 'unavailable' }
  // Zero rows: the guard fired — another request claimed it between our read and our write.
  return Array.isArray(data) && data.length > 0 ? { ok: true, lock } : { ok: false, reason: 'busy' }
}

/** Release our own lock (guarded on its exact value, so a takeover after a stale lock is never undone). Best-effort:
 *  an unreleased lock expires after `IMPORT_LOCK_TTL_MS`. */
export async function releaseShopImportLock(shopId: string, lock: ImportLock): Promise<void> {
  await db.rpc('merge_shop_metadata', {
    p_shop_id: shopId,
    p_patch: { [IMPORT_LOCK_KEY]: null },
    p_guard_key: IMPORT_LOCK_KEY,
    p_guard_mode: 'equals',
    p_expected: lock,
  }).then(() => undefined, () => undefined)
}

/** How many products the shop already has (the 150 cap counts them). `null` = could not read: fail closed. */
export async function countShopListings(shopId: string): Promise<number | null> {
  const { count, error } = await db
    .from('marketplace_listings')
    .select('id', { count: 'exact', head: true })
    .eq('shop_id', shopId)
    .neq('status', 'deleted')
  return error || typeof count !== 'number' ? null : count
}

/** Which of these titles the shop already has (lower-cased). `null` = could not read: fail closed, never "none". */
export async function existingShopTitles(shopId: string, titles: string[]): Promise<Set<string> | null> {
  const have = new Set<string>()
  const unique = [...new Set(titles.map((t) => t.trim()).filter(Boolean))]
  for (let i = 0; i < unique.length; i += 100) {
    const { data, error } = await db
      .from('marketplace_listings')
      .select('title')
      .eq('shop_id', shopId)
      .neq('status', 'deleted')
      .in('title', unique.slice(i, i + 100))
    if (error) return null
    for (const row of (data ?? []) as Array<{ title: string | null }>) have.add((row.title ?? '').trim().toLowerCase())
  }
  return have
}

export const IMPORT_BUSY = 'Ya se están agregando productos a esta tienda. Espera a que termine.'
export const IMPORT_UNAVAILABLE = 'No pudimos revisar la tienda ahora. Intenta de nuevo en un momento.'
