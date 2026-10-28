/**
 * Prompt-to-shop — the funnel (epic S5.3): seven steps, each counted ONCE.
 *
 * Every event goes through `pushAnalyticsEvent` (GTM `dataLayer`), but not through its `dedupeKey`: that one is
 * localStorage only and fires anyway when storage is blocked ("a duplicate rather than a lost event"), which is the
 * right trade for a "did this happen at all" signal and the wrong one for a funnel, where a duplicate inflates the
 * very step Daniel reads to see where merchants stop. The guard here is structural instead, two layers:
 *
 *   1. an in-memory set, for the life of the page — React's dev double-mount, a re-render with the same state, two
 *      components observing the same step: none of them can fire twice, storage or no storage;
 *   2. sessionStorage, for the tab — a reload, or a server refresh that remounts the canvas, does not re-count.
 *
 * Keyed per step AND per draft (`p2s:<event>:<draft>`), so a second shop is a second funnel. The one step that
 * happens before a draft exists — the describe box submit — is keyed to the tab (`session`).
 *
 * The decision is pure: storage and the pusher are injected, so the spec drives the real function.
 */

import { pushAnalyticsEvent } from '../analytics-events'

export const P2S_FUNNEL_EVENTS = [
  'p2s_describe_submitted',
  'p2s_preview_rendered',
  'p2s_version_requested',
  'p2s_kept',
  'p2s_real_product_added',
  'p2s_payments_connected',
  'p2s_published',
] as const
export type FunnelEvent = (typeof P2S_FUNNEL_EVENTS)[number]

/** The tab-scoped key for a step that happens before there is a draft id. */
export const SESSION_SCOPE = 'session'

export interface FunnelStorage {
  get: (key: string) => string | null
  set: (key: string, value: string) => void
}

export interface FunnelDeps {
  /** Page-lifetime memory. Shared by every caller on the page (module scope in the browser). */
  seen: Set<string>
  /** sessionStorage, or null when there is none (SSR, a blocked or throwing storage). */
  storage: FunnelStorage | null
  push: (name: string, params: Record<string, unknown>) => void
}

export function funnelKey(event: FunnelEvent, scope: string): string {
  return `p2s:${event}:${scope}`
}

/**
 * Fire `event` for `scope` unless it already fired. Returns whether it fired. The key is recorded BEFORE the push,
 * so a push that throws cannot be retried into a second count.
 */
export function fireFunnelOnce(event: FunnelEvent, scope: string, params: Record<string, unknown>, deps: FunnelDeps): boolean {
  const key = funnelKey(event, scope)
  if (deps.seen.has(key)) return false
  let stored: string | null = null
  try {
    stored = deps.storage?.get(key) ?? null
  } catch {
    stored = null
  }
  if (stored) {
    deps.seen.add(key)
    return false
  }
  deps.seen.add(key)
  try {
    deps.storage?.set(key, '1')
  } catch {
    // Storage refused the write: the in-memory set still holds this page to one count.
  }
  deps.push(event, { draft_id: scope === SESSION_SCOPE ? null : scope, ...params })
  return true
}

// ── The browser binding ──────────────────────────────────────────────────────────────────────────────────────────

const PAGE_SEEN = new Set<string>()

function browserStorage(): FunnelStorage | null {
  if (typeof window === 'undefined') return null
  try {
    const s = window.sessionStorage
    return { get: (k) => s.getItem(k), set: (k, v) => s.setItem(k, v) }
  } catch {
    return null
  }
}

/** The call components make. Safe during SSR (it does nothing there: `pushAnalyticsEvent` needs a window). */
export function trackFunnel(event: FunnelEvent, scope: string | null, params: Record<string, unknown> = {}): boolean {
  if (typeof window === 'undefined') return false
  return fireFunnelOnce(event, scope ?? SESSION_SCOPE, params, {
    seen: PAGE_SEEN,
    storage: browserStorage(),
    push: (name, p) => pushAnalyticsEvent(name, p),
  })
}
