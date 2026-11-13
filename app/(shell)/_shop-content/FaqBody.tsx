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
import { wellFormedFaqItems } from '@/lib/shop-content'
import type { Shop } from '@/lib/types'

/**
 * Shared body for both FAQ routes (own-shop premium presentation, Sprint 3):
 *  - `app/(shell)/s/[slug]/faq/page.tsx` — marketplace path.
 *  - `app/(shell)/faq/page.tsx` — channel path (subdomain/custom domain).
 *
 * Unauthored (no well-formed `faq.items`) → notFound() — never a dead nav
 * link. `wellFormedFaqItems` filters out any row missing a question/answer
 * (defense against a non-editor write path persisting a blank row).
 */
export default async function FaqBody({ shop, basePath, language }: { shop: Shop; basePath: string; language?: SiteLanguage | null }) {
  // Story 3.5 — this page is part of the shop site, not an orphan footer link,
  // so it renders the SAME nav as the Wall and the catalog.
  const nav = await resolveShopNav(shop)
  const market = readPublicSellerMarket(shop)?.market_code ?? 'mx'
  const navCopy = (await getDictionary(resolveMarketPresentation(market, language).language)).buyerCopy
  const settings = ((shop.metadata as Record<string, unknown> | null)?.settings ?? {}) as Record<string, unknown>
  const faq = settings.faq as { items?: Array<{ question?: string; answer?: string }> } | null | undefined
  const items = wellFormedFaqItems(faq?.items)
  if (items.length === 0) notFound()

  return (
    <ShopThemeShell theme={nav.theme} accent={nav.accent}>
    <div className="max-w-2xl mx-auto px-4 py-8">
      <ShopSectionNav
        shopName={shop.name}
        logoUrl={shop.logo_url ?? null}
        config={nav.sections}
        availability={nav.availability}
        basePath={basePath}
        active="faq"
        accent={nav.accent}
        activeTextColor={nav.accentTextColor}
        copy={navCopy}
      />
      <Link href={basePath || '/'} className="text-sm text-[var(--color-muted)] no-underline hover:underline">
        ← {shop.name}
      </Link>
      <h1 className="text-xl font-bold mt-3 mb-4"><BuyerCopyText copyKey="shop.content.FaqBody.8ff896c4" /></h1>
      <div className="space-y-4">
        {items.map((item, i) => (
          <div key={i} className="border border-[var(--color-border)] rounded-lg p-4">
            <p className="text-sm font-semibold mb-1">{item.question}</p>
            <p className="text-sm text-[var(--color-muted)] leading-relaxed whitespace-pre-line">{item.answer}</p>
          </div>
        ))}
      </div>
    </div>
    </ShopThemeShell>
  )
}
