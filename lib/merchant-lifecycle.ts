/**
 * lib/merchant-lifecycle.ts
 *
 * Golden Beans event-destination-router · Story 3.1 — the PURE seam of the merchant
 * lifecycle loop. Both halves live here:
 *   - CONSUMER: `classifyEnvelope()` turns a verified webhook body into a decision.
 *   - PRODUCER: `buildLifecycleTrackPayload()` builds the POST /api/v1/track body.
 *
 * DELIBERATELY ZERO-IMPORT — no `next`, no `server-only`, no Supabase. Every branch
 * below is reachable from a Playwright `api` spec by calling the function directly.
 * An HTTP-level spec can only walk the branches a well-formed request happens to
 * reach, which is how a signature-shaped feature ships four specs that pass
 * identically against a deliberately re-broken build (Roadmap/LEARNINGS.md).
 *
 * The contract this implements is golden-beans'
 * `Roadmap/01-growth-engine/event-destination-router/miyagi-lifecycle-contract.md`.
 * Read it before changing anything here.
 */

/**
 * Sprint 3, Story 3.2 (README D2 — "the 13 stages ARE the event types"):
 * grown from six to fourteen. The first 13 are `merchant.<stage>` for every
 * slug in `lib/merchant-stage.ts#STAGES`, IN THAT CANONICAL ORDER (five of
 * them — `permission_granted`, `claimed`, `three_products_live`,
 * `first_sale`, `retained_30d` — already existed; this adds the other
 * eight: `scouted`, `qualified`, `preview_in_preparation`,
 * `preview_delivered`, `activation_scheduled`, `payments_ready`,
 * `shared_externally`, `first_inquiry`). `merchant.preview_approved` is
 * appended last on purpose — it is a PREVIEW fact, not one of the 13 stages
 * (it keeps its own `preview_approved_at` projection column, unchanged by
 * this sprint), so it stays visually distinct from the stage block above it
 * rather than interleaved into `STAGES` order where it doesn't belong.
 *
 * Order here is NOT significant to any consumer (`LIFECYCLE_SET` is a Set;
 * every iteration over this array elsewhere is order-independent) — it is
 * ordered for human readability only.
 */
export const MERCHANT_LIFECYCLE_EVENTS = [
  'merchant.scouted',
  'merchant.qualified',
  'merchant.permission_granted',
  'merchant.preview_in_preparation',
  'merchant.preview_delivered',
  'merchant.activation_scheduled',
  'merchant.claimed',
  'merchant.payments_ready',
  'merchant.three_products_live',
  'merchant.shared_externally',
  'merchant.first_inquiry',
  'merchant.first_sale',
  'merchant.retained_30d',
  'merchant.preview_approved',
] as const

export type MerchantLifecycleEvent = (typeof MERCHANT_LIFECYCLE_EVENTS)[number]

const LIFECYCLE_SET: ReadonlySet<string> = new Set(MERCHANT_LIFECYCLE_EVENTS)

export function isMerchantLifecycleEvent(value: unknown): value is MerchantLifecycleEvent {
  return typeof value === 'string' && LIFECYCLE_SET.has(value)
}

/** The subject type that routes an event to a merchant. Golden Beans validates entity
 *  types against a controlled vocabulary, so this is an exact match, never a prefix. */
export const MERCHANT_SUBJECT_TYPE = 'merchant'

/** Mirrors golden-beans' MAX_ID_LENGTH (lib/event-context.ts) — if that moves, this moves. */
export const MAX_SUBJECT_ID_LENGTH = 128

/** The dedupe key becomes a PRIMARY KEY, so it is bounded. Real ids are uuids (36) or
 *  `evt_test_<uuid>` (45); 200 is slack, not a guess at the format. */
const MAX_EVENT_ID_LENGTH = 200

/**
 * The envelope, exactly as `buildEventEnvelope`/`serializeEnvelope` in golden-beans
 * emit it. EVERY `data` field is optional: the producer OMITS null/absent fields
 * rather than sending `null`, drops empty `metadata`/`tags` objects entirely, and
 * emits `actor`/`subject` only when at least one of type/id is present — and then
 * possibly with only that one half. Nothing here may assume a field exists.
 */
export interface DeliveryEnvelope {
  id: string
  type: string
  occurredAt: string
  /** Present and TRUE only on an owner-initiated "Send test". Absent (never `false`)
   *  on a real delivery, so a truthiness check is the correct test. */
  test?: true
  data?: {
    userId?: string
    subject?: { type?: string; id?: string }
    actor?: { type?: string; id?: string }
    correlationId?: string
    metadata?: Record<string, unknown>
    tags?: Record<string, unknown>
  }
}

export type EnvelopeDecision =
  /** A well-formed merchant lifecycle event to project. */
  | {
      kind: 'lifecycle'
      eventId: string
      type: MerchantLifecycleEvent
      merchantId: string
      occurredAt: string
    }
  /** An owner-initiated test send. Verify it, 2xx it, never project it. */
  | { kind: 'test'; eventId: string }
  /** Verified and well-formed, but not ours. The destination receives EVERY event of
   *  the Golden Beans project — setup-guide funnel events, preview telemetry, anything
   *  added later. Those must be accepted and dropped, not dead-lettered. */
  | { kind: 'ignored'; reason: 'not_a_lifecycle_event' | 'not_a_merchant_subject' }
  /** Structurally broken. A permanent producer-side defect: 4xx so Golden Beans
   *  dead-letters it immediately and it shows up in delivery history, instead of
   *  retrying six times against a body that will never parse. */
  | { kind: 'invalid'; reason: InvalidReason }

export type InvalidReason =
  | 'not_an_object'
  | 'missing_id'
  | 'missing_type'
  | 'missing_occurred_at'
  | 'unparseable_occurred_at'
  | 'missing_merchant_subject'

/**
 * Turn a parsed (and ALREADY SIGNATURE-VERIFIED) envelope into a decision.
 *
 * Order matters. `test` is checked before the type vocabulary because the test
 * envelope's type is `golden_beans.webhook.test` — classifying by type first would
 * route it to `ignored`, which happens to be harmless today but stops being harmless
 * the moment someone sends a test shaped like a real event to check their wiring.
 */
export function classifyEnvelope(raw: unknown): EnvelopeDecision {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'invalid', reason: 'not_an_object' }
  }
  const envelope = raw as DeliveryEnvelope

  const eventId = asBoundedString(envelope.id, MAX_EVENT_ID_LENGTH)
  if (!eventId) return { kind: 'invalid', reason: 'missing_id' }

  if (envelope.test === true) return { kind: 'test', eventId }

  if (typeof envelope.type !== 'string' || envelope.type === '') {
    return { kind: 'invalid', reason: 'missing_type' }
  }
  if (!isMerchantLifecycleEvent(envelope.type)) {
    return { kind: 'ignored', reason: 'not_a_lifecycle_event' }
  }

  if (typeof envelope.occurredAt !== 'string' || envelope.occurredAt === '') {
    return { kind: 'invalid', reason: 'missing_occurred_at' }
  }
  const parsed = Date.parse(envelope.occurredAt)
  if (Number.isNaN(parsed)) return { kind: 'invalid', reason: 'unparseable_occurred_at' }

  // Route on the SUBJECT — never by parsing metadata. `data`, `data.subject` and each
  // half of the subject are all independently optional on the wire.
  const subject = envelope.data?.subject
  const subjectType = typeof subject?.type === 'string' ? subject.type : null
  const merchantId = asBoundedString(subject?.id, MAX_SUBJECT_ID_LENGTH)

  if (subjectType !== null && subjectType !== MERCHANT_SUBJECT_TYPE) {
    // A lifecycle-named event about something that is not a merchant. Not ours to
    // project, but not broken either — drop it rather than dead-letter it.
    return { kind: 'ignored', reason: 'not_a_merchant_subject' }
  }
  if (!merchantId || subjectType !== MERCHANT_SUBJECT_TYPE) {
    // One of the six types with no usable merchant subject is UNROUTABLE, and will
    // still be unroutable on every retry. That is a producer bug worth surfacing in
    // Golden Beans' dead-letter history, not one to swallow with a 202.
    return { kind: 'invalid', reason: 'missing_merchant_subject' }
  }

  return {
    kind: 'lifecycle',
    eventId,
    type: envelope.type,
    merchantId,
    // Normalised to UTC so two spellings of the same instant produce one comparable
    // timestamp in the projection.
    occurredAt: new Date(parsed).toISOString(),
  }
}

function asBoundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max) return null
  return trimmed
}

// ---------------------------------------------------------------------------
// PRODUCER half — the POST /api/v1/track body.
// ---------------------------------------------------------------------------

/**
 * The wire shape golden-beans' `trackEventSchema` + `normalizeEventContext` accept.
 * `userId` stays REQUIRED there (every shipped TARS funnel counts distinct userId), so
 * we send the merchant id as both `userId` and `context.subject.id` — the same value
 * playing two roles, which is what keeps existing reads working while the subject
 * dimension is what routes the delivery back to us.
 */
export interface LifecycleTrackPayload {
  userId: string
  event: MerchantLifecycleEvent
  featureId: string
  tags: Record<string, string | number>
  context: {
    version: 1
    subject: { type: 'merchant'; id: string }
    occurredAt: string
    /**
     * Stable per (merchant, milestone). Golden Beans enforces a UNIQUE index on
     * `(project_id, idempotency_key)` and returns the EXISTING event for a repeat, so
     * this closes the one hole a local claim table cannot: an ambiguous send (Golden
     * Beans accepted it, the response timed out) that we later retry would otherwise
     * create a second canonical event and double-count the funnel.
     *
     * Golden Beans also fingerprints the payload when this is set and rejects a
     * mismatch — so a retry must re-send BYTE-IDENTICAL content. That is why the built
     * payload is persisted on the claim row and replayed verbatim rather than rebuilt.
     */
    idempotencyKey: string
    correlationId?: string
  }
}

export const MERCHANT_LIFECYCLE_FEATURE_ID = 'merchant-lifecycle'

/** `context.version` is a CLOSED literal in golden-beans — a v2 payload sent to a v1
 *  server is rejected outright rather than half-stored. Bump deliberately, in step. */
export const CONTEXT_VERSION = 1 as const

export interface LifecycleEmitFacts {
  /** README D1 (Sprint 3): the opaque merchant subject id is now
   *  `merchant_relationships.id` — a relationship can exist before any shop
   *  does, which a shop-keyed subject could never represent. Every call site
   *  from Sprint 3 onward passes a relationship id here; the two Sprint-1
   *  call sites that used to pass `marketplace_shops.id` directly now go
   *  through `emitMerchantLifecycleForShop`, which resolves shop → relationship
   *  BEFORE calling this. Non-personal either way; meaningless outside our
   *  own database. */
  merchantId: string
  /** Defaults to now. Injected so a spec asserts an exact payload against a fixed clock. */
  occurredAt?: Date
  /** Ties a milestone back to the action that produced it. An opaque id, never a name. */
  correlationId?: string
  /** Non-identifying counts only — see the allow-list note below. */
  productCount?: number
  /**
   * Read from the validated public Medusa seller projection before this payload
   * is claimed. This is deliberately not defaulted: lifecycle payloads are
   * durable/retried verbatim, so an invented MX tag could never be repaired.
   */
  marketCode?: 'mx' | 'us'
}

/**
 * Build the track payload for one lifecycle milestone.
 *
 * `tags` is an ALLOW-LIST, not a redaction pass: there is nowhere for a caller to put a
 * name, an email or a WhatsApp number, so a future call site cannot leak one by passing
 * an extra field. That property is load-bearing — Golden Beans forwards tenant metadata
 * values VERBATIM to every configured destination without inspecting them, so anything
 * personal that reaches it has already left our control (contract guarantee 6).
 */
export function buildLifecycleTrackPayload(
  event: MerchantLifecycleEvent,
  facts: LifecycleEmitFacts,
): LifecycleTrackPayload {
  const merchantId = String(facts.merchantId ?? '')
  const tags: Record<string, string | number> = { shop_id: merchantId }
  if (typeof facts.productCount === 'number') tags.product_count = facts.productCount
  if (facts.marketCode === 'mx' || facts.marketCode === 'us') tags.market_code = facts.marketCode

  const payload: LifecycleTrackPayload = {
    userId: merchantId,
    event,
    featureId: MERCHANT_LIFECYCLE_FEATURE_ID,
    tags,
    context: {
      version: CONTEXT_VERSION,
      subject: { type: MERCHANT_SUBJECT_TYPE, id: merchantId },
      // Explicit UTC with a time and an offset — golden-beans rejects a bare date,
      // because "2026-07-22" names 24+ different instants depending on who parses it.
      occurredAt: (facts.occurredAt ?? new Date()).toISOString(),
      idempotencyKey: lifecycleIdempotencyKey(merchantId, event),
    },
  }
  if (facts.correlationId) payload.context.correlationId = facts.correlationId
  return payload
}

/**
 * `<merchantId>:<event>` — one milestone per merchant, forever.
 *
 * Bounded to golden-beans' 128-char limit by truncating the MERCHANT id, never the
 * event name: a truncated event name would collide two different milestones for the
 * same merchant into one key, which is a silent data loss. Real ids are 36-char uuids,
 * so this never fires in practice; it exists so a pathological id degrades into a
 * collision between two merchants' *same* milestone rather than into a rejected write.
 */
export function lifecycleIdempotencyKey(merchantId: string, event: MerchantLifecycleEvent): string {
  const budget = 128 - event.length - 1
  return `${merchantId.slice(0, Math.max(1, budget))}:${event}`
}

// ---------------------------------------------------------------------------
// Order capture — shared by the sweep, kept here so every branch is spec-reachable.
// ---------------------------------------------------------------------------

/** The subset of a normalized Medusa order this decision reads. Everything optional:
 *  a backend older than MiyagiSanchez-Backend PR 109 sends no `payment_captured` at all. */
export interface CapturedOrderLike {
  status?: unknown
  payment_captured?: unknown
}

/**
 * The order statuses that mean the sale STUCK, as an ALLOW-LIST.
 *
 * This is only half the test — see `isCapturedOrder` below, which pairs it with the
 * backend's `payment_captured`. The two answer different questions and both must hold.
 *
 * This started as a deny-list of `refunded | pending_payment | canceled`, on the theory
 * that seller-set `fulfillment_state` values are all paid orders. That was wrong in the
 * direction that costs the most (cross-review round 3): a deny-list treats EVERY other
 * string — `draft`, `failed`, a typo, a status added next quarter — as revenue, and
 * these milestones are permanent and unwithdrawable.
 *
 * So: unknown status ⇒ NOT counted. The asymmetry is deliberate. A milestone deferred by
 * an unrecognised status is recovered by the next sweep once this list is widened; a
 * milestone granted by one can never be taken back.
 */
const CAPTURED_ORDER_STATUSES = new Set([
  'paid',
  'processing',
  'shipped',
  'delivered',
  'fulfilled',
  'completed',
])

/**
 * Did this order actually earn the merchant money that stayed earned?
 *
 * TWO independent signals, both required — they answer different questions and neither
 * is sufficient:
 *
 *   `payment_captured` — did the money LAND? A payment fact. Necessary because `status`
 *     is not one: `normalizeMedusaOrder` initialises it to 'paid' and only demotes for
 *     cancel/refund/return or an uncaptured MANUAL method, so a card order sitting at
 *     `payment_status: 'authorized'` normalises to 'paid'. Reading `status` alone would
 *     grant the write-once `first_sale` milestone off a fall-through default — the gap a
 *     fresh-reviewer pass found on PR 298 and MiyagiSanchez-Backend PR 109 closed.
 *
 *   `status` in the allow-list — did the sale STICK? A lifecycle fact. Necessary because
 *     `payment_captured` deliberately ignores returns and cancellations (a return is not
 *     a refund; only payment state proves funds went back). Those orders arrive here as
 *     `status: 'refunded'`, which the allow-list excludes.
 *
 * FAILS CLOSED on absence. An order without `payment_captured` — a backend older than
 * MiyagiSanchez-Backend PR 109, or a response we could not parse — does NOT count. The
 * milestone simply defers to a later sweep, which is recoverable; granting one wrongly
 * is not.
 */
export function isCapturedOrder(order: CapturedOrderLike): boolean {
  if (order.payment_captured !== true) return false
  return typeof order.status === 'string' && CAPTURED_ORDER_STATUSES.has(order.status)
}

/**
 * The first-sale / retained-30-days rule, as a PURE function of an already-
 * filtered captured-order list. Extracted here (Sprint 3, founding-merchant-
 * activation-ops, Story 3.1) from what was inline arithmetic in
 * `lib/merchant-lifecycle-sweep.ts`'s steps 2/4, so BOTH that sweep and the
 * commerce-fact adapter (`lib/merchant-commerce-facts.ts`) share ONE
 * implementation instead of two that could quietly drift — "reuse it, do not
 * rebuild it" applied to the RULE, not only the Medusa reads. Zero-import
 * (like the rest of this file), so a spec walks every boundary with no
 * network call.
 *
 * `retentionWindowMs` is a parameter, not a constant duplicated here:
 * `RETENTION_WINDOW_DAYS` is owned by `lib/merchant-lifecycle-sweep.ts`
 * (which cannot be imported FROM here — that file is `server-only` and this
 * one must stay zero-import), so every caller passes its own computed
 * window explicitly rather than this file guessing at the number.
 */
export interface SaleFacts {
  /** The EARLIEST captured order's timestamp, or null if there is none. */
  firstSaleAt: Date | null
  /**
   * "STILL ACTIVE 30 days after first sale" — the earliest captured order
   * dated ON OR AFTER the 30-day mark, or null when that has not (yet)
   * happened. Never "any later order": a first sale plus one order the next
   * day and silence thereafter is NOT retained (see the sweep's own header
   * for the cross-review round that caught the over-counting version of
   * this rule).
   */
  retainedAt: Date | null
}

export function deriveSaleFacts(
  orders: Array<{ created_at: string }>,
  now: Date,
  retentionWindowMs: number,
): SaleFacts {
  const times = orders
    .map((o) => Date.parse(o.created_at))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b)
  if (times.length === 0) return { firstSaleAt: null, retainedAt: null }

  const firstSaleMs = times[0]
  const thirtyDayMark = firstSaleMs + retentionWindowMs

  let retainedAt: Date | null = null
  if (now.getTime() >= thirtyDayMark) {
    const qualifying = times.find((t) => t >= thirtyDayMark)
    if (qualifying !== undefined) retainedAt = new Date(qualifying)
  }

  return { firstSaleAt: new Date(firstSaleMs), retainedAt }
}
