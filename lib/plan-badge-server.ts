/**
 * lib/plan-badge-server.ts — does a white-label shop show the Gratis badge? (plans-gratis-negocio S2.1, D7)
 *
 * Reads the shop's plan by slug (`planForSlug`, cached five minutes). Fails toward SHOWING the badge: a link back to
 * the platform on a shop that paid is a cosmetic slip for at most five minutes; an error page is not.
 *
 * server-only.
 */
import 'server-only'
import { planShowsBadge } from '@/lib/plan'
import { planForSlug } from '@/lib/plan-by-slug-server'

export async function shopShowsBadge(slug: string): Promise<boolean> {
  const plan = await planForSlug(slug)
  return plan ? planShowsBadge(plan) : true
}
