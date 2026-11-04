/**
 * lib/plan.ts — which plan a shop is on, decided in ONE pure place (epic 08 · plans-gratis-negocio, README D1).
 *
 * Miyagi Sánchez has two plans: **Gratis**, forever, and **Negocio**. Every shop also gets a 30-day Negocio trial,
 * once. This module answers "gratis, trial or negocio?" from three facts and nothing else:
 *
 *   1. `metadata.negocio_grant` on the shop — a `comp` (hand-granted, permanent) or a dated `one_time` grant (a
 *      yearly payment, or a promoter package), which lapses ON READ, exactly like the custom-domain grant;
 *   2. an active monthly Negocio subscription in Medusa Commerce (read by `lib/plan-server.ts`);
 *   3. `metadata.negocio_trial` — the dated trial, stamped once (D4).
 *
 * Precedence: Negocio (comp › live one_time › subscription) › a live trial › Gratis.
 *
 * Every gate — the custom domain, ML sync, the badge, the AI allowances, the check-in — reads the plan through
 * `resolvePlan` and asks the small questions below (`planOpensCustomDomain`, …). Nothing else decides a plan, so two
 * surfaces can never disagree about what a merchant paid for.
 *
 * PURE + next-free + no `server-only`: importable by middleware, routes, scripts and the Playwright `api` runner.
 */

import { NEGOCIO_TRIAL_DAYS, NEGOCIO_YEARLY_MONTHS } from './negocio-pricing'
import type { DomainEntitlement } from './domain-entitlement'

export const NEGOCIO_GRANT_KEY = 'negocio_grant'
export const NEGOCIO_TRIAL_KEY = 'negocio_trial'

export type PlanName = 'gratis' | 'trial' | 'negocio'

export type NegocioGrantType = 'comp' | 'one_time'

export type NegocioGrant = {
  type: NegocioGrantType
  /** ISO timestamp the grant was issued. */
  granted_at: string
  /** ISO timestamp the grant ends. REQUIRED for `one_time`; absent for a permanent `comp`. */
  expires_at?: string
  /** Optional human note: "yearly", "promoter negocio_anual", "WC26 partner"… */
  note?: string
  /** The payment ids (Stripe checkout session, or an approved transfer) already counted into this grant, newest
   *  last — a replayed webhook finds its id here and adds nothing. Capped at NEGOCIO_GRANT_PAYMENTS_KEPT. */
  payments?: string[]
}

/** How many payment ids a grant remembers. Far more than any replay window needs; keeps the JSON small. */
export const NEGOCIO_GRANT_PAYMENTS_KEPT = 24

export type NegocioTrial = {
  started_at: string
  expires_at: string
  /** Set once «te quedan 5 días» was claimed for sending (S2.3, D10). */
  notified_5d_at?: string
  /** Set once «ya estás en Gratis» was claimed for sending (S2.3, D10). */
  notified_end_at?: string
}

export type PlanReason =
  | 'comp' // a permanent, hand-granted Negocio
  | 'one_time' // a dated Negocio grant still within its term (yearly payment or a promoter package)
  | 'subscription' // a live monthly subscription
  | 'trial' // the 30-day trial, still running
  | 'trial_ended' // Gratis, after a trial that has ended
  | 'none' // Gratis, never trialed, nothing paid
  | 'unavailable' // Gratis for gating, but the subscription could not be read: "could not look" ≠ "none"

export type PlanState = {
  plan: PlanName
  reason: PlanReason
  /** When the current plan ends (a one_time grant or the trial), or null (comp, subscription, Gratis). */
  endsAt: string | null
}

// ── Parsing (defensive: a corrupt value never grants) ─────────────────────────

function isIso(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && Number.isFinite(Date.parse(value))
}

/** The Negocio grant on a shop's metadata, or null for a missing / malformed / unknown-type value. A `one_time`
 *  grant without a valid `expires_at` is rejected, so a half-written dated grant can never entitle forever. */
export function readNegocioGrant(metadata: unknown): NegocioGrant | null {
  if (!metadata || typeof metadata !== 'object') return null
  const raw = (metadata as Record<string, unknown>)[NEGOCIO_GRANT_KEY]
  if (!raw || typeof raw !== 'object') return null
  const g = raw as Record<string, unknown>
  if (g.type !== 'comp' && g.type !== 'one_time') return null
  if (!isIso(g.granted_at)) return null
  if (g.type === 'one_time' && !isIso(g.expires_at)) return null
  return {
    type: g.type,
    granted_at: g.granted_at,
    ...(isIso(g.expires_at) ? { expires_at: g.expires_at } : {}),
    ...(typeof g.note === 'string' && g.note.trim() ? { note: g.note.trim() } : {}),
    ...(Array.isArray(g.payments) ? { payments: g.payments.filter((x): x is string => typeof x === 'string' && x !== '') } : {}),
  }
}

/** The trial on a shop's metadata, or null when missing or malformed. */
export function readNegocioTrial(metadata: unknown): NegocioTrial | null {
  if (!metadata || typeof metadata !== 'object') return null
  const raw = (metadata as Record<string, unknown>)[NEGOCIO_TRIAL_KEY]
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  if (!isIso(t.started_at) || !isIso(t.expires_at)) return null
  return {
    started_at: t.started_at,
    expires_at: t.expires_at,
    ...(isIso(t.notified_5d_at) ? { notified_5d_at: t.notified_5d_at } : {}),
    ...(isIso(t.notified_end_at) ? { notified_end_at: t.notified_end_at } : {}),
  }
}

// ── Builders (the ONE place each shape is composed) ───────────────────────────

/**
 * `months` calendar months after `from`, CLAMPED to the target month's last day: Jan 31 + 1 month is Feb 28 (or 29),
 * never Mar 3, and Feb 29 + 12 months is Feb 28 — `setMonth` alone overflows into the next month and gives days away
 * (Codex, #471). Computed in UTC so a server's timezone never moves the date.
 */
export function addMonthsClamped(from: Date, months: number): Date {
  const y = from.getUTCFullYear()
  const m = from.getUTCMonth() + months
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  const day = Math.min(from.getUTCDate(), lastDay)
  return new Date(Date.UTC(y, m, day, from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds()))
}

/** A dated Negocio grant: `months` calendar months from `now` (12 for a yearly payment, 3 for Arranque). */
export function buildNegocioOneTimeGrant(opts?: { months?: number; now?: Date; note?: string }): NegocioGrant {
  const now = opts?.now ?? new Date()
  const months = opts?.months ?? NEGOCIO_YEARLY_MONTHS
  if (!Number.isInteger(months) || months < 1) throw new Error(`buildNegocioOneTimeGrant: months must be a positive integer (got ${months})`)
  const expires = addMonthsClamped(now, months)
  return {
    type: 'one_time',
    granted_at: now.toISOString(),
    expires_at: expires.toISOString(),
    ...(opts?.note?.trim() ? { note: opts.note.trim() } : {}),
  }
}

/** A permanent, hand-granted Negocio. */
export function buildNegocioCompGrant(opts?: { now?: Date; note?: string }): NegocioGrant {
  return {
    type: 'comp',
    granted_at: (opts?.now ?? new Date()).toISOString(),
    ...(opts?.note?.trim() ? { note: opts.note.trim() } : {}),
  }
}

/** The 30-day trial starting `now`. */
export function buildNegocioTrial(now: Date = new Date()): NegocioTrial {
  return {
    started_at: now.toISOString(),
    expires_at: new Date(now.getTime() + NEGOCIO_TRIAL_DAYS * 86_400_000).toISOString(),
  }
}

/**
 * Extending a one_time grant: a second yearly payment (or a package bought while Negocio is still running) adds its
 * months AFTER the current end, never from today — otherwise paying early would throw away the days already paid
 * for. A lapsed or absent grant starts from `now`.
 */
export function extendNegocioGrant(
  current: NegocioGrant | null,
  months: number,
  opts?: { now?: Date; note?: string; paymentId?: string },
): NegocioGrant {
  const now = opts?.now ?? new Date()
  if (current?.type === 'comp') return current // permanent already; a payment cannot shorten or replace it
  const live = current?.type === 'one_time' && !!current.expires_at && Date.parse(current.expires_at) > now.getTime()
  const from = live ? new Date(current!.expires_at!) : now
  const grant = buildNegocioOneTimeGrant({ months, now: from, note: opts?.note })
  const payments = [...(current?.payments ?? []), ...(opts?.paymentId ? [opts.paymentId] : [])].slice(-NEGOCIO_GRANT_PAYMENTS_KEPT)
  // `granted_at` records when THIS payment happened, not where the term starts.
  return { ...grant, granted_at: now.toISOString(), ...(payments.length ? { payments } : {}) }
}

/**
 * The `merge_shop_metadata` guard that matches what was READ at `key`: `absent` when the key is missing, `json_null`
 * when it holds JSON null, `equals` the exact value otherwise. Collapsing "missing" and "JSON null" into one SQL NULL
 * jams the write forever on a key that holds JSON null (`'null'::jsonb` is distinct from SQL NULL) — the stuck-shop
 * trap `lib/paywall-grandfather.ts` already guards against.
 */
export type MetadataGuard = { mode: 'absent' } | { mode: 'json_null' } | { mode: 'equals'; expected: unknown }

export function guardFor(metadata: unknown, key: string): MetadataGuard {
  const meta = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {}
  if (!(key in meta)) return { mode: 'absent' }
  if (meta[key] === null) return { mode: 'json_null' }
  return { mode: 'equals', expected: meta[key] }
}

export type NegocioPaymentDecision =
  | { action: 'replay' } // this payment id was already counted: write nothing
  | { action: 'comp' } // the shop holds a permanent Negocio: nothing to extend (the payment is still recorded by the caller)
  | { action: 'write'; grant: NegocioGrant; guard: MetadataGuard } // compare-and-swap: write `grant` iff the key is still as read

/**
 * What a paid one-time Negocio payment (a yearly payment, a promoter package) writes to the shop. Pure, so the replay
 * rule and the "add after the current end" rule are tested without Stripe. `guard` matches exactly what was read
 * (`guardFor`): if anything changed the grant between the read and the write, the write does nothing and the caller
 * re-reads.
 */
export function decideNegocioPayment(
  metadata: unknown,
  payment: { paymentId: string; months: number; now?: Date; note?: string },
): NegocioPaymentDecision {
  const current = readNegocioGrant(metadata)
  if (current?.payments?.includes(payment.paymentId)) return { action: 'replay' }
  if (current?.type === 'comp') return { action: 'comp' }
  return {
    action: 'write',
    grant: extendNegocioGrant(current, payment.months, { now: payment.now, note: payment.note, paymentId: payment.paymentId }),
    guard: guardFor(metadata, NEGOCIO_GRANT_KEY),
  }
}

// ── The decision ──────────────────────────────────────────────────────────────

export type DerivePlanInput = {
  grant: NegocioGrant | null
  trial: NegocioTrial | null
  /** true / false when Medusa Commerce answered; `undefined` when it could not be read (or was not asked). */
  hasActiveSubscription: boolean | undefined
  /** True when the subscription lookup was attempted and failed. Only then is Gratis reported as `unavailable`. */
  subscriptionUnavailable?: boolean
  now?: Date
}

export function derivePlan(input: DerivePlanInput): PlanState {
  const now = (input.now ?? new Date()).getTime()
  const { grant, trial } = input

  if (grant?.type === 'comp') return { plan: 'negocio', reason: 'comp', endsAt: null }
  if (grant?.type === 'one_time' && grant.expires_at && Date.parse(grant.expires_at) > now) {
    return { plan: 'negocio', reason: 'one_time', endsAt: grant.expires_at }
  }
  if (input.hasActiveSubscription === true) return { plan: 'negocio', reason: 'subscription', endsAt: null }
  if (trial && Date.parse(trial.expires_at) > now) return { plan: 'trial', reason: 'trial', endsAt: trial.expires_at }
  if (input.subscriptionUnavailable) return { plan: 'gratis', reason: 'unavailable', endsAt: null }
  if (trial) return { plan: 'gratis', reason: 'trial_ended', endsAt: null }
  return { plan: 'gratis', reason: 'none', endsAt: null }
}

/** Derive straight from a shop's metadata plus the subscription answer. */
export function derivePlanFromMetadata(
  metadata: unknown,
  sub: { hasActiveSubscription: boolean | undefined; subscriptionUnavailable?: boolean },
  now?: Date,
): PlanState {
  return derivePlan({ grant: readNegocioGrant(metadata), trial: readNegocioTrial(metadata), ...sub, now })
}

/**
 * May this shop start its trial? Once ever: never when a trial was already stamped (live or ended), and never when
 * it already holds any Negocio grant (it has, or had, Negocio already).
 */
export function canStartTrial(metadata: unknown): boolean {
  const meta = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {}
  // Any value under the key — even a malformed one — means a trial was attempted; never stamp twice.
  if (meta[NEGOCIO_TRIAL_KEY] != null) return false
  if (meta[NEGOCIO_GRANT_KEY] != null) return false
  return true
}

/** Whole days left in a plan that ends (rounded up, never negative), or null when it does not end. */
export function daysLeft(state: PlanState, now: Date = new Date()): number | null {
  if (!state.endsAt) return null
  const ms = Date.parse(state.endsAt) - now.getTime()
  return Math.max(0, Math.ceil(ms / 86_400_000))
}

// ── What each plan opens (README D5, D7) ──────────────────────────────────────

/** The custom domain is Negocio only — never in the trial (a domain is DNS work that does not undo cleanly). */
export function planOpensCustomDomain(state: PlanState): boolean {
  return state.plan === 'negocio'
}

/** Mercado Libre sync is part of Negocio, and the trial includes it. */
export function planOpensMlSync(state: PlanState): boolean {
  return state.plan === 'negocio' || state.plan === 'trial'
}

/** «Hecho con Miyagi Sánchez» shows on Gratis shops only. */
export function planShowsBadge(state: PlanState): boolean {
  return state.plan === 'gratis'
}

/** Where the Gratis badge links: the home page, tagged with the shop so its referrals can be counted. */
export function badgeHref(slug: string): string {
  const campaign = encodeURIComponent(slug || 'shop')
  return `https://miyagisanchez.com/?utm_source=badge&utm_medium=shop&utm_campaign=${campaign}`
}

/** The monthly check-in is part of Negocio, and the trial includes it. */
export function planGetsCheckin(state: PlanState): boolean {
  return state.plan === 'negocio' || state.plan === 'trial'
}

/**
 * Layer the plan over an item's own entitlement (custom domain, ML sync). The item's own answer wins when it entitles
 * (a grandfather, a comp, a standalone subscription — Daniel: existing paid merchants keep what they paid for);
 * otherwise the plan opens it if `opens(plan)` says so. Never takes an entitlement away.
 */
export function entitleByPlan(
  own: DomainEntitlement,
  plan: PlanState | null,
  opens: (state: PlanState) => boolean,
): DomainEntitlement {
  if (own.entitled || !plan || !opens(plan)) return own
  return { entitled: true, reason: plan.plan === 'trial' ? 'trial' : 'negocio' }
}

// ── The trial backfill planner (decision a: existing owned shops get the trial on launch day) ──

export type ShopForTrialBackfill = { id: string; slug: string | null; clerk_user_id: string | null; metadata: unknown }

export type TrialBackfillDecision = {
  shopId: string
  slug: string | null
  action: 'stamp' | 'skip'
  why: 'owned_never_trialed' | 'unowned' | 'already_trialed_or_negocio'
}

/** Owned shops that never had a trial or Negocio get one; unowned shops start theirs when claimed (D4). */
export function planNegocioTrialBackfill(shops: readonly ShopForTrialBackfill[]): TrialBackfillDecision[] {
  return shops.map((s) => {
    if (!s.clerk_user_id) return { shopId: s.id, slug: s.slug, action: 'skip', why: 'unowned' }
    if (!canStartTrial(s.metadata)) return { shopId: s.id, slug: s.slug, action: 'skip', why: 'already_trialed_or_negocio' }
    return { shopId: s.id, slug: s.slug, action: 'stamp', why: 'owned_never_trialed' }
  })
}

// ── Custom-domain release (plans-gratis-negocio D5, Codex #471) ─────────────────

export type DomainReleaseReason = 'subscription_canceled' | 'one_time_expired' | 'negocio_ended'
export type DomainReleaseDecision = 'release' | 'keep' | 'keep_and_alert' | 'nothing_to_release'

/**
 * Should a shop's custom domain be torn down? Only when it is entitled by NO path (its own grant or subscription, or
 * Negocio). An unreadable plan keeps it — a teardown is the hard-to-undo direction — and asks a human. Ending Negocio on
 * a shop that never had a domain releases nothing.
 */
export function decideDomainRelease(input: {
  reason: DomainReleaseReason
  hasDomain: boolean
  entitled: boolean
  planUnavailable: boolean
}): DomainReleaseDecision {
  if (input.reason === 'negocio_ended' && !input.hasDomain) return 'nothing_to_release'
  if (input.entitled) return 'keep'
  if (input.planUnavailable) return 'keep_and_alert'
  return 'release'
}
