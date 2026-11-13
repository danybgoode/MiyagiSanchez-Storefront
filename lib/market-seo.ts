/**
 * lib/market-seo.ts — canonical, hreflang and x-default for the market surfaces.
 *
 * Epic 07 · market-architecture-foundation, Story 2.4. The contract:
 *
 *   /     the master-brand market selector → `x-default`, self-canonical
 *   /mx   the Mexico marketplace           → self-canonical, `es-MX`
 *   /us   the US marketplace (Sprint 3)     → self-canonical, `en-US`
 *
 * ── Two rules that are easy to get wrong, so they are encoded rather than
 *    remembered ───────────────────────────────────────────────────────────────
 *
 * 1. AN ALTERNATE IS A PROMISE THAT A PAGE EXISTS. Emitting
 *    `hreflang="en-US" href="…/us"` before `/us` is a real route points every
 *    crawler that honours it at a 404 — a worse signal than no signal. So the
 *    language alternates are derived from `MARKET_LANDING_PAGES`, the markets
 *    that actually have a landing route today, and `e2e/market-seo.spec.ts`
 *    asserts each listed market really has `app/(site)/<code>/page.tsx` on disk.
 *    The list is therefore mechanically checked, not hand-trusted, and Sprint 3
 *    adding `/us` is a one-word change that its own spec verifies.
 *
 * 2. A CATALOG PAGE EMITS NO LANGUAGE ALTERNATES AT ALL. Market catalogs contain
 *    different inventories, so `/mx/l/<id>` and `/us/l/<id>` are not translations
 *    of one resource. Those pages get a self-canonical and nothing else.
 *
 * `/us-eng` (or any language-in-the-market-segment spelling) is not produced by
 * anything here: locale is a FIELD ON a market record, never a URL segment
 * (`lib/markets.ts`, D3). A spec asserts its absence, because the absence is the
 * point.
 *
 * PURE apart from the `Metadata` type import — no request state, no env, so the
 * static `/` and ISR `/mx` renders stay static.
 */

import type { Metadata } from 'next'
import { MARKETS, marketBasePath, requireMarket, type MarketCode } from './markets'
import { ROOT_LANGUAGE_PATHS, type RootLanguage } from './root-language'

/** The canonical platform origin for every marketplace URL. */
export const SITE_ORIGIN = 'https://miyagisanchez.com'

/**
 * Markets that have a real landing page in the route tree today.
 *
 * Sprint 3 adds `'us'` here in the same commit that creates
 * `app/(site)/us/page.tsx` — and cannot add it earlier, because the spec checks
 * the file exists. See rule 1 in the module header.
 */
export const MARKET_LANDING_PAGES: readonly MarketCode[] = ['mx', 'us']

/** Absolute URL for a platform path. */
export function absoluteUrl(pathname: string): string {
  return `${SITE_ORIGIN}${pathname.startsWith('/') ? pathname : `/${pathname}`}`
}

/** `{ 'es-MX': 'https://…/mx', … }` for every market whose landing page exists. */
function landingLanguageAlternates(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const code of MARKET_LANDING_PAGES) {
    out[MARKETS[code].default_locale] = absoluteUrl(marketBasePath(code))
  }
  // The selector is the language-neutral entry point: a visitor whose locale
  // matches no market lands there and chooses, rather than being guessed at.
  out['x-default'] = absoluteUrl('/')
  return out
}

/**
 * Metadata for a master-brand selector document — `/` in Spanish, `/en` in English.
 *
 * Each is SELF-canonical: they are two real pages with the same content in two
 * languages, not one page and a redirect, and telling a crawler that `/en`
 * canonicalizes to `/` would ask it to drop the English document from the index
 * entirely — the opposite of why it exists.
 *
 * The `languages` map carries both levels, and the distinction is the point:
 *
 *   · bare `es` / `en` → the two SELECTOR documents. A language, no country: this
 *     is the page for a reader, before they have chosen a market.
 *   · `es-MX` / `en-US` → the two MARKET landings. A language AND a country, with
 *     that country's currency, payments and shipping behind it.
 *
 * `x-default` stays `/`, the Spanish selector: it is the right destination for any
 * locale we do not operate in, which is most of them, and it offers the switcher.
 */
export function rootSelectorMetadata(language: RootLanguage): Pick<Metadata, 'alternates'> {
  return {
    alternates: {
      canonical: absoluteUrl(ROOT_LANGUAGE_PATHS[language]),
      languages: {
        es: absoluteUrl(ROOT_LANGUAGE_PATHS.es),
        en: absoluteUrl(ROOT_LANGUAGE_PATHS.en),
        ...landingLanguageAlternates(),
      },
    },
  }
}

/**
 * The shop builder's language pair (one-front-door-both-markets D16): `/` in Spanish, `/en` in English, `x-default`
 * `/`. Its OWN set, not the selector's: that one also names `/mx` and `/us` as the `es-MX` / `en-US` documents, which
 * would tell a crawler the Mexican-Spanish telling of the builder is the marketplace (fresh review, PR #499).
 */
export function builderLanguageMetadata(language: RootLanguage): Pick<Metadata, 'alternates'> {
  return {
    alternates: {
      canonical: absoluteUrl(ROOT_LANGUAGE_PATHS[language]),
      languages: {
        es: absoluteUrl(ROOT_LANGUAGE_PATHS.es),
        en: absoluteUrl(ROOT_LANGUAGE_PATHS.en),
        'x-default': absoluteUrl(ROOT_LANGUAGE_PATHS.es),
      },
    },
  }
}

/** The Spanish selector's metadata. Kept as its own name because `/` is the entry point every caller means. */
export function selectorMetadata(): Pick<Metadata, 'alternates'> {
  return rootSelectorMetadata('es')
}

/**
 * Metadata for a market's landing page (`/mx`, and `/us` in Sprint 3).
 *
 * Self-canonical, plus the same language map — so `/mx` names itself as the
 * `es-MX` surface and `/` as `x-default`, which is the reciprocity crawlers
 * expect.
 */
export function marketLandingMetadata(market: MarketCode): Pick<Metadata, 'alternates'> {
  const record = requireMarket(market)
  return {
    alternates: {
      canonical: absoluteUrl(marketBasePath(record.code)),
      languages: landingLanguageAlternates(),
    },
  }
}

/**
 * Self-canonical for a market-scoped CATALOG page (browse, PDP, shop).
 *
 * No `languages` key at all — see rule 2 in the module header. `pathname` is the
 * already-market-prefixed platform path (`/mx/l/prod_…`).
 */
export function marketCatalogCanonical(pathname: string): Pick<Metadata, 'alternates'> {
  return { alternates: { canonical: absoluteUrl(pathname) } }
}
