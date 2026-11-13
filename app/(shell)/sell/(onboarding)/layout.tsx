import Link from 'next/link'
import LanguageSwitch from '@/app/components/LanguageSwitch'
import { getLanguagePreference } from '@/lib/site-language-server'

/**
 * Onboarding three-doors chrome (Sprint 1) — the dark top bar only, no
 * `SellerAnnouncementStrip`, no `SellerNav`: a pre-shop merchant has no shop
 * to navigate yet (`lib/seller-nav.ts`'s own docblock is explicit that every
 * entry must point at a real `/shop/manage/*` route). Mirrors
 * `SellerShellChrome.tsx`'s top-bar markup exactly (same tokens/classes) so
 * the visual language matches once a shop exists, without pulling in that
 * component's shop-lookup/nav-flag data fetching, which doesn't apply here.
 *
 * Route-group layout (`(onboarding)`, no URL segment) so it applies only to
 * `/sell/bienvenida`, `/sell/puertas`, `/sell/agente` — siblings like
 * `/sell/edit/[id]` stay outside this group, unaffected. The root
 * `app/(shell)/layout.tsx` already suppressed buyer chrome for these three
 * paths (`isOnboardingPath`); this layout fills that bare `<main>`. The
 * parent `app/(shell)/sell/layout.tsx` defers here unchanged — its own
 * `sellShellEligible` check only ever matches the exact `/sell`/`/sell/setup`
 * strings, so it renders `<>{children}</>` for these three routes.
 */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  // Pre-shop: no market yet, so Spanish unless the visitor chose otherwise. `sell/layout.tsx`'s copy boundary
  // translates the screens below from the same preference.
  const language = (await getLanguagePreference()) ?? 'es'
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 50,
          background: 'var(--accent)',
          color: 'var(--fg-inverse)',
        }}
      >
        <div
          className="app-shell"
          style={{
            minHeight: 52,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontWeight: 600,
              fontSize: 14,
              fontFamily: 'var(--font-display, var(--font-sans))',
              color: 'var(--fg-inverse)',
            }}
          >
            <i className="iconoir-shop" style={{ fontSize: 18, lineHeight: 1 }} />
            Miyagi Sánchez · Vendedor
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <LanguageSwitch current={language} variant="inverse" />
          <Link
            href="/mx"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              textDecoration: 'none',
              fontSize: 13,
              fontFamily: 'var(--font-sans)',
              color: 'var(--fg-inverse)',
              opacity: 0.92,
            }}
          >
            <i className="iconoir-arrow-left" style={{ fontSize: 16, lineHeight: 1 }} />
            Volver a comprar
          </Link>
          </span>
        </div>
      </div>

      <main className="app-shell" style={{ paddingTop: 20 }}>
        {children}
      </main>
    </div>
  )
}
