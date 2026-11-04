/**
 * lib/plan-by-slug-server.ts — a shop's plan by its SLUG, cached five minutes (plans-gratis-negocio S2.1/S2.2).
 *
 * Public surfaces (the white-label badge, the shop chat) know only the slug, and read on every page view or message.
 * The plan lives on the Supabase mirror (`marketplace_shops`), joined on the slug — never a Medusa Commerce id. Cached
 * so a page view or a chat message never waits on the subscription lookup; a merchant who pays sees the change within
 * minutes. `null` = the plan could not be read; each caller decides which way that fails.
 *
 * server-only.
 */
import 'server-only'
import { unstable_cache } from 'next/cache'
import { db } from '@/lib/supabase'
import { resolvePlan } from '@/lib/plan-server'
import type { PlanState } from '@/lib/plan'

async function readPlanForSlug(slug: string): Promise<PlanState | null> {
  try {
    const { data, error } = await db
      .from('marketplace_shops')
      .select('id, clerk_user_id, metadata')
      .eq('slug', slug)
      .maybeSingle()
    if (error || !data) return null
    const row = data as { id: string; clerk_user_id: string | null; metadata: unknown }
    return await resolvePlan(row.metadata, { sellerClerkId: row.clerk_user_id, shopId: row.id })
  } catch {
    return null
  }
}

const cachedPlanForSlug = unstable_cache(readPlanForSlug, ['plan-by-slug'], { revalidate: 300 })

export async function planForSlug(slug: string): Promise<PlanState | null> {
  if (!slug) return null
  try {
    return await cachedPlanForSlug(slug.toLowerCase())
  } catch {
    return null
  }
}
