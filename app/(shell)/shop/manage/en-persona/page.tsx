import { redirect } from 'next/navigation'
import { auth } from '@clerk/nextjs/server'
import { getMySeller } from '@/lib/get-my-seller'
import { toCounterProducts } from '@/lib/in-person/counter-catalog'
import { SellerBreadcrumb } from '../SellerBreadcrumb'
import CounterClient from './CounterClient'

export const metadata = { title: 'Vender en persona — Mi tienda' }

// Stock changes with every sale; a cached counter would sell what is already gone.
export const dynamic = 'force-dynamic'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const PUB_KEY = process.env.MEDUSA_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

/** The route's own ceiling (`Math.min(limit, 200)`); beyond it the merchant narrows with search. */
const COUNTER_PRODUCT_LIMIT = 200

/**
 * «Vender en persona» — the counter (in-person-sales S1.3). Server side only reads the
 * seller's own active products, from the SAME `/store/sellers/me/products` call the
 * Catálogo page makes (no new backend read), flattens them to variants with
 * `toCounterProducts`, and hands the client a small serialisable list. The sale itself
 * goes through `/api/shop/en-persona/sales`.
 */
export default async function EnPersonaPage() {
  const { userId, getToken } = await auth()
  if (!userId) redirect('/sign-in')
  const jwt = await getToken()
  if (!jwt) redirect('/sign-in')

  const seller = await getMySeller()
  if (!seller) redirect('/sell')

  // In person is Mexico only (D1); the backend refuses anyone else with 422 IN_PERSON_MX_ONLY,
  // so say so here instead of showing a counter that can never ring up a sale.
  if (seller.market !== 'mx') {
    return (
      <div className="max-w-5xl mx-auto px-4 py-6">
        <SellerBreadcrumb />
        <h1 className="text-xl sm:text-2xl font-bold mt-2">Vender en persona</h1>
        <p className="text-sm text-[var(--color-muted)] mt-2">
          Vender en persona todavía no está disponible para tiendas fuera de México.
        </p>
      </div>
    )
  }

  // The route's `status=activo` means active AND in stock AND not made-to-order, so it would hide
  // made-to-order products (and sold-out ones, which the counter shows disabled). No single value
  // covers "all active", so ask for the three active shapes and merge.
  type Page = { listings?: Parameters<typeof toCounterProducts>[0]; products?: Parameters<typeof toCounterProducts>[1]; count?: number }
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
  const listings = pages.flatMap((p) => p.listings ?? [])
  const rawProducts = pages.flatMap((p) => p.products ?? [])
  const truncated = pages.some((p) => (p.count ?? 0) > COUNTER_PRODUCT_LIMIT)

  const products = toCounterProducts(listings, rawProducts).sort((a, b) => a.title.localeCompare(b.title, 'es'))
  return (
    <div className="max-w-5xl mx-auto px-4 pt-4 pb-40 md:pb-24">
      <SellerBreadcrumb />
      <h1 className="text-xl sm:text-2xl font-bold mt-2 mb-3">Vender en persona</h1>
      <CounterClient products={products} truncated={truncated} />
    </div>
  )
}
