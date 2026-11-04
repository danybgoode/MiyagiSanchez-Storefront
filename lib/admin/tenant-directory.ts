/**
 * lib/admin/tenant-directory.ts
 *
 * The PURE read-model shaper for the admin tenant directory (`/admin/tenants`,
 * admin-consolidation · Sprint 3). It turns a raw `marketplace_shops` mirror row
 * (+ the resolved paywall flag + a listing count) into one display `TenantRow`,
 * and filters a list by a search query — so the directory and its unit spec share
 * exactly one shaper.
 *
 * READ-MODEL CONTRACT (strict): **Medusa seller IDs are the canonical identity**;
 * `marketplace_shops` fields are display/enrichment only. This module never
 * mutates anything. The mirror is the only enumerable list of tenants, so it is
 * the practical list spine — but each row's identity is its
 * `metadata.medusa_seller_id` (surfaced as `medusaSellerId`); a row without one
 * is an un-imported scraped gem, flagged honestly rather than hidden.
 *
 * PURE + next-free: it imports only the equally-pure `lib/claim` and
 * `lib/domain-entitlement` seams (no `next`, no `db`, no `server-only`), so the
 * Playwright `api` runner can import and unit-test it directly. The async reads
 * live in the server sibling `lib/admin/tenant-directory-server.ts`.
 */

import { isShopClaimed } from '@/lib/claim'
import {
  readDomainGrant,
  deriveDomainEntitlement,
  type DomainEntitlementReason,
} from '@/lib/domain-entitlement'
import { marketVisibility } from '@/lib/market-visibility'
import type { MarketCode } from '@/lib/markets'
import type { PublicSellerMarket } from '@/lib/owned-market'
import type { SellerStatus } from '@/lib/seller-status'

/** Custom-domain state of a tenant, for the directory at a glance. */
export type TenantDomainStatus = 'none' | 'pending' | 'verified'

/** A shaped, display-ready tenant row. Everything here is READ-ONLY. */
export type TenantRow = {
  /** Canonical Medusa seller id (`sel_…`); null for an un-imported scraped gem. */
  medusaSellerId: string | null
  /** Supabase mirror row id — kept for keys/joins, never shown as identity. */
  shopId: string
  slug: string
  name: string
  claimed: boolean
  /** Canonical public Medusa seller ownership; null when the projection is unreadable. */
  publicSellerClaimed: boolean | null
  /** Seller ID returned for the slug by Medusa; a mismatch flags a stale mirror. */
  publicSellerId: string | null
  /** Public Medusa seller verification; null when the projection could not be read. */
  publicSellerVerified: boolean | null
  /** Claim-link page only: whether the public shop shell is currently viewable. */
  publicPreviewAvailable?: boolean | null
  /** The custom domain, or null when none is set. */
  customDomain: string | null
  domainStatus: TenantDomainStatus
  /** Entitlement reason from the pure deriver (list-level — no subscription lookup). */
  entitlementReason: DomainEntitlementReason
  entitled: boolean
  /**
   * True when this list-level reason resolved to `none` only because the paywall
   * is on and we deliberately skipped the per-seller subscription lookup — so the
   * shop could actually be entitled via an active subscription. Lets the UI avoid
   * asserting a false "no plan". Always `false` while the paywall is off.
   */
  subscriptionUnchecked: boolean
  listingCount: number
  /** Authoritative Medusa seller projection, never mirror metadata. */
  operatingMarketCode: MarketCode | null
  operatingMarketLabel: string
  marketplacePublicationLabel: string
  /** ISO timestamp the mirror row was created. */
  createdAt: string | null
  /**
   * Lifecycle status from the Medusa seller — the canonical owner of this fact
   * (tenant-lifecycle-admin · D1). THREE non-status states, never two:
   *
   *   SellerStatus  — read it
   *   'absent'      — Medusa has no such seller (an orphaned mirror row). Durable,
   *                   and a data-repair job.
   *   'unavailable' — the backend could not be reached. Transient; retry.
   *
   * The first revision collapsed the last two into `null`, so an orphaned row read
   * as a temporary glitch and nobody would ever go fix it. Caught in review.
   */
  status: SellerStatus | 'not_imported' | 'absent' | 'unavailable'
  /**
   * The email this merchant registered with, read from Clerk at request time and
   * never stored (D5).
   *
   *   string        — the address
   *   null          — unclaimed: there is no Clerk user, so there is no email
   *   'unavailable' — Clerk could not be reached. Distinct from null on purpose: a
   *                   blank cell that means "we could not ask" reads as "this
   *                   merchant has no email", which is a confident falsehood.
   */
  registrationEmail: string | null | 'unavailable'
}

/** The raw `marketplace_shops` row fields the shaper reads. */
export type RawTenantRow = {
  id: string
  slug?: string | null
  name?: string | null
  clerk_user_id?: string | null
  custom_domain?: string | null
  custom_domain_verified?: boolean | null
  metadata?: unknown
  created_at?: string | null
}

/**
 * The admin directory may enumerate every mirror shop, while the public seller
 * projection is one record per slug. Keep that authoritative enrichment from
 * bursting an unbounded number of Store API requests at Medusa as the tenant
 * population grows. Results retain the caller's input order.
 */
export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  maxConcurrent: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error('maxConcurrent must be a positive integer')
  }

  const output = new Array<R>(values.length)
  let next = 0
  async function worker() {
    while (next < values.length) {
      const index = next++
      output[index] = await mapper(values[index])
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxConcurrent, values.length) }, worker))
  return output
}

/** Walk every PostgREST page; a failed later page must never look like a complete list. */
export async function readAllPages<T>(
  pageSize: number,
  readPage: (from: number, to: number) => Promise<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ state: 'resolved'; rows: T[] } | { state: 'unavailable'; reason: string }> {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('pageSize must be a positive integer')
  const rows: T[] = []
  for (let from = 0; ; from += pageSize) {
    let page: { data: T[] | null; error: { message: string } | null }
    try { page = await readPage(from, from + pageSize - 1) }
    catch (error) { return { state: 'unavailable', reason: error instanceof Error ? error.message : String(error) } }
    if (page.error || !page.data) return { state: 'unavailable', reason: page.error?.message ?? 'empty page response' }
    rows.push(...page.data)
    if (page.data.length < pageSize) return { state: 'resolved', rows }
  }
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Pull the canonical Medusa seller id off the mirror row's metadata. */
export function medusaSellerIdOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null
  const id = (metadata as Record<string, unknown>).medusa_seller_id
  return typeof id === 'string' && id !== '' ? id : null
}

function deriveDomainStatus(domain: string | null, verified: boolean): TenantDomainStatus {
  if (!domain) return 'none'
  return verified ? 'verified' : 'pending'
}

/**
 * Shape one raw mirror row into a display row. `ctx.paywallEnabled` is the
 * once-resolved rollout flag; `ctx.listingCount` is the per-shop count the server
 * sibling computed. The entitlement is derived WITHOUT the per-seller
 * subscription lookup (too heavy to fan out across a directory) — so the reason
 * `subscription` never appears here; while the paywall flag is off (today's
 * default) every shop derives `flag_off` and the distinction is moot. Never throws.
 */
export function shapeTenantRow(
  raw: RawTenantRow,
  ctx: {
    paywallEnabled: boolean
    listingCount: number
    publicSellerMarket?: PublicSellerMarket | null
    publicSellerClaimed?: boolean | null
    publicSellerId?: string | null
    publicSellerVerified?: boolean | null
    status?: SellerStatus | 'not_imported' | 'absent' | 'unavailable'
    registrationEmail?: string | null | 'unavailable'
  },
): TenantRow {
  const customDomain = trimmed(raw.custom_domain) || null
  const entitlement = deriveDomainEntitlement({
    paywallEnabled: ctx.paywallEnabled,
    grant: readDomainGrant(raw.metadata),
  })
  const market = marketVisibility(ctx.publicSellerMarket ?? null)
  return {
    medusaSellerId: medusaSellerIdOf(raw.metadata),
    shopId: raw.id,
    slug: trimmed(raw.slug),
    name: trimmed(raw.name) || trimmed(raw.slug) || '(sin nombre)',
    claimed: ctx.publicSellerClaimed ?? isShopClaimed({ clerk_user_id: raw.clerk_user_id }),
    publicSellerClaimed: ctx.publicSellerClaimed ?? null,
    publicSellerId: ctx.publicSellerId ?? null,
    publicSellerVerified: ctx.publicSellerVerified ?? null,
    customDomain,
    domainStatus: deriveDomainStatus(customDomain, !!raw.custom_domain_verified),
    entitlementReason: entitlement.reason,
    entitled: entitlement.entitled,
    subscriptionUnchecked: ctx.paywallEnabled && entitlement.reason === 'none',
    listingCount: Math.max(0, Math.floor(ctx.listingCount) || 0),
    operatingMarketCode: market.operatingMarketCode,
    operatingMarketLabel: market.operatingMarketLabel,
    marketplacePublicationLabel: market.marketplacePublicationLabel,
    createdAt: trimmed(raw.created_at) || null,
    // Both come from OUTSIDE the mirror row — the Medusa seller and Clerk — so both
    // default to their unavailable form rather than to a made-up value. `undefined`
    // means the caller did not resolve it, which is not the same as "there is none".
    // An unspecified status is UNAVAILABLE, not absent: the caller did not resolve
    // it, which is not the same as Medusa saying there is no such seller.
    status: ctx.status ?? 'unavailable',
    registrationEmail: ctx.registrationEmail === undefined ? 'unavailable' : ctx.registrationEmail,
  }
}

// ── Filtering and sorting: the platform's own heuristics (D6) ─────────────────
//
// PURE and over the FULL set, never a page. The directory loads every shop, and
// sorting a page would sort the wrong thing — the top of a name-ordered page is not
// the shop with the most listings.

export type TenantFilter = {
  q?: string
  /**
   * Includes the two non-status states. If a row can BE `absent` or `unavailable`,
   * an operator must be able to isolate them — those are precisely the rows that
   * need attention, and a filter that cannot name them makes the distinction
   * decorative. (The first revision exposed only the three real statuses; the spec
   * casting `as never` to test the others was the tell.)
   */
  status?: SellerStatus | 'not_imported' | 'absent' | 'unavailable' | 'any'
  claimed?: 'claimed' | 'unclaimed' | 'any'
  market?: MarketCode | 'unknown' | 'any'
  domain?: TenantDomainStatus | 'any'
  entitlement?: 'entitled' | 'not_entitled' | 'any'
}

export type TenantSortKey = 'name' | 'listings' | 'created' | 'status' | 'market'
export type SortDirection = 'asc' | 'desc'

/** The one place a row is matched against the filter. */
export function matchesTenantFilter(row: TenantRow, filter: TenantFilter): boolean {
  const q = filter.q?.trim().toLowerCase()
  if (q) {
    const haystack = [
      row.name,
      row.slug,
      row.customDomain ?? '',
      row.medusaSellerId ?? '',
      // Searching by the address an operator was emailed from is the realistic way
      // to find a shop from an inbox. Only when it is a real address — the
      // 'unavailable' sentinel must never be searchable text.
      typeof row.registrationEmail === 'string' && row.registrationEmail !== 'unavailable'
        ? row.registrationEmail
        : '',
    ].join(' ').toLowerCase()
    if (!haystack.includes(q)) return false
  }
  if (filter.status && filter.status !== 'any' && row.status !== filter.status) return false
  if (filter.claimed && filter.claimed !== 'any') {
    if (filter.claimed === 'claimed' && !row.claimed) return false
    if (filter.claimed === 'unclaimed' && row.claimed) return false
  }
  if (filter.market && filter.market !== 'any') {
    const code = row.operatingMarketCode ?? 'unknown'
    if (code !== filter.market) return false
  }
  if (filter.domain && filter.domain !== 'any' && row.domainStatus !== filter.domain) return false
  if (filter.entitlement && filter.entitlement !== 'any') {
    if (filter.entitlement === 'entitled' && !row.entitled) return false
    if (filter.entitlement === 'not_entitled' && row.entitled) return false
  }
  return true
}

/** Status order for sorting: the ones needing attention first. */
const STATUS_RANK: Record<string, number> = {
  // Attention first. `not_imported` sits with `active` rather than with the problems:
  // an unimported scraped gem is a normal resting state, not a defect.
  paused: 0, deleted: 1, absent: 2, unavailable: 3, active: 4, not_imported: 5,
}

function compareRows(a: TenantRow, b: TenantRow, key: TenantSortKey): number {
  switch (key) {
    case 'listings':
      return a.listingCount - b.listingCount
    case 'created':
      // A row with no created_at sorts as oldest rather than throwing the order.
      return (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
    case 'status':
      return (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
    case 'market':
      return (a.operatingMarketCode ?? 'zz').localeCompare(b.operatingMarketCode ?? 'zz')
    case 'name':
    default:
      return a.name.localeCompare(b.name, 'es')
  }
}

/**
 * Filter then sort, over the whole set.
 *
 * Sorting is STABLE by name within equal keys, so two shops with the same listing
 * count do not shuffle between renders — an order that changes when nothing changed
 * makes an operator distrust the screen.
 */
export function selectTenants(
  rows: readonly TenantRow[],
  filter: TenantFilter = {},
  sort: { key: TenantSortKey; direction: SortDirection } = { key: 'name', direction: 'asc' },
): TenantRow[] {
  const filtered = rows.filter((row) => matchesTenantFilter(row, filter))
  const sign = sort.direction === 'desc' ? -1 : 1
  return [...filtered].sort((a, b) => {
    const primary = compareRows(a, b, sort.key) * sign
    return primary !== 0 ? primary : a.name.localeCompare(b.name, 'es')
  })
}

/**
 * Filter rows by a free-text query — case-insensitive, trimmed, matching across
 * name, slug, custom domain, and the canonical Medusa seller id. An empty query
 * returns every row. Pure (no side effects).
 */
export function filterTenants(rows: TenantRow[], query: string): TenantRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  return rows.filter((row) => {
    const haystack = [row.name, row.slug, row.customDomain ?? '', row.medusaSellerId ?? '']
      .join(' ')
      .toLowerCase()
    return haystack.includes(q)
  })
}

/** es-MX label for an entitlement reason. */
export function entitlementReasonLabel(reason: DomainEntitlementReason): string {
  switch (reason) {
    case 'flag_off':
      return 'Sin restricción (paywall apagado)'
    case 'grandfathered':
      return 'Heredado'
    case 'comp':
      return 'Cortesía'
    case 'subscription':
      return 'Suscripción activa'
    case 'one_time':
      return 'Pago único (1 año)'
    case 'negocio':
      return 'Incluido en Negocio'
    case 'trial':
      return 'Incluido en la prueba de Negocio'
    case 'none':
      return 'Sin plan'
  }
}

/** es-MX label for claim status. */
export function claimStatusLabel(claimed: boolean): string {
  return claimed ? 'Reclamada' : 'Sin reclamar'
}

/** es-MX label for custom-domain status. */
export function domainStatusLabel(status: TenantDomainStatus): string {
  switch (status) {
    case 'none':
      return 'Sin dominio'
    case 'pending':
      return 'Pendiente'
    case 'verified':
      return 'Verificado'
  }
}
