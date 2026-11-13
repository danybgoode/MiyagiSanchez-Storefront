/**
 * The builder's two languages and two market hints (epic one-front-door-both-markets D11, D12). Pure.
 *
 * A LOCALE is presentation only. A MARKET carries currency, payments and shipping, so the builder only ever HINTS a
 * market (it sets the example prices' currency) and the claim asks for the real choice (D13) — the same line
 * `MarketRecommendation` draws: a browser signal may recommend a market, never choose one.
 */

import type { ImportCurrency } from '../catalog-import'

export const P2S_LOCALES = ['es', 'en'] as const
export type P2sLocale = (typeof P2S_LOCALES)[number]

export const P2S_MARKET_HINTS = ['mx', 'us'] as const
export type P2sMarketHint = (typeof P2S_MARKET_HINTS)[number]

/** Anything → a locale. Absent or unknown is Spanish, the platform default (AGENTS rule 5). */
export function readLocale(value: unknown): P2sLocale {
  return value === 'en' ? 'en' : 'es'
}

/** Anything → a hint, or null. Null is "no hint", never "Mexico". */
export function readMarketHint(value: unknown): P2sMarketHint | null {
  return value === 'mx' || value === 'us' ? value : null
}

/** The currency example prices are suggested in. No hint suggests pesos, the market every draft used before. */
export function currencyFor(hint: P2sMarketHint | null): ImportCurrency {
  return hint === 'us' ? 'USD' : 'MXN'
}

/** Words the prompts use for that currency. */
export function currencyWords(hint: P2sMarketHint | null): { es: string; en: string; example: string } {
  return hint === 'us'
    ? { es: 'dólares estadounidenses (USD)', en: 'US dollars (USD)', example: '25 = $25' }
    : { es: 'pesos mexicanos', en: 'Mexican pesos', example: '1850 = $1,850' }
}

const US_TIMEZONES = /^America\/(New_York|Chicago|Denver|Phoenix|Los_Angeles|Anchorage|Detroit|Boise|Indiana\/|Kentucky\/|North_Dakota\/|Menominee|Juneau|Sitka|Nome|Yakutat|Metlakatla|Adak)|^Pacific\/Honolulu$/
const MX_TIMEZONES = /^America\/(Mexico_City|Cancun|Merida|Monterrey|Matamoros|Chihuahua|Ciudad_Juarez|Ojinaga|Mazatlan|Bahia_Banderas|Hermosillo|Tijuana)$/

/**
 * D12 — the browser's hint, for a page that does not belong to one market (`/`, `/en`). Timezone first: it is where
 * the phone IS, and an `en-US` phone in Monterrey is in Mexico. Then a language region. Anything else is no hint.
 */
export function browserMarketHint(input: { timeZone?: string | null; languages?: readonly string[] | null }): P2sMarketHint | null {
  const tz = input.timeZone ?? ''
  if (MX_TIMEZONES.test(tz)) return 'mx'
  if (US_TIMEZONES.test(tz)) return 'us'
  for (const lang of input.languages ?? []) {
    const region = lang.split('-')[1]?.toUpperCase()
    if (region === 'MX') return 'mx'
    if (region === 'US') return 'us'
  }
  return null
}
