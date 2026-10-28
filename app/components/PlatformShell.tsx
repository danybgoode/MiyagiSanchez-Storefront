import Link from 'next/link'
import LazyUserButton from '@/app/components/clerk-lazy/LazyUserButton'
import AuthShow from '@/app/components/AuthShow'
import MobileTabBar from '@/app/components/MobileTabBar'
import AIAgentButton from '@/app/components/AIAgentButton'
import CuentaMenu from '@/app/components/CuentaMenu'
import DesktopUnreadBadge from '@/app/components/DesktopUnreadBadge'
import PlatformBrand from '@/app/components/PlatformBrand'
import PlatformThemeToggle from '@/app/components/PlatformThemeToggle'
import CartButton from '@/app/components/CartButton'
import { getDictionary } from '@/lib/dictionary'
import { marketBasePath, type MarketCode } from '@/lib/markets'
import { sellerLandingPath } from '@/lib/seller-acquisition'
import { resolveMarketPresentation } from '@/lib/market-presentation'
import { CONTACT_EMAIL, contactMailto } from '@/lib/contact'

/**
 * The marketplace buyer chrome — sticky glass header (search, brand, cart, account,
 * nav), the `platform-main-shell` canvas with seasonal theme-spots, the footer, and
 * the PWA-only tab bar. Lifted verbatim from the old root layout's `showBuyerChrome`
 * block so the static `(site)` shell and the dynamic `(shell)` shell render identical
 * chrome from one source.
 *
 * It reads NO request headers and NO `currentUser()` — it's static-able. The platform
 * seasonal-theme boot script is emitted by the `(site)`/`(shell)` layouts (path-gated),
 * not here. `platformThemeEligible` only gates whether the theme TOGGLE surfaces in the
 * account menu, matching the old layout's behavior.
 */
export default async function PlatformShell({
  market,
  platformThemeEligible,
  children,
}: {
  market: MarketCode
  platformThemeEligible: boolean
  children: React.ReactNode
}) {
  const presentation = resolveMarketPresentation(market)
  const dict = await getDictionary(presentation.language)
  const themeToggleLabels = dict.platformTheme.toggle
  const copy = dict.buyerShell
  const marketHome = marketBasePath(market)
  const browsePath = `${marketHome}/l`
  // The seller pitch page for THIS market. Every one of the three signed-out sell
  // affordances below (mobile header, desktop header, footer) used to be a literal
  // `/vende` — so the English US chrome sent a US merchant to the Spanish Mexican
  // landing, in every viewport, on every page that renders this shell. The chrome
  // already knows its market; the destination now follows from it.
  const sellerLanding = sellerLandingPath(market)
  return (
    <>
      {/* ── Sticky header ── */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 50,
          padding: '8px 8px 0',
        }}
      >
        <header
          className="glass"
          style={{
            borderRadius: 'var(--r-lg)',
            minHeight: 56,
            display: 'flex',
            alignItems: 'center',
            padding: '0 18px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              width: '100%',
              maxWidth: 1152,
              margin: '0 auto',
              gap: 12,
            }}
          >

            {/* ── MOBILE LAYOUT: logo + search + actions ── */}
            <div
              className="flex md:hidden"
              style={{ alignItems: 'center', gap: 8, width: '100%', minWidth: 0 }}
            >
              <PlatformBrand variant="mobile" market={market} ariaLabel={copy.brandHome} />

              {/* Search bar — stays on mobile web, but HIDDEN in the installed
                  PWA standalone, where the bottom-sheet search is the single
                  primary control (PWA Liquid-Glass Nav Polish S2.2). Desktop
                  search is a separate block below and is untouched. */}
              <form
                action={browsePath}
                method="GET"
                className="pwa-hidden"
                style={{ flex: 1, minWidth: 0 }}
              >
                <div style={{ position: 'relative' }}>
                  <i
                    className="iconoir-search"
                    style={{
                      position: 'absolute',
                      left: 9,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      fontSize: 14,
                      color: 'var(--fg-subtle)',
                      pointerEvents: 'none',
                      lineHeight: 1,
                    }}
                  />
                  <input
                    name="q"
                    type="search"
                    placeholder={copy.searchPlaceholder}
                    style={{
                      width: '100%',
                      height: 38,
                      background: 'var(--bg-sunk)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--r-pill)',
                      padding: '0 34px 0 28px',
                      fontSize: 13,
                      fontFamily: 'var(--font-sans)',
                      color: 'var(--fg)',
                      outline: 'none',
                    }}
                  />
                  {/* In-search agent affordance — same sheet as the desktop AIAgentButton */}
                  <AIAgentButton variant="search" copy={copy.agent} />
                </div>
              </form>

              {/* PWA standalone only: the header search (and its in-search agent
                  button) is hidden above, so fill the freed space and re-surface
                  the agent as a top-bar icon — exactly one search + one agent
                  affordance in every mode, no dead space. */}
              <div className="pwa-only" aria-hidden="true" style={{ flex: 1 }} />
              <span className="pwa-only">
                <AIAgentButton variant="icon" copy={copy.agent} />
              </span>

              {/* Sell affordance — publish action when signed in, the labeled "Vende" pitch when signed out */}
              <AuthShow when="signed-in">
                <Link
                  href="/sell"
                  className="icon-btn accent"
                  title={copy.publishListingTitle}
                >
                  <i className="iconoir-plus-circle" style={{ fontSize: 22 }} />
                </Link>
              </AuthShow>
              <AuthShow when="signed-out">
                <Link href={sellerLanding} className="btn btn-primary btn-sm" style={{ flexShrink: 0 }}>
                  {copy.sell}
                </Link>
              </AuthShow>

              <Link
                href="/vecindario"
                className="icon-btn"
                title={copy.neighborhood}
                aria-label={copy.neighborhood}
              >
                <i className="iconoir-community" style={{ fontSize: 22 }} />
              </Link>

              {/* Cart */}
              <CartButton label={copy.cart} />

              {/* Cuenta hub — all account actions (theme, favoritos, agent…) in one menu.
                  Mobile-header instance: drop the Favoritos row in the installed PWA bar
                  (the bottom tab carries it there); it stays in the menu on mobile web. */}
              <AuthShow when="signed-in">
                <CuentaMenu
                  accountLabel={copy.account}
                  itemLabels={copy.accountItems}
                  themeEligible={platformThemeEligible}
                  hideFavoritesInPwa
                  themeSlot={
                    <PlatformThemeToggle
                      labels={themeToggleLabels}
                      variant="desktop"
                      initialEligible={platformThemeEligible}
                    />
                  }
                />
              </AuthShow>

              {/* Signed-out has no Cuenta menu — keep the standalone theme toggle
                  (self-hides on ineligible paths). */}
              <AuthShow when="signed-out">
                <PlatformThemeToggle
                  labels={themeToggleLabels}
                  variant="mobile"
                  initialEligible={platformThemeEligible}
                />
              </AuthShow>
            </div>

            {/* ── DESKTOP LAYOUT: brand · centered search + agent · nav ── */}
            <div
              className="hidden md:flex"
              style={{ alignItems: 'center', width: '100%', gap: 16 }}
            >
              <PlatformBrand variant="desktop" market={market} ariaLabel={copy.brandHome} />

              {/* Centered persistent search + the single agent affordance */}
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  gap: 8,
                  minWidth: 0,
                }}
              >
                <form action={browsePath} method="GET" style={{ flex: 1, maxWidth: 440, minWidth: 0 }}>
                  <div style={{ position: 'relative' }}>
                    <i
                      className="iconoir-search"
                      style={{
                        position: 'absolute',
                        left: 11,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        fontSize: 15,
                        color: 'var(--fg-subtle)',
                        pointerEvents: 'none',
                        lineHeight: 1,
                      }}
                    />
                    <input
                      name="q"
                      type="search"
                      placeholder={copy.searchPlaceholder}
                      style={{
                        width: '100%',
                        height: 38,
                        background: 'var(--bg-sunk)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--r-pill)',
                        padding: '0 12px 0 32px',
                        fontSize: 13,
                        fontFamily: 'var(--font-sans)',
                        color: 'var(--fg)',
                        outline: 'none',
                      }}
                    />
                  </div>
                </form>
                <AIAgentButton variant="affordance" copy={copy.agent} />
              </div>

              {/* Right nav */}
              <nav style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Link
                  href="/vecindario"
                  style={{ fontSize: 13, color: 'var(--fg-muted)', textDecoration: 'none' }}
                  className="hover:text-[var(--fg)]"
                >
                  {copy.neighborhood}
                </Link>
                <AuthShow when="signed-in">
                  <Link
                    href="/messages"
                    style={{ position: 'relative', fontSize: 13, color: 'var(--fg-muted)', textDecoration: 'none' }}
                    className="hover:text-[var(--fg)]"
                    title={copy.messages}
                  >
                    <i className="iconoir-chat-bubble" style={{ fontSize: 15, verticalAlign: 'middle' }} />
                    <DesktopUnreadBadge />
                  </Link>
                  <CartButton label={copy.cart} />
                  <Link href="/sell" className="btn btn-primary btn-sm">
                    <i className="iconoir-plus" style={{ fontSize: 14 }} />
                    {copy.publish}
                  </Link>
                  <CuentaMenu
                    accountLabel={copy.account}
                    itemLabels={copy.accountItems}
                    themeEligible={platformThemeEligible}
                    themeSlot={
                      <PlatformThemeToggle
                        labels={themeToggleLabels}
                        variant="desktop"
                        initialEligible={platformThemeEligible}
                      />
                    }
                  />
                  <LazyUserButton />
                </AuthShow>
                <AuthShow when="signed-out">
                  {/* No Cuenta menu when signed out — keep the standalone toggle
                      (self-hides on ineligible paths). */}
                  <PlatformThemeToggle
                    labels={themeToggleLabels}
                    variant="desktop"
                    initialEligible={platformThemeEligible}
                  />
                  <Link href={sellerLanding} className="btn btn-primary btn-sm">
                    {copy.publishFree}
                  </Link>
                  <Link
                    href="/sign-in"
                    style={{ fontSize: 13, color: 'var(--fg-muted)', textDecoration: 'none' }}
                    className="hover:text-[var(--fg)]"
                  >
                    {copy.signIn}
                  </Link>
                </AuthShow>
              </nav>
            </div>

          </div>
        </header>
      </div>

      <main className="platform-main-shell">
        <span aria-hidden className="platform-theme-spot platform-theme-spot-a" />
        <span aria-hidden className="platform-theme-spot platform-theme-spot-b" />
        {children}
      </main>

      {/* Footer — visible on mobile too (S3.3) so the links + Términos aren't dead-ended on phones */}
      <footer data-testid="site-footer" style={{ borderTop: '1px solid var(--border)', marginTop: 64 }}>
        <div
          className="app-shell"
          style={{ paddingTop: 24, paddingBottom: 24, display: 'flex', flexWrap: 'wrap', gap: '8px 24px' }}
        >
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{copy.footer.copyright}</span>
          <Link href={browsePath} style={{ fontSize: 12, color: 'var(--fg-muted)', textDecoration: 'none' }} className="hover:text-[var(--fg)]">{copy.footer.listings}</Link>
          <Link href="/vecindario" style={{ fontSize: 12, color: 'var(--fg-muted)', textDecoration: 'none' }} className="hover:text-[var(--fg)]">{copy.footer.neighborhood}</Link>
          <Link href={sellerLanding} style={{ fontSize: 12, color: 'var(--fg-muted)', textDecoration: 'none' }} className="hover:text-[var(--fg)]">{copy.footer.sellFree}</Link>
          {/* /mx/precios is es-MX and MX-priced (pricing-page D10) — a /us visitor gets no link to it. */}
          {market === 'mx' ? (
            <Link href="/mx/precios" data-testid="footer-pricing" style={{ fontSize: 12, color: 'var(--fg-muted)', textDecoration: 'none' }} className="hover:text-[var(--fg)]">{copy.footer.pricing}</Link>
          ) : null}
          <AuthShow when="signed-out">
            <Link href="/sign-up" data-testid="footer-signup" style={{ fontSize: 12, color: 'var(--fg-muted)', textDecoration: 'none' }} className="hover:text-[var(--fg)]">{copy.footer.createAccount}</Link>
          </AuthShow>
          <Link href="/agent" style={{ fontSize: 12, color: 'var(--fg-muted)', textDecoration: 'none' }} className="hover:text-[var(--fg)]">
            {copy.footer.agentApi}
          </Link>
          <Link href="/acerca" style={{ fontSize: 12, color: 'var(--fg-muted)', textDecoration: 'none' }} className="hover:text-[var(--fg)]">{copy.footer.about}</Link>
          <Link href="/terminos" style={{ fontSize: 12, color: 'var(--fg-muted)', textDecoration: 'none' }} className="hover:text-[var(--fg)]">{copy.footer.terms}</Link>
          {/* A plain mailto, not a contact form. The platform had no reachable
              address anywhere on the site — the only way to reach a person was to
              reply to an email we had already sent, which a visitor with a
              question has never received. `title` carries the address so it is
              readable on hover without clicking into a mail client. */}
          <a
            href={contactMailto('Miyagi Sánchez')}
            title={CONTACT_EMAIL}
            data-testid="footer-contact"
            style={{ fontSize: 12, color: 'var(--fg-muted)', textDecoration: 'none' }}
            className="hover:text-[var(--fg)]"
          >
            {copy.footer.contact}
          </a>
        </div>
      </footer>

      {/* Floating glass tab bar — PWA only (hidden in browser via .pwa-only CSS) */}
      <MobileTabBar search={dict.pwaSearch} labels={copy.tabs} />
    </>
  )
}
