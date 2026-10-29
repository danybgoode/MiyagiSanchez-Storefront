/**
 * lib/merchant-medusa-reads.ts
 *
 * Founding merchant activation operations · Sprint 3 — the shared, hardened
 * Medusa GET reads `lib/merchant-lifecycle-sweep.ts` (six cross-review
 * rounds: paging correctness, fail-closed defaults, a per-read timeout
 * budget) and `lib/merchant-commerce-facts.ts` (Story 3.1's adapter) both
 * need. Extracted into its OWN file rather than left in (or re-exported
 * from) `merchant-lifecycle-sweep.ts` to break a real circular import:
 *
 *   merchant-lifecycle-sweep.ts → merchant-relationship-lifecycle.ts
 *     (Story 3.1's "wire relationship evaluation into the cron")
 *   → merchant-commerce-facts.ts → (would have imported) merchant-lifecycle-sweep.ts
 *
 * Turbopack surfaced this as `ReferenceError: Cannot access 's' before
 * initialization` on `RETENTION_WINDOW_DAYS` during `next build` — a classic
 * ESM temporal-dead-zone symptom of a cycle, not a logic bug. Both sweep and
 * adapter now depend on THIS file; neither depends on the other, so the
 * cycle cannot recur by construction (the population fix, not a one-off
 * import reorder).
 *
 * NO MUTATION — every function here is a GET. Never write to Medusa.
 *
 * Runtime: Node only (`fetch` + `AbortSignal.timeout`).
 */
import 'server-only'
import { isCapturedOrder, isSellerGoneResponse, SELLER_GONE } from '@/lib/merchant-lifecycle'

/** The activation threshold the contract names: the THIRD product going live. */
export const THREE_PRODUCTS_THRESHOLD = 3

/** "Still active 30 days after first sale." */
export const RETENTION_WINDOW_DAYS = 30

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'

/** Per-request budget for a Medusa read. Without it, a backend that accepts the
 *  connection and never answers stalls the WHOLE cron on one merchant: every later
 *  merchant goes unchecked and the 503 the cron route exists to return is never
 *  returned, because the platform kills the request first (cross-review round 5). */
export const MEDUSA_TIMEOUT_MS = 10_000

const INTERNAL_SECRET = process.env.MEDUSA_INTERNAL_SECRET ?? ''

/**
 * LIVE product count, from Medusa. `GET /store/sellers/{slug}/products` is the public,
 * visibility-filtered storefront read — what it returns is what is actually published.
 *
 * Returns SELLER_GONE when Medusa says the seller does not exist (known absent), and null on ANY other failure
 * so the caller SKIPS rather than reads zero. An
 * unreachable Medusa must never be able to withhold a milestone forever, and — worse in
 * the other direction — a partial response must never be able to grant one.
 */
export async function countLiveProductsFromMedusa(
  sellerSlug: string,
): Promise<number | null | typeof SELLER_GONE> {
  try {
    const res = await fetch(`${MEDUSA_BASE}/store/sellers/${encodeURIComponent(sellerSlug)}/products`, {
      headers: medusaHeaders(),
      cache: 'no-store',
      signal: AbortSignal.timeout(MEDUSA_TIMEOUT_MS),
    })
    if (!res.ok) return isSellerGoneResponse(res.status, await res.text().catch(() => '')) ? SELLER_GONE : null
    const data = (await res.json()) as {
      products?: unknown[]
      listings?: unknown[]
      count?: number
    }
    const items = data.products ?? data.listings
    if (!Array.isArray(items)) return null
    // The route paginates (default limit 20) and returns the TRUE total alongside the
    // page. `items.length` would cap the reported count at 20 — harmless for the >= 3
    // threshold, but the number is shipped to Golden Beans as `product_count` and
    // forwarded verbatim to every destination, so it has to be right (fresh-reviewer
    // pass). Falls back to the page length only if the route stops sending `count`.
    return typeof data.count === 'number' ? data.count : items.length
  } catch {
    return null
  }
}

/**
 * Has this merchant transacted again SINCE their first sale? Read from Medusa, the
 * order system of record, via the backend's internal route (a cron has no Clerk JWT).
 *
 * Returns SELLER_GONE when Medusa says the seller does not exist, and null when the answer cannot be
 * determined, so the caller skips.
 */
export async function listCapturedOrders(
  sellerSlug: string,
): Promise<Array<{ created_at: string }> | null | typeof SELLER_GONE> {
  if (!INTERNAL_SECRET) return null
  try {
    const res = await fetch(
      `${MEDUSA_BASE}/internal/sellers/orders?seller_slug=${encodeURIComponent(sellerSlug)}`,
      {
        headers: { 'x-internal-secret': INTERNAL_SECRET },
        cache: 'no-store',
        signal: AbortSignal.timeout(MEDUSA_TIMEOUT_MS),
      },
    )
    if (!res.ok) return isSellerGoneResponse(res.status, await res.text().catch(() => '')) ? SELLER_GONE : null
    const data = (await res.json()) as {
      orders?: Array<{ created_at?: string; status?: string; payment_captured?: boolean }>
    }
    if (!Array.isArray(data.orders)) return null
    return data.orders
      .filter((o) => o?.created_at && isCapturedOrder(o))
      .map((o) => ({ created_at: String(o.created_at) }))
  } catch {
    return null
  }
}

export function medusaHeaders(): Record<string, string> {
  const key = process.env.MEDUSA_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''
  return key ? { 'x-publishable-api-key': key } : {}
}
