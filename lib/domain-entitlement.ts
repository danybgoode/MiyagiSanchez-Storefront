/**
 * lib/domain-entitlement.ts
 *
 * The PURE entitlement seam for the custom-domain paywall (epic 07 ·
 * custom-domain-paywall, Sprint 1). "Is this shop allowed to connect / change a
 * custom domain?" derived in ONE place, consumed by every domain mutation route
 * AND the connect UI so the rule can never drift between them.
 *
 * Design (locked with Daniel):
 *  - Entitlement is DERIVED, not a parallel boolean flag. The sources are:
 *      1. the rollout flag (off ⇒ everyone ungated — today's free behavior),
 *      2. a durable grant on `marketplace_shops.metadata.custom_domain_grant`
 *         ({ type:'grandfather'|'comp'|'one_time', ... }) — grandfather is
 *         stamped at cutover, comp is hand-granted by Daniel, and `one_time` is
 *         a DATED 12-month grant bought up-front with no recurring mandate
 *         (epic 08 · promoter-program, Sprint 2),
 *      3. an active subscription to the custom-domain plan (recurring cadence).
 *  - The grant is stored DISTINCT from "currently has a domain" so it survives
 *    the lapse logic (a lapsed seller still has `custom_domain` set but must
 *    lose entitlement).
 *  - A `one_time` grant LAPSES ON READ: it entitles only while `now < expires_at`,
 *    so the year-end lapse is graceful and needs no auto-charge and no cron to
 *    flip a flag (the gate simply closes). The physical domain teardown is a
 *    separate best-effort sweep (`releaseCustomDomainForShop`).
 *
 * This module is PURE + next-free + has zero side-effect imports, so the
 * Playwright `api` runner can import and unit-test it directly. The async
 * composition (reading the flag + the shop row) lives in
 * `lib/domain-entitlement-server.ts`.
 */

export type DomainGrantType = 'grandfather' | 'comp' | 'one_time'

export type DomainGrant = {
  type: DomainGrantType
  /** ISO timestamp the grant was issued. */
  granted_at: string
  /**
   * ISO timestamp the grant expires. REQUIRED for `one_time` (the dated 12-month
   * cadence); absent for the permanent `grandfather`/`comp` grants.
   */
  expires_at?: string
  /** Optional human note (e.g. "cutover", "WC26 partner", "one-time S2"). */
  note?: string
}

export type DomainEntitlementReason =
  | 'flag_off'        // paywall not enabled ⇒ ungated (entitled)
  | 'grandfathered'   // durable grandfather grant
  | 'comp'            // durable comp grant
  | 'one_time'        // dated one-time grant, still within its 12-month term (S2)
  | 'subscription'    // active paid subscription to the custom-domain plan
  | 'negocio'         // the shop is on Negocio, which includes it (plans-gratis-negocio D5)
  | 'trial'           // the shop's Negocio trial includes it (ML sync only — never the custom domain)
  | 'none'            // paywall on, no grant, no subscription ⇒ NOT entitled

export type DomainEntitlement = {
  entitled: boolean
  reason: DomainEntitlementReason
}

/**
 * Defensively parse a grant object stored at `metadata[key]` (a shop's JSONB).
 * Returns null for missing / malformed / unknown-type grants — so a corrupt
 * value can never accidentally grant (or, when the flag is on, deny incorrectly).
 * A `one_time` grant with a missing/blank `expires_at` is rejected (treated as
 * no grant) so a half-written dated grant can never entitle forever.
 *
 * `key` lets distinct SKUs keep distinct grants without forking the parsing rule:
 * the custom domain reads `custom_domain_grant`, the subdomain reads
 * `subdomain_grant` (epic 07 · subdomain-pricing) — same shape, separate keys, so
 * one SKU's grant never leaks entitlement to the other.
 */
export function readGrant(metadata: unknown, key: string): DomainGrant | null {
  if (!metadata || typeof metadata !== 'object') return null
  const raw = (metadata as Record<string, unknown>)[key]
  if (!raw || typeof raw !== 'object') return null
  const g = raw as Record<string, unknown>
  if (g.type !== 'grandfather' && g.type !== 'comp' && g.type !== 'one_time') return null
  if (typeof g.granted_at !== 'string' || g.granted_at === '') return null
  // A one_time grant MUST carry a non-blank expires_at — otherwise it's malformed.
  if (g.type === 'one_time' && (typeof g.expires_at !== 'string' || g.expires_at === '')) return null
  return {
    type: g.type,
    granted_at: g.granted_at,
    ...(typeof g.expires_at === 'string' && g.expires_at !== '' ? { expires_at: g.expires_at } : {}),
    ...(typeof g.note === 'string' ? { note: g.note } : {}),
  }
}

/**
 * Parse the custom-domain grant off `metadata.custom_domain_grant`. Thin wrapper
 * over `readGrant` so the custom-domain paywall keeps its exact prior behavior.
 */
export function readDomainGrant(metadata: unknown): DomainGrant | null {
  return readGrant(metadata, 'custom_domain_grant')
}

/**
 * Build a `comp` grant in the canonical `custom_domain_grant` shape — the ONE
 * place a hand-granted comp is composed, so the admin grant action (epic 09 ·
 * admin-consolidation, S4.1) writes exactly what `readDomainGrant` parses and
 * `deriveDomainEntitlement` honors (never a parallel shape). `granted_at` is an
 * ISO timestamp; a blank/whitespace note is dropped so the field is absent, not
 * empty. Revoke has no builder — it clears the `custom_domain_grant` key.
 */
export function buildCompGrant(opts?: { note?: string; now?: Date }): DomainGrant {
  return {
    type: 'comp',
    granted_at: (opts?.now ?? new Date()).toISOString(),
    ...(opts?.note?.trim() ? { note: opts.note.trim() } : {}),
  }
}

/** Default term for the one-time custom-domain cadence (epic 08 · S2). */
export const ONE_TIME_GRANT_MONTHS = 12

/**
 * Build a dated `one_time` grant in the canonical `custom_domain_grant` shape —
 * the ONE place the one-time cadence's grant is composed, so the Stripe webhook
 * (`handleCustomDomainOneTimeComplete`) writes exactly what `readDomainGrant`
 * parses and `deriveDomainEntitlement` honors. `granted_at` is now; `expires_at`
 * is `now + months` (default 12). Computed by calendar month so a Feb purchase
 * expires next Feb, not "+365 days".
 */
export function buildOneTimeGrant(opts?: { months?: number; now?: Date; note?: string }): DomainGrant {
  const now = opts?.now ?? new Date()
  const months = opts?.months ?? ONE_TIME_GRANT_MONTHS
  const expires = new Date(now)
  expires.setMonth(expires.getMonth() + months)
  return {
    type: 'one_time',
    granted_at: now.toISOString(),
    expires_at: expires.toISOString(),
    ...(opts?.note?.trim() ? { note: opts.note.trim() } : {}),
  }
}

/** True when a `one_time` grant is still within its term (`now < expires_at`). */
export function isOneTimeGrantLive(grant: DomainGrant | null, now: Date = new Date()): boolean {
  if (grant?.type !== 'one_time' || !grant.expires_at) return false
  const exp = Date.parse(grant.expires_at)
  return Number.isFinite(exp) && now.getTime() < exp
}

/**
 * Derive entitlement from the resolved inputs. Precedence:
 *   flag off → grandfather → comp → live one-time grant → active subscription → none.
 * A `one_time` grant entitles only while `now < expires_at` (lapse on read); past
 * expiry it stops entitling and the deriver falls through (subscription/none).
 * Never throws.
 */
export function deriveDomainEntitlement(input: {
  paywallEnabled: boolean
  grant: DomainGrant | null
  /** Active sub to the custom-domain plan (recurring cadence). */
  hasActiveSubscription?: boolean
  /** Injectable clock for the one-time lapse (defaults to real now). */
  now?: Date
}): DomainEntitlement {
  if (!input.paywallEnabled) return { entitled: true, reason: 'flag_off' }
  if (input.grant?.type === 'grandfather') return { entitled: true, reason: 'grandfathered' }
  if (input.grant?.type === 'comp') return { entitled: true, reason: 'comp' }
  if (isOneTimeGrantLive(input.grant, input.now ?? new Date())) return { entitled: true, reason: 'one_time' }
  if (input.hasActiveSubscription) return { entitled: true, reason: 'subscription' }
  return { entitled: false, reason: 'none' }
}
