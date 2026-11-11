/**
 * lib/event-status.ts — the public state of an event page, pure and next-free.
 *
 * One derivation for /e/[slug] and the PDP of a free Evento (merchant-panel-gaps S2.1, D6), so the two
 * can never disagree about whether registration is open. Kept out of lib/events.ts, which is
 * `server-only` and so cannot be loaded by a Playwright `api` spec.
 */
import type { MarketplaceEvent, MarketplaceEventStats } from './events-types'

export type EventPublicStatus = 'open' | 'cancelled' | 'ended' | 'full'

export function eventPublicStatus(
  event: Pick<MarketplaceEvent, 'status' | 'starts_at'>,
  stats: Pick<MarketplaceEventStats, 'full'>,
  now = new Date(),
): EventPublicStatus {
  if (event.status === 'cancelled') return 'cancelled'
  if (stats.full) return 'full'
  const open = event.status === 'active' && new Date(event.starts_at).getTime() > now.getTime()
  return open ? 'open' : 'ended'
}
