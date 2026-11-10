/**
 * Promoter Program — shared server helpers (Supabase side).
 *
 * A commission-paid, in-person seller-acquisition force. A promoter has a stable
 * code (PRM-XXXXXX); applying it at a paid-SKU checkout previews a seller discount
 * (Sprint 1) and records an attribution row so Sprint 3 can compute commission.
 *
 * Mirrors the referral spine (lib/referrals.ts) in a DISTINCT promoter namespace —
 * the `PRM-` prefix + a separate table — so promoter codes never collide with the
 * bare buyer referral codes. Promoter attribution is a concept Medusa has no notion
 * of → Supabase (AGENTS rule #2). The money path (real charge + cadence) is Sprint 2.
 *
 * Pure + next-free (no `next/cache`, no `server-only`) so the code-gen and discount
 * rules are directly unit-testable (e2e/promoter-program.spec.ts); the Supabase
 * calls live here too, exactly like lib/referrals.ts.
 *
 * Tables (supabase/migrations/20260629120000_promoter.sql):
 *   marketplace_promoters · marketplace_promoter_attributions · marketplace_promoter_settings
 *
 * Every function tolerates the tables not existing yet (returns a safe default),
 * so the UI degrades gracefully until the migration is applied. The whole feature
 * is gated by the platform flag `promoter.enabled` (lib/flags.ts, default off).
 */

import { db } from '@/lib/supabase'
import { DEFAULT_COMMISSION_RATES, accrualOutcomeOf, decideAccrual, type AccrualOutcome } from '@/lib/promoter-commission'
import { PROMOTER_SKUS, isPromoterSku, type PromoterSku } from '@/lib/promoter-skus'
import { resolveSkuPromoterPriceCents, type PromoterSkuPrices } from '@/lib/promoter-pricing'

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no ambiguous chars (shared with referrals)
const CODE_LEN = 6

/** Distinct prefix so a promoter code is never mistaken for a buyer referral code. */
export const PROMOTER_CODE_PREFIX = 'PRM-'

/** Shape of a well-formed promoter code: PRM- + 4–12 unambiguous chars. */
export const PROMOTER_CODE_RE = /^PRM-[A-Z0-9]{4,12}$/

export interface Promoter {
  id: string
  code: string
  name: string | null
  /** The Clerk identity bound to this promoter (epic 08 · S4) — null until the
   *  promoter logs into the workspace and binds their code. Powers the
   *  self-referral guard and "who am I" in the authed close workspace. */
  clerk_user_id?: string | null
  program_track?: 'promoter' | 'founding_operator'
  created_at?: string
}

function randomCode(len = CODE_LEN): string {
  let out = ''
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  return out
}

/** A fresh, prefixed promoter code (PRM-XXXXXX). */
export function generatePromoterCode(): string {
  return PROMOTER_CODE_PREFIX + randomCode()
}

/** Normalize user-entered codes: trim, upper-case. Does not validate shape. */
export function normalizePromoterCode(raw: string | null | undefined): string {
  return (raw ?? '').trim().toUpperCase()
}

/** Is this a well-formed promoter code (after normalization)? */
export function isPromoterCodeShape(raw: string | null | undefined): boolean {
  return PROMOTER_CODE_RE.test(normalizePromoterCode(raw))
}

// ── Promoter provisioning (admin) ─────────────────────────────────────────────

/**
 * Create a promoter with a stable, unique code. Retries on the (rare) unique
 * collision. Returns the new promoter, or null if the tables aren't available.
 */
export async function createPromoter(name: string | null): Promise<Promoter | null> {
  const cleanName = (name ?? '').trim() || null
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generatePromoterCode()
    const { data, error } = await db
      .from('marketplace_promoters')
      .insert({ code, name: cleanName, program_track: 'promoter' })
      .select('id, code, name, program_track, created_at')
      .maybeSingle()
    if (!error && data) return data as Promoter
    if (error?.code === '23505') continue // code collided — try another
    if (error && !/does not exist|relation/i.test(error.message ?? '')) {
      console.error('[promoter] create failed:', error.message)
    }
    return null
  }
  return null
}

/** Look up a promoter by code. Null if not found / tables missing. */
export async function getPromoterByCode(code: string): Promise<Promoter | null> {
  const normalized = normalizePromoterCode(code)
  if (!normalized) return null
  const { data, error } = await db
    .from('marketplace_promoters')
    .select('id, code, name, clerk_user_id, program_track, created_at')
    .eq('code', normalized)
    .eq('program_track', 'promoter')
    .maybeSingle()
  if (error || !data) return null
  return data as Promoter
}

/** Resolve either partner track by row id for grant-aware partner contexts. */
export async function getPartnerIdentityById(id: string): Promise<Promoter | null> {
  if (!id) return null
  const { data, error } = await db
    .from('marketplace_promoters')
    .select('id, code, name, clerk_user_id, program_track, created_at')
    .eq('id', id)
    .maybeSingle()
  if (error || !data) return null
  return data as Promoter
}

/** Look up a Promotor by id for transfer/email/economic paths. */
export async function getPromoterById(id: string): Promise<Promoter | null> {
  if (!id) return null
  const { data, error } = await db
    .from('marketplace_promoters')
    .select('id, code, name, clerk_user_id, program_track, created_at')
    .eq('id', id)
    .eq('program_track', 'promoter')
    .maybeSingle()
  if (error || !data) return null
  return data as Promoter
}

/**
 * Resolve either partner track by Clerk identity. This track-agnostic seam is
 * deliberately named differently so only grant-aware `/partner` contexts use
 * it; Promotor acquisition/economic surfaces must use getPromoterByClerkId.
 *
 * A failed read is NOT absence. This lookup participates in track-specific
 * rollback authorization, so collapsing unavailable storage into `null` would
 * let an already-bound founding operator look unbound and retain steward-scoped
 * access. The injected query keeps that three-state decision directly testable.
 */
export type PartnerIdentityQuery = (clerkUserId: string) => Promise<{
  data: Promoter | null
  error: { message?: string } | null
}>

export async function getPartnerIdentityByClerkId(
  clerkUserId: string,
  query: PartnerIdentityQuery = async (identity) => {
    const result = await db
      .from('marketplace_promoters')
      .select('id, code, name, clerk_user_id, program_track, created_at')
      .eq('clerk_user_id', identity)
      .maybeSingle()
    return { data: result.data as Promoter | null, error: result.error }
  },
): Promise<Promoter | null> {
  if (!clerkUserId) return null
  const { data, error } = await query(clerkUserId)
  if (error) {
    console.error('[partner-identity] lookup unavailable:', error.message ?? 'unknown_error')
    throw new Error('partner_identity_unavailable')
  }
  return data
}

/**
 * Look up only the Promotor-track identity bound to a Clerk user. Null when the
 * user has no PRM identity (including when they are a founding operator), so a
 * neutral partner identity can never enter a Promotor-only capability.
 */
export async function getPromoterByClerkId(clerkUserId: string): Promise<Promoter | null> {
  if (!clerkUserId) return null
  const { data, error } = await db
    .from('marketplace_promoters')
    .select('id, code, name, clerk_user_id, program_track, created_at')
    .eq('clerk_user_id', clerkUserId)
    .eq('program_track', 'promoter')
    .maybeSingle()
  if (error || !data) return null
  return data as Promoter
}

export type BindPromoterResult =
  | { ok: true; promoter: Promoter; alreadyBound: boolean }
  | { ok: false; reason: 'not_found' | 'code_taken' | 'user_taken' | 'error' }

/**
 * Bind a Clerk identity to a promoter code (epic 08 · S4). One-time + idempotent:
 *   - unknown code → not_found
 *   - code already bound to THIS user → ok (alreadyBound)
 *   - code already bound to ANOTHER user → code_taken
 *   - this user already binds a DIFFERENT code → user_taken (one code per identity)
 * Otherwise stamp `clerk_user_id` via an atomic conditional update (`.is(null)`)
 * so two concurrent binds can't both win. Promoters are admin-provisioned rows;
 * this lets a real person operate their own code in the authed workspace.
 */
export async function bindPromoterClerkId(code: string, clerkUserId: string): Promise<BindPromoterResult> {
  if (!clerkUserId) return { ok: false, reason: 'error' }
  const promoter = await getPromoterByCode(code)
  if (!promoter) return { ok: false, reason: 'not_found' }
  if (promoter.clerk_user_id === clerkUserId) return { ok: true, promoter, alreadyBound: true }
  if (promoter.clerk_user_id) return { ok: false, reason: 'code_taken' }

  // A Clerk user may bind exactly one partner identity across both tracks.
  const existing = await getPartnerIdentityByClerkId(clerkUserId)
  if (existing && existing.id !== promoter.id) return { ok: false, reason: 'user_taken' }

  const { data, error } = await db.rpc('miyagi_bind_partner_identity', {
    p_promoter_id: promoter.id,
    p_clerk_user_id: clerkUserId,
  })
  if (error || !data) {
    if (error && !/does not exist|relation/i.test(error.message ?? '')) {
      console.error('[promoter] clerk bind failed:', error.message)
    }
    if (/clerk_user_already_bound/.test(error?.message ?? '')) return { ok: false, reason: 'user_taken' }
    if (/identity_already_bound/.test(error?.message ?? '')) return { ok: false, reason: 'code_taken' }
    return { ok: false, reason: 'error' }
  }
  const bound = (Array.isArray(data) ? data[0] : data) as Promoter
  return { ok: true, promoter: bound, alreadyBound: false }
}

/** All promoters, newest first (admin console). Empty on missing tables/error. */
export async function listPromoters(): Promise<Promoter[]> {
  const { data, error } = await db
    .from('marketplace_promoters')
    .select('id, code, name, program_track, created_at')
    .eq('program_track', 'promoter')
    .order('created_at', { ascending: false })
  if (error || !data) return []
  return data as Promoter[]
}

// ── Discount settings (admin-editable, no deploy) ─────────────────────────────

export interface PromoterSettings {
  /** Admin toggle for the seller discount (distinct from the `promoter.enabled` flag). */
  enabled: boolean
  discount_type: 'fixed' | 'percentage'
  /** Pesos×100 when `fixed`; the raw percent when `percentage` (same column). */
  discount_amount_cents: number
  /** Sprint 3 (US-3.1) — which SKUs the bundle price covers. Empty = no bundle configured. */
  bundle_skus: PromoterSku[]
  /** Sprint 3 (US-3.1) — admin-set total price (whole MXN) for the bundled SKUs together. `null` = not configured. */
  bundle_price_mxn: number | null
  /** Sprint 4 (US-4.1) — admin-entered transfer instructions (CLABE/bank name/DiMo
   *  phone/CoDi reference) shown to the promoter at close. Never hardcoded.
   *  Optional (unlike `bundle_skus`/`bundle_price_mxn`) so the many existing
   *  `PromoterSettings` test fixtures across e2e/*.spec.ts don't all need updating —
   *  every real read defaults it with `?? {}`. */
  transfer_details?: PromoterTransferDetails
}

/** Admin-config transfer instructions — every field optional (shown only when set). */
export interface PromoterTransferDetails {
  clabe?: string
  bank_name?: string
  account_holder?: string
  dimo_phone?: string
  codi_reference?: string
}

const DEFAULT_SETTINGS: PromoterSettings = {
  enabled: true,
  discount_type: 'fixed',
  discount_amount_cents: 10000, // $100 MXN off the SKU
  bundle_skus: [],
  bundle_price_mxn: null,
  transfer_details: {},
}

export async function getPromoterSettings(): Promise<PromoterSettings> {
  const { data, error } = await db
    .from('marketplace_promoter_settings')
    .select('enabled, discount_type, discount_amount_cents, bundle_skus, bundle_price_mxn, transfer_details')
    .eq('id', 1)
    .maybeSingle()
  if (error || !data) return DEFAULT_SETTINGS
  return {
    enabled: data.enabled ?? true,
    discount_type: (data.discount_type as 'fixed' | 'percentage') ?? 'fixed',
    discount_amount_cents: data.discount_amount_cents ?? DEFAULT_SETTINGS.discount_amount_cents,
    bundle_skus: Array.isArray(data.bundle_skus) ? (data.bundle_skus as string[]).filter(isPromoterSku) : [],
    bundle_price_mxn: data.bundle_price_mxn ?? null,
    transfer_details: (data.transfer_details ?? {}) as PromoterTransferDetails,
  }
}

/**
 * Persist the settings patch. Returns `ok:false` when the write didn't actually
 * land — a DB error OR a 0-row update (the singleton row wasn't seeded / table
 * missing) — so the admin route can surface a real failure instead of a silent
 * "Guardado" no-op (the "check the write result" rule).
 */
export async function updatePromoterSettings(
  patch: Partial<PromoterSettings>,
): Promise<{ settings: PromoterSettings; ok: boolean }> {
  const next = { ...(await getPromoterSettings()), ...patch }
  const { data, error } = await db
    .from('marketplace_promoter_settings')
    .update({ ...next, updated_at: new Date().toISOString() })
    .eq('id', 1)
    .select('id')
  if (error && !/does not exist|relation/i.test(error.message ?? '')) {
    console.error('[promoter] settings update failed:', error.message)
  }
  const ok = !error && Array.isArray(data) && data.length > 0
  return { settings: next, ok }
}

// ── Discount resolution (pure — the SKU-checkout preview seam) ─────────────────

export type PromoterDiscount =
  | { ok: true; promoter_id: string; code: string; discount_cents: number }
  | { ok: false; reason: 'not_found' | 'disabled' }

/**
 * Discount in cents off a base. Mirrors the backend coupon engine's
 * `computeCouponDiscountCents`: a percentage of the base, or a flat cents amount,
 * never below 0 and never more than the base. `amount` is the raw percent for
 * 'percentage', or cents (pesos×100) for 'fixed' — matching `discount_amount_cents`.
 */
export function computePromoterDiscountCents(
  type: 'fixed' | 'percentage',
  amount: number,
  baseCents: number,
): number {
  if (baseCents <= 0 || amount <= 0) return 0
  const raw = type === 'percentage' ? Math.round((baseCents * amount) / 100) : Math.round(amount)
  return Math.max(0, Math.min(raw, baseCents))
}

/**
 * Resolve a promoter code to a discount preview. Pure: the caller looks the
 * promoter up (DB) and passes it in, so this stays unit-testable. Unknown code →
 * not_found; valid code but the program/discount is off → disabled.
 *
 * Sprint 3 (US-3.1) — pass `sku` + `skuPrices` to prefer an explicit per-SKU
 * promoter price (e.g. subdomain = $0, US-3.2) over the legacy global discount.
 * Omitting them keeps the exact prior behavior (back-compat for every existing
 * checkout call site) — so this is additive, never a drift risk for a SKU without
 * an override.
 */
export function resolvePromoterDiscount(input: {
  promoter: Promoter | null
  settings: PromoterSettings
  itemsCents: number
  sku?: PromoterSku
  skuPrices?: PromoterSkuPrices
}): PromoterDiscount {
  const { promoter, settings, itemsCents, sku, skuPrices } = input
  if (!promoter) return { ok: false, reason: 'not_found' }
  if (!settings.enabled) return { ok: false, reason: 'disabled' }

  const hasOverride = sku != null && skuPrices != null && skuPrices[sku] != null
  if (!hasOverride && settings.discount_amount_cents <= 0) return { ok: false, reason: 'disabled' }

  const discount_cents = hasOverride
    ? Math.max(0, itemsCents - resolveSkuPromoterPriceCents({ sku: sku as PromoterSku, regularPriceCents: itemsCents, skuPrices: skuPrices as PromoterSkuPrices, settings }))
    : computePromoterDiscountCents(settings.discount_type, settings.discount_amount_cents, itemsCents)
  return { ok: true, promoter_id: promoter.id, code: promoter.code, discount_cents }
}

/** es-MX message for a refused promoter code (mirrors couponErrorMessage). */
export function promoterRefusalMessage(reason: 'not_found' | 'disabled'): string {
  switch (reason) {
    case 'not_found':
      return 'Código de promotor no válido.'
    case 'disabled':
      return 'El descuento de promotor no está disponible.'
  }
}

// ── Real-billed discount: deterministic Stripe coupon key (epic 08 · S2) ───────
//
// The promoter discount is a single admin-set value, so ONE Stripe coupon backs
// the current discount, keyed by (type, amount). Keying by amount keeps each
// coupon immutable (Stripe coupons can't change their amount) yet idempotent:
// changing the admin amount yields a NEW id, never a mutation. The actual
// find-or-create against Stripe lives in `lib/promoter-coupon-server.ts`; this
// pure derivation lets the api spec assert determinism without Stripe.

export type PromoterCouponKey = {
  /** Deterministic Stripe Coupon id (find-or-create). */
  couponId: string
  /** Deterministic Stripe Promotion Code (uppercase, alnum). */
  promoCode: string
  /** Stripe Coupon `name` — kept ≤ 40 chars (Stripe hard cap). */
  name: string
}

/**
 * Derive the deterministic Stripe ids for the current promoter discount, or null
 * when the discount can't back a coupon (disabled, non-positive, or a percent
 * outside 1–100). Pure.
 */
export function promoterCouponKey(settings: PromoterSettings): PromoterCouponKey | null {
  if (!settings.enabled || settings.discount_amount_cents <= 0) return null
  if (settings.discount_type === 'percentage') {
    const pct = Math.round(settings.discount_amount_cents)
    if (pct <= 0 || pct > 100) return null
    return {
      couponId: `promoter_disc_pct_${pct}`,
      promoCode: `PROMOTERDISCPCT${pct}`,
      name: `Promotor −${pct}%`,
    }
  }
  const cents = Math.round(settings.discount_amount_cents)
  return {
    couponId: `promoter_disc_fixed_${cents}`,
    promoCode: `PROMOTERDISCF${cents}`,
    name: `Promotor −$${Math.round(cents / 100)} MXN`,
  }
}

// ── Attribution (enrollment ledger) ───────────────────────────────────────────

// SKU vocabulary lives in lib/promoter-skus.ts (dependency-free) so this module
// and lib/promoter-commission.ts share it without an import cycle. Imported above
// for local use; re-exported here for back-compat with `@/lib/promoter` importers.
export { PROMOTER_SKUS, isPromoterSku, type PromoterSku }

export interface PromoterAttribution {
  id: string
  promoter_id: string
  seller_id: string | null
  sku: string | null
  gross_amount_cents: number | null
  cadence: string | null
  status: string
  created_at?: string
}

export type AttributeResult = 'recorded' | 'skipped'

/**
 * Record an enrollment / attributed sale against a promoter. Idempotent — the
 * partial unique index on (promoter_id, seller_id, sku) means re-running checkout
 * doesn't double-write (swallows 23505), mirroring attributeReferral. In Sprint 1
 * the row is `enrolled` (code applied, no charge yet); amount/cadence fill in when
 * the real charge lands (Sprint 2).
 */
export async function recordAttribution(input: {
  promoterId: string
  sellerId: string | null
  sku: PromoterSku
  grossAmountCents?: number | null
  cadence?: string | null
}): Promise<AttributeResult> {
  const { promoterId, sellerId, sku } = input
  if (!promoterId || !sellerId) return 'skipped'

  // Don't double-write an existing enrollment for this (promoter, seller, sku).
  const { data: already } = await db
    .from('marketplace_promoter_attributions')
    .select('id')
    .eq('promoter_id', promoterId)
    .eq('seller_id', sellerId)
    .eq('sku', sku)
    .maybeSingle()
  if (already) return 'skipped'

  const { error } = await db.from('marketplace_promoter_attributions').insert({
    promoter_id: promoterId,
    seller_id: sellerId,
    sku,
    gross_amount_cents: input.grossAmountCents ?? null,
    cadence: input.cadence ?? null,
    status: 'enrolled',
  })
  if (error) {
    if (error.code !== '23505' && !/does not exist|relation/i.test(error.message ?? '')) {
      console.error('[promoter] attribution insert failed:', error.message)
    }
    return 'skipped'
  }
  return 'recorded'
}

/**
 * Mark a promoter attribution PAID when the real charge lands (epic 08 · S2 —
 * the Stripe/Medusa webhook). Upserts on (promoter, seller, sku): flips an
 * existing `enrolled` row to `paid` with the real gross + cadence, or inserts a
 * `paid` row if the buyer never previewed (e.g. an agent/MCP purchase). Idempotent
 * — a webhook retry re-writes the same deterministic values (Sprint 3 reads
 * `status='paid'` + the amount to compute first-payment commission). Tolerates
 * the table not existing yet.
 *
 * `skipAccrual` (Sprint 4 · US-4.2) — a cash/transfer close is "settled at
 * source": the promoter already kept their commission out of the cash they
 * collected, so it must NEVER create an `accrued` commission ledger row (unlike
 * a card close, which still runs the normal accrual-then-offline-settle flow).
 * Every existing caller omits it (defaults `false`), so this is purely additive.
 */
export async function markAttributionPaid(input: {
  promoterId: string
  sellerId: string | null
  sku: PromoterSku
  grossAmountCents: number
  cadence: string
  skipAccrual?: boolean
}): Promise<AttributeResult> {
  const { promoterId, sellerId, sku, grossAmountCents, cadence, skipAccrual = false } = input
  if (!promoterId || !sellerId) return 'skipped'

  const paidFields = {
    gross_amount_cents: grossAmountCents,
    cadence,
    status: 'paid',
  }

  const { data: existing } = await db
    .from('marketplace_promoter_attributions')
    .select('id')
    .eq('promoter_id', promoterId)
    .eq('seller_id', sellerId)
    .eq('sku', sku)
    .maybeSingle()

  if (existing) {
    const { error } = await db
      .from('marketplace_promoter_attributions')
      .update(paidFields)
      .eq('id', existing.id)
    if (error && !/does not exist|relation/i.test(error.message ?? '')) {
      console.error('[promoter] attribution paid-update failed:', error.message)
      return 'skipped'
    }
    if (!skipAccrual) await accrueCommissionForAttribution(existing.id) // Sprint 3 — best-effort, idempotent
    return 'recorded'
  }

  const { data: inserted, error } = await db
    .from('marketplace_promoter_attributions')
    .insert({
      promoter_id: promoterId,
      seller_id: sellerId,
      sku,
      ...paidFields,
    })
    .select('id')
    .maybeSingle()
  if (error) {
    // A concurrent insert (23505 on the partial-unique index) means the row now
    // exists as paid — treat as recorded, not a failure, and accrue against it.
    if (error.code === '23505') {
      const { data: row } = await db
        .from('marketplace_promoter_attributions')
        .select('id')
        .eq('promoter_id', promoterId)
        .eq('seller_id', sellerId)
        .eq('sku', sku)
        .maybeSingle()
      if (row && !skipAccrual) await accrueCommissionForAttribution(row.id)
      return 'recorded'
    }
    if (!/does not exist|relation/i.test(error.message ?? '')) {
      console.error('[promoter] attribution paid-insert failed:', error.message)
    }
    return 'skipped'
  }
  if (inserted && !skipAccrual) await accrueCommissionForAttribution(inserted.id) // Sprint 3
  return 'recorded'
}

/** A promoter's attribution rows, newest first (admin console). */
export async function listAttributions(promoterId: string): Promise<PromoterAttribution[]> {
  if (!promoterId) return []
  const { data, error } = await db
    .from('marketplace_promoter_attributions')
    .select('id, promoter_id, seller_id, sku, gross_amount_cents, cadence, status, created_at')
    .eq('promoter_id', promoterId)
    .order('created_at', { ascending: false })
  if (error || !data) return []
  return data as PromoterAttribution[]
}

// ── Commission ledger (epic 08 · S3) ──────────────────────────────────────────

export interface Commission {
  id: string
  attribution_id: string
  promoter_id: string
  seller_id: string | null
  sku: string | null
  rate_pct: number
  gross_amount_cents: number
  commission_cents: number
  status: string
  accrued_at?: string
  paid_at?: string | null
  settlement_reference?: string | null
}

/**
 * Per-SKU commission rates, defaulting any unset SKU to 0%. Tolerates the table
 * not existing yet (returns the all-zero defaults). US-7.
 */
export async function getCommissionRates(): Promise<Record<PromoterSku, number>> {
  const rates: Record<PromoterSku, number> = { ...DEFAULT_COMMISSION_RATES }
  const { data, error } = await db
    .from('marketplace_promoter_commission_rates')
    .select('sku, rate_pct')
  if (error || !data) return rates
  for (const row of data) {
    if (isPromoterSku(row.sku)) rates[row.sku] = row.rate_pct ?? 0
  }
  return rates
}

/**
 * One SKU's configured rate, or null when it could not be read or no row exists (plans-gratis-negocio S4, pr-reviewer
 * #474). A package's split must never fall back to 0%: that would charge the promoter the full price. "Could not look"
 * is not "0%". An explicitly configured 0 is returned as 0.
 */
export async function getConfiguredCommissionRate(sku: PromoterSku): Promise<number | null> {
  const { data, error } = await db
    .from('marketplace_promoter_commission_rates')
    .select('rate_pct')
    .eq('sku', sku)
    .maybeSingle()
  if (error || !data) return null
  const rate = (data as { rate_pct: number | null }).rate_pct
  return typeof rate === 'number' ? rate : null
}

/**
 * Upsert one SKU's commission rate. Returns `ok:false` when the write didn't land
 * (DB error / missing table), mirroring updatePromoterSettings' "check the write"
 * discipline. The caller validates `ratePct` with isValidRatePct first. US-7.
 */
export async function updateCommissionRate(sku: PromoterSku, ratePct: number): Promise<{ ok: boolean }> {
  const { data, error } = await db
    .from('marketplace_promoter_commission_rates')
    .upsert({ sku, rate_pct: ratePct, updated_at: new Date().toISOString() }, { onConflict: 'sku' })
    .select('sku')
  if (error && !/does not exist|relation/i.test(error.message ?? '')) {
    console.error('[promoter] commission rate update failed:', error.message)
  }
  return { ok: !error && Array.isArray(data) && data.length > 0 }
}

// ── Per-SKU promoter price overrides + bundle (Sprint 3 · US-3.1) ─────────────

/**
 * Explicit per-SKU promoter prices (whole MXN), keyed by SKU. An absent/`null`
 * entry means "not configured — fall back to the legacy global discount formula"
 * (lib/promoter-pricing.ts resolveSkuPromoterPriceCents). Tolerates the table not
 * existing yet (returns `{}`, the all-fallback default).
 */
export async function getPromoterSkuPrices(): Promise<PromoterSkuPrices> {
  const prices: PromoterSkuPrices = {}
  const { data, error } = await db
    .from('marketplace_promoter_sku_prices')
    .select('sku, promoter_price_mxn')
  if (error || !data) return prices
  for (const row of data) {
    if (isPromoterSku(row.sku)) prices[row.sku] = row.promoter_price_mxn
  }
  return prices
}

/**
 * Upsert one SKU's promoter price override (whole MXN; `null` clears the
 * override back to the global-discount fallback). Returns `ok:false` when the
 * write didn't land, mirroring updateCommissionRate's "check the write" discipline.
 */
export async function updatePromoterSkuPrice(sku: PromoterSku, promoterPriceMxn: number | null): Promise<{ ok: boolean }> {
  const { data, error } = await db
    .from('marketplace_promoter_sku_prices')
    .upsert({ sku, promoter_price_mxn: promoterPriceMxn, updated_at: new Date().toISOString() }, { onConflict: 'sku' })
    .select('sku')
  if (error && !/does not exist|relation/i.test(error.message ?? '')) {
    console.error('[promoter] sku price update failed:', error.message)
  }
  return { ok: !error && Array.isArray(data) && data.length > 0 }
}

/**
 * Accrue commission for a paid attribution (US-8). Best-effort + idempotent: fetches
 * the attribution, its SKU rate, the promoter's + shop owner's Clerk ids (the
 * self-referral guard), and whether a commission already exists, then defers the
 * decision to the pure decideAccrual seam. Inserts the ledger row only when it says
 * `ok`. Called from markAttributionPaid (the paid seam) — no money moves. The
 * UNIQUE(attribution_id) constraint is the exactly-once backstop (a webhook retry /
 * subscription renewal of the same attribution accrues nothing).
 */
export async function accrueCommissionForAttribution(attributionId: string): Promise<void> {
  await accrueCommissionOutcome(attributionId)
}

/**
 * The same accrual, saying what it amounted to (`AccrualOutcome`): `accrued`, `will_not_accrue` with the rule's
 * reason, or `failed` (a read or the insert errored). Never throws. The share paths use this so that a share the
 * rules correctly do not pay (a 0% rate set in /admin/promoter, a self-referral, a promoter off the track) is DONE,
 * and only a real failure is retried (verifier, PR 486).
 */
export async function accrueCommissionOutcome(attributionId: string): Promise<AccrualOutcome> {
  if (!attributionId) return { kind: 'failed', error: 'no attribution id' }

  const { data: attr, error: attrErr } = await db
    .from('marketplace_promoter_attributions')
    .select('id, promoter_id, seller_id, sku, gross_amount_cents, status')
    .eq('id', attributionId)
    .maybeSingle()
  if (attrErr || !attr) return { kind: 'failed', error: attrErr?.message ?? 'attribution not found' }

  const { data: existing, error: existingErr } = await db
    .from('marketplace_promoter_commissions')
    .select('id')
    .eq('attribution_id', attributionId)
    .maybeSingle()
  if (existingErr) return { kind: 'failed', error: existingErr.message }

  // The rate is read with its error kept: `getCommissionRates` falls back to 0% on a failed read, which here would
  // turn "could not look" into "the rule says nothing is owed".
  let ratePct: number | null = null
  if (isPromoterSku(attr.sku)) {
    const { data: rateRow, error: rateErr } = await db
      .from('marketplace_promoter_commission_rates')
      .select('rate_pct')
      .eq('sku', attr.sku)
      .maybeSingle()
    if (rateErr) return { kind: 'failed', error: rateErr.message }
    ratePct = (rateRow as { rate_pct: number | null } | null)?.rate_pct ?? DEFAULT_COMMISSION_RATES[attr.sku]
  }

  const { data: promoter, error: promoterErr } = await db
    .from('marketplace_promoters')
    .select('clerk_user_id, program_track')
    .eq('id', attr.promoter_id)
    .eq('program_track', 'promoter')
    .maybeSingle()
  if (promoterErr) return { kind: 'failed', error: promoterErr.message }
  if (!isPromoterEconomicIdentity(promoter)) return { kind: 'will_not_accrue', reason: 'not_promoter_track' }

  let shopOwnerClerkUserId: string | null = null
  if (attr.seller_id) {
    const { data: shop } = await db
      .from('marketplace_shops')
      .select('clerk_user_id')
      .eq('id', attr.seller_id)
      .maybeSingle()
    shopOwnerClerkUserId = shop?.clerk_user_id ?? null
  }

  const decision = decideAccrual({
    attribution: { status: attr.status, sku: attr.sku, gross_amount_cents: attr.gross_amount_cents },
    ratePct,
    existingCommission: !!existing,
    promoterClerkUserId: promoter?.clerk_user_id ?? null,
    shopOwnerClerkUserId,
  })
  if (!decision.ok) return accrualOutcomeOf(decision)

  const { error } = await db.from('marketplace_promoter_commissions').insert({
    attribution_id: attributionId,
    promoter_id: attr.promoter_id,
    seller_id: attr.seller_id,
    sku: attr.sku,
    rate_pct: decision.ratePct,
    gross_amount_cents: decision.grossAmountCents,
    commission_cents: decision.commissionCents,
    status: 'accrued',
  })
  // 23505 = a concurrent accrual already inserted (UNIQUE attribution_id) — fine.
  if (error && error.code !== '23505') {
    if (!/does not exist|relation/i.test(error.message ?? '')) console.error('[promoter] commission accrual insert failed:', error.message)
    return { kind: 'failed', error: error.message }
  }
  return { kind: 'accrued' }
}

/** Missing or non-Promotor identities can never enter commission economics. */
export function isPromoterEconomicIdentity(
  row: { clerk_user_id?: string | null; program_track?: string | null } | null,
): row is { clerk_user_id: string | null; program_track: 'promoter' } {
  return row?.program_track === 'promoter'
}

/** A promoter's commission rows, newest first (dashboard + admin). US-8. */
export async function listCommissionsForPromoter(promoterId: string): Promise<Commission[]> {
  if (!promoterId) return []
  const { data, error } = await db
    .from('marketplace_promoter_commissions')
    .select(
      'id, attribution_id, promoter_id, seller_id, sku, rate_pct, gross_amount_cents, commission_cents, status, accrued_at, paid_at, settlement_reference',
    )
    .eq('promoter_id', promoterId)
    .order('accrued_at', { ascending: false })
  if (error || !data) return []
  return data as Commission[]
}

/** All accrued (unpaid) commissions across promoters, for the settlement view. US-9. */
export async function listPendingCommissions(): Promise<Commission[]> {
  const { data, error } = await db
    .from('marketplace_promoter_commissions')
    .select(
      'id, attribution_id, promoter_id, seller_id, sku, rate_pct, gross_amount_cents, commission_cents, status, accrued_at, paid_at, settlement_reference',
    )
    .eq('status', 'accrued')
    .order('accrued_at', { ascending: false })
  if (error || !data) return []
  return data as Commission[]
}

/**
 * Mark a commission settled (paid offline). Idempotent: an atomic conditional claim
 * (`.eq('status','accrued')`) flips exactly one accrued row to paid + stamps the
 * timestamp/reference, mirroring referrals' maybeRewardReferralOnOrder. Re-settling
 * an already-paid row is a no-op that still returns `ok` (alreadyPaid). US-9.
 */
export async function settleCommission(
  id: string,
  reference: string | null,
): Promise<{ ok: boolean; alreadyPaid: boolean }> {
  if (!id) return { ok: false, alreadyPaid: false }
  const { data, error } = await db
    .from('marketplace_promoter_commissions')
    .update({ status: 'paid', paid_at: new Date().toISOString(), settlement_reference: reference })
    .eq('id', id)
    .eq('status', 'accrued')
    .select('id')
  if (error && !/does not exist|relation/i.test(error.message ?? '')) {
    console.error('[promoter] commission settle failed:', error.message)
    return { ok: false, alreadyPaid: false }
  }
  if (!error && Array.isArray(data) && data.length > 0) return { ok: true, alreadyPaid: false }

  // 0 rows claimed: either it's already paid (idempotent ok) or the id is unknown.
  const { data: row } = await db
    .from('marketplace_promoter_commissions')
    .select('status')
    .eq('id', id)
    .maybeSingle()
  if (row?.status === 'paid') return { ok: true, alreadyPaid: true }
  return { ok: false, alreadyPaid: false }
}
