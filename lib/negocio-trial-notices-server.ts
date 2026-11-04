/**
 * The I/O shell for the trial's emails (plans-gratis-negocio S2.3). Reads owned shops with a trial, resolves each
 * plan (uncached: a daily job, and a paid shop must not get the reminder), claims through `merge_shop_metadata` with
 * an `equals` guard on the exact trial read, and sends through `dispatchToSeller` (the merchant's own channel switches).
 *
 * server-only.
 */
import 'server-only'
import { db } from '@/lib/supabase'
import { dispatchToSeller } from '@/lib/notifications/dispatch'
import { sendNegocioTrialNotice } from '@/lib/email'
import { NEGOCIO_TRIAL_KEY, readNegocioTrial } from '@/lib/plan'
import { resolvePlan } from '@/lib/plan-server'
import type { TrialNoticeDeps, TrialShop } from '@/lib/negocio-trial-notices'

const BATCH = 1000

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
      return (data as Array<{ id: string; slug: string; name: string | null; clerk_user_id: string; metadata: Record<string, unknown> | null }>)
        .map((r) => ({ row: r, trial: readNegocioTrial(r.metadata) }))
        .filter((x) => x.trial !== null)
        .map(({ row, trial }) => ({
          id: row.id,
          slug: row.slug,
          name: row.name,
          clerk_user_id: row.clerk_user_id,
          trial: trial!,
          rawTrial: row.metadata?.[NEGOCIO_TRIAL_KEY] ?? null,
        }))
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
    send: async (shop, notice) => {
      let emailFailed: string | null = null
      await dispatchToSeller(shop.clerk_user_id, {
        group: 'onboarding',
        email: async (to) => {
          const r = await sendNegocioTrialNotice({ to, shopName: shop.name ?? shop.slug, notice, endsAt: shop.trial.expires_at, shopId: shop.id })
          if (!r.ok) emailFailed = r.reason
        },
      })
      if (emailFailed) throw new Error(`email ${emailFailed}`)
    },
    now: () => new Date(),
  }
}
