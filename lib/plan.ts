/**
 * lib/plan.ts — which plan a shop is on, decided in ONE pure place (epic 08 · plans-gratis-negocio, README D1;
 * widened by epic 08 · plan-tienda-three-free-months, README D1–D4).
 *
 * Miyagi Sánchez has two paid plans, **Tienda** and **Negocio**, a dated Negocio trial that every shop gets once, and
 * **Gratis**, which since plan-tienda means LEGACY Plan Gratis only: the shops that carry the legacy marker (those
 * that existed when `scripts/mark-plan-legacy.ts` was run) keep it for good. A shop with none of those is **unpaid**. This module answers
 * "gratis, trial, tienda, negocio or unpaid?" from these facts and nothing else:
 *
 *   1. `metadata.negocio_grant` — a `comp` (hand-granted, permanent) or a dated `one_time` grant (a yearly payment, or
 *      a promoter package), which lapses ON READ, exactly like the custom-domain grant;
 *   2. an active monthly Negocio subscription in Medusa Commerce (read by `lib/plan-server.ts`);
 *   3. `metadata.negocio_trial` — the dated trial, stamped once;
 *   4. `metadata.tienda_grant` — a dated `one_time` grant, the same shape as Negocio's (never a `comp`);
 *   5. an active monthly Tienda subscription in Medusa Commerce;
 *   6. `metadata.plan_legacy` — the marker `scripts/mark-plan-legacy.ts` writes on every shop that already existed.
 *
 * Precedence (plan-tienda README D4):
 *   Negocio (comp › live dated grant › subscription) › a live trial › Tienda (live dated grant › subscription)
 *   › legacy Gratis › unpaid.
 *
 * THREE states for a shop with no live plan, never two:
 *   - `gratis`  — it carries the legacy marker (reason `legacy`, or `trial_ended` after its trial);
 *   - `unpaid`  — every fact was READ and none is live, and there is no marker (reason `unpaid`). This is the only
 *                 state the pause job (sprint 3) may act on;
 *   - could not look — a subscription lookup failed and nothing that WAS read is live. Reported as
 *                 `{ plan: 'gratis', reason: 'unavailable' }` for EVERY shop, legacy or not. Why `gratis` and not
 *                 `unpaid`: "I could not check" must never read as "there is none". Under the name `gratis` every gate
 *                 already fails closed to the lower allowance and opens nothing, and no code that asks
 *                 `plan === 'unpaid'` can ever pause a shop whose subscription merely could not be read. The reason
 *                 `unavailable` is what tells it apart from a real legacy shop (callers that must not act on a
 *                 guess — the checkout, the notices, the slug cache — already test for it).
 *   A fact that WAS read and is live always wins over a failed lookup: a live trial or a live Tienda grant is
 *   reported as such even when the Negocio subscription could not be read (the shop is at least that).
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
export const TIENDA_GRANT_KEY = 'tienda_grant'
export const NEGOCIO_TRIAL_KEY = 'negocio_trial'
export const PLAN_LEGACY_KEY = 'plan_legacy'

/** The two metadata keys that hold a dated plan grant. The grant readers and builders below take one of them. */
export type PlanGrantKey = typeof NEGOCIO_GRANT_KEY | typeof TIENDA_GRANT_KEY

// There is deliberately NO cutoff date in this module (PR #484 review). Whether a shop is legacy is decided by the
// MARKER and nothing else: `derivePlan` never compares a date. The instant that separates "existed before" from
// "opened after" is an argument of the one run that writes the markers (`scripts/mark-plan-legacy.ts --cutoff`),
// chosen by a person on the day it runs. A constant here would have to be guessed before that day, and a wrong
// guess leaves the shops opened in between unmarked — and unmarked is what gets a shop paused.

/** `gratis` is LEGACY Plan Gratis only. `unpaid` is a shop with no live plan and no legacy marker (README D1). */
export type PlanName = 'gratis' | 'trial' | 'tienda' | 'negocio' | 'unpaid'

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

/** A dated plan grant. Tienda's is the same shape as Negocio's, `one_time` only (README D3). */
export type PlanGrant = NegocioGrant

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
  | 'subscription' // a live monthly Negocio subscription
  | 'trial' // the Negocio trial, still running
  | 'tienda_one_time' // a dated Tienda grant still within its term
  | 'tienda_subscription' // a live monthly Tienda subscription
  | 'trial_ended' // legacy Gratis, after a trial that has ended
  | 'legacy' // legacy Gratis, never trialed (this replaced `none`: Gratis with no marker no longer exists)
  | 'unpaid' // no live plan and no legacy marker, with every fact read
  | 'unavailable' // Gratis for gating, but a subscription could not be read: "could not look" ≠ "none", and never `unpaid`

/** The legacy marker's value (README D2). */
export type PlanLegacy = { marked_at: string }

/**
 * What a shop's metadata says about the legacy marker. Three states, never two:
 *   `marked`     — a well-formed marker;
 *   `absent`     — no key, or JSON null (nothing was ever written, or it was cleared on purpose);
 *   `unreadable` — SOMETHING is under the key but it is not a well-formed marker (or the metadata itself is not an
 *                  object). We cannot tell what was meant.
 */
export type PlanLegacyState = 'marked' | 'absent' | 'unreadable'

export type PlanState = {
  plan: PlanName
  reason: PlanReason
  /** When the current plan ends (a dated grant or the trial), or null (comp, subscription, Gratis, unpaid). */
  endsAt: string | null
}

// ── Parsing (defensive: a corrupt value never grants) ─────────────────────────

function isIso(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && Number.isFinite(Date.parse(value))
}

/**
 * The dated-grant reader, shared by both plans (README D3: nothing is copied). Returns the grant under `key`, or null
 * for a missing / malformed / unknown-type value. A `one_time` grant without a valid `expires_at` is rejected, so a
 * half-written dated grant can never entitle forever.
 */
export function readPlanGrant(metadata: unknown, key: PlanGrantKey): PlanGrant | null {
  if (!metadata || typeof metadata !== 'object') return null
  const raw = (metadata as Record<string, unknown>)[key]
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

/** The Negocio grant on a shop's metadata, or null (see `readPlanGrant`). */
export function readNegocioGrant(metadata: unknown): NegocioGrant | null {
  return readPlanGrant(metadata, NEGOCIO_GRANT_KEY)
}

/** The Tienda grant on a shop's metadata, or null. Tienda has no `comp` (README D3): a `comp` written under the
 *  Tienda key is refused like any other malformed value, so it can never entitle a shop forever. */
export function readTiendaGrant(metadata: unknown): PlanGrant | null {
  const grant = readPlanGrant(metadata, TIENDA_GRANT_KEY)
  return grant?.type === 'one_time' ? grant : null
}

/** True while a dated grant is within its term. A `comp` is not "dated": it never ends and is asked about by type. */
export function isLiveDatedGrant(grant: PlanGrant | null, now: Date): grant is PlanGrant & { expires_at: string } {
  return grant?.type === 'one_time' && !!grant.expires_at && Date.parse(grant.expires_at) > now.getTime()
}

/** The well-formed legacy marker on a shop's metadata, or null. STRICT: a malformed value is not a marker (the
 *  marking script and the admin must not present garbage as a real `marked_at`). To DECIDE a plan, use
 *  `readPlanLegacyState`, which keeps "malformed" apart from "absent". */
export function readPlanLegacy(metadata: unknown): PlanLegacy | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const raw = (metadata as Record<string, unknown>)[PLAN_LEGACY_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const marked = (raw as Record<string, unknown>).marked_at
  return isIso(marked) ? { marked_at: marked } : null
}

/**
 * Marked, absent or unreadable (see `PlanLegacyState`).
 *
 * WHY "unreadable" is its own state, and which way it fails: the marker is what keeps an old shop from being paused.
 * Only service-role tooling can write this key, so a value that is present but malformed is far more likely a
 * damaged marker on an old shop than a stray write on a new one. The two possible mistakes are not equal: calling a
 * damaged marker "absent" would make an old shop `unpaid` and get it PAUSED, breaking the promise the pricing page
 * made; calling it legacy lets, at worst, one shop keep Plan Gratis until a person looks. So `derivePlan` treats
 * `unreadable` as legacy (never `unpaid`), the marking script counts it and never overwrites it, and the pause job
 * (sprint 3) must additionally leave an `unreadable` shop alone.
 */
export function readPlanLegacyState(metadata: unknown): PlanLegacyState {
  if (metadata === null || metadata === undefined) return 'absent'
  if (typeof metadata !== 'object' || Array.isArray(metadata)) return 'unreadable'
  const meta = metadata as Record<string, unknown>
  if (!(PLAN_LEGACY_KEY in meta) || meta[PLAN_LEGACY_KEY] === null) return 'absent'
  return readPlanLegacy(metadata) ? 'marked' : 'unreadable'
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

/** A dated grant: `months` calendar months from `now` (12 for a yearly payment, 3 for Arranque). The shape carries no
 *  plan: which plan it grants is decided by the metadata key it is written under, so Tienda uses this same builder. */
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

/** The same builder under its plan-neutral name (README D3). */
export const buildPlanOneTimeGrant = buildNegocioOneTimeGrant

/** The legacy marker `scripts/mark-plan-legacy.ts` writes. */
export function buildPlanLegacy(now: Date = new Date()): PlanLegacy {
  return { marked_at: now.toISOString() }
}

/** The Negocio trial starting `now`, `NEGOCIO_TRIAL_DAYS` long. */
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
  opts?: { now?: Date; note?: string; paymentId?: string; startAfter?: Date | null },
): NegocioGrant {
  const now = opts?.now ?? new Date()
  if (current?.type === 'comp') return current // permanent already; a payment cannot shorten or replace it
  // The paid months start at the LATEST of: now, the end of a live paid term (a renewal adds on), and `startAfter`
  // (the end of a live free trial). Paying during the trial never throws the remaining free days away.
  const starts = [now.getTime(), isLiveDatedGrant(current, now) ? Date.parse(current.expires_at) : 0, opts?.startAfter ? opts.startAfter.getTime() : 0]
  const from = new Date(Math.max(...starts))
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

/** The same extender under its plan-neutral name (README D3): the grant's plan is the key it is written under. */
export const extendPlanGrant = extendNegocioGrant

/** A second key written in the SAME statement as the grant (README D4: Tienda time under Negocio). */
export type MetadataCompanionWrite = { key: PlanGrantKey; value: PlanGrant }

/** A guard that names its key: one element of `merge_shop_metadata_guards`' `p_guards`. */
export type KeyedMetadataGuard = { key: string } & MetadataGuard

/** The guard for `key`, matching what was READ there (`guardFor`), carrying the key's name. */
export function keyedGuardFor(metadata: unknown, key: string): KeyedMetadataGuard {
  return { key, ...guardFor(metadata, key) }
}

/**
 * The three keys a plan payment reads to decide: both grants, and the trial. EVERY grant write guards all three, as
 * read (PR #484 review). Guarding only the key being paid for is not enough, because the decision depends on the
 * other two:
 *   - A Negocio payment moves a live Tienda grant forward and writes that moved value. If a Tienda payment landed
 *     between the read and the write, the stale value would overwrite it and erase months somebody paid for. And if
 *     the shop had NO Tienda grant at the read, a Tienda payment landing in between would simply not be moved, and
 *     would run out underneath the new Negocio months.
 *   - A Tienda payment starts after a live trial and a live Negocio grant. If either appeared, or grew, between the
 *     read and the write, the Tienda months would start too early and be spent underneath it.
 * With all three guarded in the one UPDATE, the later writer matches no row, re-reads and decides from the truth.
 * The cost is a retry when something unrelated to the dates touches a key in that instant (a trial notice stamping
 * `notified_*_at`): harmless, the caller already loops.
 */
const PLAN_PAYMENT_READS = [NEGOCIO_GRANT_KEY, TIENDA_GRANT_KEY, NEGOCIO_TRIAL_KEY] as const

/** The guards for a grant write: the paid plan's key FIRST (so `guards[0]` is `guard`), then the other keys read. */
function planPaymentGuards(metadata: unknown, paidKey: PlanGrantKey): KeyedMetadataGuard[] {
  return [paidKey, ...PLAN_PAYMENT_READS.filter((k) => k !== paidKey)].map((k) => keyedGuardFor(metadata, k))
}

export type PlanGrantWrite = {
  action: 'write'
  grant: PlanGrant
  /** The guard on the PAID plan's key, as read. Kept for readers of the decision; what is WRITTEN is `guards`. */
  guard: MetadataGuard
  /** Every guard the write must satisfy, all in one statement: the paid key (first), the other plan's grant and the
   *  trial, each exactly as read — see `PLAN_PAYMENT_READS`. */
  guards: KeyedMetadataGuard[]
  /**
   * Present only when a dated Negocio grant is written for a shop holding a live Tienda grant: the Tienda grant moved
   * forward, merged in the SAME call as `grant` — both keys land or neither does. The Tienda key is among `guards`,
   * so the moved value can only replace the exact value it was computed from.
   */
  also?: MetadataCompanionWrite
}

export type NegocioPaymentDecision =
  | { action: 'replay' } // this payment id was already counted: write nothing
  | { action: 'comp' } // the shop holds a permanent Negocio: nothing to extend (the payment is still recorded by the caller)
  | PlanGrantWrite

export type TiendaPaymentDecision = { action: 'replay' } | PlanGrantWrite

export type PlanPayment = { paymentId: string; months: number; now?: Date; note?: string }

/** The end of the shop's trial while it is still running, or null. */
function liveTrialEnd(metadata: unknown, now: Date): Date | null {
  const trial = readNegocioTrial(metadata)
  return trial && Date.parse(trial.expires_at) > now.getTime() ? new Date(trial.expires_at) : null
}

/**
 * The plan-neutral core of a paid one-time payment: the replay rule, "add after the current end" and "start after
 * `startAfter`", with guards that match exactly what was read (`planPaymentGuards`). Both plans decide through this;
 * neither restates it.
 */
function decideGrantPayment(
  metadata: unknown,
  key: PlanGrantKey,
  current: PlanGrant | null,
  payment: PlanPayment,
  startAfter: Date | null,
): { action: 'replay' } | { action: 'write'; grant: PlanGrant; guard: MetadataGuard; guards: KeyedMetadataGuard[] } {
  if (current?.payments?.includes(payment.paymentId)) return { action: 'replay' }
  const now = payment.now ?? new Date()
  return {
    action: 'write',
    grant: extendNegocioGrant(current, payment.months, { now, note: payment.note, paymentId: payment.paymentId, startAfter }),
    guard: guardFor(metadata, key),
    guards: planPaymentGuards(metadata, key),
  }
}

/**
 * What a paid one-time Negocio payment (a yearly payment, a promoter package) writes to the shop. Pure, so the replay
 * rule and the "add after the current end" rule are tested without Stripe. `guard` matches exactly what was read
 * (`guardFor`): if anything changed the grant between the read and the write, the write does nothing and the caller
 * re-reads.
 *
 * Tienda time under Negocio (plan-tienda README D4): a shop that holds a LIVE dated Tienda grant does not lose it by
 * moving up. Negocio outranks Tienda, so for the months just granted the Tienda grant would otherwise run out
 * unused; its end is therefore moved forward by exactly those months (`also`), in the same write. The write guards the
 * Tienda key as read whether or not there is anything to move (`PLAN_PAYMENT_READS`), so a Tienda payment landing
 * in between is never overwritten and never left unmoved. A lapsed Tienda
 * grant is not revived, and a replay moves nothing (the replay is decided on the Negocio grant, which the same
 * statement wrote). Under a MONTHLY Negocio subscription nothing here runs, so the Tienda clock keeps going: the
 * months are not known in advance (the documented deviation in D4).
 */
export function decideNegocioPayment(metadata: unknown, payment: PlanPayment): NegocioPaymentDecision {
  const current = readNegocioGrant(metadata)
  if (current?.payments?.includes(payment.paymentId)) return { action: 'replay' }
  if (current?.type === 'comp') return { action: 'comp' }
  const now = payment.now ?? new Date()
  const decision = decideGrantPayment(metadata, NEGOCIO_GRANT_KEY, current, payment, liveTrialEnd(metadata, now))
  if (decision.action !== 'write') return decision
  const tienda = readTiendaGrant(metadata)
  if (!isLiveDatedGrant(tienda, now)) return decision
  return {
    ...decision,
    also: {
      key: TIENDA_GRANT_KEY,
      value: { ...tienda, expires_at: addMonthsClamped(new Date(tienda.expires_at), payment.months).toISOString() },
    },
  }
}

/**
 * What a paid one-time Tienda payment writes to the shop: the same replay rule and the same "add after the current
 * end", under the Tienda key. The paid months start after whatever already outranks Tienda and has a known end — a
 * live trial, or a live dated Negocio grant — so they are never spent underneath it. (This is the mirror of the
 * shift in `decideNegocioPayment`: whichever of the two grants is written second, the Tienda months end up after
 * Negocio's.) A permanent Negocio has no end to wait for, so it moves nothing.
 *
 * The start is chosen from the trial and the Negocio grant, so the write guards BOTH as read, beside the Tienda key
 * (`PLAN_PAYMENT_READS`). A stale start is not harmless: a Negocio grant landing between this read and this write
 * would leave the Tienda months starting today, underneath it, and the merchant would lose them.
 */
export function decideTiendaPayment(metadata: unknown, payment: PlanPayment): TiendaPaymentDecision {
  const now = payment.now ?? new Date()
  const negocio = readNegocioGrant(metadata)
  const waits = [liveTrialEnd(metadata, now)?.getTime() ?? 0, isLiveDatedGrant(negocio, now) ? Date.parse(negocio.expires_at) : 0]
  const startAfter = Math.max(...waits)
  return decideGrantPayment(metadata, TIENDA_GRANT_KEY, readTiendaGrant(metadata), payment, startAfter > 0 ? new Date(startAfter) : null)
}

/** The Postgres function every plan-grant write goes through (migration 20261110000000). */
export const GRANT_WRITE_RPC = 'merge_shop_metadata_guards'

export type GrantWriteRpcGuard = { key: string; mode: 'absent' | 'json_null' } | { key: string; mode: 'equals'; expected: unknown }

export type GrantWriteRpcArgs = { p_shop_id: string; p_patch: Record<string, PlanGrant>; p_guards: GrantWriteRpcGuard[] }

/**
 * The exact `merge_shop_metadata_guards` arguments for a decided grant write — ONE statement that merges the paid
 * plan's grant and, when present, the companion key, and lands only if EVERY guard still holds. Pure, so "both keys
 * in one patch, every key that was read guarded" is asserted without a database.
 *
 * Every grant write uses this function, also the ones that write a single key. Not "the old function when there is
 * nothing to move": whether there is a Tienda grant to move is exactly the thing that can change between the read and
 * the write, so the single-key write needs the Tienda guard as much as the two-key one. One path also means one thing
 * to test. The price is that the migration must be applied BEFORE this code deploys (the epic's deploy order);
 * without it every paid grant fails loudly (the webhook alerts) rather than landing unguarded.
 *
 * `expected` is sent ONLY with `equals`: the SQL refuses an `equals` without it, and for the other modes it would be
 * noise that a reader could mistake for a comparison.
 */
export function grantWriteRpcArgs(shopId: string, key: PlanGrantKey, write: PlanGrantWrite): GrantWriteRpcArgs {
  // A decision whose first guard is not the paid key's was not built by `decideGrantPayment`. Refuse to write it:
  // the patch would replace a grant nothing is guarding.
  if (write.guards[0]?.key !== key) throw new Error(`grantWriteRpcArgs: the write for ${key} does not guard ${key} first`)
  if (write.also && !write.guards.some((g) => g.key === write.also!.key)) throw new Error(`grantWriteRpcArgs: ${write.also.key} is written but not guarded`)
  return {
    p_shop_id: shopId,
    p_patch: { [key]: write.grant, ...(write.also ? { [write.also.key]: write.also.value } : {}) },
    p_guards: write.guards.map((g): GrantWriteRpcGuard => (g.mode === 'equals' ? { key: g.key, mode: 'equals', expected: g.expected } : { key: g.key, mode: g.mode })),
  }
}

// ── The decision ──────────────────────────────────────────────────────────────

export type DerivePlanInput = {
  /** The Negocio grant (`readNegocioGrant`). */
  grant: NegocioGrant | null
  trial: NegocioTrial | null
  /** The Tienda grant (`readTiendaGrant`). */
  tiendaGrant: PlanGrant | null
  /** The legacy marker (`readPlanLegacyState`). REQUIRED, with no default: forgetting it must be a type error, not a
   *  silent "unpaid" (which pauses) or a silent "legacy" (which gives Plan Gratis away). */
  legacy: PlanLegacyState
  /** Negocio: true / false when Medusa Commerce answered; `undefined` when it could not be read (or was not asked). */
  hasActiveSubscription: boolean | undefined
  /** True when the Negocio subscription lookup was attempted and failed. */
  subscriptionUnavailable?: boolean
  /** Tienda: true / false when Medusa Commerce answered; `undefined` when it could not be read (or was not asked). */
  hasActiveTiendaSubscription: boolean | undefined
  /** True when the Tienda subscription lookup was attempted and failed. */
  tiendaSubscriptionUnavailable?: boolean
  now?: Date
}

export function derivePlan(input: DerivePlanInput): PlanState {
  const nowDate = input.now ?? new Date()
  const now = nowDate.getTime()
  const { grant, trial, tiendaGrant } = input

  // Negocio: comp › live dated grant › subscription.
  if (grant?.type === 'comp') return { plan: 'negocio', reason: 'comp', endsAt: null }
  if (isLiveDatedGrant(grant, nowDate)) return { plan: 'negocio', reason: 'one_time', endsAt: grant.expires_at }
  if (input.hasActiveSubscription === true) return { plan: 'negocio', reason: 'subscription', endsAt: null }
  // The trial IS Negocio for free, so it outranks a paid Tienda: the merchant gets the better of the two.
  if (trial && Date.parse(trial.expires_at) > now) return { plan: 'trial', reason: 'trial', endsAt: trial.expires_at }
  // Tienda: live dated grant › subscription.
  if (isLiveDatedGrant(tiendaGrant, nowDate)) return { plan: 'tienda', reason: 'tienda_one_time', endsAt: tiendaGrant.expires_at }
  if (input.hasActiveTiendaSubscription === true) return { plan: 'tienda', reason: 'tienda_subscription', endsAt: null }
  // Nothing that was read is live. If either lookup FAILED we do not know that nothing is — say so, under `gratis`,
  // BEFORE the legacy question: never `unpaid` (see the file header), and never a confident "legacy" either.
  if (input.subscriptionUnavailable || input.tiendaSubscriptionUnavailable) return { plan: 'gratis', reason: 'unavailable', endsAt: null }
  // Legacy Plan Gratis. `unreadable` counts as legacy on purpose — see `readPlanLegacyState`.
  if (input.legacy !== 'absent') return { plan: 'gratis', reason: trial ? 'trial_ended' : 'legacy', endsAt: null }
  return { plan: 'unpaid', reason: 'unpaid', endsAt: null }
}

/** The two subscription answers `derivePlan` needs, as `lib/plan-server.ts` reads them. */
export type PlanSubscriptionFacts = {
  hasActiveSubscription: boolean | undefined
  subscriptionUnavailable?: boolean
  hasActiveTiendaSubscription: boolean | undefined
  tiendaSubscriptionUnavailable?: boolean
}

/**
 * Must the monthly Plan Tienda subscription be looked up to decide this shop's plan? Only when nothing that outranks
 * it in `derivePlan` already decides: a Negocio comp or live dated grant, a live Negocio subscription (`true`), a live
 * trial, or a live dated Tienda grant (which outranks the Tienda subscription). Every other case — including a Negocio
 * subscription that could NOT be read (`undefined`) — needs it: a live Tienda read then wins over "could not look",
 * and an unreadable one must be reported as such. Saves the backend round trip on most reads (plan-tienda S2.2).
 */
export function tiendaLookupNeeded(metadata: unknown, hasActiveSubscription: boolean | undefined, now: Date = new Date()): boolean {
  const grant = readNegocioGrant(metadata)
  if (grant?.type === 'comp' || isLiveDatedGrant(grant, now)) return false
  if (hasActiveSubscription === true) return false
  if (liveTrialEnd(metadata, now)) return false
  if (isLiveDatedGrant(readTiendaGrant(metadata), now)) return false
  return true
}

/** Derive straight from a shop's metadata plus the subscription answers. */
export function derivePlanFromMetadata(metadata: unknown, sub: PlanSubscriptionFacts, now?: Date): PlanState {
  return derivePlan({
    grant: readNegocioGrant(metadata),
    trial: readNegocioTrial(metadata),
    tiendaGrant: readTiendaGrant(metadata),
    legacy: readPlanLegacyState(metadata),
    ...sub,
    now,
  })
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

// ── What each plan opens (plans-gratis-negocio D5, D7; plan-tienda S1.3) ─────────

/**
 * One row per plan, so adding a plan name is a TYPE ERROR here until someone decides what it opens — a new plan can
 * never fall through an `=== 'negocio'` test into "opens nothing" (or worse, into "shows nothing") unnoticed.
 *
 *   customDomain — Negocio only; never the trial (a domain is DNS work that does not undo cleanly).
 *   mlSync, checkin — Negocio and its trial.
 *   badge — the Miyagi Sánchez link at the foot of the shop comes off with Plan Negocio and its trial ONLY. It
 *           stays on Plan Tienda: "no Miyagi Sánchez link" is a Plan Negocio feature in the plan table the product
 *           owner approved on 2026-11-09, and Plan Tienda is today's Plan Gratis with a price — paying for Tienda
 *           does not remove it. It also stays on legacy Gratis and on unpaid.
 */
const PLAN_OPENS: Readonly<Record<PlanName, { customDomain: boolean; mlSync: boolean; checkin: boolean; badge: boolean }>> = Object.freeze({
  negocio: { customDomain: true, mlSync: true, checkin: true, badge: false },
  trial: { customDomain: false, mlSync: true, checkin: true, badge: false },
  tienda: { customDomain: false, mlSync: false, checkin: false, badge: true },
  gratis: { customDomain: false, mlSync: false, checkin: false, badge: true },
  unpaid: { customDomain: false, mlSync: false, checkin: false, badge: true },
})

/** The custom domain is Negocio only — never in the trial (a domain is DNS work that does not undo cleanly). */
export function planOpensCustomDomain(state: PlanState): boolean {
  return PLAN_OPENS[state.plan].customDomain
}

/** Mercado Libre sync is part of Negocio, and the trial includes it. */
export function planOpensMlSync(state: PlanState): boolean {
  return PLAN_OPENS[state.plan].mlSync
}

/** The Miyagi Sánchez link shows on every plan except Negocio and its trial (see `PLAN_OPENS`). */
export function planShowsBadge(state: PlanState): boolean {
  return PLAN_OPENS[state.plan].badge
}

/** Where the Gratis badge links: the home page, tagged with the shop so its referrals can be counted. */
export function badgeHref(slug: string): string {
  const campaign = encodeURIComponent(slug || 'shop')
  return `https://miyagisanchez.com/?utm_source=badge&utm_medium=shop&utm_campaign=${campaign}`
}

/** The monthly check-in is part of Negocio, and the trial includes it. */
export function planGetsCheckin(state: PlanState): boolean {
  return PLAN_OPENS[state.plan].checkin
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

// ── The legacy marking planner (plan-tienda README D2) ───────────────────────────

export type ShopForLegacyMarking = { id: string; slug: string | null; created_at: string | null; metadata: unknown }

export type LegacyMarkingDecision = {
  shopId: string
  slug: string | null
  action: 'mark' | 'skip'
  why: 'unmarked_before_cutoff' | 'already_marked' | 'created_after_cutoff' | 'unreadable'
  /** For `mark`: the guard that matches what was read — `absent`, or `json_null` when the key holds JSON null. */
  guard?: { mode: 'absent' } | { mode: 'json_null' }
}

/**
 * Which shops get the legacy marker: every row created BEFORE `cutoff` that has none, owned or not (an imported shop
 * claimed later was promised the same page). A row is never marked twice, and a row created at or after the cutoff
 * is never marked — that is what makes a rerun safe.
 * `cutoff` is REQUIRED and has no default: the caller states the instant, this function never assumes one.
 *
 * `unreadable` is its own outcome, never folded into "skip, fine": a marker we cannot parse, or a `created_at` we
 * cannot parse, is a row we could not decide. It is reported and left for a person; overwriting a value we do not
 * understand, or guessing which side of the cutoff a shop is on, are both how a promise gets broken quietly.
 */
export function planLegacyMarking(shops: readonly ShopForLegacyMarking[], cutoff: string): LegacyMarkingDecision[] {
  const cutoffMs = Date.parse(cutoff)
  if (!Number.isFinite(cutoffMs)) throw new Error(`planLegacyMarking: the cutoff is not a date (got ${cutoff})`)
  return shops.map((s) => {
    const base = { shopId: s.id, slug: s.slug }
    const state = readPlanLegacyState(s.metadata)
    if (state === 'unreadable') return { ...base, action: 'skip', why: 'unreadable' }
    if (state === 'marked') return { ...base, action: 'skip', why: 'already_marked' }
    if (!isIso(s.created_at)) return { ...base, action: 'skip', why: 'unreadable' }
    if (Date.parse(s.created_at) >= cutoffMs) return { ...base, action: 'skip', why: 'created_after_cutoff' }
    const guard = guardFor(s.metadata, PLAN_LEGACY_KEY)
    // `absent` state means the key is missing or JSON null, so the guard can only be one of those two.
    if (guard.mode === 'equals') return { ...base, action: 'skip', why: 'unreadable' }
    return { ...base, action: 'mark', why: 'unmarked_before_cutoff', guard }
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
