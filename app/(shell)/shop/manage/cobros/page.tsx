import { redirect } from 'next/navigation'
import { auth } from '@clerk/nextjs/server'
import { getMySeller } from '@/lib/get-my-seller'
import { loadCounterProducts } from '@/lib/in-person/counter-products-server'
import { SellerBreadcrumb } from '../SellerBreadcrumb'
import CobrosClient from './CobrosClient'

export const metadata = { title: 'Cobrar con un link — Mi tienda' }
export const dynamic = 'force-dynamic'

/**
 * «Cobrar con un link» (in-person-sales S4.3). The server only loads the shop's sellable products
 * (the same loader the counter uses); the links themselves are created, listed and cancelled
 * through `/api/shop/cobros/links`, which calls the backend directly.
 */
export default async function CobrosPage() {
  const { userId, getToken } = await auth()
  if (!userId) redirect('/sign-in')
  const jwt = await getToken()
  if (!jwt) redirect('/sign-in')
  const seller = await getMySeller()
  if (!seller) redirect('/sell')

  if (seller.market !== 'mx') {
    return (
      <div className="max-w-5xl mx-auto px-4 py-6">
        <SellerBreadcrumb />
        <h1 className="text-xl sm:text-2xl font-bold mt-2">Cobrar con un link</h1>
        <p className="text-sm text-[var(--color-muted)] mt-2">Cobrar con un link todavía no está disponible para tiendas fuera de México.</p>
      </div>
    )
  }

  const { products } = await loadCounterProducts(jwt)
  return (
    <div className="max-w-3xl mx-auto px-4 pt-4 pb-24">
      <SellerBreadcrumb />
      <h1 className="text-xl sm:text-2xl font-bold mt-2 mb-3">Cobrar con un link</h1>
      <CobrosClient products={products} shopName={seller.name} />
    </div>
  )
}
