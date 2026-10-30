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
 *  - A refusal parks the sale in `needs_attention` ONLY when the code means this payload can
 *    never succeed (QUEUE_PARK_CODES). Anything that a later attempt could fix — an expired
 *    session (the counter's ~60 s Clerk token is usually stale when signal returns), a shop
 *    status blip, a 5xx — is retry-later with backoff. Parking on UNAUTHENTICATED once parked a
 *    whole queue of never-recorded sales in a single pass. This is deliberately NOT the live
 *    counter's classifier: that one decides whether a client_id may be RELEASED; this one
 *    decides whether a stored sale is hopeless.
 */
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

/** Codes that can never succeed for this payload; the merchant must look at the sale. */
export const QUEUE_PARK_CODES: ReadonlySet<string> = new Set([
  'VARIANT_NOT_OWNED', 'INVALID_BODY', 'INVALID_CLIENT_ID', 'INVALID_KIND', 'INVALID_LINE', 'INVALID_QUANTITY',
  'INVALID_TENDERED', 'INVALID_SOLD_AT', 'INVALID_EMAIL', 'EMPTY_SALE', 'TOO_MANY_LINES', 'KIND_NOT_AVAILABLE',
  'OFFLINE_NOT_CASH', 'TENDERED_NOT_CASH', 'CLIENT_ID_REUSED', 'SALE_CLOSED', 'TENDERED_SHORT', 'IN_PERSON_MX_ONLY',
])

export type QueueVerdict = 'recorded' | 'parked' | 'retry'

export interface SendResponse { status: number | null; code?: string | null; hasOrder?: boolean; message?: string | null }

/** Apply the outcome of one send. The verdict comes from the S1 classifier, never re-derived here. */
export function applyResponse(q: SaleQueue, clientId: string, res: SendResponse, now: number): { queue: SaleQueue; verdict: QueueVerdict | null } {
  const entry = q.entries.find((e) => e.client_id === clientId)
  if (!entry) return { queue: q, verdict: null }
  const recorded = res.status !== null && res.status >= 200 && res.status < 300 && res.hasOrder === true
  const verdict: QueueVerdict = recorded ? 'recorded' : res.code && QUEUE_PARK_CODES.has(res.code) ? 'parked' : 'retry'
  const replace = (next: QueueEntry | null): SaleQueue => ({
    entries: q.entries.flatMap((e) => (e.client_id !== clientId ? [e] : next ? [next] : [])),
  })
  if (verdict === 'recorded') return { queue: replace(null), verdict }
  if (verdict === 'parked') {
    return { queue: replace({ ...entry, status: 'needs_attention', attempts: entry.attempts + 1, message: res.message ?? 'No se pudo subir esta venta.' }), verdict }
  }
  const attempts = entry.attempts + 1
  return {
    queue: replace({ ...entry, attempts, uncertain: true, next_attempt_at: now + backoffMs(attempts), message: res.message ?? null }),
    verdict,
  }
}

/** «Reintentar» on a parked sale: back to pending, due now. Same id, same payload. */
export function retryParked(q: SaleQueue, clientId: string, now: number): SaleQueue {
  return { entries: q.entries.map((e) => (e.client_id === clientId && e.status === 'needs_attention' ? { ...e, status: 'pending' as const, next_attempt_at: now, message: null } : e)) }
}

/** Signal is back: every pending entry is due at once (backoff grown while offline is meaningless). */
export function wakeAll(q: SaleQueue, now: number): SaleQueue {
  return { entries: q.entries.map((e) => (e.status === 'pending' ? { ...e, next_attempt_at: now } : e)) }
}

/**
 * Whether a sync pass goes on to the next entry. It stops at the first retry-later answer, and
 * when the outcome could not be stored: an entry uploaded but not removed would otherwise be
 * re-posted over and over (a safe replay on the server, but pointless load and a stuck count).
 */
export function shouldContinuePass(verdict: QueueVerdict | null, persisted: boolean): boolean {
  return persisted && verdict !== 'retry' && verdict !== null
}

/** What changed between two queues, as per-entry writes (the store is never cleared and rewritten). */
export function diffQueues(prev: SaleQueue, next: SaleQueue): { put: QueueEntry[]; remove: string[] } {
  const before = new Map(prev.entries.map((e) => [e.client_id, JSON.stringify(e)]))
  const put = next.entries.filter((e) => before.get(e.client_id) !== JSON.stringify(e))
  const keep = new Set(next.entries.map((e) => e.client_id))
  return { put, remove: prev.entries.filter((e) => !keep.has(e.client_id)).map((e) => e.client_id) }
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
