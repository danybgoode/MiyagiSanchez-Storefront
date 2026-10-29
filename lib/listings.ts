import { unstable_cache } from 'next/cache'
import type { Listing, Shop, SearchParams } from './types'
import { formatPrice } from './format-price'
import { readAllSellerProducts } from './seller-product-pages'
import { CATEGORIES } from './types'
import { CACHE } from './cache-policy'
import { buildQuery, isPrintPlacementListing } from './listing-query'
import { deriveCarFacets, type CarFacets, type CarFacetInput } from './car-facets'
import { financingDisplay } from './auto-financing'
import { splitCategoriesFrontend, type CategoryRow } from './collection-derive'
import { readPriceGrid, type PriceGrid } from './price-grid'
import { getCustomFields, type CustomFieldDef } from './personalization'
import {
  isMarketUnavailable,
  marketMetaFor,
  marketMetaUnavailable,
  planMarketCatalogRead,
  readMarketUnavailableResponse,
  takeMarketScopedField,
  type MarketScopedMeta,
  type MarketUnavailable,
} from './market-catalog'
import { requireMarket, type MarketCode, type MarketRecord } from './markets'
import { PROCESS_MARKET_ENV, resolvePublishableKeyForMarket } from './market-medusa'
import {
  readOwnedPriceGridPayload,
  readPublicSellerMarket,
  selectBaseSellerPrice,
  type OwnedShopPriceGridResult,
  type SellerPrice,
} from './owned-market'
import {
  pickFeatured,
  curateGrid,
  curatedGridSize,
  liveCategoryCounts,
  windowSeed,
  unionById,
  type CategoryCount,
} from './home-curation'
import { loadSeleccionCandidatePool } from './seleccion-candidates'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const PUB_KEY = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

function medusaFetch(path: string, options?: RequestInit) {
  return fetch(`${MEDUSA_BASE}${path}`, {
    ...options,
    headers: {
      'x-publishable-api-key': PUB_KEY,
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  })
}

/**
 * A read of a listing that is deliberately NOT market-scoped, because it resolves
 * something the OWNER of the product defined rather than something the marketplace
 * publishes (epic decision D4: owned-shop reads never gain the market filter).
 *
 * It is a separate, differently-named helper rather than a bare `medusaFetch` so
 * the exemption is visible in one grep and so the population guard
 * (`e2e/market-catalog-population-guard.spec.ts`) can assert the invariant
 * lexically: no marketplace catalog read anywhere in this module goes out through
 * plain `medusaFetch`.
 */
function ownershipScopedFetch(path: string, options?: RequestInit) {
  return medusaFetch(path, options)
}

/**
 * Every public MARKETPLACE catalog read goes through here, and only through here.
 * It appends the resolved market to the query so the backend can scope product
 * membership to that market's Sales Channel.
 *
 * The refusal to read at all for a non-open market happens one level up, in
 * `planMarketCatalogRead` — by the time this runs, the market is known-open.
 */
function marketCatalogFetch(marketQuery: string, path: string, options?: RequestInit) {
  const market = requireMarket(new URLSearchParams(marketQuery).get('market'))
  const key = resolvePublishableKeyForMarket(market.code, PROCESS_MARKET_ENV)
  if (key.status !== 'resolved') throw new Error(key.reason)
  const separator = path.includes('?') ? '&' : '?'
  return medusaFetch(`${path}${separator}${marketQuery}`, {
    ...options,
    headers: {
      'x-publishable-api-key': key.token,
      ...(options?.headers ?? {}),
    },
  })
}

/** Missing market-owned credentials are an outage, never an empty catalog. */
function marketCredentialUnavailable(market: MarketRecord): MarketUnavailable | null {
  const key = resolvePublishableKeyForMarket(market.code, PROCESS_MARKET_ENV)
  return key.status === 'resolved'
    ? null
    : {
        unavailable: true,
        market_code: market.code,
        marketplace_status: market.marketplace_status,
        reason: 'market_filter_unavailable',
      }
}

/**
 * Thrown when a response could not confirm its market, from INSIDE an
 * `unstable_cache` body.
 *
 * The reads that are not cached simply return the unavailable state. The cached
 * ones cannot: whatever their function returns is what the cache stores for the
 * whole revalidation window, so returning a refusal there would persist it, and
 * returning rows would persist rows from the wrong market. Throwing crosses the
 * cache boundary without handing it a value to keep.
 *
 * Stated honestly, because it is the load-bearing bit: this does NOT depend on
 * Next declining to cache a rejected promise. If it does decline, the next request
 * re-fetches and recovers as soon as the backend is fixed; if it ever memoises the
 * rejection instead, the window degrades to an empty pool. BOTH outcomes are
 * fail-closed. The outcome that must be impossible — storing rows from a mismatched
 * response — is impossible either way, because the rows are never returned.
 */
class MarketFilterUnconfirmedError extends Error {
  readonly state: MarketUnavailable
  constructor(state: MarketUnavailable) {
    super(`Market filter unconfirmed (${state.reason}) for market ${state.market_code ?? 'unknown'}.`)
    this.name = 'MarketFilterUnconfirmedError'
    this.state = state
  }
}

/** Re-raise anything that is not our own refusal — never swallow a real bug. */
function unavailableStateOrRethrow(error: unknown): MarketUnavailable {
  if (error instanceof MarketFilterUnconfirmedError) return error.state
  throw error
}

/**
 * Preserve the backend's explicit market refusal, but never turn an arbitrary
 * server failure into an apparently healthy empty catalog.
 */
async function unavailableResponseOrThrow(
  res: Response,
  market: MarketRecord,
  operation: string,
): Promise<MarketUnavailable> {
  const payload = await res.json().catch(() => null)
  const unavailable = readMarketUnavailableResponse(market, res.status, payload)
  if (unavailable) return unavailable
  throw new Error(`${operation} failed (${res.status})`)
}

export type MarketScopedListings = { listings: Listing[]; total: number; page: number } & MarketScopedMeta

/**
 * The marketplace list read. `market` defaults to `DEFAULT_MARKET` for
 * un-annotated legacy callers (epic decision D5), so MX behaviour is unchanged;
 * a market that is unknown or whose marketplace is not open returns the structured
 * unavailable state and NEVER issues the request.
 */
export async function searchListings(
  params: SearchParams,
  market?: unknown,
): Promise<MarketScopedListings> {
  const page = Math.max(1, parseInt(params.page ?? '1'))
  const decision = planMarketCatalogRead(market)
  if (isMarketUnavailable(decision)) {
    return { listings: [], total: 0, page, ...marketMetaUnavailable(decision) }
  }
  const unconfigured = marketCredentialUnavailable(decision.market)
  if (unconfigured) {
    return { listings: [], total: 0, page, ...marketMetaUnavailable(unconfigured) }
  }
  const qs = buildQuery({ ...params, page: String(page), limit: 24 })

  const res = await marketCatalogFetch(decision.query, `/store/listings${qs}`, {
    next: { revalidate: CACHE.CATALOG, tags: ['listings'] },
  } as RequestInit)

  if (!res.ok) {
    const unavailable = await unavailableResponseOrThrow(res, decision.market, 'searchListings')
    return { listings: [], total: 0, page, ...marketMetaUnavailable(unavailable) }
  }

  const data = await res.json()
  const { value: listings, unavailable } = takeMarketScopedField<Listing[]>(decision.market, data, 'listings', [])
  if (unavailable) {
    console.error('[listings] searchListings market filter unconfirmed', unavailable.reason)
    return { listings, total: 0, page, ...marketMetaUnavailable(unavailable) }
  }
  return {
    listings,
    total: data.total ?? 0,
    page: data.page ?? page,
    ...marketMetaFor(decision.market),
  }
}

// Lightweight total-only count for the mobile filter sheet's live "Ver X
// resultados". Same backend filter pipeline as searchListings (so the count is
// exact), but asks for a single row and returns only the total.
//
// Returns the market meta alongside the number rather than a bare `0`, because a
// count is the one place "none" and "this market is closed" look identical to a
// reader (`LEARNINGS.md`: unknown and none are different facts).
export async function countListings(
  params: SearchParams,
  market?: unknown,
): Promise<{ total: number } & MarketScopedMeta> {
  const decision = planMarketCatalogRead(market)
  if (isMarketUnavailable(decision)) {
    return { total: 0, ...marketMetaUnavailable(decision) }
  }
  const unconfigured = marketCredentialUnavailable(decision.market)
  if (unconfigured) return { total: 0, ...marketMetaUnavailable(unconfigured) }
  const qs = buildQuery({ ...params, page: '1', limit: 1 })

  const res = await marketCatalogFetch(decision.query, `/store/listings${qs}`, {
    next: { revalidate: CACHE.CATALOG, tags: ['listings'] },
  } as RequestInit)

  if (!res.ok) {
    const unavailable = await unavailableResponseOrThrow(res, decision.market, 'countListings')
    return { total: 0, ...marketMetaUnavailable(unavailable) }
  }

  const data = await res.json()
  const { value: total, unavailable } = takeMarketScopedField<number>(decision.market, data, 'total', 0)
  if (unavailable) return { total, ...marketMetaUnavailable(unavailable) }
  return { total, ...marketMetaFor(decision.market) }
}

/**
 * Autos facet rail (cars-vertical S1.1). One cached call for the compact
 * `facet_pool` — the full visibility-filtered autos set, projected to
 * make/model/year/km/price — then the pure `deriveCarFacets` builds the rail.
 * Kept separate from the 30s grid fetch (searchListings) so the rail caches for
 * 5 min (CACHE.CATEGORY) and never touches the grid's perf window.
 *
 * `marca` scopes the modelo options to the currently-selected brand. Degrades
 * gracefully: if the backend hasn't yet deployed the `facet_pool` (async
 * backend-first deploy window), returns null so the UI falls back to the plain
 * free-text autos panel instead of erroring.
 */
export async function getAutoFacets(marca?: string, market?: unknown): Promise<CarFacets | null> {
  const decision = planMarketCatalogRead(market)
  // A facet rail is derived from the catalog, so a refused market gets no rail at
  // all — `null` is already this function's "no rail, fall back to the free-text
  // panel" answer, and it is fail-closed (it can render no rows).
  if (isMarketUnavailable(decision)) return null
  if (marketCredentialUnavailable(decision.market)) return null

  const res = await marketCatalogFetch(decision.query, `/store/listings?category=autos&facets=1`, {
    next: { revalidate: CACHE.CATEGORY, tags: ['listings'] },
  } as RequestInit)

  if (!res.ok) {
    console.error('[listings] getAutoFacets failed', res.status)
    return null
  }

  const data = await res.json()
  const { value: pool } = takeMarketScopedField<CarFacetInput[] | null>(decision.market, data, 'facet_pool', null)
  if (!Array.isArray(pool)) return null   // refused market, or old backend with no facet_pool → graceful degrade
  return deriveCarFacets(pool, { marca })
}

// The market check happens INSIDE this cache body, before anything else, for a
// reason worth stating: the view counter below is a WRITE, and it is deliberately
// inside the cache so a listing records roughly one view per revalidation window
// rather than one per render. Verifying outside the wrapper (the shape this
// started as) left that write firing on a response we then refused — a product we
// never showed anyone accruing views. Order matters more than placement here:
// confirm the market, THEN record the view.
const getListingCached = unstable_cache(
  async (id: string, marketCode: string, marketQuery: string): Promise<Listing | null> => {
    const market = requireMarket(marketCode)
    const res = await marketCatalogFetch(marketQuery, `/store/listings/${id}`)
    if (!res.ok) return null
    const data = await res.json()

    const { value: listing, unavailable } = takeMarketScopedField<Listing | null>(market, data, 'listing', null)
    if (unavailable) throw new MarketFilterUnconfirmedError(unavailable)

    // Increment view count fire-and-forget via a PATCH on the seller product metadata
    // (async, does not block rendering)
    if (listing) {
      const newViews = (listing.metadata?.views as number ?? 0) + 1
      medusaFetch(`/store/listings/${id}/view`, {
        method: 'POST',
        body: JSON.stringify({ views: newViews }),
      }).catch(() => {})
    }

    return listing
  },
  ['listing'],
  { revalidate: CACHE.LISTING, tags: ['listings'] },
)

/**
 * The marketplace detail (PDP) read. Fail-closed answer is `null`, which the PDP
 * routes already turn into an ordinary 404 — the correct user-facing outcome for a
 * market with no marketplace, and one that cannot render another market's product.
 * Callers needing the *reason* (Sprint 2's `/us` surface, the MCP tools) call
 * `planMarketCatalogRead` directly and get the structured state.
 */
export async function getListing(id: string, market?: unknown): Promise<Listing | null> {
  const decision = planMarketCatalogRead(market)
  if (isMarketUnavailable(decision)) return null
  try {
    return await getListingCached(id, decision.market.code, decision.query)
  } catch (error) {
    const state = unavailableStateOrRethrow(error)
    console.error('[listings] getListing market filter unconfirmed', state.reason)
    return null
  }
}

/**
 * Fresh, side-effect-free read of a listing's custom-field defs, for a
 * security-relevant server check (custom-print-products S3 Story 3.2's
 * upload route resolving the REAL `allowed_formats`/`max_size_mb` for a
 * field, never trusting a client-supplied limit). Deliberately does NOT use
 * `getListing` — that helper increments the listing's view count as a side
 * effect and is `unstable_cache`-wrapped, neither of which is wanted here
 * (an upload isn't a "view", and we want the seller's latest limits, not a
 * cached one). Returns `[]` on any failure — callers fall back to the
 * global hard caps, never to an unbounded upload.
 *
 * This helper is the MARKETPLACE version and therefore uses the market seam.
 * Tenant uploads use the separately named owner helper below; keeping both entry
 * points explicit prevents an owner exemption from becoming a bare marketplace
 * by-id read.
 */
export async function getListingCustomFieldsUncached(
  id: string,
  market?: unknown,
): Promise<CustomFieldDef[]> {
  const decision = planMarketCatalogRead(market)
  if (isMarketUnavailable(decision)) return []
  try {
    const res = await marketCatalogFetch(decision.query, `/store/listings/${id}`, { cache: 'no-store' })
    if (!res.ok) return []
    const data = await res.json()
    const { value: listing, unavailable } = takeMarketScopedField<Listing | null>(
      decision.market,
      data,
      'listing',
      null,
    )
    if (unavailable) return []
    return getCustomFields(listing?.metadata ?? null)
  } catch {
    return []
  }
}

/**
 * A multi-variant (print-configurator) listing's per-variant quantity price
 * ladder — fetched once (server-side, cached) from the backend's own Price
 * rows, never a metadata mirror (custom-print-products Sprint 2, Story 2.3).
 * Returns null for a normal single-variant listing (no tiers to show).
 */
const getPriceGridCached = unstable_cache(
  async (id: string, marketCode: string, marketQuery: string): Promise<PriceGrid | null> => {
    const market = requireMarket(marketCode)
    const res = await marketCatalogFetch(marketQuery, `/store/listings/${id}/price-grid`, {
      next: { revalidate: CACHE.LISTING, tags: ['listings'] },
    } as RequestInit)
    if (!res.ok) return null
    const data = await res.json()
    const { value, unavailable } = takeMarketScopedField<unknown>(market, data, 'price_grid', null)
    if (unavailable) throw new MarketFilterUnconfirmedError(unavailable)
    return readPriceGrid({ price_grid: value })
  },
  ['price-grid'],
  { revalidate: CACHE.LISTING, tags: ['listings'] },
)

export async function getPriceGrid(id: string, market?: unknown): Promise<PriceGrid | null> {
  const decision = planMarketCatalogRead(market)
  if (isMarketUnavailable(decision)) return null
  try {
    return await getPriceGridCached(id, decision.market.code, decision.query)
  } catch (error) {
    const state = unavailableStateOrRethrow(error)
    console.error('[listings] getPriceGrid market filter unconfirmed', state.reason)
    return null
  }
}

interface OwnedListingPayload {
  listing?: Listing | null
  seller?: Shop | null
  market_code?: unknown
}

function readOwnedListingPayload(
  payload: unknown,
  sellerSlug: string,
  listingId: string,
): Listing | null {
  if (!payload || typeof payload !== 'object') return null
  const data = payload as OwnedListingPayload
  const sellerMarket = readPublicSellerMarket(data.seller)
  if (
    !sellerMarket ||
    data.market_code !== sellerMarket.market_code ||
    data.seller?.slug !== sellerSlug ||
    data.listing?.id !== listingId ||
    typeof data.listing.currency !== 'string' ||
    data.listing.currency.toLowerCase() !== sellerMarket.currency_code
  ) {
    return null
  }
  return { ...data.listing, shop: data.seller }
}

const getOwnedShopListingCached = unstable_cache(
  async (sellerSlug: string, id: string): Promise<Listing | null> => {
    const res = await ownershipScopedFetch(
      `/store/sellers/${encodeURIComponent(sellerSlug)}/products/${encodeURIComponent(id)}`,
    )
    if (!res.ok) return null
    return readOwnedListingPayload(await res.json(), sellerSlug, id)
  },
  ['owned-shop-listing'],
  { revalidate: CACHE.LISTING, tags: ['listings'] },
)

/** Trusted-channel PDP detail. Ownership + published state replace Sales Channel membership. */
export function getOwnedShopListing(sellerSlug: string, id: string): Promise<Listing | null> {
  return getOwnedShopListingCached(sellerSlug, id)
}

const getOwnedShopPriceGridCached = unstable_cache(
  async (sellerSlug: string, id: string): Promise<OwnedShopPriceGridResult> => {
    let res: Response
    try {
      res = await ownershipScopedFetch(
        `/store/sellers/${encodeURIComponent(sellerSlug)}/products/${encodeURIComponent(id)}/price-grid`,
        { next: { revalidate: CACHE.LISTING, tags: ['listings'] } } as RequestInit,
      )
    } catch {
      return { status: 'error' }
    }
    if (!res.ok) return { status: 'unavailable', http_status: res.status }
    try {
      return readOwnedPriceGridPayload(await res.json(), id)
    } catch {
      return { status: 'invalid' }
    }
  },
  ['owned-shop-price-grid'],
  { revalidate: CACHE.LISTING, tags: ['listings'] },
)

/** Trusted-channel price grid, deliberately independent of marketplace membership. */
export function getOwnedShopPriceGrid(
  sellerSlug: string,
  id: string,
): Promise<OwnedShopPriceGridResult> {
  return getOwnedShopPriceGridCached(sellerSlug, id)
}

/** Fresh owner-scoped field definitions for tenant artwork uploads. */
export async function getOwnedListingCustomFieldsUncached(
  sellerSlug: string,
  id: string,
): Promise<CustomFieldDef[]> {
  try {
    const res = await ownershipScopedFetch(
      `/store/sellers/${encodeURIComponent(sellerSlug)}/products/${encodeURIComponent(id)}`,
      { cache: 'no-store' },
    )
    if (!res.ok) return []
    const listing = readOwnedListingPayload(await res.json(), sellerSlug, id)
    return getCustomFields(listing?.metadata ?? null)
  } catch {
    return []
  }
}

export const getShop = unstable_cache(
  async (slug: string, market?: MarketCode): Promise<Shop | null> => {
    const key = market ? resolvePublishableKeyForMarket(market, PROCESS_MARKET_ENV) : null
    if (key?.status === 'unconfigured') return null
    const res = await medusaFetch(`/store/sellers/${slug}`, key ? {
      headers: { 'x-publishable-api-key': key.token },
    } : undefined)
    if (!res.ok) return null
    const data = await res.json()
    return data.seller ?? null
  },
  ['shop'],
  { revalidate: CACHE.SHOP, tags: ['shops'] },
)

/** Ownership and takedown decisions cannot wait out the public shop cache. */
export async function readShopFresh(slug: string, market?: MarketCode): Promise<
  | { state: 'resolved'; shop: Shop }
  | { state: 'absent' }
  | { state: 'unavailable'; reason: string }
> {
  const key = market ? resolvePublishableKeyForMarket(market, PROCESS_MARKET_ENV) : null
  if (key?.status === 'unconfigured') return { state: 'unavailable', reason: 'market credential missing' }
  try {
    const res = await medusaFetch(`/store/sellers/${encodeURIComponent(slug)}`, {
      cache: 'no-store',
      ...(key ? { headers: { 'x-publishable-api-key': key.token } } : {}),
    })
    if (res.status === 404) return { state: 'absent' }
    if (!res.ok) return { state: 'unavailable', reason: `HTTP ${res.status}` }
    const data = await res.json() as { seller?: Shop }
    if (!data.seller?.id) return { state: 'unavailable', reason: 'seller payload malformed' }
    return { state: 'resolved', shop: data.seller }
  } catch (error) {
    return { state: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The shape of the Medusa seller-products payload AS THIS MAPPER READS IT — not a
 * full model, just the fields touched below. Introduced by the market-architecture
 * S1 PR for a boring reason: `lint:changed` judges every file a branch touches, and
 * this mapper's `any` annotations predate that gate.
 *
 * Every field is OPTIONAL and every read below was already optional-chained with a
 * `??` fallback, so this is a type-only change with no runtime effect. Keep it that
 * way — widening a field to required here would turn a tolerated missing value into
 * a build error against a payload the backend is still free to send.
 */
interface SellerProductPrice {
  amount?: number
  currency_code?: string
  min_quantity?: number | null
}

interface SellerProductLocationLevel {
  stocked_quantity?: number | null
  reserved_quantity?: number | null
}

interface SellerProductInventoryItem {
  inventory?: { location_levels?: SellerProductLocationLevel[] | null } | null
}

interface SellerProductVariant {
  metadata?: { disabled?: boolean } | null
  prices?: SellerProductPrice[] | null
  manage_inventory?: boolean | null
  allow_backorder?: boolean | null
  inventory_items?: SellerProductInventoryItem[] | null
}

interface SellerProduct {
  id: string
  title: string
  description?: string | null
  status?: string
  created_at?: string
  metadata?: Record<string, unknown> | null
  variants?: SellerProductVariant[] | null
  images?: Array<{ url: string; metadata?: { alt?: string | null } | null }> | null
  tags?: Array<{ value: string }> | null
  type?: { value?: string } | null
  categories?: CategoryRow[] | null
}

/** Thrown inside the cache so a failed read is never cached as an empty catalog (share-kit verifier, PR 449). */
class ShopListingsReadFailed extends Error {}

/**
 * One shop's listings AND whether the read was whole (share-kit S3, AGENTS "three states"). A failed first page
 * throws inside the cache, so it is retried on the next call instead of serving an empty shop for the cache's
 * lifetime; a later page that failed is cached as `complete: false`. Only the Meta feed acts on `complete` (a Meta
 * replace-feed would delete every missing product); every other surface reads `getShopListings`.
 */
const getShopListingsCached = unstable_cache(
  async (sellerSlug: string): Promise<{ listings: Listing[]; complete: boolean }> => {
    // Every page, not the backend's default first 20 (share-kit D2, `lib/seller-product-pages.ts`).
    const read = await readAllSellerProducts<SellerProduct>(async (limit, offset) => {
      const res = await medusaFetch(`/store/sellers/${sellerSlug}/products?limit=${limit}&offset=${offset}`, {
        next: { revalidate: CACHE.LISTING, tags: ['listings'] },
      } as RequestInit)
      return res.ok ? res.json() : null
    })
    if (!read.ok) throw new ShopListingsReadFailed(sellerSlug)
    if (!read.complete) {
      console.error(`[listings] getShopListings(${sellerSlug}) read ${read.products.length} products, then a page failed — the catalog is partial`)
    }
    const data: { seller?: Shop; products: SellerProduct[] } = { seller: read.seller as Shop | undefined, products: read.products }

    // Map seller products to Listing shape. Print-ad placement products (sold
    // only through the dedicated print-edition flow) are excluded here — this
    // is the shop-storefront seam every buyer-facing surface reads through
    // (marketplace /s/[slug], subdomain, custom domain, embed, sitemap, PDP
    // "more from this shop"), matching the general-catalog exclusion already
    // live in the backend /store/listings route.
    const seller = data.seller
    const sellerMarket = readPublicSellerMarket(seller)
    if (!sellerMarket) return { listings: [], complete: true }
    const listings = (data.products ?? [])
      .filter((p: SellerProduct) => !isPrintPlacementListing(p.metadata))
      .map((p: SellerProduct) => {
        const meta = (p.metadata ?? {}) as Record<string, unknown>
        // Price = min across all variants ("desde $X" for multi-variant
        // configurator listings); inventory = summed across all variants.
        // Mirrors apps/backend/src/api/store/_utils/listing.ts:toListingShape.
        // Excludes any variant flagged metadata.disabled (defensive; nothing
        // sets this today — mirrors apps/backend's toListingShape filter).
        const variants: SellerProductVariant[] = (p.variants ?? []).filter((v) => v?.metadata?.disabled !== true)
        const variantPrices = variants
          .map((v) => {
            const prices: SellerProductPrice[] = v?.prices ?? []
            const validPrices: SellerPrice[] = prices.filter(
              (price): price is SellerPrice =>
                typeof price.amount === 'number' &&
                typeof price.currency_code === 'string',
            )
            return selectBaseSellerPrice(validPrices, sellerMarket.currency_code)
          })
          .filter((pr): pr is { amount: number; currency_code: string } => !!pr)
        const priceObj = variantPrices.length > 0
          ? variantPrices.reduce((min, pr) => (pr.amount < min.amount ? pr : min))
          : undefined
        const metadataCurrency = typeof meta.currency === 'string' ? meta.currency.toLowerCase() : null
        const fallbackPrice = metadataCurrency === sellerMarket.currency_code && typeof meta.price_cents === 'number'
          ? meta.price_cents
          : null
        const { platformCategory, collections } = splitCategoriesFrontend(p.categories, seller?.slug)
        const manageInventory = variants.some((v) => !!v?.manage_inventory)
        const allowBackorder = variants.some((v) => !!v?.allow_backorder)
        const managedLevels: SellerProductLocationLevel[] = manageInventory
          ? variants
              .filter((v) => v?.manage_inventory)
              .flatMap((v) => v?.inventory_items ?? [])
              .flatMap((ii) => ii?.inventory?.location_levels ?? [])
          : []
        const availableQuantity = manageInventory
          ? managedLevels.reduce((sum: number, lvl) =>
              sum + (Number(lvl?.stocked_quantity ?? 0) - Number(lvl?.reserved_quantity ?? 0)), 0)
          : null
        const reservedQuantity = manageInventory
          ? managedLevels.reduce((sum: number, lvl) => sum + Number(lvl?.reserved_quantity ?? 0), 0)
          : null
        return {
          id: p.id,
          shop_id: seller?.id ?? '',
          medusa_product_id: p.id,
          title: p.title,
          description: p.description ?? null,
          price_cents: priceObj?.amount ?? fallbackPrice,
          currency: sellerMarket.currency_code.toUpperCase(),
          condition: (meta.condition as string) ?? null,
          listing_type: p.type?.value ?? (meta.listing_type as string | undefined) ?? 'product',
          category: platformCategory?.handle ?? null,
          collections: collections.map((c) => c.handle),
          state: (meta.state as string) ?? null,
          municipio: (meta.municipio as string) ?? null,
          location: (meta.location as string) ?? null,
          attrs: (meta.attrs as Record<string, unknown> | undefined) ?? {},
          metadata: meta,
          images: (p.images ?? []).map((img) => ({ url: img.url, alt: img.metadata?.alt ?? null })),
          tags: (p.tags ?? []).map((t) => t.value),
          status: p.status === 'published' ? 'active' : p.status,
          source_platform: (meta.source_platform as string) ?? null,
          source_url: (meta.source_url as string) ?? null,
          views: (meta.views as number) ?? 0,
          manage_inventory: manageInventory,
          available_quantity: availableQuantity,
          reserved_quantity: reservedQuantity,
          in_stock: !manageInventory || (availableQuantity ?? 0) > 0,
          allow_backorder: allowBackorder,
          dispatch_estimate: (meta.dispatch_estimate as string | undefined) ?? null,
          created_at: p.created_at,
          shop: seller ? {
            id: seller.id,
            slug: seller.slug,
            name: seller.name,
            description: seller.description ?? null,
            location: seller.location ?? null,
            logo_url: seller.logo_url ?? null,
            clerk_user_id: seller.clerk_user_id ?? null,
            verified: seller.verified ?? false,
            source: seller.source ?? null,
            source_url: seller.source_url ?? null,
            metadata: seller.metadata ?? null,
            created_at: seller.created_at ?? p.created_at,
            market_code: sellerMarket.market_code,
            country_code: sellerMarket.country_code,
            currency_code: sellerMarket.currency_code,
            marketplace_status: sellerMarket.marketplace_status,
            custom_domain: null,
            custom_domain_verified: false,
            custom_domain_vercel_ok: false,
          } : null,
        } as Listing
      })
    return { listings, complete: read.complete }
  },
  ['shop-listings-read'],
  { revalidate: CACHE.LISTING, tags: ['listings'] },
)

export async function readShopListings(sellerSlug: string): Promise<{ listings: Listing[]; complete: boolean }> {
  try {
    return await getShopListingsCached(sellerSlug)
  } catch (error) {
    if (!(error instanceof ShopListingsReadFailed)) throw error
    return { listings: [], complete: false }
  }
}

export async function getShopListings(sellerSlug: string): Promise<Listing[]> {
  return (await readShopListings(sellerSlug)).listings
}

/**
 * Country-market view of one seller's catalog.
 *
 * Keep this separate from `getShopListings`: that function is the seller-owned
 * channel and intentionally ignores marketplace Sales Channel membership (D4).
 * A `/mx/s/:slug` page is marketplace discovery, so it uses the same channel
 * filter and market-echo verification as the main marketplace grid.
 */
export async function getMarketplaceShopListings(
  sellerSlug: string,
  market?: unknown,
): Promise<{ listings: Listing[] } & MarketScopedMeta> {
  const decision = planMarketCatalogRead(market)
  if (isMarketUnavailable(decision)) {
    return { listings: [], ...marketMetaUnavailable(decision) }
  }
  const unconfigured = marketCredentialUnavailable(decision.market)
  if (unconfigured) return { listings: [], ...marketMetaUnavailable(unconfigured) }
  const qs = new URLSearchParams({ seller_slug: sellerSlug, limit: '100' })
  const res = await marketCatalogFetch(
    decision.query,
    `/store/listings?${qs.toString()}`,
    { next: { revalidate: CACHE.LISTING, tags: ['listings'] } } as RequestInit,
  )
  if (!res.ok) {
    const unavailable = await unavailableResponseOrThrow(
      res,
      decision.market,
      'getMarketplaceShopListings',
    )
    return { listings: [], ...marketMetaUnavailable(unavailable) }
  }
  const data = await res.json()
  const { value: listings, unavailable } = takeMarketScopedField<Listing[]>(
    decision.market,
    data,
    'listings',
    [],
  )
  if (unavailable) {
    console.error('[listings] marketplace shop market filter unconfirmed', unavailable.reason)
    return { listings, ...marketMetaUnavailable(unavailable) }
  }
  return { listings, ...marketMetaFor(decision.market) }
}

/**
 * A shop's seller-defined collections (own-shop-premium-presentation S2),
 * ordered by the seller's own sort_order. Public read — powers the shop's
 * nav strip on every channel (marketplace/subdomain/custom domain).
 */
export const getShopCollections = unstable_cache(
  async (sellerSlug: string, market?: MarketCode): Promise<Array<{ id: string; handle: string; name: string; sort_order: number }>> => {
    const key = market ? resolvePublishableKeyForMarket(market, PROCESS_MARKET_ENV) : null
    if (key?.status === 'unconfigured') return []
    const res = await medusaFetch(`/store/sellers/${sellerSlug}/collections`, {
      next: { revalidate: CACHE.LISTING, tags: ['listings'] },
      ...(key ? { headers: { 'x-publishable-api-key': key.token } } : {}),
    } as RequestInit)
    if (!res.ok) return []
    const data = await res.json()
    return data.collections ?? []
  },
  ['shop-collections'],
  { revalidate: CACHE.LISTING, tags: ['listings'] },
)

// The pool helpers below (`getRecentListings`, `getSeleccionCandidates`, the
// curated pool) answer `[]` for a refused market rather than a structured state.
// That is fail-closed — an empty pool renders an empty module — and it is the right
// shape here because their consumers are internal grid builders and one admin
// screen, none of which render a market-unavailable surface. The PUBLIC list and
// count reads (`searchListings`, `countListings`) carry the structured state, and
// any new caller that needs it asks `planMarketCatalogRead` directly.
export async function getRecentListings(limit = 8, market?: unknown): Promise<Listing[]> {
  const decision = planMarketCatalogRead(market)
  if (isMarketUnavailable(decision)) return []
  const res = await marketCatalogFetch(decision.query, `/store/listings?sort=reciente&limit=${limit}`, {
    next: { revalidate: CACHE.LISTING, tags: ['listings'] },
  } as RequestInit)
  if (!res.ok) return []
  const data = await res.json()
  const { value: listings, unavailable } = takeMarketScopedField<Listing[]>(decision.market, data, 'listings', [])
  if (unavailable) return []
  return listings
}

// ── Homepage Polish — Dirección B · Sprint 2: curated Selección + Categorías ──
// The curation/count *logic* lives in the next-free `lib/home-curation.ts` seam
// (unit-tested by `e2e/home-curation.spec.ts`); these are the thin Medusa-reading
// wrappers. One cached pool feeds both featured + grid so they stay consistent.

// A small pool of the freshest listings UNIONed with the explicit pinned set
// (`?featured=true`, S2.2) so an admin pin renders even when it's older than the
// freshest-24 window. Cached so getFeaturedListing + getCuratedListings share one
// fetch per request window. Degrades gracefully: each fetch contributes only if it
// succeeds, so if the backend `featured` filter lags a deploy the pool is just the
// freshest-24 (today's behaviour) — never throws (the homepage prerenders at build).
async function fetchListings(market: MarketRecord, marketQuery: string, path: string): Promise<Listing[]> {
  let data: unknown
  try {
    const res = await marketCatalogFetch(marketQuery, path, {
      next: { revalidate: CACHE.LISTING, tags: ['listings'] },
    } as RequestInit)
    if (!res.ok) return []
    data = await res.json()
  } catch {
    // Network reject / malformed JSON (e.g. backend mid-deploy) → degrade to empty,
    // never throw: the homepage prerenders at build and the pool falls back to whatever
    // the other fetch returned.
    return []
  }

  // The market check sits OUTSIDE that catch deliberately, and the distinction is
  // the whole point: a transport failure is a degraded read and may legitimately
  // become an empty pool, but a response that cannot confirm its market is a
  // REFUSAL, and a refusal must not be silently downgraded into "there was nothing
  // there". Swallowing it in the catch above is precisely how this path shipped
  // without a check at all — the only read in the file that went through
  // `marketCatalogFetch` and never called `verifyMarketFilter`. (Cross-family
  // review of the first PR, and the population guard now proves the pairing for
  // every call site rather than for the ones a reader happened to look at.)
  const { value: rows, unavailable } = takeMarketScopedField<Listing[]>(market, data, 'listings', [])
  if (unavailable) throw new MarketFilterUnconfirmedError(unavailable)
  return rows
}

/**
 * Candidate listings for `/admin/seleccion`: newest products to discover UNIONed
 * with every explicit pin so bulk imports can never hide older pinned products
 * from the one screen that must be able to remove and reorder them.
 */
export async function getSeleccionCandidates(limit = 50, market?: unknown): Promise<Listing[]> {
  const decision = planMarketCatalogRead(market)
  if (isMarketUnavailable(decision)) return []
  try {
    return await loadSeleccionCandidatePool(
      (query) => fetchListings(decision.market, decision.query, `/store/listings${query}`),
      limit,
    )
  } catch (error) {
    const state = unavailableStateOrRethrow(error)
    console.error('[listings] seleccion candidate pool market filter unconfirmed', state.reason)
    return []
  }
}

const getCuratedPoolCached = unstable_cache(
  async (marketCode: string, marketQuery: string): Promise<Listing[]> => {
    const market = requireMarket(marketCode)
    const [fresh, pinned] = await Promise.all([
      fetchListings(market, marketQuery, '/store/listings?sort=reciente&limit=24'),
      fetchListings(market, marketQuery, '/store/listings?featured=true&limit=50'),
    ])
    return unionById(fresh, pinned)
  },
  ['curated-pool'],
  { revalidate: CACHE.LISTING, tags: ['listings'] },
)

async function getCuratedPool(market?: unknown): Promise<Listing[]> {
  const decision = planMarketCatalogRead(market)
  if (isMarketUnavailable(decision)) return []
  try {
    return await getCuratedPoolCached(decision.market.code, decision.query)
  } catch (error) {
    const state = unavailableStateOrRethrow(error)
    console.error('[listings] curated pool market filter unconfirmed', state.reason)
    return []
  }
}

// `now` is injectable so the page can pass ONE timestamp to both featured + grid:
// computing it independently in each could, at the exact 14-day cutoff, let a
// listing be the featured pick in one call yet not be excluded by the other.
/** The Selección featured pick (pinned-first, else freshest qualifying); null when none. */
export async function getFeaturedListing(now = Date.now(), market?: unknown): Promise<Listing | null> {
  const pool = await getCuratedPool(market)
  return pickFeatured(pool, now)
}

/**
 * The Selección grid — every remaining qualifying pin (so the admin's full curation
 * renders, S1.2) plus auto-fill up to GRID_SIZE, capped at GRID_CAP; excludes the
 * featured card. The unpinned remainder is shuffled per ISR window (`windowSeed(now)`,
 * S3.1) so it visibly rotates across revalidations; pinned/admin-ordered items stay fixed.
 */
export async function getCuratedListings(now = Date.now(), market?: unknown): Promise<Listing[]> {
  const pool = await getCuratedPool(market)
  const featured = pickFeatured(pool, now)
  const n = curatedGridSize(pool, now, featured?.id)
  return curateGrid(pool, now, n, featured?.id, windowSeed(now))
}

/**
 * Live category counts for the "Categorías con vida" module — builds on
 * countListings (one cheap total-only call per category), drops empty categories.
 * Cached ~5 min behind the listings tag.
 */
const getCategoryCountsCached = unstable_cache(
  async (market: string): Promise<CategoryCount[]> => {
    const totals = await Promise.all(
      CATEGORIES.map(c => countListings({ category: c.key }, market)),
    )
    const counts: Record<string, number> = {}
    CATEGORIES.forEach((c, i) => { counts[c.key] = totals[i].total })
    return liveCategoryCounts(counts)
  },
  ['category-counts'],
  { revalidate: CACHE.CATEGORY, tags: ['listings'] },
)

export async function getCategoryCounts(market?: unknown): Promise<CategoryCount[]> {
  const decision = planMarketCatalogRead(market)
  if (isMarketUnavailable(decision)) return []
  return getCategoryCountsCached(decision.market.code)
}

export { formatPrice }

export function conditionLabel(condition: Listing['condition'], language: 'es' | 'en' = 'es'): string {
  const map: Record<string, string> = language === 'en' ? {
    new: 'New',
    like_new: 'Like new',
    good: 'Good',
    fair: 'Fair',
    parts: 'For parts',
  } : {
    new: 'Nuevo',
    like_new: 'Como nuevo',
    good: 'Buen estado',
    fair: 'Aceptable',
    parts: 'Para piezas',
  }
  return condition ? (map[condition] ?? condition) : ''
}

/**
 * "$X,XXX/mes" muted chip for the /l card grid (cars-vertical S2.2) — autos
 * only. null when the listing has no financing hint set (card renders
 * nothing, today's card unchanged). Thin delegator — all the math stays in
 * lib/auto-financing.ts, shared with the PDP hero and the UCP catalog.
 */
export function financingChip(listing: Listing): string | null {
  if (listing.category !== 'autos') return null
  const metadata = (listing.metadata ?? {}) as Record<string, unknown>
  const attrs = listing.attrs ?? (metadata.attrs as Record<string, unknown> | undefined) ?? {}
  const financing = financingDisplay({
    priceCents: listing.price_cents,
    downPaymentPct: attrs.financing_down_payment_pct,
    months: attrs.financing_months,
  })
  return financing ? financing.monthlyLabel : null
}

/** Slim listing shape for the print-builder's curation drawers (US-4 + the print-studio catalog). */
export interface CatalogListingItem {
  id: string
  title: string
  description: string | null
  price: string | null
  image: string | null
  shop: { slug: string; name: string; logo: string | null; description: string | null } | null
}

export function toCatalogItems(listings: Listing[]): CatalogListingItem[] {
  return listings.map((l) => ({
    id: l.id,
    title: l.title,
    description: l.description,
    price: l.price_cents != null ? formatPrice(l) : null,
    image: l.images?.[0]?.url ?? null,
    shop: l.shop ? { slug: l.shop.slug, name: l.shop.name, logo: l.shop.logo_url ?? null, description: l.shop.description ?? null } : null,
  }))
}
