/**
 * lib/site-language.ts — the ONE language preference, for every surface.
 *
 * Until 2026-11-13 the site had three language systems that never spoke to each other: the front door hopped by
 * browser language and remembered a click in `localStorage`, the seller portal kept its own `seller_locale` cookie,
 * and every buyer page took its language from the MARKET (Mexico ⇒ Spanish, US ⇒ English) with no way to change it.
 * A merchant who chose English in the back office was dropped back into their browser's language the moment they
 * left it. The product owner's ask was plain: one switcher, everywhere, and it sticks.
 *
 * The model, in one breath:
 *
 *   · A visitor's explicit choice is one cookie, `ms_lang`. Every switcher writes it; every server render reads it.
 *   · No choice ⇒ the page's own default: the market's language on market pages (`/mx` Spanish, `/us` English),
 *     the URL's language on the few pages whose language IS their address.
 *   · Language never chooses a market. A Mexican shop read in English still sells in pesos from Mexico.
 *
 * ── Why a cookie and not a URL segment for buyer pages ───────────────────────
 * Search engines want one language per URL, and they get it: crawlers carry no cookie, so every URL is crawled and
 * indexed in its market's default language, exactly as before. The preference only changes what a PERSON who asked
 * for it sees. Those renders must never be shared through a cache, which is why every surface that reads the cookie
 * renders per request (`private, no-store`) — see the layouts that call `getLanguagePreference()`.
 *
 * ── Pages whose language is their address ────────────────────────────────────
 * `/` and `/en` are the same shop builder in two languages, and `/us/sell` / `/us/vende` the same US seller pitch.
 * They are separately indexed, hreflang-paired documents, so the switch on them NAVIGATES to the twin rather than
 * re-rendering in place. `URL_LANGUAGE_TWINS` is the one table of those pairs.
 *
 * PURE — no React, no Next, no DOM — so it is unit-tested and shared by server and client.
 */

export type SiteLanguage = 'es' | 'en'

export const SITE_LANGUAGES: readonly SiteLanguage[] = ['es', 'en']

/** The cookie that carries the visitor's explicit choice. Readable on both sides; no personal data. */
export const SITE_LANGUAGE_COOKIE = 'ms_lang'

/**
 * Where the seller portal stored the same choice before the two were unified. Read as a fallback so a merchant who
 * already picked a language is not reset by the rename; never written again.
 */
export const LEGACY_SELLER_LOCALE_COOKIE = 'seller_locale'

/** A year: a language choice is not a session fact. */
export const SITE_LANGUAGE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

export function isSiteLanguage(value: unknown): value is SiteLanguage {
  return value === 'es' || value === 'en'
}

/**
 * The stored choice, or `null` when there is none.
 *
 * `null` is a real third state, not "Spanish": an absent preference lets each page use its own default, which is
 * what keeps the market default (and the crawler's view) intact. An unparseable value is treated as absent, never
 * as a third language.
 */
export function languagePreferenceFromCookies(
  read: (name: string) => string | null | undefined,
): SiteLanguage | null {
  const current = read(SITE_LANGUAGE_COOKIE)
  if (isSiteLanguage(current)) return current
  const legacy = read(LEGACY_SELLER_LOCALE_COOKIE)
  if (isSiteLanguage(legacy)) return legacy
  return null
}

/** Parse a raw `document.cookie` / `Cookie:` header string into the stored choice. */
export function languagePreferenceFromCookieHeader(header: string | null | undefined): SiteLanguage | null {
  const jar = new Map<string, string>()
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    // First occurrence wins, matching how browsers order a host cookie before a parent-domain one.
    if (name && !jar.has(name)) jar.set(name, part.slice(eq + 1).trim())
  }
  return languagePreferenceFromCookies((name) => jar.get(name))
}

const PLATFORM_DOMAIN = 'miyagisanchez.com'

/**
 * The `Domain=` attribute for the cookie on this host, or `null` for host-only.
 *
 * On the apex and every `<shop>.miyagisanchez.com` subdomain the choice is written to the parent domain, so a
 * visitor who picks English on a shop's subdomain still reads English on the marketplace, and the reverse. A
 * merchant's own custom domain cannot share a cookie with ours, so there it stays host-only. Local and preview hosts
 * are host-only too: a `Domain=` that does not match the host is silently dropped by the browser.
 */
export function languageCookieDomain(hostname: string | null | undefined): string | null {
  const host = (hostname ?? '').toLowerCase().split(':')[0]
  if (host === PLATFORM_DOMAIN || host.endsWith(`.${PLATFORM_DOMAIN}`)) return `.${PLATFORM_DOMAIN}`
  return null
}

/** The `document.cookie` assignment string that stores `language` for this host. */
export function serializeLanguageCookie(language: SiteLanguage, hostname: string | null | undefined): string {
  const domain = languageCookieDomain(hostname)
  return [
    `${SITE_LANGUAGE_COOKIE}=${language}`,
    'path=/',
    `max-age=${SITE_LANGUAGE_COOKIE_MAX_AGE}`,
    'samesite=lax',
    ...(domain ? [`domain=${domain}`] : []),
  ].join('; ')
}

/**
 * Pages whose language is part of their address, and their twin in the other language.
 *
 * Exact paths only. A path not listed here is a preference-rendered page: the switch re-renders it in place.
 */
export const URL_LANGUAGE_TWINS: Readonly<Record<string, { language: SiteLanguage; twin: string }>> = Object.freeze({
  '/': { language: 'es', twin: '/en' },
  '/en': { language: 'en', twin: '/' },
  '/us/sell': { language: 'en', twin: '/us/vende' },
  '/us/vende': { language: 'es', twin: '/us/sell' },
})

/**
 * Spanish-only seller pitches (`/mx/vende/<persona>`, `/mx/precios` is NOT one — it is market chrome). They have no
 * English twin; their English telling is the English builder, so choosing English there goes to `/en`.
 */
const SPANISH_ONLY_PITCH = /^\/mx\/vende(?:\/|$)/

function normalizePath(pathname: string): string {
  const path = (pathname || '/').split(/[?#]/)[0]
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/** The language a page's ADDRESS fixes, or `null` when the page renders in the visitor's preference. */
export function urlLanguage(pathname: string): SiteLanguage | null {
  const path = normalizePath(pathname)
  const twin = URL_LANGUAGE_TWINS[path]
  if (twin) return twin.language
  if (SPANISH_ONLY_PITCH.test(path)) return 'es'
  return null
}

/**
 * Where choosing `language` on `pathname` should take the visitor.
 *
 *   · a URL-language page in the other language ⇒ its twin (or `/en` for a Spanish-only pitch)
 *   · anything else ⇒ `null`: stay, store the choice, re-render in place
 */
export function languageSwitchTarget(pathname: string, language: SiteLanguage): string | null {
  const path = normalizePath(pathname)
  const fixed = urlLanguage(path)
  if (!fixed || fixed === language) return null
  const twin = URL_LANGUAGE_TWINS[path]
  if (twin) return twin.twin
  return language === 'en' ? URL_LANGUAGE_TWINS['/'].twin : null
}
