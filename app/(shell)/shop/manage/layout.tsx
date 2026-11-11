import { headers } from 'next/headers'
import SellerShellChrome from './_components/SellerShellChrome'
import SellerCopyBoundary from '@/app/components/SellerCopyBoundary'
import SellerFormatProvider from '@/app/components/SellerFormatProvider'
import { getDictionary } from '@/lib/dictionary'
import { getMySeller } from '@/lib/get-my-seller'
import { cookies } from 'next/headers'
import { SELLER_LOCALE_COOKIE, resolveSellerLocale, sellerCopyBoundaryNeeded } from '@/lib/seller-locale'
import { sellerFormatContextForMarket } from '@/lib/seller-format'
import { PendingListingDeleteProvider } from '@/components/seller/PendingListingDeleteProvider'
import { retryShopCreatedWelcome } from '@/lib/shop-created-welcome'
import { auth } from '@clerk/nextjs/server'
import { ensureNegocioTrial } from '@/lib/plan-server'

/**
 * Seller-mode shell for `/shop/manage/*`.
 *
 * The root `app/layout.tsx` already suppresses the buyer header/footer/MobileTabBar
 * here (via `isSellerModePath`); this nested layout fills that space with
 * `SellerShellChrome` (the brand top bar + `SellerNav` rail/bar + its flag-safe
 * nav/badge data, extracted so `app/(shell)/sell/layout.tsx` can render the
 * identical shell for a signed-in shop owner — catalog-management epic, Sprint 6
 * · Story 6.1).
 *
 * Composition with white-label: on a custom domain/subdomain the root layout wraps
 * everything in `ChannelLayout`, so rendering the seller shell here too would stack
 * two shells. We detect white-label from the same middleware headers and defer —
 * the channel shell owns the chrome; manage just renders plain inside it. This is
 * the "no double-suppression" guarantee, enforced on both layers consistently.
 */
export default async function SellerManageLayout({ children }: { children: React.ReactNode }) {
  const hdrs = await headers()
  const isEmbed = hdrs.get('x-miyagi-embed') === '1'
  const channel = hdrs.get('x-miyagi-channel')
  const isChannel = channel === 'custom' || channel === 'subdomain'
  const whiteLabel = isEmbed || isChannel
  const seller = await getMySeller()
  // A failed creation-time send remains pending; the owner's next dashboard
  // visit retries it. Pre-existing shops have no delivery row and get nothing.
  if (seller) await retryShopCreatedWelcome(seller).catch((error) => {
    console.error('[shop/manage] shop welcome retry failed:', seller.id, error)
  })
  // The Negocio trial (`NEGOCIO_TRIAL_DAYS`) starts the first time the OWNER opens their panel (plans-gratis-negocio D4) — so a
  // promoter's unclaimed shop never spends it before the merchant claims it. Stamped once, guarded in the UPDATE;
  // a failure only delays the trial to the next visit, so it never blocks the panel.
  if (seller) {
    const { userId } = await auth()
    if (userId) await ensureNegocioTrial(userId).catch((error) => {
      console.error('[shop/manage] negocio trial stamp failed:', seller.id, error)
    })
  }
  const market = seller?.market ?? 'mx'
  const locale = resolveSellerLocale({
    preference: (await cookies()).get(SELLER_LOCALE_COOKIE)?.value,
    market,
  })

  const managedContent = <PendingListingDeleteProvider>{children}</PendingListingDeleteProvider>
  const shell = whiteLabel
    ? managedContent
    : <SellerShellChrome>{managedContent}</SellerShellChrome>

  // Numbers, dates and prices are NOT copy: the boundary substitutes text nodes
  // against a generated population, and a formatted amount has no letters to
  // match, so ~30 call sites here used to hardcode `es-MX` and stayed Spanish in
  // an English portal. This provider carries all three facts the formatters need
  // — the merchant's LANGUAGE, and the market's CURRENCY and CLOCK, which must
  // never follow the language (`lib/seller-format.ts`). It renders no DOM node,
  // so it sits ABOVE the Spanish early-return without touching the authored tree.
  const content = (
    <SellerFormatProvider context={sellerFormatContextForMarket(locale, market)}>
      {shell}
    </SellerFormatProvider>
  )

  // Spanish is the authored tree, byte for byte: no boundary and no dictionary are
  // introduced into its render path. The seller's stored choice decides, and the
  // shop's Medusa market is only the DEFAULT behind it — so an MX merchant can
  // read the portal in English and a US merchant in Spanish, which a
  // `market !== 'us'` check could not express in either direction.
  if (!sellerCopyBoundaryNeeded(locale)) return content

  const copy = (await getDictionary(locale)).sellerCopy

  // White-label host → the root ChannelLayout already owns the chrome. Render the
  // manage pages plainly inside it; no seller shell, no stacked bars.
  return <SellerCopyBoundary locale={locale} copy={copy}>{content}</SellerCopyBoundary>
}
