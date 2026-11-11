/**
 * The I/O shell for the free months' notices (plans-gratis-negocio S2.3; plan-tienda S3.2). Reads owned shops with a trial, resolves each
 * plan (uncached: a daily job, and a paid shop must not get the reminder), claims through `merge_shop_metadata` with
 * an `equals` guard on the exact trial read, and sends through `dispatchToSeller` (the merchant's own channel switches).
 *
 * server-only.
 */
import 'server-only'
import { db } from '@/lib/supabase'
import { dispatchToSeller } from '@/lib/notifications/dispatch'
import { sendNegocioTrialNotice } from '@/lib/email'
import { NEGOCIO_TRIAL_KEY, readNegocioTrial, readPlanLegacyState } from '@/lib/plan'
import { claimMarket, hasPlanPause, rawPlanPause, type PlanPauseMarket } from '@/lib/plan-pause'
import { readShopMarket } from '@/lib/plan-pause-server'
import { noticeVariantFor } from '@/lib/negocio-trial-notices'
import { resolvePlan } from '@/lib/plan-server'
import type { TrialNoticeDeps, TrialShop } from '@/lib/negocio-trial-notices'

const BATCH = 1000

/**
 * The market, read only for a NEW shop (a legacy shop's wording does not depend on it, so it costs no read). A paused
 * shop's comes from its claim: the public seller read hides a paused seller.
 */
async function marketFor(slug: string, metadata: unknown): Promise<PlanPauseMarket> {
  if (readPlanLegacyState(metadata) !== 'absent') return 'unknown'
  if (hasPlanPause(metadata)) return claimMarket(metadata)
  return readShopMarket(slug, metadata)
}

/** The claim's `paused_at`, when it is a string; anything else is null (the decision then counts from the end). */
function pausedAtOf(metadata: unknown): string | null {
  const raw = rawPlanPause(metadata) as { paused_at?: unknown } | null
  return raw && typeof raw === 'object' && typeof raw.paused_at === 'string' ? raw.paused_at : null
}

export function trialNoticeDeps(): TrialNoticeDeps {
  return {
    readShops: async () => {
      const { data, error } = await db
        .from('marketplace_shops')
        .select('id, slug, name, clerk_user_id, metadata')
        .not('clerk_user_id', 'is', null)
        .not(`metadata->${NEGOCIO_TRIAL_KEY}`, 'is', null)
        .order('created_at', { ascending: true })
        .limit(BATCH)
      if (error || !Array.isArray(data)) return null
      const rows = (data as Array<{ id: string; slug: string; name: string | null; clerk_user_id: string; metadata: Record<string, unknown> | null }>)
        .map((r) => ({ row: r, trial: readNegocioTrial(r.metadata) }))
        .filter((x) => x.trial !== null)
      const shops: TrialShop[] = []
      for (const { row, trial } of rows) shops.push({
          id: row.id,
          slug: row.slug,
          name: row.name,
          clerk_user_id: row.clerk_user_id,
          trial: trial!,
          rawTrial: row.metadata?.[NEGOCIO_TRIAL_KEY] ?? null,
          facts: {
            legacy: readPlanLegacyState(row.metadata),
            planPaused: hasPlanPause(row.metadata),
            pausedAt: pausedAtOf(row.metadata),
            market: await marketFor(row.slug, row.metadata),
          },
        })
      return shops
    },
    readPlan: async (shop: TrialShop) => {
      const { data } = await db.from('marketplace_shops').select('metadata').eq('id', shop.id).maybeSingle()
      if (!data) return null
      const plan = await resolvePlan((data as { metadata: unknown }).metadata, { sellerClerkId: shop.clerk_user_id, shopId: shop.id })
      // A subscription that could not be read must not trigger «ya estás en Gratis» on a paying merchant.
      return plan.reason === 'unavailable' ? null : plan
    },
    claim: async (shop, next) => {
      const { data, error } = await db.rpc('merge_shop_metadata', {
        p_shop_id: shop.id,
        p_patch: { [NEGOCIO_TRIAL_KEY]: next },
        p_guard_key: NEGOCIO_TRIAL_KEY,
        p_guard_mode: 'equals',
        p_expected: shop.rawTrial,
      })
      return !error && Array.isArray(data) && data.length === 1
    },
    release: async (shop, claimed) => {
      await db.rpc('merge_shop_metadata', {
        p_shop_id: shop.id,
        p_patch: { [NEGOCIO_TRIAL_KEY]: shop.rawTrial },
        p_guard_key: NEGOCIO_TRIAL_KEY,
        p_guard_mode: 'equals',
        p_expected: claimed,
      })
    },
    send: async (shop, notice) => {
      let emailFailed: string | null = null
      await dispatchToSeller(shop.clerk_user_id, {
        group: 'onboarding',
        email: async (to) => {
          const r = await sendNegocioTrialNotice({ to, shopName: shop.name ?? shop.slug, notice, variant: noticeVariantFor(shop.facts.legacy), endsAt: shop.trial.expires_at, shopId: shop.id })
          if (!r.ok) emailFailed = r.reason
        },
      })
      if (emailFailed) throw new Error(`email ${emailFailed}`)
    },
    now: () => new Date(),
  }
}
