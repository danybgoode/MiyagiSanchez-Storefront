/**
 * Offline cash queue — the state machine behind «Venta guardada» (in-person-sales S3.1, D11).
 *
 * PURE: no IndexedDB, no fetch, no clock (the caller passes `now`). The browser adapter
 * (sale-queue-idb.ts) persists `entries`; the counter sends them.
 *
 * The rules, each one a past or avoidable money bug:
 *  - client_id is minted when the sale is MADE and the payload is frozen with it, so every
 *    resend is a replay of the same sale on the server (D4), never a second order.
 *  - An entry leaves the queue ONLY when the backend returned its order (verdict 'recorded').
 *  - A network failure or a 5xx keeps the entry and backs off. Never dropped.
 *  - A DEFINITE refusal does not delete the sale either: it moves to `needs_attention`, where
 *    the merchant sees it and decides. Whether a refusal is definite is the S1 classifier's
 *    call, including its sticky rule (an entry that was ever uncertain may already exist, so
 *    only the post-claim codes can park it).
 */
import { classifySaleResponse, type SaleVerdict } from './sale-response'
import type { SaleLine } from './counter-cart'

export interface QueueEntry {
  client_id: string
  lines: SaleLine[]
  tendered_cents: number | null
  /** ISO time the sale was made, frozen at enqueue. */
  sold_at: string
  status: 'pending' | 'needs_attention'
  attempts: number
  /** Some send of this entry was uncertain, so the order may already exist (sticky rule). */
  uncertain: boolean
  next_attempt_at: number
  /** Total in centavos, for the merchant-facing list. */
  total_cents: number
  message: string | null
}

export interface SaleQueue { entries: QueueEntry[] }

export const emptyQueue = (): SaleQueue => ({ entries: [] })

const BACKOFF_BASE_MS = 2_000
const BACKOFF_MAX_MS = 5 * 60_000

/** 2 s, 4 s, 8 s ... capped at 5 min. */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1))
}

export function enqueue(
  q: SaleQueue,
  input: { client_id: string; lines: SaleLine[]; tendered_cents: number | null; total_cents: number; uncertain?: boolean },
  now: number,
): SaleQueue {
  // The same id twice is the same sale: keep the first, frozen payload.
  if (q.entries.some((e) => e.client_id === input.client_id)) return q
  const entry: QueueEntry = {
    client_id: input.client_id,
    lines: input.lines.map((l) => ({ ...l })),
    tendered_cents: input.tendered_cents,
    sold_at: new Date(now).toISOString(),
    status: 'pending',
    attempts: 0,
    uncertain: input.uncertain === true,
    next_attempt_at: now,
    total_cents: input.total_cents,
    message: null,
  }
  return { entries: [...q.entries, entry] }
}

/** The oldest pending entry that is due, or null. */
export function nextToSend(q: SaleQueue, now: number): QueueEntry | null {
  return q.entries.find((e) => e.status === 'pending' && e.next_attempt_at <= now) ?? null
}

export const pendingCount = (q: SaleQueue): number => q.entries.filter((e) => e.status === 'pending').length
export const needsAttention = (q: SaleQueue): QueueEntry[] => q.entries.filter((e) => e.status === 'needs_attention')

export interface SendResponse { status: number | null; code?: string | null; hasOrder?: boolean; message?: string | null }

/** Apply the outcome of one send. The verdict comes from the S1 classifier, never re-derived here. */
export function applyResponse(q: SaleQueue, clientId: string, res: SendResponse, now: number): { queue: SaleQueue; verdict: SaleVerdict | null } {
  const entry = q.entries.find((e) => e.client_id === clientId)
  if (!entry) return { queue: q, verdict: null }
  const verdict = classifySaleResponse({ status: res.status, code: res.code, hasOrder: res.hasOrder, hadUncertainAttempt: entry.uncertain })
  const replace = (next: QueueEntry | null): SaleQueue => ({
    entries: q.entries.flatMap((e) => (e.client_id !== clientId ? [e] : next ? [next] : [])),
  })
  if (verdict === 'recorded') return { queue: replace(null), verdict }
  if (verdict === 'refused') {
    return { queue: replace({ ...entry, status: 'needs_attention', attempts: entry.attempts + 1, message: res.message ?? 'No se pudo subir esta venta.' }), verdict }
  }
  const attempts = entry.attempts + 1
  return {
    queue: replace({ ...entry, attempts, uncertain: true, next_attempt_at: now + backoffMs(attempts), message: res.message ?? null }),
    verdict,
  }
}

/** The merchant explicitly dismissed a parked sale. The only way an entry leaves without an order. */
export function dismiss(q: SaleQueue, clientId: string): SaleQueue {
  return { entries: q.entries.filter((e) => !(e.client_id === clientId && e.status === 'needs_attention')) }
}

/** Rehydrate from storage: keep only well-formed entries (a corrupt row must not wedge the queue). */
export function sanitizeEntries(raw: unknown): QueueEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((e): e is QueueEntry =>
    !!e && typeof e.client_id === 'string' && Array.isArray(e.lines) && typeof e.sold_at === 'string' &&
    (e.status === 'pending' || e.status === 'needs_attention') && Number.isFinite(e.next_attempt_at))
}
