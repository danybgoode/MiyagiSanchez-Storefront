'use client'

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { META_PIXEL_ID, shouldLoadMetaPixel, type Fbq } from '@/lib/meta-pixel'

/**
 * MetaPixel — loads the Meta Pixel next to `<SiteAnalytics>` (GTM) in the root document, for paid seller-acquisition
 * campaigns on Facebook/Instagram. Same shape as SiteAnalytics and for the same reason: the load decision is made
 * client-side from `window.location`, so the static root layout reads no request headers.
 *
 * Not a GTM tag because the GTM container is not reachable from the account that runs the ads (2026-11-17); in code it
 * is reviewed, versioned and covered by a spec.
 *
 * PageView: once on load (the snippet's own), then once per client-side navigation — the App Router changes pages
 * without a document load, so without the pathname effect every page after the landing would be invisible to Meta.
 * Funnel events reach the Pixel through `pushAnalyticsEvent` (`lib/analytics-events.ts`), not from here.
 */

declare global {
  interface Window {
    fbq?: Fbq & { callMethod?: Fbq; queue?: unknown[]; loaded?: boolean; version?: string; push?: Fbq }
    _fbq?: unknown
  }
}

const SCRIPT_ID = 'meta-pixel-loader'

function injectPixel(id: string) {
  if (document.getElementById(SCRIPT_ID)) return // already loaded (client nav / re-mount)
  // Meta's standard stub: queue calls until fbevents.js arrives and drains them.
  if (!window.fbq) {
    const n = function (...args: unknown[]) {
      if (n.callMethod) n.callMethod(...args)
      else n.queue!.push(args)
    } as NonNullable<Window['fbq']>
    n.push = n
    n.loaded = true
    n.version = '2.0'
    n.queue = []
    window.fbq = n
    if (!window._fbq) window._fbq = n
  }
  const script = document.createElement('script')
  script.id = SCRIPT_ID
  script.async = true
  script.src = 'https://connect.facebook.net/en_US/fbevents.js'
  document.head.appendChild(script)
  window.fbq!('init', id)
  window.fbq!('track', 'PageView')
}

export default function MetaPixel() {
  const pathname = usePathname()
  const loaded = useRef(false)
  const lastPath = useRef<string | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!loaded.current) {
      if (!shouldLoadMetaPixel({ hostname: window.location.hostname, pathname: window.location.pathname })) return
      injectPixel(META_PIXEL_ID)
      loaded.current = true
      lastPath.current = pathname
      return
    }
    if (pathname === lastPath.current) return
    lastPath.current = pathname
    // A navigation INTO an excluded surface (a pay link, the embed) must not report it.
    if (!shouldLoadMetaPixel({ hostname: window.location.hostname, pathname: window.location.pathname })) return
    window.fbq?.('track', 'PageView')
  }, [pathname])

  return <div data-meta-pixel="mounted" hidden suppressHydrationWarning />
}
