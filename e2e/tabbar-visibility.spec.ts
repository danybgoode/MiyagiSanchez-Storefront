import { test, expect } from '@playwright/test'
import {
  shouldHideTabBar, nextTabBarHidden, LABEL_MODE,
  BOTTOM_TABS, resolveBottomTabHref, isBottomTabActive,
} from '../lib/tabbar-visibility'

/**
 * PWA bottom-bar visibility — pure logic (api gate, no browser). The MobileTabBar
 * island reads these, so the route-hide rules and the hide-on-scroll decision
 * can't drift between component and test.
 */
test.describe('tabbar · shouldHideTabBar', () => {
  test('hides on full-screen detail/flow surfaces', () => {
    expect(shouldHideTabBar('/l/abc123')).toBe(true)      // PDP
    expect(shouldHideTabBar('/checkout')).toBe(true)
    expect(shouldHideTabBar('/checkout/bundle')).toBe(true)
    expect(shouldHideTabBar('/messages/conv_42')).toBe(true) // open conversation
    expect(shouldHideTabBar('/sell')).toBe(true)
    expect(shouldHideTabBar('/sell/edit')).toBe(true)
    // Prompt-to-shop's canvas: its keep bar is stuck to the bottom of the screen (business-infrastructure S1.1).
    expect(shouldHideTabBar('/p2s/7f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607')).toBe(true)
    expect(shouldHideTabBar('/p2sx')).toBe(false)
  })

  test('stays visible on index routes and the rest of the app', () => {
    expect(shouldHideTabBar('/')).toBe(false)
    expect(shouldHideTabBar('/l')).toBe(false)            // listings index ≠ PDP
    expect(shouldHideTabBar('/l/')).toBe(false)           // trailing slash, no id
    expect(shouldHideTabBar('/messages')).toBe(false)     // inbox ≠ a conversation
    expect(shouldHideTabBar('/account')).toBe(false)
    expect(shouldHideTabBar('/account/favorites')).toBe(false)
    expect(shouldHideTabBar('/vecindario')).toBe(false)
    expect(shouldHideTabBar('')).toBe(false)
  })

  test('does not match unrelated routes that merely share a prefix', () => {
    expect(shouldHideTabBar('/selling-guide')).toBe(false) // not /sell or /sell/
    expect(shouldHideTabBar('/checkout-help')).toBe(false)
  })

  test('normalizes the market-cutover /mx prefix — the platform-host redirect target', () => {
    expect(shouldHideTabBar('/mx/l/abc123')).toBe(true)  // PDP, post-308 from /l/abc123
    expect(shouldHideTabBar('/mx/l')).toBe(false)        // listings index ≠ PDP
  })
})

test.describe('tabbar · nextTabBarHidden', () => {
  test('always shows near the top of the page', () => {
    expect(nextTabBarHidden(0, 0, false)).toBe(false)
    expect(nextTabBarHidden(0, 8, true)).toBe(false)   // y ≤ threshold → show
  })

  test('hides when scrolling down past the 8px delta', () => {
    expect(nextTabBarHidden(100, 120, false)).toBe(true)
  })

  test('springs back on any upward scroll', () => {
    expect(nextTabBarHidden(300, 280, true)).toBe(false)
  })

  test('sub-threshold jitter leaves the state unchanged', () => {
    expect(nextTabBarHidden(100, 105, false)).toBe(false) // +5 < 8 → unchanged
    expect(nextTabBarHidden(100, 105, true)).toBe(true)
  })
})

test.describe('tabbar · LABEL_MODE', () => {
  test('defaults to icons-only', () => {
    expect(LABEL_MODE).toBe('icons-only')
  })
})

test.describe('tabbar · BOTTOM_TABS (set + order)', () => {
  test('renders exactly Inicio · Mensajes · ⊕ Vender · Favoritos · Perfil, in order', () => {
    // The deliberate S1.1 order (partial revert of the 2026-06-11 nav-reorg).
    expect(BOTTOM_TABS.map(t => t.key)).toEqual([
      'home', 'messages', 'sell', 'favorites', 'profile',
    ])
    // No Explorar/search tab — search left the bar for the detached control.
    expect(BOTTOM_TABS.find(t => t.key === 'sell')?.kind).toBe('fab')
    expect(BOTTOM_TABS.filter(t => t.kind === 'tab')).toHaveLength(4)
  })

  test('signed-in hrefs and es-MX aria-labels', () => {
    const byKey = Object.fromEntries(BOTTOM_TABS.map(t => [t.key, t]))
    expect(byKey.home.href).toBe('/mx')
    expect(byKey.messages.href).toBe('/messages')
    expect(byKey.sell.href).toBe('/sell')
    expect(byKey.favorites.href).toBe('/account/favorites')
    expect(byKey.profile.href).toBe('/account')
    expect(byKey.profile.label).toBe('Perfil')
    expect(byKey.favorites.label).toBe('Favoritos')
    // Only Mensajes carries the global unread dot.
    expect(BOTTOM_TABS.filter(t => t.unread).map(t => t.key)).toEqual(['messages'])
  })
})

test.describe('tabbar · resolveBottomTabHref', () => {
  const byKey = Object.fromEntries(BOTTOM_TABS.map(t => [t.key, t]))

  test('auth-gated tabs fall back to /sign-in when signed out', () => {
    expect(resolveBottomTabHref(byKey.messages, false)).toBe('/sign-in')
    expect(resolveBottomTabHref(byKey.favorites, false)).toBe('/sign-in')
    expect(resolveBottomTabHref(byKey.profile, false)).toBe('/sign-in')
  })

  test('signed-in keeps the real destination; un-gated tabs never change', () => {
    expect(resolveBottomTabHref(byKey.favorites, true)).toBe('/account/favorites')
    expect(resolveBottomTabHref(byKey.home, false)).toBe('/mx')   // no signedOutHref
    expect(resolveBottomTabHref(byKey.sell, false)).toBe('/sell')
  })
})

test.describe('tabbar · isBottomTabActive', () => {
  test('home is active only on the exact Mexico marketplace root', () => {
    expect(isBottomTabActive('home', '/mx')).toBe(true)
    expect(isBottomTabActive('home', '/')).toBe(false) // master-brand selector is not Inicio
    expect(isBottomTabActive('home', '/mx/l')).toBe(false)
  })

  test('favorites and profile do not both light up on the favorites subtree', () => {
    expect(isBottomTabActive('favorites', '/account/favorites')).toBe(true)
    expect(isBottomTabActive('profile', '/account/favorites')).toBe(false) // its own tab
    expect(isBottomTabActive('profile', '/account')).toBe(true)
    expect(isBottomTabActive('profile', '/account/orders')).toBe(true)
  })

  test('no tab owns the /sign-in interstitial (several auth-gated tabs route there)', () => {
    expect(isBottomTabActive('profile', '/sign-in')).toBe(false)
    expect(isBottomTabActive('favorites', '/sign-in')).toBe(false)
    expect(isBottomTabActive('messages', '/sign-in')).toBe(false)
  })

  test('messages is active across the whole section', () => {
    expect(isBottomTabActive('messages', '/messages')).toBe(true)
    expect(isBottomTabActive('messages', '/account')).toBe(false)
  })
})
