/**
 * Promoter Funnel v2 · Sprint 4 (US-4.1/US-4.2) — net-remittance transfers
 * (Supabase side). Mirrors lib/promoter-applications.ts's shape: pure transition
 * rules live in lib/promoter-transfer.ts (singular — the seam), the CRUD +
 * atomic claim-then-transition primitives live here.
 *
 * Table (supabase/migrations/20260703140000_promoter_transfers.sql):
 *   marketplace_promoter_transfers
 *
 * Every function tolerates the table not existing yet (returns a safe default),
 * so the close workspace degrades gracefully until the migration is applied.
 * The whole path is additionally gated by the platform flag
 * `promoter.transfer_enabled` (lib/flags.ts, default off).
 */

import { isPackageSku } from '@/lib/promoter-packages'
import { db } from '@/lib/supabase'
import { computeOwedCents, isTransferMethod, hasRequiredTransferDetail, type TransferSku, type TransferMethod, type TransferStatus } from '@/lib/promoter-transfer'
import { computeCommissionCents } from '@/lib/promoter-commission'
import {
  resolvePromoterDiscount,
  promoterRefusalMessage,
  getPromoterSettings,
  getPromoterSkuPrices,
  getCommissionRates,
  type Promoter,
  type PromoterSku,
  type PromoterTransferDetails,
} from '@/lib/promoter'

export interface PromoterTransfer {
  id: string
  promoter_id: string
  seller_id: string
  sku: TransferSku
  method: TransferMethod
  gross_amount_cents: number
  commission_cents: number
  owed_cents: number
  transfer_details: PromoterTransferDetails
  status: TransferStatus
  reported_at: string | null
  approved_at: string | null
  approved_by: string | null
  rejected_at: string | null
  rejected_reason: string | null
  created_at?: string
  updated_at?: string
}

const TRANSFER_COLUMNS =
  'id, promoter_id, seller_id, sku, method, gross_amount_cents, commission_cents, owed_cents, transfer_details, status, reported_at, approved_at, approved_by, rejected_at, rejected_reason, created_at, updated_at'

// ── Creation (US-4.1 — the close route) ───────────────────────────────────────

export type CreateTransferResult =
  | { ok: true; transfer: PromoterTransfer }
  | { ok: false; reason: 'already_active' | 'error' }

/**
 * Insert a new `pending` transfer request, freezing the owed amount + the
 * transfer-details snapshot at creation time (a later admin edit never
 * retroactively changes what a promoter was already shown). Refuses when an
 * active (pending/reported) transfer already exists for this shop+SKU — checked
 * here for a friendly error, backstopped by the DB's own partial unique index
 * for the race (23505 ⇒ `already_active`).
 */
export async function createPromoterTransfer(input: {
  promoterId: string
  sellerId: string
  sku: TransferSku
  method: TransferMethod
  grossAmountCents: number
  commissionCents: number
  owedCents: number
  transferDetails: PromoterTransferDetails
}): Promise<CreateTransferResult> {
  const { data, error } = await db
    .from('marketplace_promoter_transfers')
    .insert({
      promoter_id: input.promoterId,
      seller_id: input.sellerId,
      sku: input.sku,
      method: input.method,
      gross_amount_cents: input.grossAmountCents,
      commission_cents: input.commissionCents,
      owed_cents: input.owedCents,
      transfer_details: input.transferDetails,
      status: 'pending',
    })
    .select(TRANSFER_COLUMNS)
    .maybeSingle()
  if (error) {
    if (error.code === '23505') return { ok: false, reason: 'already_active' }
    if (!/does not exist|relation/i.test(error.message ?? '')) {
      console.error('[promoter-transfers] create failed:', error.message)
    }
    return { ok: false, reason: 'error' }
  }
  if (!data) return { ok: false, reason: 'error' }
  return { ok: true, transfer: data as PromoterTransfer }
}

export type StartTransferCloseResult =
  | { ok: true; transfer: PromoterTransfer }
  | { ok: false; status: number; error: string }

/**
 * The shared "start a transfer close" logic every `/api/promoter/close/<sku>`
 * route's transfer branch calls — one place so the owed math + guards can never
 * drift between domain/subdomain/ml_sync. Computes `grossCents` via the EXACT
 * same `resolvePromoterDiscount` call each route's existing Stripe branch already
 * makes (same deriver as Sprint 3 — "advertised = charged = owed"), then
 * `owedCents` via `computeOwedCents`. Refuses (409) if an active transfer already
 * exists for this shop+SKU.
 */
export async function startPromoterTransferClose(input: {
  promoter: Promoter
  sku: PromoterSku & TransferSku
  basePriceCents: number
  sellerId: string
  transferMethod: unknown
  /** A rate the caller already READ for this SKU (packages: never the 0% fallback). Omitted → the rates table. */
  ratePct?: number
}): Promise<StartTransferCloseResult> {
  const { promoter, sku, basePriceCents, sellerId, transferMethod } = input
  if (!isTransferMethod(transferMethod)) {
    return { ok: false, status: 400, error: 'Selecciona un método de transferencia válido (SPEI, DiMo o CoDi).' }
  }

  const existingActive = await getActivePromoterTransfer(sellerId, sku)
  if (existingActive) {
    return { ok: false, status: 409, error: 'Ya hay una transferencia activa para esta tienda.' }
  }

  const [settings, skuPrices, rates] = await Promise.all([
    getPromoterSettings(),
    getPromoterSkuPrices(),
    getCommissionRates(),
  ])

  // Cross-agent review (PR 167) — refuse BEFORE creating a transfer request when
  // the admin hasn't configured the destination the chosen method needs (e.g.
  // no CLABE on file for SPEI). Without this, a promoter could be shown
  // "Transferir a Miyagi" with nothing to actually transfer to.
  if (!hasRequiredTransferDetail(settings.transfer_details ?? {}, transferMethod)) {
    return { ok: false, status: 422, error: 'Aún no hay datos de transferencia configurados para este método. Contacta al administrador.' }
  }

  // A package has its OWN list price and no promoter discount (plans-gratis-negocio D12): the promoter charges the
  // list price and keeps their rate of it, so the gross is exactly `basePriceCents`. Every other SKU keeps the
  // existing discount deriver.
  let grossAmountCents: number
  if (isPackageSku(sku)) {
    grossAmountCents = basePriceCents
  } else {
    const resolved = resolvePromoterDiscount({ promoter, settings, itemsCents: basePriceCents, sku, skuPrices })
    if (!resolved.ok) {
      return { ok: false, status: 422, error: promoterRefusalMessage(resolved.reason) }
    }
    grossAmountCents = Math.max(0, basePriceCents - resolved.discount_cents)
  }
  const ratePct = input.ratePct ?? rates[sku] ?? 0
  const commissionCents = computeCommissionCents(ratePct, grossAmountCents)
  const owedCents = computeOwedCents(grossAmountCents, ratePct)

  const created = await createPromoterTransfer({
    promoterId: promoter.id,
    sellerId,
    sku,
    method: transferMethod,
    grossAmountCents,
    commissionCents,
    owedCents,
    transferDetails: settings.transfer_details ?? {},
  })
  if (!created.ok) {
    return {
      ok: false,
      status: created.reason === 'already_active' ? 409 : 502,
      error: created.reason === 'already_active' ? 'Ya hay una transferencia activa para esta tienda.' : 'No se pudo iniciar la transferencia.',
    }
  }
  return { ok: true, transfer: created.transfer }
}

/** The shop+SKU's currently active (pending/reported) transfer, if any. */
export async function getActivePromoterTransfer(sellerId: string, sku: TransferSku): Promise<PromoterTransfer | null> {
  if (!sellerId) return null
  const { data, error } = await db
    .from('marketplace_promoter_transfers')
    .select(TRANSFER_COLUMNS)
    .eq('seller_id', sellerId)
    .eq('sku', sku)
    .in('status', ['pending', 'reported'])
    .maybeSingle()
  if (error || !data) return null
  return data as PromoterTransfer
}

/** Look up a single transfer by id. Null if not found / table missing. */
export async function getPromoterTransferById(id: string): Promise<PromoterTransfer | null> {
  if (!id) return null
  const { data, error } = await db
    .from('marketplace_promoter_transfers')
    .select(TRANSFER_COLUMNS)
    .eq('id', id)
    .maybeSingle()
  if (error || !data) return null
  return data as PromoterTransfer
}

// ── "Ya transferí" (US-4.1) ───────────────────────────────────────────────────

export type ReportTransferResult =
  | { ok: true; transfer: PromoterTransfer }
  | { ok: false; reason: 'not_found' | 'invalid_transition' }

/**
 * Flip `pending → reported` ("Ya transferí"). Atomic conditional update — only a
 * row still in `pending` can be claimed, so a double-tap is a harmless no-op on
 * the second call (idempotent: re-fetches and returns the already-reported row
 * rather than erroring). Never activates anything — no grant write here.
 */
export async function reportPromoterTransfer(id: string): Promise<ReportTransferResult> {
  const existing = await getPromoterTransferById(id)
  if (!existing) return { ok: false, reason: 'not_found' }
  if (existing.status === 'reported') return { ok: true, transfer: existing } // idempotent re-tap
  if (existing.status !== 'pending') return { ok: false, reason: 'invalid_transition' }

  const { data, error } = await db
    .from('marketplace_promoter_transfers')
    .update({ status: 'reported', reported_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .select(TRANSFER_COLUMNS)
    .maybeSingle()
  if (error || !data) {
    if (error && !/does not exist|relation/i.test(error.message ?? '')) {
      console.error('[promoter-transfers] report failed:', error.message)
    }
    return { ok: false, reason: 'invalid_transition' }
  }
  return { ok: true, transfer: data as PromoterTransfer }
}

// ── Admin review (US-4.2) ─────────────────────────────────────────────────────

/** All `reported` transfers, oldest first — so the age-since-reported UI (the
 *  "nothing rots silently" requirement) surfaces the longest-waiting ones first. */
export async function listReportedPromoterTransfers(): Promise<PromoterTransfer[]> {
  const { data, error } = await db
    .from('marketplace_promoter_transfers')
    .select(TRANSFER_COLUMNS)
    .eq('status', 'reported')
    .order('reported_at', { ascending: true })
  if (error || !data) return []
  return data as PromoterTransfer[]
}

export type ClaimTransferResult =
  | { ok: true; transfer: PromoterTransfer }
  | { ok: false; reason: 'not_found' | 'invalid_transition' }

/**
 * Claim a `reported` transfer for approval (atomic `reported → approved`),
 * BEFORE any activation side effect — mirrors `approvePromoterApplication`'s
 * claim-then-activate order, so two concurrent approve clicks can't both pass
 * and both write a grant. The caller (`POST .../approve`) activates the SKU
 * only after this claim wins; on activation failure it calls
 * `releasePromoterTransferClaim` to roll back to `reported` (retryable, not a
 * permanent dead end).
 */
export async function claimPromoterTransferForApproval(id: string, adminUserId: string | null): Promise<ClaimTransferResult> {
  const existing = await getPromoterTransferById(id)
  if (!existing) return { ok: false, reason: 'not_found' }
  if (existing.status !== 'reported') return { ok: false, reason: 'invalid_transition' }

  const { data, error } = await db
    .from('marketplace_promoter_transfers')
    .update({
      status: 'approved',
      approved_at: new Date().toISOString(),
      approved_by: adminUserId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'reported')
    .select(TRANSFER_COLUMNS)
    .maybeSingle()
  if (error || !data) {
    if (error && !/does not exist|relation/i.test(error.message ?? '')) {
      console.error('[promoter-transfers] approve claim failed:', error.message)
    }
    return { ok: false, reason: 'invalid_transition' }
  }
  return { ok: true, transfer: data as PromoterTransfer }
}

/**
 * Roll a claimed transfer back `approved → reported` — used only when the
 * activation side effect (the grant write / attribution) fails after the claim
 * won, so a transient failure never leaves a transfer silently "approved" with
 * nothing actually active. Best-effort; logs but doesn't throw.
 */
export async function releasePromoterTransferClaim(id: string): Promise<void> {
  const { error } = await db
    .from('marketplace_promoter_transfers')
    .update({ status: 'reported', approved_at: null, approved_by: null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'approved')
  if (error) console.error('[promoter-transfers] release claim failed:', error.message)
}

/**
 * Reject a `reported` transfer (atomic `reported → rejected`) with an es-MX
 * reason. No grant write. The unique index only blocks concurrent
 * pending/reported rows for the same shop+SKU, so a fresh transfer request can
 * follow without any manual cleanup.
 */
export async function rejectPromoterTransfer(id: string, reason: string): Promise<ClaimTransferResult> {
  const existing = await getPromoterTransferById(id)
  if (!existing) return { ok: false, reason: 'not_found' }
  if (existing.status !== 'reported') return { ok: false, reason: 'invalid_transition' }

  const { data, error } = await db
    .from('marketplace_promoter_transfers')
    .update({
      status: 'rejected',
      rejected_at: new Date().toISOString(),
      rejected_reason: reason || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'reported')
    .select(TRANSFER_COLUMNS)
    .maybeSingle()
  if (error || !data) {
    if (error && !/does not exist|relation/i.test(error.message ?? '')) {
      console.error('[promoter-transfers] reject failed:', error.message)
    }
    return { ok: false, reason: 'invalid_transition' }
  }
  return { ok: true, transfer: data as PromoterTransfer }
}
