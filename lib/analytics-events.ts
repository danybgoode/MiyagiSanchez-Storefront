/**
 * lib/analytics-events.ts
 *
 * The first reusable custom-event pusher into the GTM `dataLayer` bootstrapped
 * by `<SiteAnalytics>` (site-wide-analytics-gtm epic) — that epic only shipped
 * the container-load bootstrap, no event API, so this is new rather than reuse.
 * Respects the same eligibility gate (`shouldLoadAnalytics`) the container
 * itself loads under, so an event never fires on a surface where GTM was never
 * injected in the first place (white-label channels, embed widget).
 *
 * `dedupeKey`, when given, makes an event fire at most once per browser via
 * `localStorage` — for "did this happen at all" signals (a step's first
 * completion, a first share tap) where a reload/refresh would otherwise
 * re-fire it every time the now-true state re-renders.
 */

import { shouldLoadAnalytics } from './analytics-gating'
import { forwardToMetaPixel } from './meta-pixel'

const DEDUPE_PREFIX = 'miyagi_evt_'

export function pushAnalyticsEvent(
  name: string,
  params: Record<string, unknown> = {},
  options?: { dedupeKey?: string },
): void {
  if (typeof window === 'undefined') return
  if (!shouldLoadAnalytics({ hostname: window.location.hostname, pathname: window.location.pathname })) return

  if (options?.dedupeKey) {
    const storageKey = `${DEDUPE_PREFIX}${options.dedupeKey}`
    try {
      if (window.localStorage.getItem(storageKey)) return
      window.localStorage.setItem(storageKey, '1')
    } catch {
      // localStorage blocked (private mode / disabled) — fire anyway, worst
      // case is a duplicate event rather than a silently lost one.
    }
  }

  window.dataLayer = window.dataLayer || []
  window.dataLayer.push({ event: name, ...params })
  // The few funnel steps paid campaigns optimise on also reach the Meta Pixel (an allow-list, name only — see
  // lib/meta-pixel.ts). A no-op wherever the Pixel is not loaded.
  forwardToMetaPixel(name, window.fbq)
}
