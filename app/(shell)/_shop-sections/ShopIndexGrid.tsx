import type { Listing } from '@/lib/types'
import { formatPrice } from '@/lib/listings'
import { hasExcerpt } from '@/lib/excerpt'
import ClosetListingCard from '@/app/(shell)/s/[slug]/ClosetListingCard'
import { listingHref } from '@/lib/shop-presentation/chrome'

/**
 * The shop index's product grid, presentational (prompt-to-shop D14).
 *
 * Extracted verbatim from `ShopIndexBody`, which still fetches its own listings and renders through this. It takes
 * the listings as props so a surface that has no Medusa shop behind it (the prompt-to-shop canvas) can reuse the
 * grid's geometry instead of forking a second one that drifts. This component itself fetches nothing.
 */

/** The grid's layout, exported so the draft canvas lays its EJEMPLO cards out on the very same columns. */
export const SHOP_INDEX_GRID_CLASS = 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3'

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
  /** `ShopPresentationContext.listingBase` — NOT the shop base (see the comment on `href` below). */
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
            // NOT `ctx.basePath` — that is the SHOP base, and a product is
            // not shop-scoped on the marketplace. This exact line 404'd
            // every product on /mx/s/<slug>/tienda. See `ShopBases`.
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
