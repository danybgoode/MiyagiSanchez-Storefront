import { notFound, redirect } from 'next/navigation'
import { auth } from '@clerk/nextjs/server'
import OrderDetail from './OrderDetail'
import { stripBuyerClerkId } from '@/lib/order-buyer'

export const metadata = { title: { absolute: 'Detalle de pedido — Miyagi Sánchez' } }

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const MEDUSA_PUB_KEY = process.env.MEDUSA_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { userId, getToken } = await auth()
  if (!userId) redirect('/sign-in')

  const clerkJwt = await getToken()
  if (!clerkJwt) redirect('/sign-in')

  // All seller orders now routed by Medusa order ID
  const res = await fetch(`${MEDUSA_BASE}/store/sellers/me/orders/${id}`, {
    headers: {
      'x-publishable-api-key': MEDUSA_PUB_KEY,
      Authorization: `Bearer ${clerkJwt}`,
    },
    cache: 'no-store',
  })

  if (!res.ok) notFound()

  const { order: rawOrder } = await res.json() as { order?: Record<string, unknown> }
  if (!rawOrder) notFound()
  // Strip the buyer's Clerk id before it crosses into the 'use client' OrderDetail
  // component — it's a server-side-only dispatch-gating field (buyer-notifications-
  // money-path S1), never meant to reach the browser.
  const order = stripBuyerClerkId(rawOrder) as Parameters<typeof OrderDetail>[0]['order']

  return <OrderDetail order={order} />
}
