'use client'

import { useEffect, useRef } from 'react'

/**
 * Cloudflare Turnstile, rendered explicitly (prompt-to-shop D8).
 *
 * The site key arrives as a PROP from a server component: it is a runtime env (`TURNSTILE_SITE_KEY`), deliberately
 * not `NEXT_PUBLIC_*`, so it needs no Docker build arg. The script is loaded here and only here, so it is fetched
 * only on the pages that show a describe box. A token is single use, so a caller that needs another one (every
 * «Otra versión») bumps `resetKey` and the widget issues a fresh challenge.
 *
 * The app sets no Content-Security-Policy on these pages, so nothing needs allow-listing for
 * challenges.cloudflare.com; if one is ever added it needs script-src and frame-src for that origin.
 */

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
const SCRIPT_ID = 'cf-turnstile-script'

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string
  reset: (widgetId?: string) => void
  remove: (widgetId?: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

function whenTurnstileReady(cb: () => void): () => void {
  if (window.turnstile) {
    cb()
    return () => {}
  }
  let script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null
  if (!script) {
    script = document.createElement('script')
    script.id = SCRIPT_ID
    script.src = SCRIPT_SRC
    script.async = true
    script.defer = true
    document.head.appendChild(script)
  }
  script.addEventListener('load', cb)
  return () => script?.removeEventListener('load', cb)
}

export default function TurnstileWidget({
  siteKey,
  onToken,
  resetKey = 0,
}: {
  siteKey: string
  /** A fresh token, or null when it expired or the challenge failed. */
  onToken: (token: string | null) => void
  resetKey?: number
}) {
  const host = useRef<HTMLDivElement>(null)
  const widgetId = useRef<string | null>(null)
  const onTokenRef = useRef(onToken)
  // Kept current in an effect (not during render) so the widget's callbacks never call a stale handler.
  useEffect(() => {
    onTokenRef.current = onToken
  })

  useEffect(() => {
    let cancelled = false
    const stop = whenTurnstileReady(() => {
      if (cancelled || !host.current || !window.turnstile || widgetId.current) return
      widgetId.current = window.turnstile.render(host.current, {
        sitekey: siteKey,
        theme: 'light',
        language: 'es',
        callback: (token: string) => onTokenRef.current(token),
        'expired-callback': () => onTokenRef.current(null),
        'error-callback': () => onTokenRef.current(null),
      })
    })
    return () => {
      cancelled = true
      stop()
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current)
      widgetId.current = null
    }
  }, [siteKey])

  useEffect(() => {
    if (resetKey > 0 && widgetId.current && window.turnstile) {
      onTokenRef.current(null)
      window.turnstile.reset(widgetId.current)
    }
  }, [resetKey])

  return <div ref={host} data-testid="p2s-turnstile" className="min-h-[65px]" />
}
