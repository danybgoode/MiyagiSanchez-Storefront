import { getLanguagePreference } from '@/lib/site-language-server'
import { headers } from 'next/headers'
import SellerShellChrome from '@/app/(shell)/shop/manage/_components/SellerShellChrome'
import SellerCopyBoundary from '@/app/components/SellerCopyBoundary'
import SellerFormatProvider from '@/app/components/SellerFormatProvider'
import { getDictionary } from '@/lib/dictionary'
import { getMySeller } from '@/lib/get-my-seller'
import { sellShellEligible } from '@/lib/seller-shell-gate'
import { resolveSellerLocale, sellerCopyBoundaryNeeded } from '@/lib/seller-locale'
import { sellerFormatContextForMarket } from '@/lib/seller-format'

/**
 * Seller shell over `/sell` + `/sell/setup` for a signed-in shop owner
 * (catalog-management epic, Sprint 6 · Story 6.1).
 *
 * Mirrors `app/(shell)/shop/manage/layout.tsx`'s whiteLabel-defer shape exactly
 * — same headers, same boolean, same "no double-suppression" guarantee. The
 * root `app/(shell)/layout.tsx` already computes the identical
 * `sellShellEligible(platformPath)` result (memoized per-request via React
 * `cache()`, so this call shares that one evaluation rather than re-running it)
 * to decide whether to suppress buyer chrome; THIS layout is what actually
 * fills the resulting bare `<main>` with the seller shell, exactly the same
 * "root suppresses, nested layout fills" composition `shop/manage/layout.tsx`
 * already uses.
 *
 * Applies to every route under `app/(shell)/sell/` (Next.js layout scoping),
 * but `sellShellEligible`'s own pure fast-path (`isSellShellCandidatePath`)
 * only ever returns true for the exact `/sell`/`/sell/setup` strings — sibling
 * routes like `/sell/edit/[id]` and `/sell/print/[editionId]` fall through to
 * `<>{children}</>` unaffected, unchanged from today.
 */
export default async function SellLayout({ children }: { children: React.ReactNode }) {
  const hdrs = await headers()
  const isEmbed = hdrs.get('x-miyagi-embed') === '1'
  const channel = hdrs.get('x-miyagi-channel')
  const isChannel = channel === 'custom' || channel === 'subdomain'
  const whiteLabel = isEmbed || isChannel
  const seller = await getMySeller()
  const market = seller?.market ?? 'mx'
  const locale = resolveSellerLocale({
    preference: await getLanguagePreference(),
    market,
  })

  const platformPath = hdrs.get('x-miyagi-path') ?? '/'
  const eligible = await sellShellEligible(platformPath)

  const shell = whiteLabel || !eligible
    ? children
    : <SellerShellChrome>{children}</SellerShellChrome>

  // Same three facts, same reason as shop/manage/layout.tsx: the copy boundary
  // cannot reach a formatted number, so language/currency/clock arrive here. A
  // context provider emits no DOM, so Spanish stays the byte-for-byte identity.
  const content = (
    <SellerFormatProvider context={sellerFormatContextForMarket(locale, market)}>
      {shell}
    </SellerFormatProvider>
  )

  // Spanish is the authored tree, byte for byte (see shop/manage/layout.tsx —
  // same resolver, same three states). The shop's Medusa market is the default;
  // the seller's stored choice is what actually decides.
  if (!sellerCopyBoundaryNeeded(locale)) return content

  const copy = (await getDictionary(locale)).sellerCopy

  return <SellerCopyBoundary locale={locale} copy={copy}>{content}</SellerCopyBoundary>
}
