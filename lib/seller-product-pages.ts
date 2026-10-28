/**
 * Read EVERY page of a seller's products (share-kit D2).
 *
 * `GET /store/sellers/:slug/products` pages: it defaults to 20 products and caps a page at 50. `getShopListings` asked
 * for one page with no limit, so a shop's 21st published product was missing from its own `/tienda`, the sitemap, the
 * story image — and would have been missing from its catalog, its PDF and its Meta feed. Live on 2026-10-28 the
 * largest shop had 16, so nobody had hit it yet.
 *
 * The fetch is injected so the paging decision is a pure, unit-tested loop.
 */

export const SELLER_PRODUCTS_PAGE_SIZE = 50
/** The backend reads at most this many products per seller (`take: 2000` in the route), so paging stops there too. */
export const SELLER_PRODUCTS_MAX = 2000

export type SellerProductsPage<P> = { seller?: unknown; products?: P[]; count?: number }

export type SellerProductsRead<P> =
  | { ok: true; seller: unknown; products: P[]; complete: boolean }
  | { ok: false }

/**
 * `fetchPage(limit, offset)` returns the parsed page, or null for a failed request. A failed FIRST page is a failed
 * read (`ok: false`, the caller's existing "no shop" path). A failed LATER page keeps what was read and says
 * `complete: false`, so the caller can log it rather than present a partial catalog as the whole one.
 */
export async function readAllSellerProducts<P>(
  fetchPage: (limit: number, offset: number) => Promise<SellerProductsPage<P> | null>,
): Promise<SellerProductsRead<P>> {
  const first = await fetchPage(SELLER_PRODUCTS_PAGE_SIZE, 0)
  if (!first) return { ok: false }
  const products: P[] = [...(first.products ?? [])]
  const total = Math.min(typeof first.count === 'number' ? first.count : products.length, SELLER_PRODUCTS_MAX)

  while (products.length < total) {
    const page = await fetchPage(SELLER_PRODUCTS_PAGE_SIZE, products.length)
    const rows = page?.products ?? []
    // An empty page before `count` is reached would loop forever on the same offset; treat it as the end.
    if (!page || rows.length === 0) return { ok: true, seller: first.seller, products, complete: false }
    products.push(...rows)
  }
  return { ok: true, seller: first.seller, products: products.slice(0, total), complete: true }
}
