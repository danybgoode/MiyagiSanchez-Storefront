/**
 * Promoter Funnel v2 · Sprint 4 (US-4.1/US-4.2) — the net-remittance pure seam.
 *
 * A promoter who collected cash reports a transfer of (price − commission) instead
 * of paying by card — "settled at source": the promoter already kept their
 * commission out of the cash, so this NEVER creates an accrued commission ledger
 * row (unlike a card close, which still runs the existing accrual-then-offline-
 * settle flow via lib/promoter-commission.ts). Admin approval activates the SKU
 * via the EXISTING grant/entitlement writers — no new payment path.
 *
 * Pure + next-free (no `next/cache`, no `server-only`, no DB) — directly
 * unit-testable (e2e/promoter-transfer.spec.ts). Mirrors the shape of
 * lib/promoter-commission.ts (the settlement state machine) and
 * lib/promoter-close.ts (the S4 in-person-close string builders). The Supabase
 * CRUD lives in lib/promoter-transfers-server.ts; the metadata grant write lives
 * in lib/promoter-grant-server.ts.
 *
 * Scope: `custom_domain` | `subdomain` | `ml_sync` | `migration` — the SKUs in the
 * close-workspace picker (`CLOSE_SKUS`). `print_ad` has its own cash-report path
 * from Sprint 3 (`/api/promoter/close/print` + the existing `/admin/print` review)
 * and isn't in the close-workspace picker until Sprint 5 — out of scope here.
 *
 * `migration` (platform-migrations · Sprint 2) has no ongoing feature to entitle —
 * it's a one-time consulting service the promoter already delivered by the time
 * this closes. Its `migration_grant` write below is an inert paid/audit marker
 * only; nothing reads it to gate a feature (unlike the other three SKUs' grants).
 */

import { computeCommissionCents } from '@/lib/promoter-commission'

export const TRANSFER_SKUS = [
  'custom_domain', 'subdomain', 'ml_sync', 'migration',
  // plans-gratis-negocio S4 (D12): the three packages, settled at source by transfer (M1 widened the DB CHECK).
  'negocio_anual', 'negocio_arranque', 'setup_gratis',
] as const
export type TransferSku = (typeof TRANSFER_SKUS)[number]

/** Narrow an untrusted value to a known TransferSku. */
export function isTransferSku(raw: unknown): raw is TransferSku {
  return typeof raw === 'string' && (TRANSFER_SKUS as readonly string[]).includes(raw)
}

export const TRANSFER_METHODS = ['spei', 'dimo', 'codi'] as const
export type TransferMethod = (typeof TRANSFER_METHODS)[number]

/** Narrow an untrusted value to a known TransferMethod. */
export function isTransferMethod(raw: unknown): raw is TransferMethod {
  return typeof raw === 'string' && (TRANSFER_METHODS as readonly string[]).includes(raw)
}

// ── Owed math (the "advertised = charged = owed" seam) ────────────────────────

/**
 * What the promoter must transfer: the price charged (`grossCents` — resolved by
 * the SAME deriver every existing Stripe close route already uses,
 * `lib/promoter.ts#resolvePromoterDiscount`) minus the commission they keep
 * (`lib/promoter-commission.ts#computeCommissionCents`). Never negative — a rate
 * over 100% (shouldn't happen; `isValidRatePct` already caps admin input at 100)
 * or a rounding edge can never invert into owing more than the sale itself.
 *
 * The $0-subdomain case (Sprint 3 · US-3.2) falls straight through:
 * `computeCommissionCents` already returns 0 for a non-positive gross, so
 * `computeOwedCents(0, anyRate) === 0` — no special-casing needed.
 */
export function computeOwedCents(grossCents: number, ratePct: number): number {
  const commissionCents = computeCommissionCents(ratePct, grossCents)
  return Math.max(0, grossCents - commissionCents)
}

// ── Remittance state machine ───────────────────────────────────────────────────

export type TransferStatus = 'pending' | 'reported' | 'approved' | 'rejected'

/**
 * Legal transitions. `pending` (created at close, owed amount frozen) →
 * `reported` ("Ya transferí") → `approved` (admin activates) | `rejected` (admin
 * declines, sale returns to unpaid — a fresh transfer request may be created
 * afterwards, the unique index only blocks concurrent pending/reported rows).
 * `approved`/`rejected` are terminal for THIS row.
 */
const TRANSFER_TRANSITIONS: Record<TransferStatus, readonly TransferStatus[]> = {
  pending: ['reported'],
  reported: ['approved', 'rejected'],
  approved: [],
  rejected: [],
}

/** Can a transfer move `from → to`? `from === to` is a no-op (idempotent re-report). */
export function canTransitionTransfer(from: TransferStatus, to: TransferStatus): boolean {
  if (from === to) return true
  return TRANSFER_TRANSITIONS[from]?.includes(to) ?? false
}

// ── Activation mapping (per-SKU grant key) ────────────────────────────────────

/**
 * sku → the `marketplace_shops.metadata` key the existing entitlement readers
 * already derive from (`lib/domain-entitlement.ts`, `lib/subdomain-entitlement.ts`
 * `SUBDOMAIN_GRANT_KEY`, `lib/ml-sync-entitlement.ts` `ML_SYNC_GRANT_KEY`) —
 * consumed by `lib/promoter-grant-server.ts#activatePromoterOneTimeGrant` so
 * approval writes to the SAME place every existing paid path (Stripe webhook /
 * `grantFreeSubdomainYear`) already writes to.
 */
export const SKU_GRANT_KEYS: Record<TransferSku, string> = {
  custom_domain: 'custom_domain_grant',
  subdomain: 'subdomain_grant',
  ml_sync: 'ml_sync_grant',
  migration: 'migration_grant',
  // The packages grant Negocio through `applyNegocioPayment` (lib/negocio-webhook.ts), not a per-SKU key.
  negocio_anual: 'negocio_grant',
  negocio_arranque: 'negocio_grant',
  setup_gratis: '',
}

/** es-MX display label per SKU — for transfer-approval/rejection email subjects. */
export const TRANSFER_SKU_LABEL: Record<TransferSku, string> = {
  custom_domain: 'Dominio propio',
  subdomain: 'Subdominio propio',
  ml_sync: 'Sincronización Mercado Libre',
  migration: 'Migración de tienda',
  negocio_anual: 'Paquete Anual (instalación + 12 meses de Negocio)',
  negocio_arranque: 'Paquete Arranque (instalación + 3 meses de Negocio)',
  setup_gratis: 'Instalación en el plan Gratis',
}

// ── Transfer-details completeness (the "never a dead-end destination" guard) ──

/** Which admin transfer_details field is required for a promoter to actually
 *  be able to send money via that method — an empty/missing field would show
 *  the promoter a destination with nothing to transfer to. */
const REQUIRED_DETAIL_FIELD: Record<TransferMethod, 'clabe' | 'dimo_phone' | 'codi_reference'> = {
  spei: 'clabe',
  dimo: 'dimo_phone',
  codi: 'codi_reference',
}

/**
 * True when the admin has configured the field the chosen method needs (a
 * non-blank string). Cross-agent review flagged that a promoter could be
 * offered "Transferir a Miyagi" via a method with no usable destination
 * (admin never entered a CLABE/DiMo/CoDi) — this is the guard the route calls
 * BEFORE creating a transfer request, so that dead-end never reaches a promoter.
 */
export function hasRequiredTransferDetail(
  details: Partial<Record<'clabe' | 'bank_name' | 'account_holder' | 'dimo_phone' | 'codi_reference', string>>,
  method: TransferMethod,
): boolean {
  const field = REQUIRED_DETAIL_FIELD[method]
  const value = details[field]
  return typeof value === 'string' && value.trim().length > 0
}
