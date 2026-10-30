/**
 * Counter catalog — the seller's own products, flattened for the «Vender en persona» grid
 * (in-person-sales S1.3). Pure: it reads the `{ listings, products }` pair that
 * `GET /store/sellers/me/products` already returns (the same call the Catálogo page makes),
 * so the counter adds no new backend read.
 *
 * Why two arrays: `listings[i]` is the display shape (title, photos, status) and
 * `products[i]` is the raw Medusa product (variants, prices, inventory levels) — the page
 * needs the variant ids and per-variant stock, which only the raw side carries. They are
 * the same length and order (the route maps one `page` to both), but we JOIN BY ID rather
 * than trust the index.
 *
 * MONEY: Medusa amounts in this codebase ARE centavos (`listing.price_cents` is read
 * straight from `prices[].amount`), and the backend prices the sale from the stored
 * variant price (D2), so the number shown here is only ever a preview of what the server
 * will charge.
 *
 * MXN only: in-person is MX-only (D1), so a variant with no `mxn` price is not sellable
 * here and is dropped rather than shown with a wrong currency.
 */

export interface CounterVariant {
  variantId: string
  /** null for a single-variant product (Medusa's «Default variant» is noise). */
  title: string | null
  unitCents: number
  /** null = stock not tracked or sold on backorder. */
  available: number | null
}

export interface CounterProduct {
  productId: string
  title: string
  imageUrl: string | null
  variants: CounterVariant[]
}

interface RawLevel { stocked_quantity?: unknown; reserved_quantity?: unknown }
interface RawVariant {
  id?: unknown
  title?: unknown
  prices?: Array<{ currency_code?: unknown; amount?: unknown; min_quantity?: unknown }>
  manage_inventory?: unknown
  allow_backorder?: unknown
  inventory_items?: Array<{ inventory?: { location_levels?: RawLevel[] } }>
  metadata?: { disabled?: unknown } | null
}
interface RawProduct { id?: unknown; variants?: RawVariant[] }
interface ListingLike {
  id: string
  title: string
  status: string
  images?: Array<{ url: string }>
}

const DEFAULT_VARIANT_TITLES = new Set(['default variant', 'default', 'default title'])

/** The qty=1 price in MXN — a bulk tier (`min_quantity > 1`) is never the counter price. */
function basePriceCents(prices: RawVariant['prices']): number | null {
  const mxn = (prices ?? []).filter(
    (p) => String(p.currency_code ?? '').toLowerCase() === 'mxn' && Number.isSafeInteger(p.amount) && (p.amount as number) >= 0,
  )
  if (mxn.length === 0) return null
  const base = mxn.reduce((low, p) => (Number(p.min_quantity ?? 1) < Number(low.min_quantity ?? 1) ? p : low))
  return base.amount as number
}

function availableUnits(variant: RawVariant): number | null {
  if (!variant.manage_inventory || variant.allow_backorder) return null
  const levels = (variant.inventory_items ?? []).flatMap((item) => item.inventory?.location_levels ?? [])
  const units = levels.reduce((sum, level) => sum + (Number(level.stocked_quantity ?? 0) - Number(level.reserved_quantity ?? 0)), 0)
  return Math.max(0, Math.floor(units))
}

export function toCounterProducts(listings: ListingLike[], rawProducts: RawProduct[]): CounterProduct[] {
  const rawById = new Map<string, RawProduct>()
  for (const raw of rawProducts) if (typeof raw.id === 'string') rawById.set(raw.id, raw)

  const out: CounterProduct[] = []
  for (const listing of listings) {
    if (listing.status !== 'active') continue
    const raw = rawById.get(listing.id)
    if (!raw) continue

    const live = (raw.variants ?? []).filter((v) => typeof v.id === 'string' && v.metadata?.disabled !== true)
    const variants: CounterVariant[] = []
    for (const v of live) {
      const unitCents = basePriceCents(v.prices)
      if (unitCents === null) continue
      const rawTitle = typeof v.title === 'string' ? v.title.trim() : ''
      const showTitle = live.length > 1 && rawTitle !== '' && !DEFAULT_VARIANT_TITLES.has(rawTitle.toLowerCase())
      variants.push({ variantId: v.id as string, title: showTitle ? rawTitle : null, unitCents, available: availableUnits(v) })
    }
    if (variants.length === 0) continue
    out.push({ productId: listing.id, title: listing.title, imageUrl: listing.images?.[0]?.url ?? null, variants })
  }
  return out
}

/** Accent-insensitive, case-insensitive title match for the search box. */
export function matchesQuery(title: string, query: string): boolean {
  const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const q = fold(query).trim()
  return q === '' || fold(title).includes(q)
}

/** True when the variant can still be added (unlimited, or at least one unit left). */
export function isSellable(variant: CounterVariant): boolean {
  return variant.available === null || variant.available > 0
}
