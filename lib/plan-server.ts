/**
 * lib/plan-server.ts — the I/O shell around `lib/plan.ts` (epic 08 · plans-gratis-negocio S1.2, README D1/D4).
 *
 * `resolvePlan` is the ONE way a gate learns a shop's plan: it reads the Medusa Commerce subscription only when the
 * shop's own grants do not already answer, then hands every fact to the pure `derivePlanFromMetadata`.
 *
 * `ensureNegocioTrial` stamps the 30-day trial the first time an owned shop's owner opens their panel. The write is
 * `merge_shop_metadata` guarded on the key being ABSENT: one atomic statement that merges only the trial key (a
 * concurrent change to any other key survives) and does nothing if a trial already exists — so two tabs opening the
 * panel at once can never stamp two trials, and the trial is never moved.
 *
 * server-only (reads the service-role Supabase client and the Medusa internal secret).
 */
import 'server-only'
import { db } from '@/lib/supabase'
import { getNegocioSubscription } from '@/lib/negocio-subscription'
import {
  NEGOCIO_TRIAL_KEY,
  buildNegocioTrial,
  canStartTrial,
  derivePlanFromMetadata,
  readNegocioGrant,
  type PlanState,
} from '@/lib/plan'

export type ResolvePlanOptions = {
  /** The shop owner's Clerk id — the key of their Medusa Commerce subscription. Omit for an unowned shop. */
  sellerClerkId?: string | null
  /** The marketplace shop id: Negocio is per shop, so the subscription must be this shop's (README D1). */
  shopId?: string | null
  /** Pass a known answer (a caller that already read it, or a test) to skip the lookup. */
  hasActiveSubscription?: boolean
  now?: Date
}

/**
 * The shop's plan. The subscription is looked up only when nothing on the shop already makes it Negocio (a comp or a
 * live one_time grant), so most reads cost no backend round-trip. A failed lookup yields `reason: 'unavailable'`
 * (Gratis for gating, never a grant).
 */
export async function resolvePlan(metadata: unknown, opts: ResolvePlanOptions = {}): Promise<PlanState> {
  const now = opts.now ?? new Date()
  const grant = readNegocioGrant(metadata)
  const grantDecides = grant?.type === 'comp' || (grant?.type === 'one_time' && !!grant.expires_at && Date.parse(grant.expires_at) > now.getTime())

  // No lookup without BOTH ids: the Backend requires shop_id (Negocio is per shop), so an unowned shop or a caller
  // without the shop id never reaches it.
  if (grantDecides || opts.hasActiveSubscription !== undefined || !opts.sellerClerkId || !opts.shopId) {
    return derivePlanFromMetadata(metadata, { hasActiveSubscription: opts.hasActiveSubscription ?? false }, now)
  }
  const sub = await getNegocioSubscription(opts.sellerClerkId, opts.shopId)
  return derivePlanFromMetadata(
    metadata,
    { hasActiveSubscription: sub.unavailable ? undefined : sub.active, subscriptionUnavailable: sub.unavailable },
    now,
  )
}

export type OwnedShopRow = { id: string; slug: string; clerk_user_id: string | null; metadata: unknown }

/** The owner's shop row (their oldest, matching every other owner surface's lookup), or null. */
export async function readOwnedShop(clerkUserId: string): Promise<OwnedShopRow | null> {
  const { data, error } = await db
    .from('marketplace_shops')
    .select('id, slug, clerk_user_id, metadata')
    .eq('clerk_user_id', clerkUserId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`marketplace_shops read failed: ${error.message}`)
  return (data as OwnedShopRow | null) ?? null
}

export type EnsureTrialResult = 'stamped' | 'already' | 'not_eligible' | 'no_shop'

/**
 * Stamp the trial once, for an owned shop that never had a trial or Negocio. Idempotent and race-safe (the guard is
 * in the UPDATE). Never call it from a public read: the trial starts when the OWNER arrives (D4), so a promoter's
 * unclaimed shop never spends its trial before the merchant claims it.
 */
export async function ensureNegocioTrial(clerkUserId: string, now: Date = new Date()): Promise<EnsureTrialResult> {
  const shop = await readOwnedShop(clerkUserId)
  if (!shop) return 'no_shop'
  if (!canStartTrial(shop.metadata)) return 'not_eligible'
  const { data, error } = await db.rpc('merge_shop_metadata', {
    p_shop_id: shop.id,
    p_patch: { [NEGOCIO_TRIAL_KEY]: buildNegocioTrial(now) },
    p_guard_key: NEGOCIO_TRIAL_KEY,
    p_guard_mode: 'absent',
    p_expected: null,
  })
  if (error) throw new Error(`negocio trial stamp failed: ${error.message}`)
  // Zero rows: the guard fired — a trial appeared between the read and the write. That is the idempotent outcome.
  return Array.isArray(data) && data.length > 0 ? 'stamped' : 'already'
}

/** The signed-in owner's shop and its plan, for owner surfaces («Tu suscripción», the panel). */
export async function resolveMyPlan(clerkUserId: string, now: Date = new Date()): Promise<{ shop: OwnedShopRow; plan: PlanState } | null> {
  const shop = await readOwnedShop(clerkUserId)
  if (!shop) return null
  const plan = await resolvePlan(shop.metadata, { sellerClerkId: clerkUserId, shopId: shop.id, now })
  return { shop, plan }
}
