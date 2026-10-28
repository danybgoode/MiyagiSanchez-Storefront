/**
 * The share kit's one model of a shop's shareable catalog (share-kit D6).
 *
 * The catalog page, the print page behind the PDF and the Meta feed all render THIS, so they cannot disagree about
 * which products a shop shares, what they cost or where an order goes. It is built from `getShopListings(slug)` — the
 * shop's own channel, already filtered upstream (published only, hidden and print-placement products dropped, an
 * unadmitted seller 404s; D1). It adds no second visibility rule; the one guard it does add is the two-shop one (D7).
 *
 * Pure: no `server-only`, no `next/*`, relative imports only, so the `api` Playwright project unit-tests it.
 */

import type { Listing, Shop } from '../types'
import { formatPrice } from '../format-price'
import { isShopClaimed } from '../claim'
import { readableTextOn } from '../platform-theme'
import { listingTarget, PLATFORM_ORIGIN, SHORTLINK_ORIGIN } from '../shortlink'
import { shopWhatsAppNumberFromMetadata, whatsappDigits, whatsappMessageLink } from './whatsapp'

export type CatalogOrder = { kind: 'whatsapp' | 'buy'; href: string }

export interface CatalogItem {
  id: string
  title: string
  description: string | null
  imageUrl: string | null
  priceCents: number | null
  currency: string
  priceLabel: string
  /** The product page, absolute on the platform origin. */
  url: string
  /** `mschz.org/l/<id>` — what a QR code and an order message carry. */
  shortUrl: string
  order: CatalogOrder
}

export interface CatalogModel {
  shop: {
    slug: string
    name: string
    description: string | null
    logoUrl: string | null
    accent: string | null
    accentText: string
    /** `wa.me` digits, only when the shop is claimed AND the merchant turned the WhatsApp button on (D4). */
    whatsapp: string | null
    claimed: boolean
  }
  links: {
    /** The catalog page the merchant shares. */
    catalog: string
    catalogShort: string
    shop: string
    pdf: string
    feed: string
  }
  items: CatalogItem[]
}

/** The catalog page lives on the platform origin under `/mx` — the share kit is Mexico-only (D5). */
export function catalogUrl(slug: string): string {
  return `${PLATFORM_ORIGIN}/mx/s/${slug}/catalogo`
}

/** The short form, through the short-link host's `/s` passthrough (`lib/shortlink.ts`). */
export function catalogShortUrl(slug: string): string {
  return `${SHORTLINK_ORIGIN}/s/${slug}/catalogo`
}

/** The public, shareable catalog PDF (S2, D16). */
export function catalogPdfUrl(slug: string): string {
  return `${PLATFORM_ORIGIN}/api/catalogo/${slug}/pdf`
}

/** The public per-shop Meta feed (S3, D18). */
export function metaFeedUrl(slug: string): string {
  return `${PLATFORM_ORIGIN}/api/feeds/meta/${slug}.csv`
}

/** The message a buyer sends when they tap «Pedir por WhatsApp». */
export function orderMessage(item: { title: string; priceLabel: string; shortUrl: string }): string {
  return `Hola, quiero pedir "${item.title}" (${item.priceLabel}): ${item.shortUrl}`
}

type CatalogShopInput = Pick<Shop, 'slug' | 'name'> & {
  description?: string | null
  logo_url?: string | null
  clerk_user_id?: string | null
  metadata?: Record<string, unknown> | null
}

export function buildCatalogModel({ shop, listings }: { shop: CatalogShopInput; listings: Listing[] }): CatalogModel {
  const claimed = isShopClaimed(shop)
  const rawNumber = claimed ? shopWhatsAppNumberFromMetadata(shop.metadata) : null
  const whatsapp = rawNumber ? whatsappDigits(rawNumber) : null
  const settings = ((shop.metadata ?? {}) as { settings?: { theme?: { accent_color?: string | null } } }).settings
  const accent = settings?.theme?.accent_color ?? null

  const seen = new Set<string>()
  const items = listings
    // D7: a listing that is not this shop's never reaches its catalog, whatever the seam above returned.
    .filter((listing) => listing.shop?.slug === shop.slug)
    // Pages of the seam are cached separately, so a product can appear on two of them (verifier, PR 447): once.
    .filter((listing) => (seen.has(listing.id) ? false : (seen.add(listing.id), true)))
    .map((listing): CatalogItem => {
      const shortUrl = `${SHORTLINK_ORIGIN}/l/${listing.id}`
      const url = listingTarget(listing.id)
      const priceLabel = formatPrice(listing, 'es-MX')
      const order: CatalogOrder = whatsapp
        ? { kind: 'whatsapp', href: whatsappMessageLink(whatsapp, orderMessage({ title: listing.title, priceLabel, shortUrl })) }
        : { kind: 'buy', href: url }
      return {
        id: listing.id,
        title: listing.title,
        description: listing.description,
        imageUrl: listing.images?.[0]?.url ?? null,
        priceCents: listing.price_cents,
        currency: listing.currency ?? 'MXN',
        priceLabel,
        url,
        shortUrl,
        order,
      }
    })

  return {
    shop: {
      slug: shop.slug,
      name: shop.name,
      description: shop.description ?? null,
      logoUrl: shop.logo_url ?? null,
      accent,
      accentText: readableTextOn(accent ?? undefined),
      whatsapp,
      claimed,
    },
    links: {
      catalog: catalogUrl(shop.slug),
      catalogShort: catalogShortUrl(shop.slug),
      shop: `${PLATFORM_ORIGIN}/mx/s/${shop.slug}`,
      pdf: catalogPdfUrl(shop.slug),
      feed: metaFeedUrl(shop.slug),
    },
    items,
  }
}
