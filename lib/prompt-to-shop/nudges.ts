/**
 * Prompt-to-shop — the day 1 / 3 / 7 nudges (epic S5.4). Pure: the clock, the reads, the write and the send are
 * injected, so the spec drives the real decision and the real cron order.
 *
 * WHO. A draft that was KEPT (claimed, and its shop created) and whose shop is still not public. The day is counted
 * from the keep (`claimed_at`). An unclaimed draft is never nudged: the only address one could have is the one typed
 * into «Mándame el enlace», and S3 sends that email without storing it (`mail-link.ts`), so there is nothing to nudge
 * and nowhere to send it. Storing it would need a migration and a consent decision; neither is this story.
 *
 * WHEN. On day 1, 3 and 7 after the keep, each at most once, and nothing after day 7 or once the shop is public. A
 * cron that missed a run does not catch up on a stale milestone: on day 3 the day-3 nudge goes, the day-1 one is
 * never sent late. A shop whose state could not be read is not nudged — a reminder to finish a shop that may already
 * be finished is worse than a reminder that comes one run later.
 *
 * WHAT. The ONE next step, read from the same `getSetupSteps` the checklist shows (D17): the first step not done,
 * or «Publicar» when all five are.
 *
 * ONCE. Which nudges went is recorded on the draft itself, under `block_status.nudges` (`{ "1": iso, … }`), next to
 * S4's `photo_confirms` — no migration. The record is CLAIMED before the send (a conditional write that reads back
 * the row it changed); a lost claim sends nothing. At most once beats at least once for a reminder: a failed send is
 * one reminder fewer, a double claim would be two of the same.
 *
 * HOW. Through `dispatchToSeller` and the new `onboarding` preference group (D19), so the merchant's channel choices
 * hold. A merchant who switched every onboarding channel off is skipped before the claim, so turning a channel back
 * on later still finds the milestone unspent.
 */

import { timingSafeEqual } from 'node:crypto'
import { CHANNELS, isChannelEnabled, resolvePrefs, type PrefRow } from '../notifications/preferences'
import type { SetupStep, SetupStepId } from '../setup-guide'

export const NUDGE_DAYS = [1, 3, 7] as const
export type NudgeDay = (typeof NUDGE_DAYS)[number]
/** The window closes at the end of day 7. */
export const NUDGE_WINDOW_DAYS = 8
const DAY_MS = 24 * 60 * 60 * 1000

/** The one step a nudge names: a checklist step, or «Publicar» once all five are done. */
export type NudgeStep = SetupStepId | 'publicar'

export interface NudgeCandidate {
  draftId: string
  /** The shop's name as the draft holds it, for the message. */
  shopName: string
  /** The Clerk user who kept it; null for a draft nobody kept. */
  claimedBy: string | null
  claimedAt: string | null
  /** Only an unclaimed draft could carry one, and S3 stores none. Kept on the type so the rule is stated in code. */
  email: string | null
  /** `block_status.nudges`, as read. */
  sent: Partial<Record<string, string>>
  /** Has the shop any public product? `null` = could not tell. */
  published: boolean | null
  /** The checklist for this shop (`getSetupSteps`). `null` = could not read it. */
  steps: SetupStep[] | null
  /** The merchant's `notification_preferences` rows. `null` = could not read them. */
  prefs: PrefRow[] | null
}

export type SkipReason =
  | 'not_kept'
  | 'too_early'
  | 'past_day_7'
  | 'published'
  | 'already_sent'
  | 'state_unavailable'
  | 'opted_out'

export type NudgeDecision =
  | { draftId: string; send: { day: NudgeDay; clerkUserId: string; step: NudgeStep; shopName: string } }
  | { draftId: string; skip: SkipReason }

/** Whole days since the keep. */
export function daysSince(claimedAt: string, now: Date): number | null {
  const t = Date.parse(claimedAt)
  if (!Number.isFinite(t)) return null
  return Math.floor((now.getTime() - t) / DAY_MS)
}

/** The milestone due at `days` after the keep: the latest of 1/3/7 reached, or null before day 1 / after day 7. */
export function dueDay(days: number): NudgeDay | null {
  if (days < 1 || days >= NUDGE_WINDOW_DAYS) return null
  let due: NudgeDay | null = null
  for (const d of NUDGE_DAYS) if (days >= d) due = d
  return due
}

/** The first checklist step not done, else «Publicar». `null` when the checklist did not load (`[]`). */
export function nextNudgeStep(steps: SetupStep[]): NudgeStep | null {
  if (steps.length === 0) return null
  return steps.find((s) => !s.done)?.id ?? 'publicar'
}

/** Would `dispatchToSeller` reach this merchant on any channel for the onboarding group? */
export function onboardingReachable(rows: PrefRow[]): boolean {
  const prefs = resolvePrefs(rows)
  return CHANNELS.some((ch) => isChannelEnabled(prefs, 'onboarding', ch))
}

function decide(c: NudgeCandidate, now: Date): NudgeDecision {
  const skip = (reason: SkipReason): NudgeDecision => ({ draftId: c.draftId, skip: reason })
  if (!c.claimedBy || !c.claimedAt) return skip('not_kept')
  const days = daysSince(c.claimedAt, now)
  if (days === null) return skip('state_unavailable')
  if (days >= NUDGE_WINDOW_DAYS) return skip('past_day_7')
  const day = dueDay(days)
  if (day === null) return skip('too_early')
  if (c.published === null) return skip('state_unavailable')
  if (c.published) return skip('published')
  // A later milestone already sent covers this one too: never step backwards.
  if (NUDGE_DAYS.some((d) => d >= day && c.sent[String(d)])) return skip('already_sent')
  if (c.steps === null) return skip('state_unavailable')
  const step = nextNudgeStep(c.steps)
  if (step === null) return skip('state_unavailable')
  if (c.prefs === null) return skip('state_unavailable')
  if (!onboardingReachable(c.prefs)) return skip('opted_out')
  return { draftId: c.draftId, send: { day, clerkUserId: c.claimedBy, step, shopName: c.shopName } }
}

/** One decision per candidate, in the order given. */
export function selectNudges(now: Date, candidates: NudgeCandidate[]): NudgeDecision[] {
  return candidates.map((c) => decide(c, now))
}

/**
 * `block_status` with this milestone recorded, every other key untouched (S4's `photo_confirms`, the per-block
 * statuses). `null` when it is already recorded — the claim was lost to another run.
 */
export function withNudge(blockStatus: unknown, day: NudgeDay, at: string): Record<string, unknown> | null {
  const current = blockStatus && typeof blockStatus === 'object' && !Array.isArray(blockStatus) ? (blockStatus as Record<string, unknown>) : {}
  const raw = current.nudges
  const nudges = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  if (nudges[String(day)]) return null
  return { ...current, nudges: { ...nudges, [String(day)]: at } }
}

/** `block_status.nudges` as the selection reads it. */
export function sentNudges(blockStatus: unknown): Partial<Record<string, string>> {
  const raw = blockStatus && typeof blockStatus === 'object' ? (blockStatus as Record<string, unknown>).nudges : null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Partial<Record<string, string>> = {}
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v) out[k] = v
  return out
}

// ── The cron run ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface NudgeCronDeps {
  /** Every kept draft in the window, with its shop's state. `null` = the read failed. */
  loadCandidates: (now: Date) => Promise<NudgeCandidate[] | null>
  /** Record the milestone on the draft, conditionally. true = this run owns the send. */
  claim: (draftId: string, day: NudgeDay, at: string) => Promise<boolean>
  send: (n: { draftId: string; clerkUserId: string; day: NudgeDay; step: NudgeStep; shopName: string }) => Promise<void>
  now: () => Date
  log: (line: Record<string, unknown>) => void
}

export type NudgeCronBody =
  | { ok: true; candidates: number; sent: number; lost: number; failed: number; skipped: Partial<Record<SkipReason, number>> }
  | { ok: false; error: 'unauthorized' | 'unavailable' }

/**
 * The cron secret, compared in constant time. Header ONLY: a `?secret=` query string is written into every access
 * log on the way in, so this route never reads one (the VM's `miyagi-cron@.service` sends the header). An unset or
 * empty `CRON_SECRET` refuses everything; unequal lengths refuse before the comparison, which needs equal buffers.
 */
export function cronSecretMatches(header: string | null, expected: string | undefined): boolean {
  if (!expected || !header) return false
  const a = Buffer.from(header, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Order: authorise → read → decide → for each send, claim THEN send. Nothing is read before the secret is checked,
 * and nothing is sent that was not claimed first.
 *
 * A send that throws is caught for THAT candidate, logged and counted as `failed`, and the run carries on: one bad
 * address must not cost every later merchant their reminder. The claim is deliberately NOT released on failure —
 * never-twice beats at-least-once for a reminder, and a release that raced a retried run could send it twice.
 */
export async function runNudgeCron(
  input: { secretHeader: string | null; cronSecret: string | undefined },
  deps: NudgeCronDeps,
): Promise<{ status: number; body: NudgeCronBody }> {
  if (!cronSecretMatches(input.secretHeader, input.cronSecret)) return { status: 401, body: { ok: false, error: 'unauthorized' } }

  const now = deps.now()
  const candidates = await deps.loadCandidates(now)
  // The read failed: say so with a failing status. An empty 200 here would read as "nobody needed a nudge".
  if (!candidates) return { status: 503, body: { ok: false, error: 'unavailable' } }

  const skipped: Partial<Record<SkipReason, number>> = {}
  let sent = 0
  let lost = 0
  let failed = 0
  for (const d of selectNudges(now, candidates)) {
    if ('skip' in d) {
      skipped[d.skip] = (skipped[d.skip] ?? 0) + 1
      continue
    }
    if (!(await deps.claim(d.draftId, d.send.day, now.toISOString()))) {
      lost++
      continue
    }
    try {
      await deps.send({ draftId: d.draftId, ...d.send })
      sent++
    } catch (e) {
      failed++
      deps.log({ step: 'nudge_failed', draft_id: d.draftId, day: d.send.day, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { status: 200, body: { ok: true, candidates: candidates.length, sent, lost, failed, skipped } }
}
