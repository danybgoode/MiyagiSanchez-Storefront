import Link from 'next/link'
import { getShopListings } from '@/lib/listings'
import { deriveShopCollections } from '@/lib/collection-derive'
import ShopSectionNav from './ShopSectionNav'
import ShopThemeShell from './ShopThemeShell'
import { getDictionary } from '@/lib/dictionary'
import { resolveMarketPresentation } from '@/lib/market-presentation'
import { readPublicSellerMarket } from '@/lib/owned-market'
import type { ShopPresentationContext } from '@/lib/shop-presentation/context'

/**
 * Living Shop — the Collections index (epic 07, Story 3.1/3.2).
 *
 * A destination that lists the merchant's collections, so "Colecciones" in the
 * nav opens onto something rather than being a chip strip with nowhere to go.
 * The collections themselves keep their SHIPPED routes (`/c/[handle]`), which is
 * the "evolve, don't fork" rule from the scope's reuse list — nothing about a
 * collection page changes here.
 *
 * Counts come from `deriveShopCollections`, the same helper the chip strip uses,
 * so a collection's size is one number computed one way. Two derivations of the
 * same count is how a "3 artículos" chip ends up next to a page holding four.
 */

export default async function CollectionsIndexBody({ ctx }: { ctx: ShopPresentationContext }) {
  const market = readPublicSellerMarket(ctx.shop)?.market_code ?? 'mx'
  const dict = await getDictionary(resolveMarketPresentation(market, ctx.language).language)
  const copy = dict.buyerCopy

  const listings = await getShopListings(ctx.shop.slug)
  // The helper's first entry is the synthetic "Todos" chip — a filter, not a
  // collection, so it has no place on a list OF collections.
  const entries = deriveShopCollections(listings, ctx.collections, ctx.basePath, ctx.shop.slug)
    .filter((entry) => entry.shortSlug !== null)

  return (
    <ShopThemeShell theme={ctx.theme} accent={ctx.accent}>
    <div className="pb-12">
      <ShopSectionNav
        shopName={ctx.shop.name}
        logoUrl={ctx.shop.logo_url ?? null}
        config={ctx.sections}
        availability={ctx.availability}
        basePath={ctx.basePath}
        active="collections"
        accent={ctx.accent}
        activeTextColor={ctx.accentTextColor}
        copy={copy}
      />

      <div className="max-w-4xl mx-auto px-4">
        <h1 className="text-xl font-bold mb-4">{copy['shopSections.collectionsTitle']}</h1>

        {entries.length === 0 ? (
          <p className="text-center py-16 text-[var(--color-muted)]">{copy['shopSections.collectionsEmpty']}</p>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3 list-none p-0 m-0">
            {entries.map((entry) => (
              <li key={entry.shortSlug ?? entry.href}>
                <Link
                  href={entry.href}
                  className="flex items-center justify-between gap-3 p-4 rounded-xl border border-[var(--color-border)] no-underline text-[var(--color-text)] hover:border-[var(--color-text)] transition-colors"
                >
                  <span className="font-medium">{entry.label}</span>
                  <span className="text-sm text-[var(--color-muted)]">
                    {entry.count === 1
                      ? copy['shopSections.itemCountOne']
                      : copy['shopSections.itemCount'].replace('{0}', String(entry.count))}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
    </ShopThemeShell>
  )
}
