import { redirect } from 'next/navigation'
import { auth } from '@clerk/nextjs/server'
import OrdersInbox from './OrdersInbox'
import { stripBuyerClerkId } from '@/lib/order-buyer'

export const metadata = { title: { absolute: 'Pedidos — Miyagi Sánchez' } }

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const MEDUSA_PUB_KEY = process.env.MEDUSA_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

export default async function OrdersPage() {
  const { userId, getToken } = await auth()
  if (!userId) redirect('/sign-in')

  const clerkJwt = await getToken()
  if (!clerkJwt) redirect('/sign-in')

  // Fetch seller profile for shop name/slug in the UI header
  let shop = { id: '', slug: '', name: 'Mi tienda' }
  try {
    const res = await fetch(`${MEDUSA_BASE}/store/sellers/me`, {
      headers: {
        'x-publishable-api-key': MEDUSA_PUB_KEY,
        Authorization: `Bearer ${clerkJwt}`,
      },
      cache: 'no-store',
    })
    if (res.ok) {
      const { seller } = await res.json() as { seller?: { id: string; slug: string; name: string } }
      if (seller) shop = { id: seller.id, slug: seller.slug, name: seller.name }
    }
  } catch { /* proceed with defaults */ }

  if (!shop.id) redirect('/sell')

  // Fetch orders from Medusa
  let orders: Parameters<typeof OrdersInbox>[0]['initialOrders'] = []
  try {
    const res = await fetch(`${MEDUSA_BASE}/store/sellers/me/orders`, {
      headers: {
        'x-publishable-api-key': MEDUSA_PUB_KEY,
        Authorization: `Bearer ${clerkJwt}`,
      },
      cache: 'no-store',
    })
    if (res.ok) {
      const { orders: data } = await res.json() as { orders?: Array<Record<string, unknown>> }
      // Strip the buyer's Clerk id before it crosses into the 'use client'
      // OrdersInbox component — it's a server-side-only dispatch-gating field
      // (buyer-notifications-money-path S1), never meant to reach the browser.
      orders = (data ?? []).map(stripBuyerClerkId) as unknown as typeof orders
    }
  } catch { /* show empty inbox */ }

  return <OrdersInbox shop={shop} initialOrders={orders} />
}
