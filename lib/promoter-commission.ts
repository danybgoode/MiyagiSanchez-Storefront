/**
 * Promoter Program · Sprint 3 — commission ledger (pure seam).
 *
 * Turns a paid+attributed sale (Sprint 1 attribution flipped to `status='paid'`
 * by markAttributionPaid in Sprint 2) into an accrued commission for the promoter:
 * commission = SKU rate % × the eligible gross, FIRST-PAYMENT only, with a
 * self-referral guard. No money moves in-app — the admin settles offline (US-9).
 *
 * Pure + next-free (no `next/cache`, no `server-only`, no DB) so the accrual rules,
 * the rate validation, the settlement state machine, and the dashboard totals are
 * directly unit-testable (e2e/promoter-commission.spec.ts). The Supabase wiring
 * (fetch the attribution + rate + identities, insert the ledger row) lives in
 * lib/promoter.ts, exactly like the discount seam — the caller passes pre-fetched
 * rows in, this module only decides. Mirrors lib/manual-payment-state.ts (the
 * state machine) and lib/promoter.ts computePromoterDiscountCents (the money math).
 *
 * Copy is es-MX to match the live app.
 */

import { isPromoterSku, type PromoterSku } from '@/lib/promoter-skus'

// ── Per-SKU commission rate (admin config, US-7) ──────────────────────────────

/** A 0% rate per known SKU — the floor until the admin sets a real percentage. */
export const DEFAULT_COMMISSION_RATES: Record<PromoterSku, number> = {
  custom_domain: 0,
  print_ad: 0,
  subdomain: 0,
  ml_sync: 0,
  migration: 0,
  // plans-gratis-negocio (D12, D13): the real rates (55 / 50 / 80 / 10) are rows seeded by M1; 0 is only the floor.
  negocio_anual: 0,
  negocio_arranque: 0,
  setup_gratis: 0,
  negocio_renewal: 0,
  // plan-tienda S4 (D12): the real rates (60 / 55 / 10 / 20) are rows seeded by M1 (20261111000000); 0 is only the floor.
  tienda_anual: 0,
  negocio_semestral: 0,
  tienda_renewal: 0,
  negocio_upgrade: 0,
}

/**
 * Is `n` a valid commission rate? A whole percent in [0, 100]. Rejects negatives,
 * >100, fractions, and non-finite input — the admin route uses this to 400 bad input.
 */
export function isValidRatePct(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 100
}

// ── Commission math (pure money fn) ───────────────────────────────────────────

/**
 * Commission in cents = `ratePct`% of `grossAmountCents`, rounded, floored at 0.
 * Mirrors computePromoterDiscountCents' shape. Non-positive rate or gross ⇒ 0.
 */
export function computeCommissionCents(ratePct: number, grossAmountCents: number): number {
  if (ratePct <= 0 || grossAmountCents <= 0) return 0
  return Math.max(0, Math.round((grossAmountCents * ratePct) / 100))
}

// ── Accrual decision (the heart — first-payment + self-referral guards) ───────

export interface AccrualAttribution {
  status: string
  sku: string | null
  gross_amount_cents: number | null
}

export interface AccrualInput {
  /** The attribution row the commission would accrue against. */
  attribution: AccrualAttribution
  /** The configured commission rate for this SKU (null when no rate row exists). */
  ratePct: number | null
  /** True when a commission row already exists for this attribution (exactly-once). */
  existingCommission: boolean
  /** The promoter's linked Clerk account, if any (self-referral guard). */
  promoterClerkUserId?: string | null
  /** The enrolled shop owner's Clerk account, if resolvable (self-referral guard). */
  shopOwnerClerkUserId?: string | null
}

export type AccrualReason =
  | 'not_paid'
  | 'sku_not_eligible'
  | 'self_referral'
  | 'no_rate'
  | 'no_gross'
  | 'already_accrued'

export type AccrualDecision =
  | { ok: true; commissionCents: number; ratePct: number; grossAmountCents: number }
  | { ok: false; reason: AccrualReason }

/**
 * Decide whether (and how much) commission accrues for an attribution. Pure — the
 * caller fetches the attribution, the SKU rate, the linked identities, and whether
 * a commission already exists, then passes them in.
 *
 * Refusals, in order: the sale isn't paid; the SKU isn't a commissionable one; the
 * promoter is the shop owner (self-referral); no/zero rate configured; a commission
 * already accrued (first-payment/exactly-once — a renewal of the same attribution
 * lands here, reinforced by the UNIQUE(attribution_id) DB constraint).
 */
export function decideAccrual(input: AccrualInput): AccrualDecision {
  const { attribution, ratePct, existingCommission, promoterClerkUserId, shopOwnerClerkUserId } = input

  if (attribution.status !== 'paid') return { ok: false, reason: 'not_paid' }
  if (!isPromoterSku(attribution.sku)) return { ok: false, reason: 'sku_not_eligible' }

  // Self-referral: the promoter owns the shop they enrolled. Only fires when both
  // identities are known — an unlinked promoter (clerk_user_id null) can't self-refer.
  if (promoterClerkUserId && shopOwnerClerkUserId && promoterClerkUserId === shopOwnerClerkUserId) {
    return { ok: false, reason: 'self_referral' }
  }

  if (ratePct == null || ratePct <= 0) return { ok: false, reason: 'no_rate' }
  if (existingCommission) return { ok: false, reason: 'already_accrued' }

  const grossAmountCents = attribution.gross_amount_cents ?? 0
  const commissionCents = computeCommissionCents(ratePct, grossAmountCents)
  if (commissionCents <= 0) return { ok: false, reason: 'no_gross' } // rate is valid but no eligible gross

  return { ok: true, commissionCents, ratePct, grossAmountCents }
}

// ── Settlement state machine (US-9) ───────────────────────────────────────────

export type CommissionState = 'accrued' | 'paid'

/** Legal transitions. `accrued → paid` (offline settlement); `paid` is terminal. */
const TRANSITIONS: Record<CommissionState, readonly CommissionState[]> = {
  accrued: ['paid'],
  paid: [],
}

/** Can a commission move `from → to`? `from === to` is a no-op (idempotent settle). */
export function canTransition(from: CommissionState, to: CommissionState): boolean {
  if (from === to) return true
  return TRANSITIONS[from]?.includes(to) ?? false
}

// ── Dashboard totals (US-8) ───────────────────────────────────────────────────

export interface CommissionLike {
  commission_cents: number | null
  status: string
}

export interface CommissionTotals {
  /** Everything accrued, paid or not. */
  earnedCents: number
  /** Accrued but not yet settled. */
  pendingCents: number
  /** Settled (paid offline). */
  paidCents: number
}

/** Sum a promoter's commission rows into earned / pending / paid (pure projection). */
export function summarizeCommissions(rows: readonly CommissionLike[]): CommissionTotals {
  let earnedCents = 0
  let paidCents = 0
  for (const row of rows) {
    const cents = row.commission_cents ?? 0
    earnedCents += cents
    if (row.status === 'paid') paidCents += cents
  }
  return { earnedCents, pendingCents: earnedCents - paidCents, paidCents }
}
