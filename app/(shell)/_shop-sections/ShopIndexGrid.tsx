import type { Listing } from '@/lib/types'
import { formatPrice } from '@/lib/listings'
import { hasExcerpt } from '@/lib/excerpt'
import ClosetListingCard from '@/app/(shell)/s/[slug]/ClosetListingCard'
import { listingHref, SHOP_INDEX_GRID_CLASS } from '@/lib/shop-presentation/chrome'

/**
 * The shop index's product grid, presentational (prompt-to-shop D14).
 *
 * Extracted verbatim from `ShopIndexBody`, which still fetches its own listings and renders through this. It takes
 * the listings as props so a surface that has no Medusa shop behind it (the prompt-to-shop canvas) can reuse the
 * grid's geometry instead of forking a second one that drifts. This component itself fetches nothing.
 */

export default function ShopIndexGrid({
  listings,
  shop,
  listingBase,
  accent,
  payments,
  htmlLang,
}: {
  listings: Listing[]
  shop: { id?: string | null; slug: string; name: string }
  /** `ShopPresentationContext.listingBase` — from `shopListingBase` (see `ShopBases`). */
  listingBase: string
  accent: string
  payments: { stripe: boolean; mercadopago: boolean; bankTransfer: boolean }
  htmlLang: string
}) {
  return (
    <div className={SHOP_INDEX_GRID_CLASS}>
      {listings.map((listing) => (
        <ClosetListingCard
          key={listing.id}
          accent={accent}
          item={{
            productId: listing.id,
            variantId: null,
            sellerId: shop.id ?? '',
            sellerSlug: shop.slug,
            sellerName: shop.name,
            title: listing.title,
            price_cents: listing.price_cents ?? 0,
            currency: listing.currency ?? 'MXN',
            imageUrl: listing.images?.[0]?.url ?? null,
            listing_type: listing.listing_type ?? 'product',
            paymentMethods: { stripe: payments.stripe, mp: payments.mercadopago, spei: payments.bankTransfer },
            // `listingBase`, never `ctx.basePath`: which PDP a product opens is
            // decided once, in `shopListingBase`. See `ShopBases`.
            href: listingHref({ listingBase }, listing.id),
            formattedPrice: formatPrice(listing, htmlLang),
            status: listing.status,
            hasExcerpt: hasExcerpt(listing.metadata),
          }}
        />
      ))}
    </div>
  )
}
