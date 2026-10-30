import Link from 'next/link'
import { marketBasePath } from '@/lib/markets'
import { ROOT_LANGUAGE_PATHS } from '@/lib/root-language'

type MarketLinksCopy = { label: string; mx: string; us: string; en: string }

/**
 * The country picker's job, without being the front door (root-shop-builder-home D10).
 *
 * `/` used to BE the picker. Now it is the Mexico shop builder, so the other doors become a
 * quiet strip at the end of the page: the Mexican marketplace, the US one, and the English
 * document at `/en` (which still renders the full picker). It lives in this page rather than in
 * `PlatformShell` so no other page's chrome changes.
 *
 * `hrefLang="en"` on the English link is the honest annotation — it is a different-language
 * document — even though `/` itself carries no hreflang pair any more (D3).
 */
export default function RootMarketLinks({ copy }: { copy: MarketLinksCopy }) {
  const links = [
    { href: marketBasePath('mx'), label: copy.mx, testId: 'root-market-link-mx' },
    { href: marketBasePath('us'), label: copy.us, testId: 'root-market-link-us' },
    { href: ROOT_LANGUAGE_PATHS.en, label: copy.en, testId: 'root-market-link-en', hrefLang: 'en' },
  ]

  return (
    <nav
      aria-label={copy.label}
      data-testid="root-market-links"
      className="app-shell"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--s-2) var(--s-4)',
        justifyContent: 'center',
        alignItems: 'center',
        paddingBottom: 'var(--s-8)',
        fontSize: 13,
        color: 'var(--fg-muted)',
      }}
    >
      <span>{copy.label}</span>
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          hrefLang={link.hrefLang}
          data-testid={link.testId}
          prefetch={false}
          style={{ color: 'var(--fg-muted)', textDecoration: 'underline', textUnderlineOffset: 3 }}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  )
}
