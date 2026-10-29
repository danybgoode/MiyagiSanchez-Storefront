/**
 * lib/merchant-lifecycle-sweep.ts
 *
 * Golden Beans event-destination-router · Story 3.1 (extended: founding-merchant
 * activation ops, Sprint 3) — the periodic half of the emit side, and the safety net
 * for the whole of it. Five jobs, in order:
 *
 *   1. DRAIN pending emissions (claimed, not yet confirmed delivered).
 *   2. BACKFILL `preview_approved` / `claimed` / `first_sale` from state.
 *   3. Derive `merchant.three_products_live` from **Medusa**.
 *   4. Derive `merchant.retained_30d` from **Medusa**.
 *   5. EVALUATE every `merchant_relationships` row's 13-stage position from
 *      commerce + CRM facts, writing + emitting whatever newly advanced
 *      (`lib/merchant-relationship-lifecycle.ts#evaluateRelationship` — the
 *      "relationship evaluation" the Sprint 3 build contract adds to THIS
 *      route rather than a second cron).
 *
 * WHY BACKFILL WHAT THE HOOKS ALREADY EMIT (2).
 * The hooks in the approval and claim paths give TIMELINESS. This gives COMPLETENESS.
 * A hook that never ran — a transient DB error at claim time, a milestone reached before
 * this feature shipped, a new door someone adds later — would otherwise lose that
 * milestone permanently, because nothing ever revisits it. Deriving from state is
 * self-healing, and the once-only constraint means the two paths cannot collide.
 *
 * `first_sale` has NO hook at all and is derived here only. It briefly had one in
 * `upsertOrderMirror`, which was removed (cross-review round 3): the reconcile-cron path
 * reaches that writer long after the order, so it stamped the milestone with the
 * RECONCILIATION time, and the permanent outbox claim then blocked this sweep from ever
 * correcting it. Deriving it here uses Medusa's actual earliest captured order, and it
 * takes the money path out of this PR entirely — a worthwhile trade for at most a day of
 * latency on a CRM milestone.
 *
 * WHY A SWEEP AND NOT A HOOK AT ALL (3).
 * `three_products_live` is a THRESHOLD on accumulated state, not a moment, and it has
 * no single door: a product reaches `published` through the seller portal, the MCP
 * `create_listing` tool, the bulk catalog importer, supply activation, a preview
 * activation and the listing-status seam. Hooking the door you happen to find and
 * calling it done is exactly the failure this repo has already paid for (LEARNINGS:
 * "guard the population, not the door you found"). Deriving from the resulting STATE is
 * mechanically complete by construction — it does not care how the third product got
 * there, and a door added next month is covered without anyone remembering to.
 * `retained_30d` needs a sweep regardless: nothing happens at the 30-day mark to hook.
 *
 * MEDUSA IS COMMERCE TRUTH, INCLUDING HERE (AGENTS rule #1; cross-agent review, Codex,
 * PR 298). The first version counted `marketplace_listings` / `marketplace_orders` —
 * the Supabase mirrors. That was wrong in a way that matters: these milestones are
 * PERMANENT and once-only, so a mirror row that has drifted from Medusa emits a false
 * milestone that can never be withdrawn. Both counts now come from Medusa:
 *   - products via the public `GET /store/sellers/{slug}/products` (the same
 *     visibility-filtered read the public storefront uses — published means published),
 *   - orders via the backend internal `GET /internal/sellers/orders` (cron-usable; the
 *     Clerk-gated `/store/sellers/me/*` routes are not).
 * The mirrors are still read for *funnel bookkeeping* — who is a founding merchant, and
 * which shop maps to which seller slug. That is not commerce state.
 *
 * FAIL CLOSED. Every read that cannot be completed skips the merchant rather than
 * assuming zero, and the failure is COUNTED in the result so a cron that did nothing
 * cannot report success. An unreachable Medusa must never be read as "no products".
 */
import 'server-only'
import { db } from '@/lib/supabase'
import { isEnabled } from '@/lib/flags'
import { deriveSaleFacts, SELLER_GONE, shopIdForEmissionSubject } from '@/lib/merchant-lifecycle'
import {
  emitMerchantLifecycleForShop,
  deliverClaimedEmission,
  listPendingEmissions,
  type EmitOutcome,
} from '@/lib/merchant-lifecycle-server'
import { evaluateRelationship } from '@/lib/merchant-relationship-lifecycle'
import { scheduleRetentionTask } from '@/lib/portfolio/retention-server'
import { retentionDedupeKey } from '@/lib/portfolio/retention'
import { emitPortfolioLifecycleEvent, PORTFOLIO_EVENT_SWEEP_ACTOR } from '@/lib/portfolio/events-server'
import { loadPortfolio } from '@/lib/portfolio/loader'
import { portfolioEventDedupeKey } from '@/lib/portfolio/events'
// The Medusa GET reads and their constants moved to `lib/merchant-medusa-
// reads.ts` (Sprint 3) — see that file's header for why (breaking a circular
// import Story 3.1's relationship evaluation introduced). Re-exported below
// (not just imported) so `THREE_PRODUCTS_THRESHOLD` stays a stable public name
// from THIS file too, in case anything still imports it from here.
import {
  THREE_PRODUCTS_THRESHOLD,
  RETENTION_WINDOW_DAYS,
  countLiveProductsFromMedusa,
  listCapturedOrders,
} from '@/lib/merchant-medusa-reads'
export { THREE_PRODUCTS_THRESHOLD, RETENTION_WINDOW_DAYS, countLiveProductsFromMedusa, listCapturedOrders }

const RETENTION_WINDOW_MS = RETENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000

/**
 * Rows per page.
 *
 * MUST stay well under PostgREST's `db-max-rows` (default 1000), and the walk must not
 * depend on that: an earlier version used PAGE_SIZE = 1000 with a `limit + 1` probe, so
 * a request for 1001 rows was silently capped at 1000, the probe read "no more", and the
 * sweep stopped early while reporting `truncated: false` — a partial run announcing
 * itself as complete, which is the exact failure class six review rounds kept catching
 * (fresh-reviewer pass, PR 298). Two independent defences now: a page size with real
 * headroom, AND truncation decided by the server's own `count` rather than inferred from
 * page length, which is correct whatever `db-max-rows` turns out to be.
 */
const PAGE_SIZE = 500

/** UUIDs per `.in()` batch. These serialise into a GET query string, so a large batch
 *  is a 414 rather than a slow query — 200 uuids is roughly 7.6 KB, comfortably inside
 *  any proxy's header limit. */
const IN_BATCH_SIZE = 200

/** Hard ceiling on one run, so a runaway table cannot make the cron unbounded. The
 *  founding-merchant population is small by definition; reaching this means something
 *  is wrong, which is why it is REPORTED (`truncated`) rather than silently absorbed. */
const CANDIDATE_CAP = 20_000

/** Read every row of a table, page by page. Returns `truncated` only when the hard cap
 *  stopped the walk — never merely because one page was full. */
async function readPaged(
  table: string,
  columns: string,
): Promise<{ rows: Array<Record<string, unknown>>; truncated: boolean; errors: number }> {
  const rows: Array<Record<string, unknown>> = []
  for (let offset = 0; offset < CANDIDATE_CAP; offset += PAGE_SIZE) {
    // `count: 'exact'` makes the SERVER tell us the true total. Inferring "is there
    // more?" from how many rows came back cannot be trusted, because PostgREST may cap
    // the response below what we asked for — and then a short page is indistinguishable
    // from the end of the table.
    const { data, error, count } = await db
      .from(table)
      .select(columns, { count: 'exact' })
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) {
      // Report and stop: continuing past a failed page would produce a result that
      // looks complete while missing an arbitrary slice of the population.
      console.error(`[merchant-lifecycle] paged read of ${table} failed at ${offset}:`, error.message)
      return { rows, truncated: true, errors: 1 }
    }
    const page = (data ?? []) as unknown as Array<Record<string, unknown>>
    rows.push(...page)

    // An empty page always ends the walk (guards against a zero-progress loop if the
    // server ever returns nothing while claiming a larger count).
    if (page.length === 0) return { rows, truncated: false, errors: 0 }
    if (typeof count === 'number') {
      if (rows.length >= count) return { rows, truncated: false, errors: 0 }
    } else if (page.length < PAGE_SIZE) {
      // No count header — fall back to page-length inference, which is sound HERE only
      // because PAGE_SIZE is below db-max-rows.
      return { rows, truncated: false, errors: 0 }
    }
  }
  // Genuinely more rows than one run may read. Reported, so the 503 is an honest alarm
  // rather than a silent ceiling — at CANDIDATE_CAP founding merchants something is
  // wrong with the population query, not with the cron.
  return { rows, truncated: true, errors: 0 }
}

/**
 * Wall-clock budget for one run. The sweep is sequential — 200 drained deliveries at
 * 5s each plus two 10s Medusa reads per candidate can far exceed any platform request
 * limit — and being KILLED mid-run is strictly worse than stopping: the next run
 * restarts on the same oldest work and never reaches the rest (cross-review round 6).
 *
 * Stopping deliberately lets the run report `truncated` (→ 503 → retry) with its
 * partial progress durably committed, and every unit of work it did complete is
 * permanent, so the following run resumes rather than repeats.
 */
const SWEEP_BUDGET_MS = 240_000

export interface SweepResult {
  candidates: number
  /** True when the candidate query hit CANDIDATE_CAP — some merchants were NOT looked
   *  at. A caller that ignores this is reporting a partial sweep as a complete one. */
  truncated: boolean
  drained: number
  /** Milestones recovered from state because a hook never ran (or ran before this
   *  feature existed). Reported separately so a healthy run is distinguishable from a
   *  run that is quietly repairing missed events. */
  backfilled: number
  threeProductsLive: number
  retained30d: number
  /** True when `growth.telemetry_enabled` is OFF. NOT an error — a deliberate operator
   *  state. Milestones are still claimed and stay pending, so nothing is lost; the drain
   *  ships them the moment the flag is on. Surfaced so a run reporting zero deliveries
   *  explains itself. */
  telemetryOff: boolean
  /** Reads that failed. Non-zero means this run was incomplete, whatever else it did. */
  errors: number
  /** Shops whose Medusa seller no longer exists (deleted or retired). KNOWN ABSENT, not a failed read, so NOT an
   *  error: there is nothing left to derive a milestone from. Counted so the skip is visible. */
  sellersGone: number
  /** Sprint 3, Story 3.1 — relationships whose stage was (re-)evaluated this run. */
  relationshipsEvaluated: number
  /** Relationships whose stage ADVANCED (one or more new transition rows written)
   *  this run — reported separately so a healthy steady-state run (facts unchanged,
   *  nothing to write) reads differently from one that's actively repairing. */
  relationshipsAdvanced: number
  /** True when `promoter.activation_crm_enabled` is OFF and the Sprint-3 relationship
   *  walk (step 5) was therefore SKIPPED. NOT an error — the same operator-state
   *  posture as `telemetryOff`. The shop-keyed sweep (steps 1–4) still runs; only the
   *  new relationship-keyed emission is held. This is the epic kill-switch doing its
   *  job: the walk emits WRITE-ONCE, unwithdrawable milestones under relationship-id
   *  subjects, and the flag's contract is that nothing in this epic's write paths goes
   *  live until a disposable-merchant smoke passes and Daniel flips it. */
  relationshipsSkippedFlagOff: boolean
  /** Merchant Partner lifecycle · Sprint 3, Story 3.1 (README D7) — 30-day
   *  retention check-in tasks newly scheduled this run, off a relationship's
   *  write-once `first_sale` transition. Does NOT count `already_scheduled`
   *  or `no_first_sale` — both are expected steady-state outcomes, not
   *  events worth alarming a healthy-run count with. */
  retentionTasksScheduled: number
  /** Merchant Partner lifecycle · Sprint 3, Story 3.3 (README D8/D9) — PII-free
   *  portfolio SLA/retention events emitted this run (`merchant.steward_assigned`
   *  is emitted from the admin reassign route instead — see that route's own
   *  header — so it is never counted here). */
  portfolioEventsEmitted: number
}

interface Candidate {
  /** The SHOP MIRROR id (`marketplace_shops.id`) — this sweep's population is
   *  candidated on shop/preview rows, so this field is named for pre-Sprint-3
   *  history. Every emit call below goes through `emitMerchantLifecycleForShop`
   *  (README D1), which resolves this onto the actual subject key — the
   *  relationship id — before calling Golden Beans. */
  merchantId: string
  sellerSlug: string | null
  /** `merchant_previews.approved_at` — the consent record, non-commerce, and the
   *  authoritative answer to "did this merchant approve their preview?". */
  previewApprovedAt: string | null
  /** `marketplace_shops.clerk_user_id` — set the moment ownership transfers. Claiming
   *  is a marketplace concept, not a commerce one, so the mirror IS the record here. */
  claimedByClerkId: string | null
}


/**
 * The population this epic tracks: FOUNDING merchants, not every shop on the
 * marketplace. A shop qualifies once it has entered the funnel at all — it has a
 * preview anchor (it was pitched) or it has already emitted some milestone.
 *
 * Deliberately NOT "every shop": the epic is a founding-merchant CRM proof, and
 * sweeping the whole marketplace would emit activation milestones for hundreds of
 * scraped imports nobody is running a relationship with.
 *
 * These are Supabase reads by design — "is this merchant in our funnel?" and "which
 * seller slug is this shop?" are marketplace bookkeeping, not commerce facts.
 */
async function loadCandidates(): Promise<{ candidates: Candidate[]; truncated: boolean; errors: number }> {
  const ids = new Set<string>()
  const approvedAt = new Map<string, string>()
  let errors = 0
  let truncated = false

  // PAGED, not `.limit(CAP)`. A single capped read always returns the SAME first N rows,
  // so any merchant past the cap would be permanently unswept no matter how many daily
  // runs happen — the cap would silently become a hard ceiling on the funnel rather than
  // a per-run budget (cross-review round 3). Paging walks the whole set; `truncated`
  // now means only "this run stopped at the hard cap", and the next run resumes from the
  // page after the last one it completed is not needed because the work itself is
  // idempotent — the emission constraint makes a re-scan of earlier pages free.
  const previews = await readPaged('merchant_previews', 'shop_id, approved_at')
  errors += previews.errors
  truncated ||= previews.truncated
  for (const row of previews.rows) {
    if (!row?.shop_id) continue
    ids.add(String(row.shop_id))
    if (row.approved_at) approvedAt.set(String(row.shop_id), String(row.approved_at))
  }

  const emitted = await readPaged('merchant_lifecycle_emissions', 'merchant_id')
  errors += emitted.errors
  truncated ||= emitted.truncated
  // Emission rows carry the merchant SUBJECT id, which is a relationship id since Sprint 3: map each back to its
  // shop (`shopIdForEmissionSubject`), or the relationship id becomes a phantom shop candidate.
  const subjects = emissionSubjects(emitted.rows)
  const relShops = await loadRelationshipShops(subjects)
  errors += relShops.errors
  for (const subject of subjects) {
    const shopId = shopIdForEmissionSubject(subject, relShops.map)
    if (shopId) ids.add(shopId)
  }

  // Resolve slug + claim state in batches rather than one read per merchant.
  const merchantIds = [...ids]
  const shopById = new Map<string, { slug: string | null; clerkUserId: string | null }>()
  for (let i = 0; i < merchantIds.length; i += IN_BATCH_SIZE) {
    const shops = await db
      .from('marketplace_shops')
      .select('id, slug, clerk_user_id')
      .in('id', merchantIds.slice(i, i + IN_BATCH_SIZE))
    if (shops.error) {
      console.error('[merchant-lifecycle] shop lookup failed:', shops.error.message)
      errors += 1
      continue
    }
    for (const row of shops.data ?? []) {
      if (!row?.id) continue
      shopById.set(String(row.id), {
        slug: row.slug ? String(row.slug) : null,
        clerkUserId: row.clerk_user_id ? String(row.clerk_user_id) : null,
      })
    }
  }

  return {
    candidates: merchantIds.map((merchantId) => ({
      merchantId,
      sellerSlug: shopById.get(merchantId)?.slug ?? null,
      previewApprovedAt: approvedAt.get(merchantId) ?? null,
      claimedByClerkId: shopById.get(merchantId)?.clerkUserId ?? null,
    })),
    truncated,
    errors,
  }
}

function emissionSubjects(rows: Array<Record<string, unknown>>): string[] {
  return [...new Set(rows.map((r) => (r?.merchant_id ? String(r.merchant_id) : '')).filter(Boolean))]
}

/** relationship id → its shop id (null when the relationship has no shop yet), for the given subject ids.
 *  Ids that are not relationships are simply absent; `shopIdForEmissionSubject` treats those as shop ids. */
async function loadRelationshipShops(subjects: string[]): Promise<{ map: Map<string, string | null>; errors: number }> {
  const map = new Map<string, string | null>()
  let errors = 0
  for (let i = 0; i < subjects.length; i += IN_BATCH_SIZE) {
    const rels = await db
      .from('merchant_relationships')
      .select('id, shop_id')
      .in('id', subjects.slice(i, i + IN_BATCH_SIZE))
    if (rels.error) {
      console.error('[merchant-lifecycle] relationship lookup failed:', rels.error.message)
      errors += 1
      continue
    }
    for (const row of rels.data ?? []) {
      if (row?.id) map.set(String(row.id), row.shop_id ? String(row.shop_id) : null)
    }
  }
  return { map, errors }
}

/** Milestones already delivered or claimed, so the sweep skips the work rather than
 *  relying on the unique-violation path for every merchant on every run. The constraint
 *  is still what GUARANTEES once-only — this is an optimisation, not the guard. */
async function loadClaimed(): Promise<{
  byMerchant: Map<string, Set<string>>
  errors: number
  truncated: boolean
}> {
  const byMerchant = new Map<string, Set<string>>()
  const paged = await readPaged('merchant_lifecycle_emissions', 'merchant_id, event_type')
  if (paged.errors > 0) return { byMerchant, errors: paged.errors, truncated: paged.truncated }
  // Keyed by SHOP id, like the candidates. Keyed by the raw subject (a relationship id since Sprint 3), no real
  // shop ever matched its own claims, so every run re-attempted every milestone for every shop.
  const relShops = await loadRelationshipShops(emissionSubjects(paged.rows))
  if (relShops.errors > 0) return { byMerchant, errors: relShops.errors, truncated: paged.truncated }
  for (const row of paged.rows) {
    const id = shopIdForEmissionSubject(String(row?.merchant_id ?? ''), relShops.map)
    if (!id) continue
    if (!byMerchant.has(id)) byMerchant.set(id, new Set())
    byMerchant.get(id)!.add(String(row?.event_type ?? ''))
  }
  // A truncated claim map means some milestones look unclaimed and get re-attempted.
  // The PK still guarantees once-only, so this is wasted Medusa calls rather than a
  // correctness bug — but the run is partial and must say so (fresh-reviewer pass).
  return { byMerchant, errors: 0, truncated: paged.truncated }
}

/**
 * Run one sweep. Never throws — a failure on one merchant must not abort the rest, and
 * a failed run is simply retried by the next one (every emission is idempotent).
 */
export async function sweepMerchantLifecycle(now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = {
    candidates: 0,
    truncated: false,
    drained: 0,
    backfilled: 0,
    telemetryOff: false,
    threeProductsLive: 0,
    retained30d: 0,
    errors: 0,
    sellersGone: 0,
    relationshipsEvaluated: 0,
    relationshipsAdvanced: 0,
    relationshipsSkippedFlagOff: false,
    retentionTasksScheduled: 0,
    portfolioEventsEmitted: 0,
  }

  // ── 1. Drain anything claimed but not confirmed delivered ──────────────────
  // Re-sending is safe: the payload is replayed verbatim under a stable
  // idempotencyKey, and golden-beans returns the existing event for a repeat.
  const deadline = Date.now() + SWEEP_BUDGET_MS
  const outOfTime = () => Date.now() > deadline

  const drain = await listPendingEmissions()
  if (drain.failed) fail(result, 'listing pending emissions failed')
  if (drain.truncated) result.truncated = true
  for (const pending of drain.pending) {
    if (outOfTime()) {
      result.truncated = true
      break
    }
    try {
      const outcome = await deliverClaimedEmission(
        pending.merchantId,
        pending.eventType,
        pending.payload,
        pending.attempts,
        // Sprint 3, Story 3.3 (README D8) — the third PK component.  `''`
        // for a milestone row (byte-identical to before); a real key for a
        // pending portfolio event. Without this, a merchant with TWO
        // pending occurrences of the same event type would have BOTH
        // marked delivered the moment either one actually sent.
        pending.dedupeKey,
      )
      if (outcome === 'delivered') result.drained += 1
      else if (outcome === 'flag_off') result.telemetryOff = true
      else {
        // Includes 'delivered_unrecorded': golden-beans has it, we could not record
        // that. Harmless to re-send (the idempotency key dedupes), but the run is not
        // clean and must not be reported as such.
        fail(result, `redelivery of ${pending.eventType} for ${pending.merchantId}: ${outcome}`)
      }
    } catch (err) {
      fail(result, `redelivery of ${pending.eventType} for ${pending.merchantId} threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const loaded = await loadCandidates()
  result.candidates = loaded.candidates.length
  // OR, never assign: the drain may already have set it (cross-review round 3 — a
  // straight assignment here erased a truncated drain whenever the candidate walk
  // completed, so >200 pending emissions reported a clean run).
  result.truncated ||= loaded.truncated
  result.errors += loaded.errors

  const claimed = await loadClaimed()
  result.errors += claimed.errors
  result.truncated ||= claimed.truncated
  // Without the claim map we cannot skip safely; the constraint would still prevent a
  // duplicate, but we would hammer Medusa for every merchant on every run.
  if (claimed.errors > 0) return result

  for (const { merchantId, sellerSlug, previewApprovedAt, claimedByClerkId } of loaded.candidates) {
    if (outOfTime()) {
      result.truncated = true
      break
    }
    const done = claimed.byMerchant.get(merchantId) ?? new Set<string>()

    // ── 2. BACKFILL the event-driven milestones from state ────────────────────
    // The hooks in the approval / claim / order-mirror paths give timeliness; this
    // gives COMPLETENESS. A hook that never ran — a transient DB error at claim time,
    // a milestone reached before this feature shipped, a door added later — would
    // otherwise lose the milestone permanently, because nothing revisits it
    // (cross-review round 2). Deriving from state is self-healing.
    if (!done.has('merchant.preview_approved') && previewApprovedAt) {
      // The real approval timestamp, not now — this one we actually know.
      // `...ForShop` (Sprint 3, README D1): `merchantId` here is the SHOP MIRROR id
      // (the population this sweep candidates on) — the seam resolves it onto its
      // relationship id before emitting, which is the actual subject key now.
      if (record(await emitMerchantLifecycleForShop('merchant.preview_approved', {
        shopId: merchantId,
        occurredAt: new Date(previewApprovedAt),
      }), result)) {
        result.backfilled += 1
      }
    }

    if (!done.has('merchant.claimed') && claimedByClerkId) {
      if (record(await emitMerchantLifecycleForShop('merchant.claimed', { shopId: merchantId, occurredAt: now }), result)) {
        result.backfilled += 1
      }
    }

    // Every remaining check needs the Medusa seller slug. No slug → no authoritative
    // read → skip. Deliberately not falling back to the Supabase mirror.
    if (!sellerSlug) {
      // Every Medusa-derived milestone is unreachable without it. `retained_30d` was
      // missing from this list, so a merchant whose first_sale and three_products_live
      // were already claimed had its retention check skipped SILENTLY, forever
      // (cross-review round 4).
      const unreachable = (
        ['merchant.three_products_live', 'merchant.first_sale', 'merchant.retained_30d'] as const
      ).some((e) => !done.has(e))
      if (unreachable) {
        fail(result, `no seller slug for shop ${merchantId}: Medusa-derived milestones skipped`)
      }
      continue
    }

    // Orders are needed for both first_sale and retention; fetch once, and
    // derive both facts through the ONE shared rule (`deriveSaleFacts`,
    // lib/merchant-lifecycle.ts — Sprint 3, Story 3.1) rather than two
    // separate inline computations that could drift from each other or from
    // the commerce-fact adapter's own use of the same function.
    const needsOrders = !done.has('merchant.first_sale') || !done.has('merchant.retained_30d')
    const orders = needsOrders ? await listCapturedOrders(sellerSlug) : []
    if (orders === SELLER_GONE) {
      result.sellersGone += 1
      continue
    }
    if (needsOrders && orders === null) fail(result, `orders unreadable from Medusa for ${sellerSlug}`)
    const sale = orders && orders.length > 0 ? deriveSaleFacts(orders, now, RETENTION_WINDOW_MS) : null

    if (!done.has('merchant.first_sale') && sale?.firstSaleAt) {
      if (record(await emitMerchantLifecycleForShop('merchant.first_sale', {
        shopId: merchantId,
        occurredAt: sale.firstSaleAt,
      }), result)) {
        result.backfilled += 1
      }
    }

    // ── 3. merchant.three_products_live ───────────────────────────────────────
    if (!done.has('merchant.three_products_live')) {
      try {
        const live = await countLiveProductsFromMedusa(sellerSlug)
        if (live === SELLER_GONE) {
          result.sellersGone += 1
        } else if (live === null) {
          fail(result, `live product count unreadable from Medusa for ${sellerSlug}`)
        } else if (live >= THREE_PRODUCTS_THRESHOLD) {
          // `occurredAt` is NOW, not the third product's publish time: nothing records
          // when the count crossed the threshold, and inventing a timestamp we cannot
          // derive would be worse than an honest one. Read this column as "when we
          // first observed three live", never as "when the third went live".
          if (record(await emitMerchantLifecycleForShop('merchant.three_products_live', {
            shopId: merchantId,
            occurredAt: now,
            productCount: live,
          }), result)) {
            result.threeProductsLive += 1
          }
        }
      } catch (err) {
        fail(result, `three_products_live for ${sellerSlug} threw: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // ── 4. merchant.retained_30d ──────────────────────────────────────────────
    // "STILL ACTIVE 30 DAYS AFTER first sale" — `sale.retainedAt` (from the SAME
    // `deriveSaleFacts` call above) is the EARLIEST captured order dated ON OR
    // AFTER the 30-day mark, or null otherwise. Never "any later order": a first
    // sale on July 1 plus one order on July 2 and silence thereafter is NOT
    // retained — describing a merchant who churned on day 3 as retained is
    // exactly the over-counting bug an earlier version of this rule had
    // (cross-review round 2). `sale.retainedAt` is the REAL timestamp retention
    // happened at, never `now` — `now` would permanently stamp the sweep's own
    // run time, and because the outbox allows one emission per milestone, a
    // sweep recovering an August retention in October would have recorded
    // October, forever (cross-review round 5).
    if (!done.has('merchant.retained_30d') && sale?.retainedAt) {
      try {
        if (record(await emitMerchantLifecycleForShop('merchant.retained_30d', {
          shopId: merchantId,
          occurredAt: sale.retainedAt,
        }), result)) {
          result.retained30d += 1
        }
      } catch (err) {
        fail(result, `retained_30d for ${sellerSlug} threw: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // ── 5. RELATIONSHIP STAGE EVALUATION (Sprint 3, Story 3.1) ─────────────────
  // "Extend it; do not write a second sweep" (build contract) — this is why the
  // relationship walk lives in THIS function rather than a second cron/route. Every
  // `merchant_relationships` row not already at the terminal stage is re-evaluated;
  // `evaluateRelationship` itself is what makes re-running on unchanged facts a
  // no-op (the UNIQUE constraint on the transition insert, not a check here).
  //
  // KILL-SWITCH (fresh-reviewer pass, PR 305): held behind
  // `promoter.activation_crm_enabled`. Steps 1–4 above are the pre-existing shop-keyed
  // sweep and are UNCHANGED by the flag; only this Sprint-3 relationship walk is gated.
  // The walk emits WRITE-ONCE, unwithdrawable `merchant.<stage>` milestones under
  // relationship-id subjects across the whole backfilled population — the epic's own
  // kill-switch contract says nothing in its write paths goes live until a
  // disposable-merchant smoke passes and Daniel flips the flag. Emitting those
  // permanent milestones on deploy, before that smoke, is exactly what the flag exists
  // to prevent. Skipping is an operator state, not an error (same posture as
  // `telemetryOff`): the admin replay route re-runs the identical `evaluateRelationship`
  // once the flag is on, so nothing is lost by waiting.
  if (!(await isEnabled('promoter.activation_crm_enabled'))) {
    result.relationshipsSkippedFlagOff = true
    return result
  }

  const relLoaded = await loadRelationshipCandidates()
  result.errors += relLoaded.errors
  result.truncated ||= relLoaded.truncated

  for (const relationshipId of relLoaded.ids) {
    if (outOfTime()) {
      result.truncated = true
      break
    }
    try {
      const outcome = await evaluateRelationship(relationshipId, now)
      if (!outcome) {
        // The relationship itself couldn't be read — report and move on; the
        // whole run is not clean, but one bad id must not abort the rest.
        fail(result, `relationship ${relationshipId} could not be read`)
        continue
      }
      result.relationshipsEvaluated += 1
      if (outcome.advanced.length > 0) result.relationshipsAdvanced += 1
      // `ok: false` covers BOTH an incomplete commerce-fact read (Medusa
      // unreachable — this relationship simply didn't advance as far as it
      // might have, recoverable next run) AND an emission that genuinely
      // failed to send (the transition row is still durably written; the
      // sweep's own drain, step 1, will redeliver it next run). Either way
      // the run as a whole is not clean.
      if (!outcome.ok) fail(result, `relationship ${relationshipId}: commerce facts incomplete or an emission failed to send`)

      // Merchant Partner lifecycle · Sprint 3, Story 3.1 (README D7) — the
      // sweep is what DISCOVERS `first_sale`, so scheduling the retention
      // task right here costs no new cron and cannot run before the
      // transition exists. Safe to call unconditionally: it no-ops
      // (`no_first_sale`) when the transition doesn't exist yet, and
      // no-ops (`already_scheduled`, under the migration's partial UNIQUE
      // constraint) when the task was already written on an earlier run —
      // never a SELECT-then-INSERT.
      const scheduled = await scheduleRetentionTask(relationshipId, now)
      if (scheduled === 'scheduled') result.retentionTasksScheduled += 1

      // Story 3.3 — emitted right after the canonical write it describes, never
      // instead of it. `retentionDedupeKey` is the SAME key the task row was
      // claimed under, so exactly one scheduling event exists per relationship,
      // matching the task's own once-only guarantee.
      //
      // EMITTED FOR `already_scheduled` TOO (fresh-reviewer finding 9, PR 311).
      // The emit used to be inside the `=== 'scheduled'` branch, which bound a
      // DURABLE fact to a TRANSIENT outcome: if the sweep died between the task
      // insert and the emit, the next run got `already_scheduled` and the emit was
      // never retried — the event was permanently lost, silently, with the task
      // sitting right there in the database. Every other event in this rail is
      // claim-backed and self-healing; this one wasn't.
      //
      // Retrying is FREE and cannot duplicate: the emission claim's own
      // `(merchant_id, event_type, dedupe_key)` primary key makes a repeat a no-op
      // (`already_emitted`), which is the same argument that lets the milestone
      // paths derive from state rather than hooking a write. `error` still skips —
      // we don't know whether a task exists to describe.
      if (scheduled === 'scheduled' || scheduled === 'already_scheduled') {
        const outcome2 = await emitPortfolioLifecycleEvent({
          relationshipId,
          event: 'merchant.retention_scheduled',
          dedupeKey: retentionDedupeKey(relationshipId),
          occurredAt: now.toISOString(),
        })
        if (recordPortfolioEvent(outcome2, result)) result.portfolioEventsEmitted += 1
      }

      if (scheduled === 'error') {
        fail(result, `retention task scheduling failed for relationship ${relationshipId}`)
      }
    } catch (err) {
      fail(result, `relationship ${relationshipId} threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── 6. PORTFOLIO SLA EVENTS (Sprint 3, Story 3.3) ───────────────────────
  // A STATE-DERIVED scan, the same "derive from state, don't hook every
  // writer" posture steps 3/4 already use for three_products_live/
  // retained_30d — chosen here specifically because the two natural
  // per-write trigger points (`lib/portfolio/reminders-server.ts`'s claim
  // flow for overdue, `lib/portfolio/reassign-server.ts` for assignment)
  // are BOTH foundation modules this sprint may import but not reshape
  // (build brief). Reading the SAME `loadPortfolio` the UI/API route
  // already calls means this can never disagree with what a partner
  // actually sees, and the widened `merchant_lifecycle_emissions` PK (D8)
  // makes a daily re-scan free: a relationship still overdue against the
  // SAME `slaDueAt` window re-claims the identical dedupe key and is
  // skipped by the constraint.
  //
  // `merchant.steward_assigned` and `merchant.sla_completed` are NOT
  // emitted here — they are wired at their own canonical write sites (the
  // admin reassign route, and the extended task-complete route,
  // respectively), where the ACTUAL write just happened rather than being
  // re-derived from a periodic scan.
  if (outOfTime()) {
    result.truncated = true
    return result
  }
  const slaScan = await loadPortfolio(PORTFOLIO_EVENT_SWEEP_ACTOR, { view: 'all' }, now)
  if (!slaScan.ok) {
    fail(result, 'portfolio SLA scan failed')
    return result
  }
  for (const row of slaScan.portfolio.rows) {
    if (outOfTime()) {
      result.truncated = true
      break
    }
    try {
      if (row.slaOverdue) {
        const outcome = await emitPortfolioLifecycleEvent({
          relationshipId: row.id,
          event: 'merchant.sla_overdue',
          dedupeKey: portfolioEventDedupeKey('merchant.sla_overdue', row.slaDueAt),
          slaPolicyVersion: row.slaPolicyVersion,
          occurredAt: now.toISOString(),
          overdueReason: row.slaOverdueReason ?? undefined,
        })
        if (recordPortfolioEvent(outcome, result)) result.portfolioEventsEmitted += 1
      } else if (row.dueState === 'due_soon') {
        const window = row.nextActionDueAt ?? row.slaDueAt
        const outcome = await emitPortfolioLifecycleEvent({
          relationshipId: row.id,
          event: 'merchant.sla_due',
          dedupeKey: portfolioEventDedupeKey('merchant.sla_due', window),
          slaPolicyVersion: row.slaPolicyVersion,
          occurredAt: now.toISOString(),
        })
        if (recordPortfolioEvent(outcome, result)) result.portfolioEventsEmitted += 1
      }
    } catch (err) {
      fail(result, `SLA event for relationship ${row.id} threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return result
}

/**
 * The relationships still worth re-evaluating: everything NOT already at the
 * terminal stage. A relationship at `retained_30d` has nowhere further to
 * advance (`resolveStage` cannot walk past the last element of `STAGES`), so
 * re-reading its commerce facts every run forever would be pure waste at
 * marketplace scale. Paged with the same `readPaged` discipline as
 * `loadCandidates` above (server `count`, never inferred from page length).
 */
async function loadRelationshipCandidates(): Promise<{ ids: string[]; truncated: boolean; errors: number }> {
  const paged = await readPaged('merchant_relationships', 'id, stage')
  const ids = paged.rows
    .filter((r) => r?.stage !== 'retained_30d')
    .map((r) => (r?.id ? String(r.id) : null))
    .filter((id): id is string => !!id)
  return { ids, truncated: paged.truncated, errors: paged.errors }
}

/** Count a failure AND log what it was. The cron used to answer `errors: 41` with nothing in the log for most of
 *  them, so a daily 503 could not be diagnosed without re-deriving this file's logic by hand (2026-10-29). */
function fail(result: SweepResult, reason: string): void {
  result.errors += 1
  console.error(`[merchant-lifecycle] ${reason}`)
}

/**
 * Did this emission actually go out, and if not, was that a FAILURE?
 *
 * `counted()` used to return a bare boolean, so a `send_failed` / `claim_failed` on a
 * newly-discovered milestone left `errors` at zero and the cron reported a clean run
 * while a milestone it had just found never left the building (cross-review round 4).
 * `flag_off` is deliberately NOT an error — telemetry being switched off is an operator
 * decision, and the claim is safely pending until it is switched back on.
 */
function record(outcome: EmitOutcome, result: SweepResult): boolean {
  if (outcome === 'emitted') return true
  if (outcome === 'already_emitted') return false
  if (outcome === 'flag_off') {
    result.telemetryOff = true
    return false
  }
  fail(result, `emit ${outcome}`)
  return false
}

/** Sprint 3, Story 3.3 — the SAME decision as `record` above, kept as a
 *  separate function only so a portfolio-event failure/flag-off never gets
 *  folded into `result.threeProductsLive`-shaped milestone counters by
 *  accident; it shares `result.telemetryOff`/`result.errors` with `record`
 *  on purpose — both draw from the SAME outbox and the SAME flag. */
function recordPortfolioEvent(outcome: EmitOutcome, result: SweepResult): boolean {
  return record(outcome, result)
}
