import { redirect, notFound } from 'next/navigation'
import { currentUser, auth } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import OrderTrackingClient from './OrderTrackingClient'

export const metadata = { title: { absolute: 'Detalle de compra — Miyagi Sánchez' } }

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const MEDUSA_PUB_KEY = process.env.MEDUSA_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

export default async function BuyerOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  // ── Medusa-backed order (id like "order_…") ───────────────────────────────
  // Read straight from Medusa (the system of record) instead of the Supabase
  // mirror, so orders that were never mirrored still open. Ownership is enforced
  // server-side by the backend (Clerk JWT → customer.external_id).
  if (id.startsWith('order_')) {
    const { getToken } = await auth()
    const clerkJwt = await getToken()
    if (!clerkJwt) redirect('/sign-in')

    const res = await fetch(`${MEDUSA_BASE}/store/buyer/me/orders/${id}`, {
      headers: {
        'x-publishable-api-key': MEDUSA_PUB_KEY,
        Authorization: `Bearer ${clerkJwt}`,
      },
      cache: 'no-store',
    })
    if (!res.ok) notFound()
    const { order } = await res.json() as { order?: Parameters<typeof OrderTrackingClient>[0]['order'] }
    if (!order) notFound()
    return <OrderTrackingClient order={order} />
  }

  // ── Legacy Supabase order ─────────────────────────────────────────────────
  const buyerEmail = user.emailAddresses?.[0]?.emailAddress ?? ''

  const { data: order } = await db
    .from('marketplace_orders')
    .select(`
      id, status, amount_cents, currency, shipping_method, shipping_address,
      buyer_name, buyer_email, buyer_clerk_user_id, created_at, updated_at,
      marketplace_listings!inner(id, title, images, listing_type),
      marketplace_shops!inner(id, name, slug),
      marketplace_shipments(
        id, carrier, tracking_number, label_url, status,
        estimated_delivery_date, created_at
      )
    `)
    .eq('id', id)
    .maybeSingle()

  if (!order) notFound()

  // Access control: buyer only
  const isBuyer =
    order.buyer_clerk_user_id === user.id ||
    order.buyer_email?.toLowerCase() === buyerEmail.toLowerCase()

  if (!isBuyer) notFound()

  return <OrderTrackingClient order={order as Parameters<typeof OrderTrackingClient>[0]['order']} />
}
