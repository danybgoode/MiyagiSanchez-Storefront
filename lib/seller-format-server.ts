import { getLanguagePreference } from './site-language-server'
import 'server-only'
import { cache } from 'react'
import { getMySeller } from './get-my-seller'
import { resolveSellerLocale } from './seller-locale'
import { sellerFormatContextForMarket, type SellerFormatContext } from './seller-format'
import { DEFAULT_MARKET } from './markets'

/**
 * The one server-side resolution of "what language, what money, what clock" for
 * the signed-in merchant.
 *
 * Both seller layouts and any SERVER component in the portal read it from here.
 * Server components cannot consume React context, so `SellerFormatProvider` is
 * not an option for them — they call `createSellerFormat()` on this result
 * directly. Keeping one function means the two answers cannot disagree.
 *
 * `cache()`-wrapped and built on `getMySeller` (itself `cache()`-wrapped), so the
 * extra callers cost no extra Medusa round-trip.
 */
export const getSellerFormatContext = cache(async (): Promise<SellerFormatContext> => {
  const seller = await getMySeller()
  const market = seller?.market ?? DEFAULT_MARKET
  const locale = resolveSellerLocale({
    preference: await getLanguagePreference(),
    market,
  })
  return sellerFormatContextForMarket(locale, market)
})
