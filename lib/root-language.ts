/**
 * lib/root-language.ts — which of the two root documents a browser should read.
 *
 * The market selector exists in exactly two languages, at two static URLs: `/` in
 * Spanish and `/en` in English. This is the pure function that turns a browser's
 * stated language preferences into a choice between them, and nothing else. It
 * decides a DOCUMENT, never a market: `recommendedMarketForLocale` still owns the
 * "suggested by your browser" badge, and a visitor who reads English is not
 * thereby a United States seller — plenty of them are in Mexico.
 *
 * ── Why a second URL rather than one page that swaps text ────────────────────
 * `/` is a statically prerendered CDN asset and has to stay one: the marketplace
 * homepage once cold-started ~30 s as a per-request function, and the fix was a
 * route-group split plus client-gated chrome (`Roadmap/LEARNINGS.md`,
 * marketplace-static-shell). Reading `Accept-Language` on the server would undo
 * that, and it would not survive the edge anyway — Cloudflare fronts Cloud Run and
 * does not vary its cache key on arbitrary request headers, so one visitor's
 * language would be served to everyone behind the same cache entry.
 *
 * Two prerendered documents avoid both problems. The whole page is translated,
 * chrome included, because each root sits under its own market layout; each URL is
 * separately indexable and `hreflang`-linked; and the only thing that happens at
 * runtime is a client-side hop between two static pages.
 *
 * ── Why the region subtag is ignored here ────────────────────────────────────
 * `recommendedMarketForLocale` reads ONLY the region, because a market is a
 * country. This reads only the LANGUAGE, for the same reason inverted: `es-US` is
 * a Spanish speaker in the United States and `en-MX` is an English speaker in
 * Mexico, and both are common. Language picks the document; region picks the
 * market badge; neither stands in for the other.
 */

export type RootLanguage = 'es' | 'en'

/** The Spanish document, and the default for anything unreadable. */
export const DEFAULT_ROOT_LANGUAGE: RootLanguage = 'es'

/** Where each language's selector lives. The ONE place that knows. */
export const ROOT_LANGUAGE_PATHS: Readonly<Record<RootLanguage, string>> = Object.freeze({
  es: '/',
  en: '/en',
})

/**
 * `['es-MX', 'en']` → `'es'`, `['en-US', 'es']` → `'en'`, `[]` → `'es'`.
 *
 * FIRST match wins, walking the list in the browser's own priority order, so a
 * visitor whose primary language is English but who also lists Spanish gets the
 * English document — the opposite (any Spanish anywhere ⇒ Spanish) would hand the
 * Spanish page to most bilingual users who chose otherwise in their OS settings.
 *
 * Anything that is neither Spanish nor English — the majority of the world's
 * languages — falls to Spanish, which is this platform's canonical locale
 * (AGENTS rule 5) and the language of its only operating consumer market. That is
 * a deliberate default, not a claim that the visitor reads Spanish; the switcher
 * is one click away and is rendered on both documents for exactly this reason.
 */
export function preferredRootLanguage(
  languages: readonly (string | null | undefined)[] | null | undefined,
): RootLanguage {
  for (const tag of languages ?? []) {
    const language = (tag ?? '').trim().toLowerCase().split(/[-_]/)[0]
    if (language === 'es') return 'es'
    if (language === 'en') return 'en'
  }
  return DEFAULT_ROOT_LANGUAGE
}

/**
 * Should a visitor currently reading `current` be moved to the other document?
 *
 * Total, and deliberately NOT symmetric-by-accident: it returns a target only when
 * the preference differs from what is already on screen, so the two documents can
 * never bounce a visitor back and forth. `/` moves a visitor away only when they
 * prefer English, `/en` only when they prefer Spanish, and an explicit choice
 * (`chosen`) stops both — a person who clicked the switcher has out-voted their
 * browser's settings, and re-deciding for them on the next page load would make the
 * switcher look broken.
 */
export function rootLanguageRedirect(input: {
  current: RootLanguage
  languages: readonly (string | null | undefined)[] | null | undefined
  chosen?: string | null
}): string | null {
  if (input.chosen === 'es' || input.chosen === 'en') return null
  const preferred = preferredRootLanguage(input.languages)
  if (preferred === input.current) return null
  return ROOT_LANGUAGE_PATHS[preferred]
}

/**
 * The shop builder's hop (one-front-door-both-markets D16) — the same two documents, one more rule.
 *
 * `/` is the Spanish builder and `/en` the English one. A browser that prefers English is moved from `/` to `/en`
 * ONLY when nothing in its list says Mexico: an `en-MX` phone is common in Mexico, and root-shop-builder-home D5
 * found that hopping it would skip the Mexican pitch entirely. `/en` → `/` stays the plain language rule. A stored
 * choice (`chosen`) wins over both, exactly as `rootLanguageRedirect` says.
 */
export function builderLanguageRedirect(input: {
  current: RootLanguage
  languages: readonly (string | null | undefined)[] | null | undefined
  chosen?: string | null
}): string | null {
  const target = rootLanguageRedirect(input)
  if (target !== ROOT_LANGUAGE_PATHS.en) return target
  const saysMexico = (input.languages ?? []).some((tag) => /[-_]mx$/i.test((tag ?? '').trim()))
  return saysMexico ? null : target
}
