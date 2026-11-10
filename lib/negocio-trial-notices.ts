/**
 * The trial's two emails (epic 08 · plans-gratis-negocio S2.3, README D10): «te quedan 5 días» and «ya estás en
 * Gratis». Day 31 must never be a surprise.
 *
 * Pure decision + an injected runner, like the monthly check-in: the daily VM timer calls the same cron route, and
 * each notice is sent at most once per shop — claim THEN send, the claim being a compare-and-swap on the trial that
 * stamps `notified_5d_at` / `notified_end_at`. A paid shop gets neither. A trial that ended more than a week ago
 * (a shop that existed before this shipped, or a run that could not look) gets no «ya estás en Gratis»: a late notice
 * about a change long past reads as a mistake.
 */
import { daysLeft, type NegocioTrial, type PlanState } from './plan'

export type TrialNotice = 'five_days' | 'ended'

/** Days before the end the reminder goes out. */
export const TRIAL_REMINDER_DAYS = 5
/** How long after the end «ya estás en Gratis» may still be sent. */
export const TRIAL_ENDED_NOTICE_WINDOW_DAYS = 7

export function decideTrialNotice(trial: NegocioTrial | null, plan: PlanState, now: Date): TrialNotice | null {
  if (!trial) return null
  if (plan.plan === 'negocio') return null
  const end = Date.parse(trial.expires_at)
  if (plan.plan === 'trial') {
    const left = daysLeft(plan, now)
    return left !== null && left <= TRIAL_REMINDER_DAYS && !trial.notified_5d_at ? 'five_days' : null
  }
  // Gratis after the trial.
  if (trial.notified_end_at) return null
  if (now.getTime() < end) return null
  if (now.getTime() - end > TRIAL_ENDED_NOTICE_WINDOW_DAYS * 86_400_000) return null
  return 'ended'
}

/** The trial with the notice's timestamp set — what the claim writes. */
export function markNotified(trial: NegocioTrial, notice: TrialNotice, now: Date): NegocioTrial {
  return notice === 'five_days' ? { ...trial, notified_5d_at: now.toISOString() } : { ...trial, notified_end_at: now.toISOString() }
}

export type TrialShop = { id: string; slug: string; name: string | null; clerk_user_id: string; trial: NegocioTrial; rawTrial: unknown }

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
    const notice = decideTrialNotice(shop.trial, plan, now)
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
