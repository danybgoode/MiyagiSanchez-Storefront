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
import { getTiendaSubscription } from '@/lib/tienda-subscription'
import {
  NEGOCIO_TRIAL_KEY,
  buildNegocioTrial,
  canStartTrial,
  guardFor,
  derivePlanFromMetadata,
  isLiveDatedGrant,
  readNegocioGrant,
  tiendaLookupNeeded,
  type PlanState,
} from '@/lib/plan'

export type ResolvePlanOptions = {
  /** The shop owner's Clerk id — the key of their Medusa Commerce subscription. Omit for an unowned shop. */
  sellerClerkId?: string | null
  /** The marketplace shop id: a plan is per shop, so the subscription must be this shop's (README D1). */
  shopId?: string | null
  /** Pass a known Negocio answer (a caller that already read it, or a test) to skip the lookup. */
  hasActiveSubscription?: boolean
  /** Pass a known Tienda answer to skip its lookup. Omitted: looked up when needed (`tiendaSubscriptionFacts`). */
  hasActiveTiendaSubscription?: boolean
  now?: Date
}

/**
 * The monthly Plan Tienda subscription answer (plan-tienda S2.2, replacing sprint 1's "nobody can hold one yet").
 * Read from Medusa Commerce through `lib/tienda-subscription.ts`, and ONLY when nothing that outranks it already
 * decides the plan (`tiendaLookupNeeded`) — most shops pay no extra round trip. A failed read is
 * `{ hasActiveTiendaSubscription: undefined, tiendaSubscriptionUnavailable: true }`, never "not subscribed": the plan
 * then reads `unavailable` unless something that WAS read is live (lib/plan.ts header).
 */
async function tiendaSubscriptionFacts(
  metadata: unknown,
  hasActiveSubscription: boolean | undefined,
  opts: ResolvePlanOptions,
  now: Date,
): Promise<{ hasActiveTiendaSubscription: boolean | undefined; tiendaSubscriptionUnavailable?: boolean }> {
  if (opts.hasActiveTiendaSubscription !== undefined) return { hasActiveTiendaSubscription: opts.hasActiveTiendaSubscription }
  if (!tiendaLookupNeeded(metadata, hasActiveSubscription, now)) return { hasActiveTiendaSubscription: undefined }
  // Without BOTH ids there is no subscription to look up — an unowned shop cannot hold one, exactly as the Negocio
  // lookup below treats it. That is a known absence, not "could not look".
  if (!opts.sellerClerkId || !opts.shopId) return { hasActiveTiendaSubscription: false }
  const sub = await getTiendaSubscription(opts.sellerClerkId, opts.shopId)
  return sub.unavailable
    ? { hasActiveTiendaSubscription: undefined, tiendaSubscriptionUnavailable: true }
    : { hasActiveTiendaSubscription: sub.active }
}

/**
 * The shop's plan. The Negocio subscription is looked up only when nothing on the shop already makes it Negocio (a
 * comp or a live dated grant), and the Tienda subscription only when neither Negocio nor a live trial (nor a live
 * Tienda grant) decides it, so most reads cost no backend round-trip. A failed lookup yields `reason: 'unavailable'`
 * (Gratis for gating, never a grant and never `unpaid`) unless something that was read is live — see the header of
 * `lib/plan.ts`.
 */
export async function resolvePlan(metadata: unknown, opts: ResolvePlanOptions = {}): Promise<PlanState> {
  const now = opts.now ?? new Date()
  const grant = readNegocioGrant(metadata)
  const grantDecides = grant?.type === 'comp' || isLiveDatedGrant(grant, now)

  // No lookup without BOTH ids: the Backend requires shop_id (a plan is per shop), so an unowned shop or a caller
  // without the shop id never reaches it.
  if (grantDecides || opts.hasActiveSubscription !== undefined || !opts.sellerClerkId || !opts.shopId) {
    const hasActiveSubscription = opts.hasActiveSubscription ?? false
    const tienda = await tiendaSubscriptionFacts(metadata, hasActiveSubscription, opts, now)
    return derivePlanFromMetadata(metadata, { hasActiveSubscription, ...tienda }, now)
  }
  const sub = await getNegocioSubscription(opts.sellerClerkId, opts.shopId)
  const hasActiveSubscription = sub.unavailable ? undefined : sub.active
  const tienda = await tiendaSubscriptionFacts(metadata, hasActiveSubscription, opts, now)
  return derivePlanFromMetadata(metadata, { hasActiveSubscription, subscriptionUnavailable: sub.unavailable, ...tienda }, now)
}

export type OwnedShopRow = { id: string; slug: string; clerk_user_id: string | null; metadata: unknown }

/** The owner's shop row (their oldest, matching every other owner surface's lookup), or null. */
export async function readOwnedShop(clerkUserId: string): Promise<OwnedShopRow | null> {
  const { data, error } = await db
    .from('marketplace_shops')
    .select('id, slug, clerk_user_id, metadata')
    .eq('clerk_user_id', clerkUserId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true }) // a deterministic tie-break: two reads must never pick different shops
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
  // `canStartTrial` treats a JSON-null trial as "never trialed", so the guard must match it (`json_null`), or the
  // write silently never lands and the shop never gets its trial.
  const guard = guardFor(shop.metadata, NEGOCIO_TRIAL_KEY)
  if (guard.mode === 'equals') return 'not_eligible'
  const { data, error } = await db.rpc('merge_shop_metadata', {
    p_shop_id: shop.id,
    p_patch: { [NEGOCIO_TRIAL_KEY]: buildNegocioTrial(now) },
    p_guard_key: NEGOCIO_TRIAL_KEY,
    p_guard_mode: guard.mode,
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

/**
 * The plan for a shop given its metadata, its owner and its id, for the item composers (custom domain, ML sync).
 * The shop id is REQUIRED: Negocio is per shop, and guessing it (say, the owner's oldest shop) would let one shop's
 * subscription open items on another (Codex, #471). Any failure returns null: the plan then opens nothing.
 */
export async function resolvePlanForOwner(
  metadata: unknown,
  opts: { sellerClerkId: string; shopId: string; now?: Date },
): Promise<PlanState | null> {
  try {
    return await resolvePlan(metadata, { sellerClerkId: opts.sellerClerkId, shopId: opts.shopId, now: opts.now })
  } catch (e) {
    console.error('[plan] owner plan read failed:', e)
    return null
  }
}
