/**
 * May THIS promoter close a package on THIS shop? (epic 08 · plans-gratis-negocio S4.2 — Codex security, #474.)
 *
 * `resolveTargetShop` only proves a shop exists. A package grants Negocio and makes the promoter the shop's renewal
 * beneficiary, so a promoter must not be able to attach themselves to someone else's shop by paying a small share.
 * A promoter may close a package only on a shop they themselves opened (its `source_url` is
 * `promoter://<their code>/…`, minted by the workspace's «Abrir la tienda»), or on a shop linked to their OWN merchant
 * relationship record (`merchant_relationships.promoter_id = them`, `shop_id = the shop`).
 *
 * Anything that cannot be read is a refusal (fail closed).
 */
import 'server-only'
import { db } from '@/lib/supabase'
import { isSelfOwned, promoterOpenedShop } from '@/lib/promoter-close'

export async function promoterMayCloseShop(input: {
  promoter: { id: string; code: string; clerk_user_id?: string | null }
  shop: { id: string; sourceUrl: string | null; clerkUserId?: string | null }
}): Promise<boolean> {
  // Never on a shop the promoter OWNS (Codex security, #474): opening a shop, claiming it with their own account and
  // closing a package would buy Negocio at the promoter's share. A product call for Daniel may relax this.
  if (isSelfOwned(input.shop.clerkUserId, input.promoter.clerk_user_id)) return false
  if (promoterOpenedShop(input.shop.sourceUrl, input.promoter.code)) return true
  const { data, error } = await db
    .from('merchant_relationships')
    .select('id')
    .eq('promoter_id', input.promoter.id)
    .eq('shop_id', input.shop.id)
    .limit(1)
  if (error) return false
  return Array.isArray(data) && data.length > 0
}
