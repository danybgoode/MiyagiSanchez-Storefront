import { BuyerCopyText } from '@/app/components/BuyerPresentationContext'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import ShopSectionNav from '@/app/(shell)/_shop-sections/ShopSectionNav'
import ShopThemeShell from '@/app/(shell)/_shop-sections/ShopThemeShell'
import { resolveShopNav } from '@/lib/shop-presentation/context'
import { getDictionary } from '@/lib/dictionary'
import { resolveMarketPresentation } from '@/lib/market-presentation'
import type { SiteLanguage } from '@/lib/site-language'
import { readPublicSellerMarket } from '@/lib/owned-market'
import { authoredAboutBody } from '@/lib/shop-content'
import type { Shop } from '@/lib/types'

/**
 * Shared body for both Acerca routes (own-shop premium presentation, Sprint 3):
 *  - `app/(shell)/s/[slug]/acerca/page.tsx` — marketplace path.
 *  - `app/(shell)/acerca/page.tsx` — channel path (subdomain/custom domain),
 *    shop already resolved from the unspoofable `x-miyagi-shop-slug` header;
 *    falls through to the platform About page when that header is absent.
 *
 * Unauthored (`about.body` empty) → notFound() — never a dead nav link, since
 * the nav only links here when `about.body` is truthy.
 */
export default async function AcercaBody({ shop, basePath, language }: { shop: Shop; basePath: string; language?: SiteLanguage | null }) {
  // Story 3.5 — this page is part of the shop site, not an orphan footer link,
  // so it renders the SAME nav as the Wall and the catalog.
  const nav = await resolveShopNav(shop)
  const market = readPublicSellerMarket(shop)?.market_code ?? 'mx'
  const navCopy = (await getDictionary(resolveMarketPresentation(market, language).language)).buyerCopy
  const settings = ((shop.metadata as Record<string, unknown> | null)?.settings ?? {}) as Record<string, unknown>
  const about = settings.about as { body?: string } | null | undefined
  const body = authoredAboutBody(about)
  if (!body) notFound()

  return (
    <ShopThemeShell theme={nav.theme} accent={nav.accent}>
    <div className="max-w-2xl mx-auto px-4 py-8">
      <ShopSectionNav
        shopName={shop.name}
        logoUrl={shop.logo_url ?? null}
        config={nav.sections}
        availability={nav.availability}
        basePath={basePath}
        active="about"
        accent={nav.accent}
        activeTextColor={nav.accentTextColor}
        copy={navCopy}
      />
      <Link href={basePath || '/'} className="text-sm text-[var(--color-muted)] no-underline hover:underline">
        ← {shop.name}
      </Link>
      <h1 className="text-xl font-bold mt-3 mb-4"><BuyerCopyText copyKey="shop.content.AcercaBody.1a7485f9" />{' '}{shop.name}</h1>
      <p className="text-sm leading-relaxed whitespace-pre-line">{body}</p>
    </div>
    </ShopThemeShell>
  )
}
