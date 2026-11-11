import 'server-only'

/**
 * Living Shop — one shop-presentation context per render (epic 07, Sprint 3).
 *
 * Every section route needs the same six things: the Medusa seller, the Supabase
 * mirror row, the persisted settings, the normalized section config, what each
 * section actually has behind it, and the channel-correct base path. Six routes
 * × two channel variants deriving that independently is twelve chances to get
 * the base path or the preview guard wrong — so it is derived HERE, once.
 *
 * It also holds the two guards every public shop surface must pass: a shop that
 * does not exist, and a preview-private shop that has not consented to being
 * public. Both answer `null`, and the caller `notFound()`s.
 */

import { getShop, getShopCollections } from '@/lib/listings'
import { isShopPreviewPrivateBySlug } from '@/lib/preview-access'
import { isLikelyShopSlug } from '@/lib/route-shape'
import { resolvePublicWallShop } from '@/lib/wall/store'
import { resolveMarketPresentation } from '@/lib/market-presentation'
import { readPublicSellerMarket } from '@/lib/owned-market'
import { readableTextOn } from '@/lib/platform-theme'
import { normalizeSections } from './sections'
import { resolveTheme } from './theme'
import { shopListingBase } from './chrome'
import { resolveSectionAvailability } from './availability'
import type { SectionConfig, SectionAvailability, ResolvedTheme } from './types'
import type { Shop } from '@/lib/types'
import type { MarketCode } from '@/lib/markets'

export interface ShopPresentationContext {
  shop: Shop
  /** The Supabase mirror row's id — Wall entries and events reference it. Null when unmirrored. */
  wallShopId: string | null
  settings: Record<string, unknown>
  sections: SectionConfig
  availability: SectionAvailability
  collections: Array<{ id: string; handle: string; name: string; sort_order: number }>
  /** The merchant's resolved look — one derivation, shared by every shop surface. */
  theme: ResolvedTheme
  /** Where the SHOP's own routes live: `''` on an owned host, `/mx/s/<slug>` otherwise. */
  basePath: string
  /**
   * Where a PRODUCT lives — decided by `shopListingBase`: `''` on an owned host,
   * the shop base on the Mexico marketplace (the shop-scoped PDP), the market
   * base elsewhere. Kept as its own field so no call site guesses. See `ShopBases`.
   */
  listingBase: string
  accent: string
  accentTextColor: string
  htmlLang: string
  onOwnedHost: boolean
}

/**
 * The nav slice for a page that ALREADY has the shop object.
 *
 * The existing content and collection pages (`/acerca`, `/faq`, `/politicas`,
 * `/c/[handle]`) each receive `shop` and `basePath` from their own route and
 * render through one shared body. Threading the full context down would have
 * meant editing twelve route files to pass a prop that the body can derive from
 * what it already holds — so it derives it, and Story 3.5's "reuse the unified
 * nav" costs those pages one events query instead of a refactor.
 */
export async function resolveShopNav(shop: Shop): Promise<{
  sections: SectionConfig
  availability: SectionAvailability
  theme: ResolvedTheme
  accent: string
  accentTextColor: string
}> {
  const settings = ((shop.metadata as Record<string, unknown> | null)?.settings ?? {}) as Record<string, unknown>
  const [wallShop, collections] = await Promise.all([
    resolvePublicWallShop(shop.slug),
    getShopCollections(shop.slug),
  ])
  const theme = (settings.theme ?? {}) as { accent_color?: string | null }
  return {
    sections: normalizeSections(settings.sections),
    availability: await resolveSectionAvailability({
      shopId: wallShop?.id ?? null,
      settings,
      collectionCount: collections.length,
    }),
    theme: resolveTheme(settings),
    accent: theme.accent_color ?? 'var(--color-accent)',
    accentTextColor: readableTextOn(theme.accent_color ?? undefined),
  }
}

/**
 * Resolve the context for a section route.
 *
 * `slug` comes from the URL on the marketplace and from the unspoofable
 * `x-miyagi-shop-slug` header on an owned host — middleware sets that header and
 * strips any a client tried to inject, which is what makes the owned-host branch
 * a boundary rather than a suggestion.
 */
export interface ShopPresentationOptions {
  /** `/mx`, `/us`, or `''` for the unprefixed marketplace and owned hosts. */
  marketBasePath?: string
  /**
   * The country market this route serves, when it serves one.
   *
   * An OBJECT argument rather than a positional one so the literal
   * `market: 'mx'` appears in each wrapper's source — that is what
   * `market-route-population.spec.ts` greps for, and a decision that is only
   * inferable from a URL prefix is exactly what it exists to catch.
   */
  market?: MarketCode
  /** Explicit tenant identity supplied only by a dynamic owned-host adapter. */
  ownedShopSlug?: string | null
}

export async function resolveShopPresentation(
  slug: string | null,
  options: ShopPresentationOptions = {},
): Promise<ShopPresentationContext | null> {
  const { marketBasePath = '', market, ownedShopSlug: channelSlug = null } = options
  const onOwnedHost = !!channelSlug
  const resolvedSlug = channelSlug ?? slug

  if (!resolvedSlug || !isLikelyShopSlug(resolvedSlug)) return null

  const shop = await getShop(resolvedSlug, market)
  if (!shop) return null
  // A MARKET DECISION, not just a URL prefix. Without this, `/mx/s/<us-shop>/tienda`
  // would happily render a US merchant's catalog under the Mexico prefix — the
  // shop homepage has always refused that and every section route must too.
  // `market-route-population.spec.ts` is what caught this missing.
  if (market && readPublicSellerMarket(shop)?.market_code !== market) return null
  if (await isShopPreviewPrivateBySlug(shop.slug, shop.clerk_user_id)) return null

  const [wallShop, collections] = await Promise.all([
    resolvePublicWallShop(shop.slug),
    getShopCollections(shop.slug, market),
  ])

  const settings = ((shop.metadata as Record<string, unknown> | null)?.settings ?? {}) as Record<string, unknown>
  const sections = normalizeSections(settings.sections)
  const availability = await resolveSectionAvailability({
    shopId: wallShop?.id ?? null,
    settings,
    collectionCount: collections.length,
  })

  const theme = (settings.theme ?? {}) as { accent_color?: string | null }
  const accent = theme.accent_color ?? 'var(--color-accent)'
  const presentationMarket = market ?? readPublicSellerMarket(shop)?.market_code ?? 'mx'

  return {
    shop,
    wallShopId: wallShop?.id ?? null,
    settings,
    sections,
    availability,
    collections,
    theme: resolveTheme(settings),
    basePath: onOwnedHost ? '' : `${marketBasePath}/s/${shop.slug}`,
    listingBase: shopListingBase({ onOwnedHost, marketBasePath, shopSlug: shop.slug }),
    accent,
    accentTextColor: readableTextOn(theme.accent_color ?? undefined),
    htmlLang: resolveMarketPresentation(presentationMarket).htmlLang,
    onOwnedHost,
  }
}
