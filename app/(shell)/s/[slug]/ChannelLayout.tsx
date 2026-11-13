import { BuyerCopyText } from '@/app/components/BuyerPresentationContext'
import LanguageSwitch from '@/app/components/LanguageSwitch'
import type { SiteLanguage } from '@/lib/site-language'
/* eslint-disable @next/next/no-img-element -- seller-hosted logos are rendered from arbitrary remote domains. */
/**
 * ChannelLayout — white-label shell for custom domain ("own channel") requests.
 *
 * Used when a seller's shop is visited via their own domain (e.g. myshop.mx).
 * Renders NO miyagisanchez platform chrome — just the shop's brand.
 * On miyagisanchez.com the standard root layout wraps everything instead.
 */

import type { ReactNode } from 'react'
import Link from 'next/link'

interface Props {
  shopName: string
  accentColor: string
  logoUrl: string | null
  domain: string
  /**
   * Cross-channel trust parity (#3c · Epic D / D.2): an optional discreet
   * platform-assurance slot rendered above the page content. Callers pass Epic C's
   * slim `<TrustSignals>` node; this shell wraps it with the subtle es-MX
   * "Pago seguro · Compra protegida" lead line. Additive — when absent, no strip
   * renders, so existing white-label renders are unchanged.
   */
  trust?: ReactNode
  /**
   * The «Tienda impulsada por Miyagi Sánchez» footer link is the Gratis plan's badge (plans-gratis-negocio D7): a
   * Negocio or trial shop hides it. Defaults to shown, so a caller that does not know the plan changes nothing.
   */
  showBadge?: boolean
  /** Where the badge links, tagged with the shop's campaign (`badgeHref` in lib/plan.ts). */
  badgeHref?: string
  /** The language the document rendered in, so the shop's own header carries the same ES/EN switch as the platform's. */
  language: SiteLanguage
  children: ReactNode
}

export default function ChannelLayout({
  shopName,
  accentColor,
  logoUrl,
  trust,
  showBadge = true,
  badgeHref = 'https://miyagisanchez.com',
  language,
  children,
}: Props) {
  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        '--color-accent': accentColor,
        '--color-accent-hover': accentColor,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      } as React.CSSProperties}
    >
      {/* ── Minimal branded nav ────────────────────────────────────────────── */}
      <header
        className="sticky top-0 z-30 border-b bg-white/95 backdrop-blur-sm"
        style={{ borderColor: 'rgba(0,0,0,0.08)' }}
      >
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
          {/* Logo + name */}
          <Link href="/" className="flex items-center gap-2.5 no-underline min-w-0">
            {logoUrl ? (
              <img
                src={logoUrl}
                alt={shopName}
                className="w-8 h-8 rounded-full object-cover flex-shrink-0 border border-black/10"
              />
            ) : (
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-white text-sm font-bold"
                style={{ backgroundColor: accentColor }}
              >
                {shopName.charAt(0).toUpperCase()}
              </div>
            )}
            <span className="font-semibold text-sm truncate" style={{ color: 'var(--embed-fg)' }}>
              {shopName}
            </span>
          </Link>
          <LanguageSwitch current={language} />
        </div>
      </header>

      {/* ── Page content ──────────────────────────────────────────────────── */}
      <main className="flex-1 bg-[var(--surface-channel)]">
        {/* Platform-assurance strip (Epic D / D.2) — discreet, not platform nav. */}
        {trust && (
          <div className="border-b" style={{ borderColor: 'rgba(0,0,0,0.06)', background: 'rgba(0,0,0,0.015)' }}>
            <div className="max-w-6xl mx-auto px-4 py-2 flex items-center gap-x-3 gap-y-1.5 flex-wrap">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--embed-fg-muted)' }}>
                <i className="iconoir-shield-check" style={{ fontSize: 13 }} />
                <BuyerCopyText copyKey="s.slug.ChannelLayout.607fd824" /></span>
              {trust}
            </div>
          </div>
        )}
        {children}
      </main>

      {/* ── Minimal footer ────────────────────────────────────────────────── */}
      <footer className="border-t py-5 bg-white" style={{ borderColor: 'rgba(0,0,0,0.08)' }}>
        <div className="max-w-6xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs"
          style={{ color: 'var(--embed-fg-subtle)' }}>
          <span>© {new Date().getFullYear()} {shopName}</span>
          {showBadge && (
            <a
              href={badgeHref}
              target="_blank"
              rel="noopener noreferrer"
              className="no-underline hover:opacity-70 transition-opacity"
              style={{ color: 'var(--fg-subtle)' }}
              data-testid="shop-plan-badge"
            >
              <BuyerCopyText copyKey="s.slug.ChannelLayout.bb1173f1" /></a>
          )}
        </div>
      </footer>
    </div>
  )
}
