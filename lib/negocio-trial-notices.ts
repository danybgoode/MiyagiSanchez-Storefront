/**
 * The free months' notices (epic 08 · plans-gratis-negocio S2.3, README D10; plan-tienda-three-free-months S3.2,
 * README D8): «te quedan 15 días», «te quedan 5 días», and the end. The end of the free months is never a surprise.
 *
 * Pure decision + an injected runner, like the monthly check-in: the daily VM timer calls the same cron route, and
 * each notice is sent at most once per shop — claim THEN send, the claim being a compare-and-swap on the trial that
 * stamps `notified_15d_at` / `notified_5d_at` / `notified_end_at`. A paid shop gets none.
 *
 * Two variants, chosen by the legacy marker (`noticeVariantFor`): a LEGACY shop falls to Plan Gratis at the end; a new
 * shop is told to choose Plan Tienda or Plan Negocio, or be paused with nothing deleted. A marker that cannot be read
 * gets the legacy wording, as `derivePlan` reads it: never a pause message that may be false.
 *
 * The END notice of a new shop says «tu tienda está en pausa», so it is sent only once the pause job has CLAIMED the
 * pause (`plan_pause`, lib/plan-pause.ts) — before that, or while the job's timer is still off, the sentence would be
 * false. Its seven-day window runs from the pause, not from the trial's end, for the same reason.
 *
 * A new shop that is not KNOWN to be in Mexico gets NOTHING (plan-tienda S3.3 review): the pause job never pauses it
 * ("No United States plans"), so «elige un plan o se pausa» and «tu tienda está en pausa» would both be false, and
 * the legacy wording («pasa al Plan Gratis») would promise a plan it does not have — «Tu suscripción» reads it as
 * having none. Silence is the only sentence that is not false; when there is a plan for it, it gets its own notice.
 * An unknown market sends nothing this run and is looked at again the next day (nothing is claimed). A legacy end notice
 * that would arrive more than a week after the end (a run that could not look) is not sent: a late notice about a
 * change long past reads as a mistake.
 */
import { daysLeft, type NegocioTrial, type PlanLegacyState, type PlanState } from './plan'
import type { PlanPauseMarket } from './plan-pause'

export type TrialNotice = 'fifteen_days' | 'five_days' | 'ended'
export type TrialNoticeVariant = 'legacy' | 'pause'

/** Days before the end the reminders go out (D8). */
export const TRIAL_FIRST_REMINDER_DAYS = 15
export const TRIAL_REMINDER_DAYS = 5
/** How long after the end (legacy) or after the pause (a new shop) the end notice may still be sent. */
export const TRIAL_ENDED_NOTICE_WINDOW_DAYS = 7

/** Which wording a shop gets. Only a marker that is known ABSENT is a new shop; marked and unreadable are legacy. */
export function noticeVariantFor(legacy: PlanLegacyState): TrialNoticeVariant {
  return legacy === 'absent' ? 'pause' : 'legacy'
}

/** What the decision needs besides the trial and the plan: the marker, and the pause job's claim (lib/plan-pause.ts). */
export type TrialNoticeFacts = {
  legacy: PlanLegacyState
  /** The shop holds a `plan_pause` claim. */
  planPaused: boolean
  /** Its `paused_at`, when readable. */
  pausedAt: string | null
  /**
   * The shop's market, needed only for a new shop (a legacy shop's wording does not depend on it). For a paused shop
   * it is the market the claim recorded (`claimMarket`): a paused seller is hidden from the public read.
   */
  market: PlanPauseMarket
}

export function decideTrialNotice(trial: NegocioTrial | null, plan: PlanState, now: Date, facts: TrialNoticeFacts): TrialNotice | null {
  if (!trial) return null
  // A paid shop gets nothing; a plan that could not be read is never guessed at.
  if (plan.plan === 'negocio' || plan.plan === 'tienda' || plan.reason === 'unavailable') return null
  // A new shop outside Mexico, or whose market could not be read, gets none (see the header).
  if (noticeVariantFor(facts.legacy) === 'pause' && facts.market !== 'mx') return null
  if (plan.plan === 'trial') {
    const left = daysLeft(plan, now)
    if (left === null) return null
    // The nearer reminder wins: a run that first looks at 4 days left sends «5 días», never a late «15 días».
    if (left <= TRIAL_REMINDER_DAYS) return trial.notified_5d_at ? null : 'five_days'
    if (left <= TRIAL_FIRST_REMINDER_DAYS) return trial.notified_15d_at || trial.notified_5d_at ? null : 'fifteen_days'
    return null
  }
  if (trial.notified_end_at) return null
  const end = Date.parse(trial.expires_at)
  if (now.getTime() < end) return null
  const windowMs = TRIAL_ENDED_NOTICE_WINDOW_DAYS * 86_400_000
  if (noticeVariantFor(facts.legacy) === 'legacy') {
    // Only a shop that IS on Plan Gratis is told it is.
    if (plan.plan !== 'gratis') return null
    return now.getTime() - end > windowMs ? null : 'ended'
  }
  // A new shop: only once paused (see the header), and within a week of the pause.
  if (plan.plan !== 'unpaid' || !facts.planPaused) return null
  const from = facts.pausedAt && Number.isFinite(Date.parse(facts.pausedAt)) ? Date.parse(facts.pausedAt) : end
  return now.getTime() - from > windowMs ? null : 'ended'
}

/** The trial with the notice's timestamp set — what the claim writes. */
export function markNotified(trial: NegocioTrial, notice: TrialNotice, now: Date): NegocioTrial {
  const at = now.toISOString()
  if (notice === 'fifteen_days') return { ...trial, notified_15d_at: at }
  if (notice === 'five_days') return { ...trial, notified_5d_at: at }
  return { ...trial, notified_end_at: at }
}

export type TrialShop = {
  id: string
  slug: string
  name: string | null
  clerk_user_id: string
  trial: NegocioTrial
  rawTrial: unknown
  /** The legacy marker and the pause claim, read with the shop (they choose the variant and gate the pause notice). */
  facts: TrialNoticeFacts
}

export interface TrialNoticeDeps {
  /** Owned shops carrying a trial; null = could not read (the run reports unavailable, never "nobody"). */
  readShops: () => Promise<TrialShop[] | null>
  /** The shop's plan; null = could not read (that shop waits for tomorrow). */
  readPlan: (shop: TrialShop) => Promise<PlanState | null>
  /** Compare-and-swap the trial from `rawTrial` to `next`. True = this run owns the send. */
  claim: (shop: TrialShop, next: NegocioTrial) => Promise<boolean>
  send: (shop: TrialShop, notice: TrialNotice) => Promise<void>
  /** Undo a claim whose send FAILED (compare-and-swap `claimed` back to the trial read), so tomorrow retries it
   *  (Codex, #472). Best-effort: if it cannot release, the notice is skipped rather than sent twice. */
  release?: (shop: TrialShop, claimed: NegocioTrial) => Promise<void>
  now: () => Date
}

export type TrialNoticeRun = { ok: true; sent: number; skipped: number; unavailable: number; failed: number } | { ok: false; error: 'unavailable' }

export async function runTrialNotices(deps: TrialNoticeDeps): Promise<TrialNoticeRun> {
  const shops = await deps.readShops()
  if (!shops) return { ok: false, error: 'unavailable' }
  const now = deps.now()
  let sent = 0, skipped = 0, unavailable = 0, failed = 0
  for (const shop of shops) {
    const plan = await deps.readPlan(shop)
    if (!plan) { unavailable += 1; continue }
    const notice = decideTrialNotice(shop.trial, plan, now, shop.facts)
    if (!notice) { skipped += 1; continue }
    const claimed = markNotified(shop.trial, notice, now)
    if (!(await deps.claim(shop, claimed))) { skipped += 1; continue }
    try {
      await deps.send(shop, notice)
      sent += 1
    } catch {
      // Claimed but not sent: release the claim so tomorrow's run retries it. A release that fails leaves the
      // notice skipped — one missed email, never two.
      failed += 1
      await deps.release?.(shop, claimed).catch(() => {})
    }
  }
  return { ok: true, sent, skipped, unavailable, failed }
}
