import { redirect, notFound } from 'next/navigation'
import { auth, currentUser } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { isEnabled } from '@/lib/flags'
import { resolveMlSyncEntitlement } from '@/lib/ml-sync-entitlement-server'
import {
  computeOrderMargins,
  computeSkuMargins,
  type ProfitEvent,
  type ProfitOrderInfo,
} from '@/lib/profit'
import ProfitClient from './ProfitClient'

export const metadata = { title: 'Ganancias — Mi tienda' }

// The flag check runs BEFORE any dynamic API (flag → notFound → currentUser),
// so without this Next prerenders the page at build time with the flag's
// BUILD-TIME value — the launch flip of `ops.profit_enabled` served a baked
// static 404 forever (caught live at flip, 2026-07-06). Force per-request
// rendering so the flag is evaluated at runtime like every other gate.
export const dynamic = 'force-dynamic'

/**
 * Seller profit/margins dashboard (profit-analyzer S1 · US-3). Dark behind
 * `ops.profit_enabled` (flag → notFound, before auth — the flag decides
 * whether the page exists). Reads the backend's raw financial-events ledger
 * and computes everything in the pure `lib/profit.ts` seam. ML-fee analytics
 * ride the `ml_sync` SKU: fee columns render only for entitled sellers
 * (`resolveMlSyncEntitlement` — same gate as the ML manage page).
 */
export default async function ProfitPage() {
  if (!(await isEnabled('ops.profit_enabled'))) notFound()

  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const { data: shop } = await db
    .from('marketplace_shops')
    .select('id, slug, metadata')
    .eq('clerk_user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!shop?.slug) redirect('/sell')

  // Ledger read — seller-scoped, Clerk-authed, straight from the backend.
  let events: ProfitEvent[] = []
  let orders: ProfitOrderInfo[] = []
  let loadFailed = false
  try {
    const { getToken } = await auth()
    const clerkJwt = await getToken()
    if (!clerkJwt) throw new Error('no token')
    const base = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
    const pub = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''
    const r = await fetch(`${base}/store/sellers/me/profit`, {
      headers: { 'x-publishable-api-key': pub, Authorization: `Bearer ${clerkJwt}` },
      cache: 'no-store',
    })
    if (!r.ok) throw new Error(`profit read ${r.status}`)
    const d = await r.json() as { events?: ProfitEvent[]; orders?: ProfitOrderInfo[] }
    events = d.events ?? []
    orders = d.orders ?? []
  } catch {
    loadFailed = true
  }

  const entitlement = await resolveMlSyncEntitlement(shop.metadata, { sellerClerkId: user.id, shopId: shop.id })
  const showMlFees = entitlement?.entitled ?? false

  const orderRows = computeOrderMargins(events, orders)
  const skuRows = computeSkuMargins(events, orders)

  return (
    <ProfitClient
      orderRows={orderRows}
      skuRows={skuRows}
      showMlFees={showMlFees}
      loadFailed={loadFailed}
    />
  )
}
