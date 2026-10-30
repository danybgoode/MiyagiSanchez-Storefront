import { redirect } from 'next/navigation'
import { auth } from '@clerk/nextjs/server'
import { getMySeller } from '@/lib/get-my-seller'
import { loadCounterProducts } from '@/lib/in-person/counter-products-server'
import { SellerBreadcrumb } from '../SellerBreadcrumb'
import CounterClient from './CounterClient'

export const metadata = { title: 'Vender en persona — Mi tienda' }

// Stock changes with every sale; a cached counter would sell what is already gone.
export const dynamic = 'force-dynamic'

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

  const { products, truncated } = await loadCounterProducts(jwt)
  return (
    <div className="max-w-5xl mx-auto px-4 pt-4 pb-40 md:pb-24">
      <SellerBreadcrumb />
      <h1 className="text-xl sm:text-2xl font-bold mt-2 mb-3">Vender en persona</h1>
      <CounterClient products={products} truncated={truncated} shopName={seller.name} shopSlug={seller.slug} sellerId={seller.id} />
    </div>
  )
}
