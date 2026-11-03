/**
 * PWA bottom-bar visibility — pure, next-free helpers.
 *
 * The MobileTabBar client island imports these; the api spec
 * (`e2e/tabbar-visibility.spec.ts`) loads them directly. Keeping the logic here
 * (no DOM, no `next/*`) means the hide rules can't drift between component and
 * test. Same pattern as `lib/gallery.ts` ↔ `e2e/gallery.spec.ts`.
 */

import { stripMarketPrefix } from './market-url'

/** How tab labels render. The const below is the single switch (no remote flag, no peek mode). */
export type LabelMode = 'icons-only' | 'active-label' | 'full-labels'

/**
 * Default label rendering for the bar:
 *   'icons-only'   — icon + aria-label only (no visible text) ← default
 *   'active-label' — text shown on the active tab only
 *   'full-labels'  — text shown on every tab
 */
export const LABEL_MODE: LabelMode = 'icons-only'

/**
 * The bottom bar's slots, in display order. A pure descriptor so the MobileTabBar
 * island and the api spec read the *same* set/order — they can't drift.
 *
 * Order (PWA Liquid-Glass Nav Polish, S1.1 — a deliberate partial revert of the
 * 2026-06-11 nav-reorg): Inicio · Mensajes · ⊕ Vender (center FAB) · Favoritos ·
 * Perfil. Search left the bar (the Explorar tab is gone) and lives in the
 * detached glass control (S1.2) → bottom-sheet (S2).
 *
 *   kind 'tab' → a flat icon tab; kind 'fab' → the raised center publish button.
 *   `signedOutHref` → where an auth-gated tab points when signed out (else `href`).
 *   `unread` → this tab shows the global unread dot (Mensajes only).
 */
export type BottomTabKey = 'home' | 'messages' | 'sell' | 'favorites' | 'profile'

export interface BottomTab {
  key: BottomTabKey
  kind: 'tab' | 'fab'
  /** Signed-in destination. */
  href: string
  /** Destination when signed out, when the tab is auth-gated. */
  signedOutHref?: string
  icon: string
  /** es-MX name — the aria-label in icons-only mode. */
  label: string
  /** Shows the global unread dot (Mensajes). */
  unread?: boolean
}

export const BOTTOM_TABS: readonly BottomTab[] = [
  { key: 'home',      kind: 'tab', href: '/mx',                icon: 'iconoir-home-simple', label: 'Inicio' },
  { key: 'messages',  kind: 'tab', href: '/messages', signedOutHref: '/sign-in', icon: 'iconoir-chat-bubble', label: 'Mensajes', unread: true },
  { key: 'sell',      kind: 'fab', href: '/sell',             icon: 'iconoir-plus',        label: 'Vender' },
  { key: 'favorites', kind: 'tab', href: '/account/favorites', signedOutHref: '/sign-in', icon: 'iconoir-heart', label: 'Favoritos' },
  { key: 'profile',   kind: 'tab', href: '/account', signedOutHref: '/sign-in', icon: 'iconoir-user', label: 'Perfil' },
] as const

/** Resolve a tab's href for the current auth state (signed-out → `signedOutHref`). */
export function resolveBottomTabHref(tab: BottomTab, isSignedIn: boolean): string {
  if (isSignedIn) return tab.href
  return tab.signedOutHref ?? tab.href
}

/**
 * Is this tab the active one for `pathname`? Pure so the spec can pin it.
 *   - home: exact `/mx` only (`/` is the master-brand market selector)
 *   - messages: anything under `/messages`
 *   - favorites: anything under `/account/favorites`
 *   - profile: `/account[...]` (but NOT the favorites subtree, which is its own tab)
 *   - sell: the publish flow (the bar is hidden there, so this is for completeness)
 *
 * `/sign-in` is deliberately owned by NO tab: several auth-gated tabs (Favoritos,
 * Perfil, Mensajes) all route there when signed out, so highlighting any one of
 * them on that transient interstitial would be arbitrary/misleading.
 */
export function isBottomTabActive(key: BottomTabKey, pathname: string): boolean {
  switch (key) {
    case 'home':      return pathname === '/mx'
    case 'messages':  return pathname.startsWith('/messages')
    case 'favorites': return pathname.startsWith('/account/favorites')
    case 'sell':      return pathname === '/sell' || pathname.startsWith('/sell/')
    case 'profile':
      if (pathname.startsWith('/account/favorites')) return false
      return pathname === '/account' || pathname.startsWith('/account/')
    default:          return false
  }
}

/**
 * The bar is removed entirely (not just hidden) on these surfaces — full-screen
 * flows where the bottom chrome would cover content: the PDP, checkout, an open
 * conversation, and the publish wizard.
 *
 * Detail routes only — the `/l` and `/messages` *index* pages keep the bar.
 *   true  → /l/<id>, /checkout[...], /messages/<id>, /sell[...], /p2s[...]
 *   false → /l, /l?…, /messages, /, /account, …
 *
 * `/l` is one of the market-cutover's prefixed families (`lib/market-url.ts` —
 * `MARKET_PREFIXED_PATH_FAMILIES`), so a platform-host PDP request lands on
 * `/mx/l/<id>`, not the bare `/l/<id>` this predicate was written against.
 * `stripMarketPrefix` normalizes both shapes to the same un-prefixed input —
 * the same seam every other pre-cutover path predicate goes through — so this
 * stays correct on both the legacy path and its `/mx` redirect target.
 * `/checkout`, `/messages` and `/sell` never carry a market prefix, so the
 * normalization is a no-op for them.
 */
export function shouldHideTabBar(pathname: string): boolean {
  if (!pathname) return false
  const path = stripMarketPrefix(pathname)
  // Detail routes: a non-empty segment after the base.
  if (/^\/l\/[^/]+/.test(path)) return true
  if (/^\/messages\/[^/]+/.test(path)) return true
  // Whole-section flows: the base or anything under it.
  if (path === '/checkout' || path.startsWith('/checkout/')) return true
  if (path === '/sell' || path.startsWith('/sell/')) return true
  // Prompt-to-shop's canvas keeps «Quedármela» in a bar stuck to the bottom of the screen; the installed app's tab bar
  // (fixed, z 100) would sit on top of it (business-infrastructure S1.1 review).
  if (path === '/p2s' || path.startsWith('/p2s/')) return true
  return false
}

/**
 * Hide-on-scroll decision (pure). Given the previous and current scroll Y, the
 * current hidden state, and an 8px threshold, return the next hidden state:
 *   - near the top (y ≤ threshold) → always shown
 *   - scrolled down past the threshold delta → hide
 *   - any upward move → show
 *   - sub-threshold jitter → unchanged
 */
export function nextTabBarHidden(
  prevY: number,
  currentY: number,
  hidden: boolean,
  threshold = 8,
): boolean {
  if (currentY <= threshold) return false
  const delta = currentY - prevY
  if (delta > threshold) return true
  if (delta < 0) return false
  return hidden
}
