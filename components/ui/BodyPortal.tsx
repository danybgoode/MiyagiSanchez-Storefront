'use client'

import { useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Renders its children into `document.body`.
 *
 * Why: `.platform-main-shell` is `isolation: isolate` (globals.css), so a fixed overlay rendered inside the page can
 * never out-rank the header or the tab bar. Every sheet and modal that covers the screen mounts here instead, with
 * `z-index: var(--z-overlay)`.
 *
 * Nothing renders on the server or on the first client render (`document` does not exist there), so there is no
 * hydration mismatch; overlays are opened by a user action anyway.
 */
const subscribe = () => () => {}
const onClient = () => true
const onServer = () => false

export default function BodyPortal({ children }: { children: ReactNode }) {
  const mounted = useSyncExternalStore(subscribe, onClient, onServer)
  return mounted ? createPortal(children, document.body) : null
}
