import Link from 'next/link'
import { marketBasePath } from '@/lib/markets'
import RootEnglishLink from './RootEnglishLink'
import RootLanguageSwitch from './RootLanguageSwitch'

type MarketLinksCopy = { label: string; mx: string; us: string; en: string }

/**
 * The country picker's job, without being the front door (root-shop-builder-home D10).
 *
 * `/` used to BE the picker. Now it is the Mexico shop builder, so the other doors become a
 * quiet strip at the end of the page: the Mexican marketplace, the US one, and the English
 * document at `/en` (which still renders the full picker). It lives in this page rather than in
 * `PlatformShell` so no other page's chrome changes.
 *
 * The English link is `RootEnglishLink`, a client island, because it must store the choice that
 * stops `/en` from hopping a Spanish browser straight back here.
 */
export default function RootMarketLinks({ copy, language = 'es' }: { copy: MarketLinksCopy; language?: 'es' | 'en' }) {
  const links = [
    { href: marketBasePath('mx'), label: copy.mx, testId: 'root-market-link-mx' },
    { href: marketBasePath('us'), label: copy.us, testId: 'root-market-link-us' },
  ]
  const linkStyle = { color: 'var(--fg-muted)', textDecoration: 'underline', textUnderlineOffset: 3 }

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
        <Link key={link.href} href={link.href} data-testid={link.testId} prefetch={false} style={linkStyle}>
          {link.label}
        </Link>
      ))}
      {/* Client islands. On `/`, the English link stores the choice; on `/en`, the switch to Spanish does, and it also
          runs the one-time hop (one-front-door-both-markets D16). `/` runs the hop through its own switch below. */}
      {language === 'es' ? <RootEnglishLink label={copy.en} style={linkStyle} /> : <RootLanguageSwitch current="en" />}
    </nav>
  )
}
