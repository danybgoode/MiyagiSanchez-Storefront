import 'server-only'
import { cache } from 'react'
import { cookies, headers } from 'next/headers'
import { languagePreferenceFromCookies, urlLanguage, type SiteLanguage } from './site-language'
import { resolveMarketPresentation, type MarketPresentation } from './market-presentation'

/**
 * The visitor's stored language choice for THIS request, or `null` when they have made none.
 *
 * Reading it opts the calling route into per-request rendering, on purpose: a render that depends on a cookie must
 * never be cached and handed to the next visitor (`lib/site-language.ts`). Memoised per request so the layout, the
 * chrome and the page body agree without each reading the jar.
 */
export const getLanguagePreference = cache(async (): Promise<SiteLanguage | null> => {
  const jar = await cookies()
  return languagePreferenceFromCookies((name) => jar.get(name)?.value)
})

/** A market's buyer presentation in the language this visitor chose (or the market's own, when they chose none). */
export async function buyerPresentation(market: unknown): Promise<MarketPresentation> {
  return resolveMarketPresentation(market, await getLanguagePreference())
}

/**
 * The language a per-request LAYOUT should render this page's chrome in.
 *
 * A page whose language is its address (`/us/sell`, `/us/vende`, `/mx/vende/*`) keeps that language whatever the
 * visitor stored — its body cannot change, and English chrome around a Spanish page is the inconsistency this
 * replaced; the switch on it navigates to the twin instead. Everything else follows the stored choice. The path
 * comes from `x-miyagi-path`, which middleware sets on every platform request and strips from clients.
 */
export async function layoutLanguage(): Promise<SiteLanguage | null> {
  const path = (await headers()).get('x-miyagi-path')
  return (path ? urlLanguage(path) : null) ?? (await getLanguagePreference())
}
