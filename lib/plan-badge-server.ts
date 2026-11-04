/**
 * lib/plan-badge-server.ts — does a white-label shop show the Gratis badge? (plans-gratis-negocio S2.1, D7)
 *
 * The white-label layout's shop comes from Medusa Commerce (`getShop`), but the plan lives on the Supabase mirror
 * (`marketplace_shops.metadata`) — joined on the SLUG, never the id (the two stores' ids differ). Read on every
 * subdomain and embed page, so it is cached for five minutes per slug: a merchant who pays sees the badge go within
 * minutes, and a page view never waits on the subscription lookup.
 *
 * Fails toward SHOWING the badge: a link back to the platform on a shop that paid is a cosmetic slip for at most five
 * minutes; an error page is not.
 *
 * server-only.
 */
import 'server-only'
import { unstable_cache } from 'next/cache'
import { db } from '@/lib/supabase'
import { planShowsBadge } from '@/lib/plan'
import { resolvePlan } from '@/lib/plan-server'

async function readShowsBadge(slug: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('marketplace_shops')
      .select('id, clerk_user_id, metadata')
      .eq('slug', slug)
      .maybeSingle()
    if (error || !data) return true
    const row = data as { id: string; clerk_user_id: string | null; metadata: unknown }
    const plan = await resolvePlan(row.metadata, { sellerClerkId: row.clerk_user_id, shopId: row.id })
    return planShowsBadge(plan)
  } catch {
    return true
  }
}

const cachedShowsBadge = unstable_cache(readShowsBadge, ['plan-badge'], { revalidate: 300 })

export async function shopShowsBadge(slug: string): Promise<boolean> {
  if (!slug) return true
  try {
    return await cachedShowsBadge(slug)
  } catch {
    return true
  }
}
