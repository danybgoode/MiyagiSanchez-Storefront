/**
 * lib/ml-sync-entitlement-server.ts
 *
 * Server-side composer for the ML-sync paid/promoter-SKU gate (epic 03 ·
 * mercadolibre-sync, S5 · US-14; subscription wired in S6). A faithful clone of
 * `lib/subdomain-entitlement-server.ts`: reads the rollout flag (fail-open) + the
 * durable grant off the shop's metadata, conditionally resolves the seller's Medusa
 * ML-sync subscription, then runs the pure deriver.
 *
 * Keep the pure logic in `lib/ml-sync-entitlement.ts` so the Playwright `api` runner
 * can unit-test the seam without pulling in `server-only`.
 *
 * FAIL-SAFE by design: `ml.sync_paywall_enabled` defaults OFF, so if the flag store
 * is unreachable (or the flag is simply not flipped) every connected seller stays
 * entitled — an already-enabled tester can never be trapped behind the paywall.
 */
import 'server-only'
import { entitleByPlan, planOpensMlSync } from '@/lib/plan'
import { resolvePlanForOwner } from '@/lib/plan-server'
import { isEnabled } from '@/lib/flags'
import { readMlSyncGrant, deriveMlSyncEntitlement } from '@/lib/ml-sync-entitlement'
import { isOneTimeGrantLive, type DomainEntitlement } from '@/lib/domain-entitlement'
import { hasActiveMlSyncSubscription } from '@/lib/ml-sync-subscription'

/**
 * Resolve a shop's ML-sync entitlement from its `metadata` JSONB.
 *
 * Pass `sellerClerkId` and this resolves the seller's Medusa ML-sync subscription
 * (the source of truth) to feed the deriver's `hasActiveSubscription`. The lookup is
 * SKIPPED when the paywall is off (everyone ungated) or an entitling grant already
 * covers the shop — so a comp/grandfathered/live-one-time shop adds zero backend
 * round-trip. Callers that already have the boolean (or a unit test) may pass
 * `hasActiveSubscription` directly to skip the lookup.
 */
export async function resolveMlSyncEntitlement(
  metadata: unknown,
  opts?: {
    sellerClerkId?: string
    hasActiveSubscription?: boolean
    /** The marketplace shop whose metadata this is. REQUIRED for Negocio to open the item (Negocio is per shop):
     *  without it the plan is not read and only the item's own grants and subscription count. */
    shopId?: string | null
  },
): Promise<DomainEntitlement> {
  const paywallEnabled = await isEnabled('ml.sync_paywall_enabled')

  const grant = readMlSyncGrant(metadata)
  const grantEntitles =
    grant?.type === 'grandfather' || grant?.type === 'comp' || isOneTimeGrantLive(grant)
  let hasActiveSubscription = opts?.hasActiveSubscription
  if (hasActiveSubscription === undefined && paywallEnabled && !grantEntitles && opts?.sellerClerkId) {
    hasActiveSubscription = await hasActiveMlSyncSubscription(opts.sellerClerkId)
  }

  const own = deriveMlSyncEntitlement({ paywallEnabled, grant, hasActiveSubscription })
  // Negocio includes the ML sync (plans-gratis-negocio D5). The item's own answer wins when it entitles — an old grant
  // or a standalone subscription keeps working — so the plan is only read when it could change the answer.
  if (own.entitled || !opts?.sellerClerkId || !opts.shopId) return own
  const plan = await resolvePlanForOwner(metadata, { sellerClerkId: opts.sellerClerkId, shopId: opts.shopId })
  return entitleByPlan(own, plan, planOpensMlSync)
}
