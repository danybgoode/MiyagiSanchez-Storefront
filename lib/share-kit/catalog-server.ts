import 'server-only'

import { getShopListings } from '@/lib/listings'
import { readPublicSellerMarket } from '@/lib/owned-market'
import type { ShopPresentationContext } from '@/lib/shop-presentation/context'
import { buildCatalogModel, type CatalogModel } from './catalog'

/**
 * The catalog model for a resolved shop context (share-kit D6), or null when the shop has no catalog — not a Mexico
 * shop (D5). The page, the print page and the PDF route all call THIS, so they print the same model.
 */
export async function catalogFor(ctx: ShopPresentationContext): Promise<CatalogModel | null> {
  if (readPublicSellerMarket(ctx.shop)?.market_code !== 'mx') return null
  const listings = await getShopListings(ctx.shop.slug)
  return buildCatalogModel({ shop: ctx.shop, listings })
}
