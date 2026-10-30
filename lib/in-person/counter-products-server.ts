import 'server-only'
/**
 * The seller's sellable products for the counter and the payment-link picker (in-person-sales S1.3, S4.3).
 * One loader so the two screens can never disagree about what "sellable" means.
 *
 * The route's `status=activo` means active AND in stock AND not made-to-order, so it would hide made-to-order
 * products (and sold-out ones, which show disabled). No single value covers "all active", so ask for the three
 * active shapes and merge.
 */
import { toCounterProducts, type CounterProduct } from './counter-catalog'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const PUB_KEY = process.env.MEDUSA_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

/** The route's own ceiling (`Math.min(limit, 200)`); beyond it the merchant narrows with search. */
export const COUNTER_PRODUCT_LIMIT = 200

type Page = { listings?: Parameters<typeof toCounterProducts>[0]; products?: Parameters<typeof toCounterProducts>[1]; count?: number }

export async function loadCounterProducts(jwt: string): Promise<{ products: CounterProduct[]; truncated: boolean }> {
  const pages = await Promise.all(
    ['activo', 'sobre_pedido', 'agotado'].map(async (status): Promise<Page> => {
      const res = await fetch(
        `${MEDUSA_BASE}/store/sellers/me/products?status=${status}&sort=title&limit=${COUNTER_PRODUCT_LIMIT}`,
        { headers: { 'x-publishable-api-key': PUB_KEY, Authorization: `Bearer ${jwt}` }, cache: 'no-store' },
      )
      if (!res.ok) throw new Error('No se pudieron cargar tus productos.')
      return (await res.json()) as Page
    }),
  )
  const products = toCounterProducts(pages.flatMap((p) => p.listings ?? []), pages.flatMap((p) => p.products ?? []))
    .sort((a, b) => a.title.localeCompare(b.title, 'es'))
  return { products, truncated: pages.some((p) => (p.count ?? 0) > COUNTER_PRODUCT_LIMIT) }
}
