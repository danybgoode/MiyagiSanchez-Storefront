/**
 * The setup guide's reads — ONE query, called by Resumen (`/shop/manage`) and the owner canvas (`/sell/armar`), so
 * the two can never read different rows for the same merchant (prompt-to-shop S4.1, D17).
 */

import 'server-only'
import { db } from '@/lib/supabase'
import { DELETED_STATUS } from '@/lib/listing-lifecycle'
import { GUIDE_SHOP_COLUMNS, type GuideShopRow } from './setup-guide-source'

/**
 * The merchant's guide row: their FIRST `marketplace_shops` row by creation, exactly as Resumen has always read it.
 * `undefined` means the read failed; `null` means there is no row. Resumen renders both as "no guide".
 */
export async function fetchGuideShop(clerkUserId: string): Promise<(GuideShopRow & { id: string }) | null | undefined> {
  const { data, error } = await db
    .from('marketplace_shops')
    .select(`id, ${GUIDE_SHOP_COLUMNS}`)
    .eq('clerk_user_id', clerkUserId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) return undefined
  return (data as (GuideShopRow & { id: string }) | null) ?? null
}

/** Medusa product ids the Supabase mirror already marks deleted (Resumen's deploy-lag guard). */
export async function fetchDeletedListingIds(shopMirrorId: string): Promise<Set<string>> {
  const { data } = await db
    .from('marketplace_listings')
    .select('medusa_product_id')
    .eq('shop_id', shopMirrorId)
    .eq('status', DELETED_STATUS)
  return new Set((data ?? []).map((row) => row.medusa_product_id as string | null).filter((id): id is string => !!id))
}
