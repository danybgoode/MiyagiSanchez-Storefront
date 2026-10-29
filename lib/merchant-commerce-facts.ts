/**
 * lib/merchant-commerce-facts.ts
 *
 * Founding merchant activation operations · Sprint 3, Story 3.1 — the Medusa
 * commerce-fact adapter. `loadCommerceFacts(relationship)` returns the
 * state-derived subset of `lib/merchant-stage.ts`'s `StageFacts` (build
 * contract's table): `claimed`, `paymentsReady`, `threeProductsLive`,
 * `firstSale`, `retained30d`, plus the two the contract originally called
 * "CRM-sourced" — `sharedExternally` and `firstInquiry` — which turned out to
 * have real state signals after all (E1b, architect review of the S3 build):
 *
 *   - `firstInquiry` ← a `marketplace_conversations` row for the shop. A buyer
 *     opening a conversation with the shop IS the first inquiry: state-derived
 *     and complete-by-construction, exactly like the Medusa reads.
 *   - `sharedExternally` ← the shipped setup-guide "comparte" signal
 *     (`shop.metadata.settings.guide.share_done`, the same flag
 *     `app/(shell)/shop/manage/page.tsx` reads). WEAKER provenance than a
 *     Medusa read — it is the SELLER'S OWN recorded action, not a fact Medusa
 *     owns — but that is exactly why it does NOT violate D3: D3 forbids the
 *     CRM asserting commerce truth it doesn't own, and a merchant recording
 *     that they shared their own shop is a genuine fact about the merchant.
 *     Fail-closed on absence (a missing flag reads as `false`, never unknown).
 *
 * Why derive them here rather than leave them admin-only: without both, the
 * resolver's `first_sale`/`retained_30d` were UNREACHABLE (a gap at
 * `shared_externally` used to break the walk — see `resolveStage`'s header),
 * so half of Story 3.1's commerce work was inert. Deriving from state is also
 * the backfill-safety-net the sweep already relies on for the Medusa facts.
 *
 * REUSE, NOT REBUILD (build contract): the paged, fail-closed, timeout-budgeted
 * Medusa reads originated in `lib/merchant-lifecycle-sweep.ts` — six cross-
 * review rounds argued through paging correctness, fail-closed defaults and a
 * per-read timeout budget — and now live in `lib/merchant-medusa-reads.ts`
 * (extracted, unchanged, purely to break a circular import: this module needs
 * them, and the sweep now needs THIS module for its Story 3.1 relationship
 * evaluation, so the reads cannot live in either end of that cycle). This
 * module imports `countLiveProductsFromMedusa` and `listCapturedOrders` from
 * there rather than re-issuing the same fetches with subtly different
 * edge-case handling. The first-sale / retained-30-days ARITHMETIC is
 * `lib/merchant-lifecycle.ts#deriveSaleFacts` — the SAME function
 * `sweepMerchantLifecycle` itself calls, so there is only one implementation
 * of the rule to drift.
 *
 * FAIL-CLOSED, STATE-DERIVED (build contract): every fact here is read fresh,
 * from Medusa or the shop mirror's own columns — never inferred from a webhook
 * having fired. `ok: false` on the result means AT LEAST ONE read could not be
 * completed; the caller (the cron sweep) must treat that run as INCOMPLETE
 * (retryable 5xx), never report success while quietly missing a signal. An
 * unreachable Medusa reads as "unknown", never as "zero products" or
 * "unclaimed" — `facts` simply omits whatever could not be confirmed, and
 * `resolveStage` (fail-closed by its own construction) declines to grant
 * anything from an omitted fact.
 *
 * NO MUTATION (build contract: "no adapter writes to Medusa"). Every Medusa
 * call below is a GET; every Supabase call is a `.select()`. `e2e/merchant-
 * commerce-facts.spec.ts` asserts this module's own source text contains no
 * Supabase write verb and no non-GET fetch — the population-guard, not a
 * single call site, per Roadmap/LEARNINGS.md "guard the population, not the
 * door you found".
 *
 * Runtime: Node only (Supabase service-role client + `fetch` to Medusa).
 */
import 'server-only'
import { db } from '@/lib/supabase'
import type { StageFacts } from '@/lib/merchant-stage'
import { computeShopCompletion, type ShopRow } from '@/lib/setup-guide'
import { deriveSaleFacts, SELLER_GONE } from '@/lib/merchant-lifecycle'
import {
  THREE_PRODUCTS_THRESHOLD,
  RETENTION_WINDOW_DAYS,
  countLiveProductsFromMedusa,
  listCapturedOrders,
} from '@/lib/merchant-medusa-reads'

const RETENTION_WINDOW_MS = RETENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000

export type CommerceStageFacts = Partial<
  Pick<
    StageFacts,
    'claimed' | 'paymentsReady' | 'threeProductsLive' | 'firstSale' | 'retained30d' | 'sharedExternally' | 'firstInquiry'
  >
>

export interface CommerceFactsResult {
  facts: CommerceStageFacts
  /** False when ANY underlying read failed or was unreachable — the caller
   *  must treat the whole evaluation as incomplete (retryable), never report
   *  a clean run while a fact silently stayed unknown. */
  ok: boolean
}

interface ShopFactsRow extends ShopRow {
  id: string
  slug: string | null
  clerk_user_id: string | null
}

const SHOP_COLUMNS = 'id, slug, clerk_user_id, name, description, metadata, mp_enabled, custom_domain, ucp_webhook_url'

/**
 * The commerce-fact subset for ONE relationship. `shopId` may be null — every
 * relationship before `claimed` has no linked shop at all (README D1: the
 * relationship exists before the shop does), and that is a COMPLETE read of
 * "nothing to check yet", not a failure (`ok: true`, empty `facts`).
 */
export async function loadCommerceFacts(relationship: { shopId: string | null }): Promise<CommerceFactsResult> {
  if (!relationship.shopId) return { facts: {}, ok: true }

  const { data: shop, error: shopError } = await db
    .from('marketplace_shops')
    .select(SHOP_COLUMNS)
    .eq('id', relationship.shopId)
    .maybeSingle()

  // A read error OR a missing row for a `shop_id` the relationship itself
  // names is unexpected — fail closed rather than silently reading "not
  // claimed, no products, no sale" for a shop we simply couldn't read.
  if (shopError || !shop) return { facts: {}, ok: false }

  const row = shop as unknown as ShopFactsRow
  const facts: CommerceStageFacts = {
    claimed: !!row.clerk_user_id,
    paymentsReady: computeShopCompletion(row).pagos,
    // The seller's own "comparte" action (E1b). Read straight off the mirror
    // row already fetched — no extra round trip. Absent/malformed ⇒ false
    // (fail-closed: a missing flag is "not shared", never unknown), so it
    // never affects `ok`.
    sharedExternally: readShareDone(row.metadata),
  }

  let ok = true

  // `firstInquiry` (E1b): does a buyer↔shop conversation exist yet? A single
  // fail-closed existence probe on the shop-indexed column
  // (`idx_conversations_shop`). A read error is UNREACHABLE, not "no inquiry":
  // it drops `ok` and leaves the fact unset, exactly like the Medusa reads
  // below — never silently reads "no inquiry" for a shop we couldn't query.
  const { data: convo, error: convoError } = await db
    .from('marketplace_conversations')
    .select('id')
    .eq('shop_id', relationship.shopId)
    .limit(1)
    .maybeSingle()
  if (convoError) {
    ok = false
  } else {
    facts.firstInquiry = !!convo
  }

  const sellerSlug = row.slug
  if (!sellerSlug) {
    // No Medusa seller slug on the mirror row — the three Medusa-derived facts
    // are unreachable. `claimed`/`paymentsReady`/`sharedExternally`/
    // `firstInquiry` above are still returned (they need only the mirror row
    // and the conversations probe), but the run as a whole is incomplete.
    return { facts, ok: false }
  }

  // A seller Medusa says no longer exists is KNOWN ABSENT: its Medusa facts stay unset and the read is complete.
  // Only an unanswered read makes the evaluation incomplete (`ok: false`).
  const liveCount = await countLiveProductsFromMedusa(sellerSlug)
  if (liveCount === null) {
    ok = false
  } else if (liveCount !== SELLER_GONE) {
    facts.threeProductsLive = liveCount >= THREE_PRODUCTS_THRESHOLD
  }

  const orders = await listCapturedOrders(sellerSlug)
  if (orders === null) {
    ok = false
  } else if (orders !== SELLER_GONE && orders.length > 0) {
    const sale = deriveSaleFacts(orders, new Date(), RETENTION_WINDOW_MS)
    facts.firstSale = sale.firstSaleAt !== null
    facts.retained30d = sale.retainedAt !== null
  }

  return { facts, ok }
}

/**
 * Read `metadata.settings.guide.share_done` defensively (E1b). The mirror's
 * `metadata` is free-form JSON, so every level may be absent or the wrong
 * type — anything that is not a literal `true` reads as `false` (fail-closed:
 * an unset or malformed flag is "not shared", never "unknown"). Mirrors the
 * exact path `app/(shell)/shop/manage/page.tsx` reads, so the two can never
 * disagree about what "shared" means.
 */
function readShareDone(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false
  const settings = (metadata as { settings?: unknown }).settings
  if (!settings || typeof settings !== 'object') return false
  const guide = (settings as { guide?: unknown }).guide
  if (!guide || typeof guide !== 'object') return false
  return (guide as { share_done?: unknown }).share_done === true
}
