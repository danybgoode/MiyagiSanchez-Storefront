/**
 * Prompt-to-shop — the ONE module that owns every allowance number (epic D6).
 *
 * Routes, refusal copy («Te quedan 2 versiones») and, later, the pricing page import these. A number retyped
 * anywhere else is a second source that drifts, so nothing else declares one.
 *
 * Pure: no I/O. The spend itself is the Postgres function `spend_p2s_generation` (one conditional write, D4); this
 * module only decides the subjects, the periods and what an RPC answer means.
 */

export const P2S_LIMITS = Object.freeze({
  /** Generations a device gets before signup. The first shop counts: after it, two are left. */
  anonVersions: 3,
  ownerVersionsPerMonth: 10,
  photosPerMonth: 20,
  /** Platform-wide generations per Mexico City day. `P2S_DAILY_BUDGET` overrides it. */
  dailyBudgetDefault: 300,
})

/** The budget resets at local midnight for the merchants it serves, not at UTC midnight. */
export const BUDGET_TIME_ZONE = 'America/Mexico_City'

export function deviceSubject(deviceId: string): string {
  return `device:${deviceId}`
}

export function userSubject(clerkUserId: string): string {
  return `user:${clerkUserId}`
}

/** `YYYY-MM-DD` in Mexico City. */
export function budgetPeriod(now: Date): string {
  // en-CA formats as YYYY-MM-DD, which is exactly the key shape.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUDGET_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

/** `YYYY-MM` in Mexico City — the period for monthly owner versions and photos. */
export function monthPeriod(now: Date): string {
  return budgetPeriod(now).slice(0, 7)
}

/**
 * The daily budget from the environment. Anything that is not a positive integer falls back to the default:
 * a typo in an env file must never mean "unlimited", and 0 would mean "closed for good", which is a decision
 * someone should make on purpose by other means, not by a malformed value.
 */
export function resolveDailyBudget(raw: string | undefined): number {
  if (raw === undefined) return P2S_LIMITS.dailyBudgetDefault
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return P2S_LIMITS.dailyBudgetDefault
  const n = Number(trimmed)
  return Number.isSafeInteger(n) && n >= 1 ? n : P2S_LIMITS.dailyBudgetDefault
}

export type SpendDecision =
  | { ok: true; versionsUsed: number; versionsLeft: number }
  | { ok: false; reason: 'allowance' | 'budget' | 'unavailable' }

/**
 * Read the `spend_p2s_generation` answer. Fails CLOSED (D5): an RPC error, a null, or any shape we do not
 * recognise is `unavailable`, never a spend. "I could not check" is not "there is room".
 */
export function decideSpend(rpc: { data: unknown; error: unknown }, cap: number = P2S_LIMITS.anonVersions): SpendDecision {
  if (rpc.error) return { ok: false, reason: 'unavailable' }
  const d = rpc.data
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, reason: 'unavailable' }
  const row = d as Record<string, unknown>
  if (row.ok === true) {
    const used = row.versions_used
    if (typeof used !== 'number' || !Number.isInteger(used) || used < 1 || used > cap) {
      return { ok: false, reason: 'unavailable' }
    }
    return { ok: true, versionsUsed: used, versionsLeft: cap - used }
  }
  if (row.ok === false && (row.reason === 'allowance' || row.reason === 'budget')) {
    return { ok: false, reason: row.reason }
  }
  return { ok: false, reason: 'unavailable' }
}

/** «Te quedan 2 versiones» — singular at one, and an explicit zero rather than an empty string. */
export function versionsLeftCopy(left: number): string {
  if (left <= 0) return 'Ya no te quedan versiones'
  return left === 1 ? 'Te queda 1 versión' : `Te quedan ${left} versiones`
}
