/**
 * The monthly check-in (business-infrastructure S3.4, D12): once a month, each merchant with a plan hears whether last
 * month's sales reached it, and the one thing to do next.
 *
 * Runs DAILY (the VM timer), sends at most once per merchant per month, only in the first `CHECKIN_WINDOW_DAYS` of the
 * month: a ledger that could not be read on the 1st is tried again on the 2nd, never skipped for the month and never
 * reported as zero sales.
 *
 * Order: authorise → read → decide → for each send, claim THEN send (claim = a conditional write of
 * `last_checkin_period`, read back). A failed read answers 503, never an empty 200 (the timer's log must show a run
 * that could not look, not a run that found nobody). Every effect is injected; the spec drives the real function.
 */

import type { ProfitEvent, ProfitOrderInfo } from '../profit'
import { computePlan, type Move, type Plan } from './engine'
import { activeOffers, readInputs } from './model'

/** Send in the first week: late enough to retry a failed read, early enough to still be "last month". */
export const CHECKIN_WINDOW_DAYS = 7

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']

/** The month a check-in on `now` reports on: the previous calendar month (UTC), as 'YYYY-MM'. */
export function reportedPeriod(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export function monthName(period: string): string {
  return MONTHS_ES[Number(period.slice(5, 7)) - 1] ?? period
}

/**
 * MXN units sold in `period` (revenue events, a line counted once). `null` = the ledger is INCOMPLETE: an in-period
 * revenue event whose order line is missing (the backend degrades to `orders: []` when its enrichment fails). That is
 * "could not tell", never zero — a confident "you sold 0" would be emailed and the month claimed (PR #468 review).
 */
export function unitsInPeriod(events: ProfitEvent[], orders: ProfitOrderInfo[], period: string): number | null {
  const qty = new Map<string, number>()
  for (const o of orders) for (const it of o.items) if (typeof it.quantity === 'number' && it.quantity > 0) qty.set(it.id, it.quantity)
  const counted = new Set<string>()
  let units = 0
  for (const e of events) {
    if (e.event_type !== 'revenue' || !e.order_line_id || (e.currency_code ?? '').toLowerCase() !== 'mxn') continue
    if (!e.captured_at.startsWith(period) || counted.has(e.order_line_id)) continue
    const q = qty.get(e.order_line_id)
    if (!q) return null
    counted.add(e.order_line_id)
    units += q
  }
  return units
}

export interface CheckinRow {
  id: string
  seller_id: string
  clerk_user_id: string
  shop_slug: string | null
  inputs: unknown
  last_checkin_period: string | null
}

export interface CheckinMessage {
  period: string
  month: string
  sold: number
  /** Null when the plan has no goal yet (then the message asks for one). */
  needed: number | null
  onTrack: boolean | null
  /** The plan's first move, if any — the one thing to do next. */
  next: Move | null
}

export type CheckinDecision =
  | { kind: 'send'; row: CheckinRow; message: CheckinMessage }
  | { kind: 'skip'; row: CheckinRow; reason: 'already_sent' | 'no_offers' | 'outside_window' }

/** Pure: whether and what to send to one merchant, given last month's units (already read). */
export function decideCheckin(row: CheckinRow, soldLastMonth: number, now: Date): CheckinDecision {
  const period = reportedPeriod(now)
  if (now.getUTCDate() > CHECKIN_WINDOW_DAYS) return { kind: 'skip', row, reason: 'outside_window' }
  if (row.last_checkin_period === period) return { kind: 'skip', row, reason: 'already_sent' }
  const inputs = readInputs(row.inputs)
  if (!activeOffers(inputs).length) return { kind: 'skip', row, reason: 'no_offers' }
  // The plan as the merchant last saw it; the comparison is with last month's REAL units, read from the ledger.
  const plan: Plan = computePlan(inputs)
  return {
    kind: 'send',
    row,
    message: {
      period,
      month: monthName(period),
      sold: soldLastMonth,
      needed: plan.needed_units,
      onTrack: plan.needed_units != null ? soldLastMonth >= plan.needed_units : null,
      next: plan.moves[0] ?? null,
    },
  }
}

export interface CheckinDeps {
  readRows: () => Promise<CheckinRow[] | null>
  /** One seller's ledger through the internal read; null = could not read (that merchant waits for tomorrow). */
  readLedger: (sellerId: string) => Promise<{ events: ProfitEvent[]; orders: ProfitOrderInfo[] } | null>
  /** Conditional `last_checkin_period = period` where it is not already, `.select()` back. True = this run owns the send. */
  claim: (rowId: string, period: string) => Promise<boolean>
  send: (row: CheckinRow, message: CheckinMessage) => Promise<void>
  /**
   * Does this shop's plan include the check-in? (plans-gratis-negocio D9: Negocio and its trial.) null = could not
   * read the plan — the merchant waits for tomorrow, counted as unavailable. Omitted (a test, an older caller): every
   * shop gets it, as before.
   */
  planIncludesCheckin?: (row: CheckinRow) => Promise<boolean | null>
  now: () => Date
  log?: (line: Record<string, unknown>) => void
}

export type CheckinCronBody =
  | { ok: true; period: string; sent: number; skipped: number; unavailable: number; failed: number }
  | { ok: false; error: 'unauthorized' | 'unavailable' }

export async function runCheckinCron(
  auth: { authorised: boolean },
  deps: CheckinDeps,
): Promise<{ status: number; body: CheckinCronBody }> {
  if (!auth.authorised) return { status: 401, body: { ok: false, error: 'unauthorized' } }
  const now = deps.now()
  const period = reportedPeriod(now)
  if (now.getUTCDate() > CHECKIN_WINDOW_DAYS) return { status: 200, body: { ok: true, period, sent: 0, skipped: 0, unavailable: 0, failed: 0 } }
  const rows = await deps.readRows()
  if (!rows) return { status: 503, body: { ok: false, error: 'unavailable' } }

  let sent = 0, skipped = 0, unavailable = 0, failed = 0, read = 0
  for (const row of rows) {
    if (row.last_checkin_period === period) { skipped += 1; continue }
    // A shop with nothing in its plan is skipped before any read: no network call, no false "unavailable".
    if (!activeOffers(readInputs(row.inputs)).length) { skipped += 1; continue }
    if (deps.planIncludesCheckin) {
      const included = await deps.planIncludesCheckin(row)
      if (included === null) { unavailable += 1; continue }
      if (!included) { skipped += 1; continue }
    }
    const ledger = await deps.readLedger(row.seller_id)
    const units = ledger ? unitsInPeriod(ledger.events, ledger.orders, period) : null
    if (units === null) { unavailable += 1; continue }
    read += 1
    const decision = decideCheckin(row, units, now)
    if (decision.kind === 'skip') { skipped += 1; continue }
    if (!(await deps.claim(row.id, period))) { skipped += 1; continue }
    try {
      await deps.send(row, decision.message)
      sent += 1
    } catch (e) {
      // The claim is NOT released: a second send next morning would be a duplicate the merchant sees twice; a missed
      // one is a gap the log names. Same trade as the prompt-to-shop nudges.
      failed += 1
      deps.log?.({ event: 'checkin_send_failed', row: row.id, error: e instanceof Error ? e.message : String(e) })
    }
  }
  // Every merchant it should have written to could not be read: a run that could not look is a 503 in the timer's
  // log, never a green day that sent nothing (AGENTS rule 5; PR #468 review — an unset internal secret looks like this).
  if (unavailable > 0 && read === 0) {
    return { status: 503, body: { ok: false, error: 'unavailable' } }
  }
  return { status: 200, body: { ok: true, period, sent, skipped, unavailable, failed } }
}
