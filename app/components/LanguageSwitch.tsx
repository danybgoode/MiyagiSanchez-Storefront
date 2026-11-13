'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useTransition } from 'react'
import { useBuyerCopy } from '@/app/components/BuyerPresentationContext'
import { builderLanguageRedirect, rootLanguageRedirect } from '@/lib/root-language'
import {
  SITE_LANGUAGES,
  URL_LANGUAGE_TWINS,
  languagePreferenceFromCookieHeader,
  languageSwitchTarget,
  serializeLanguageCookie,
  type SiteLanguage,
} from '@/lib/site-language'

const LABELS: Record<SiteLanguage, string> = { es: 'ES', en: 'EN' }

/**
 * Each option is described IN THE LANGUAGE IT SWITCHES TO — the Wikipedia/Google convention. A visitor who cannot
 * read the language on screen is exactly the person who needs this control, so their own language must not hide
 * behind words they cannot read. Paired with `lang` on the button so a screen reader uses the right voice.
 */
const TITLES: Record<SiteLanguage, string> = {
  es: 'Cambiar idioma a español',
  en: 'Switch language to English',
}

/**
 * Module functions, not inline statements: `react-hooks/immutability` (React Compiler) rejects assigning to anything
 * declared outside the component — `document` included. These are genuine browser side effects.
 */
function persistLanguage(language: SiteLanguage): void {
  document.cookie = serializeLanguageCookie(language, window.location.hostname)
}

function storedLanguage(): SiteLanguage | null {
  return languagePreferenceFromCookieHeader(document.cookie)
}

/**
 * The automatic hop, for the few pages whose language is their address (`lib/site-language.ts`).
 *
 *   · a stored choice that differs from the page ⇒ go to the twin. Someone who picked English in the back office
 *     and then follows a link to `/` reads `/en`, which is the bug this replaced.
 *   · no stored choice on the front door ⇒ the browser hint, by the same rules as before (`lib/root-language.ts`:
 *     an `en-MX` phone stays on the Mexican pitch).
 *
 * Only exact twins hop. A Spanish-only pitch (`/mx/vende/<persona>`) a promoter shared stays put even for an English
 * reader; the switch on it still offers `/en`.
 */
function hopTarget(pathname: string): string | null {
  const twin = URL_LANGUAGE_TWINS[pathname]
  if (!twin) return null
  const chosen = storedLanguage()
  if (chosen) return chosen === twin.language ? null : twin.twin
  if (pathname !== '/' && pathname !== '/en') return null
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  return pathname === '/'
    ? builderLanguageRedirect({ current: 'es', languages })
    : rootLanguageRedirect({ current: 'en', languages })
}

/**
 * The ES/EN switch, in every header on the site: buyer chrome, a shop's own branded chrome, and the seller portal.
 *
 * Clicking stores the choice in ONE cookie every server render reads, then either re-renders the page in place (a
 * market page: same URL, same shop, other language) or, on a page whose language is its address, goes to its twin.
 * `router.refresh()` keeps scroll position and client state; the server does the translating, so nothing flashes.
 */
export default function LanguageSwitch({
  current,
  variant = 'default',
}: {
  /** The language this page actually rendered in. */
  current: SiteLanguage
  /** `inverse` sits on the brand-accent seller bar; `default` on the buyer header's glass. */
  variant?: 'default' | 'inverse'
}) {
  const router = useRouter()
  const pathname = usePathname() ?? '/'
  const [pending, startTransition] = useTransition()
  const copy = useBuyerCopy()

  useEffect(() => {
    const target = hopTarget(pathname)
    // `replace`: the back button should leave the site, not bounce off the document the visitor was moved out of.
    if (target) router.replace(`${target}${window.location.search}`)
  }, [pathname, router])

  function choose(next: SiteLanguage) {
    persistLanguage(next)
    if (next === current) return
    const target = languageSwitchTarget(pathname, next)
    if (target) {
      router.push(`${target}${window.location.search}`)
      return
    }
    startTransition(() => router.refresh())
  }

  const inverse = variant === 'inverse'
  const edge = inverse ? 'var(--fg-inverse)' : 'var(--fg-muted)'

  return (
    <div
      role="group"
      aria-label={copy('page.languageSwitchLabel')}
      data-testid="language-switch"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: 'var(--r-pill)',
        border: `1px solid color-mix(in srgb, ${edge} 45%, transparent)`,
        overflow: 'hidden',
        opacity: pending ? 0.6 : 1,
        flexShrink: 0,
      }}
    >
      {SITE_LANGUAGES.map((option) => {
        const active = option === current
        return (
          <button
            key={option}
            type="button"
            onClick={() => choose(option)}
            aria-pressed={active}
            lang={option}
            title={TITLES[option]}
            data-testid={`language-switch-${option}`}
            style={{
              minHeight: 28,
              padding: '0 10px',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.04em',
              lineHeight: 1,
              cursor: active ? 'default' : 'pointer',
              border: 'none',
              background: active ? (inverse ? 'var(--fg-inverse)' : 'var(--fg)') : 'transparent',
              color: active ? (inverse ? 'var(--accent)' : 'var(--bg)') : (inverse ? 'var(--fg-inverse)' : 'var(--fg)'),
            }}
          >
            {LABELS[option]}
          </button>
        )
      })}
    </div>
  )
}

