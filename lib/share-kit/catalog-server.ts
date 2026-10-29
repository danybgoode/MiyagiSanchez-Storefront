import 'server-only'

import { readShopListings } from '@/lib/listings'
import { readPublicSellerMarket } from '@/lib/owned-market'
import { isShopSlug } from '@/lib/share-link'
import { resolveShopPresentation, type ShopPresentationContext } from '@/lib/shop-presentation/context'
import { buildCatalogModel, type CatalogModel } from './catalog'

/**
 * The catalog model for a resolved shop context (share-kit D6), or null when the shop has no catalog — not a Mexico
 * shop (D5). The page, the print page and the PDF route all call THIS, so they print the same model.
 */
export async function catalogFor(ctx: ShopPresentationContext): Promise<CatalogModel | null> {
  if (readPublicSellerMarket(ctx.shop)?.market_code !== 'mx') return null
  const { listings, complete } = await readShopListings(ctx.shop.slug)
  return buildCatalogModel({ shop: ctx.shop, listings, complete })
}

/**
 * The public catalog model of a shop by slug, through the same resolver the catalog page uses (an unknown,
 * preview-private or non-Mexico shop is null). The PDF route, the Meta feed route and the `get_share_kit` MCP tool all
 * read THIS, so none of them can publish a shop the catalog page would not show.
 */
export async function publicCatalogModel(slug: string): Promise<CatalogModel | null> {
  if (!isShopSlug(slug)) return null
  const ctx = await resolveShopPresentation(slug, { marketBasePath: '/mx', market: 'mx' })
  return ctx ? catalogFor(ctx) : null
}
