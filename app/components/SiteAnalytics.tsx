'use client'

import { useEffect } from 'react'
import { shouldLoadAnalytics } from '@/lib/analytics-gating'

/**
 * SiteAnalytics — the single, site-wide GTM container loader
 * (site-wide-analytics-gtm epic, S1.2). GA4 + Microsoft Clarity are configured as
 * tags INSIDE GTM (managed without a redeploy), so this component only loads the
 * one container; it ships no hardcoded measurement id.
 *
 * Mounted once in the STATIC root `app/layout.tsx`, so it covers both the `(site)`
 * and `(shell)` trees. It reads NO request headers — the load decision is made
 * client-side from `window.location` via the pure `shouldLoadAnalytics` gate — so it
 * does not opt the static `(site)` subtree into dynamic rendering
 * (marketplace-static-shell constraint).
 *
 * It renders a small, invisible marker so a Playwright `api` spec can confirm the
 * loader is mounted in the layout (the actual GTM injection is JS-only and gated, so
 * it can't be asserted from SSR HTML — that's the unit-tested gate's job).
 */

const GTM_ID = process.env.NEXT_PUBLIC_GTM_ID

declare global {
  interface Window {
    dataLayer?: Record<string, unknown>[]
  }
}

const SCRIPT_ID = 'gtm-container-loader'

function injectGtm(id: string) {
  if (document.getElementById(SCRIPT_ID)) return // already loaded (client nav / re-mount)
  window.dataLayer = window.dataLayer || []
  window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' })
  const script = document.createElement('script')
  script.id = SCRIPT_ID
  script.async = true
  script.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(id)}`
  document.head.appendChild(script)
}

// tally (~/dobby/tally, tally.goldenfrijoles.com): our own first-party analytics for the portfolio (page views, Web
// Vitals, JavaScript errors; no cookies, no IP stored). Same gate as GTM: production hosts only, the same exclusions.
const TALLY_ID = 'tally-loader'
function injectTally() {
  if (document.getElementById(TALLY_ID)) return
  const script = document.createElement('script')
  script.id = TALLY_ID
  script.defer = true
  script.src = 'https://tally.goldenfrijoles.com/t.js'
  script.dataset.site = 'miyagisanchez'
  document.head.appendChild(script)
}

export default function SiteAnalytics() {
  useEffect(() => {
    if (typeof window !== 'undefined' && shouldLoadAnalytics({ hostname: window.location.hostname, pathname: window.location.pathname })) {
      injectTally()
    }
  }, [])

  useEffect(() => {
    // No id configured (dev / preview without NEXT_PUBLIC_GTM_ID) → skip cleanly.
    if (!GTM_ID) return
    if (typeof window === 'undefined') return
    if (
      !shouldLoadAnalytics({
        hostname: window.location.hostname,
        pathname: window.location.pathname,
      })
    ) {
      return
    }
    injectGtm(GTM_ID)
  }, [])

  return <div data-site-analytics="mounted" hidden suppressHydrationWarning />
}
