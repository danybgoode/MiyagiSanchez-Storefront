/**
 * lib/growth-track.ts
 *
 * The PURE half of the growth-telemetry forwarding route (golden-beans
 * Roadmap/01-growth-engine/growth-engine-v1, Sprint 1 · Story 1.3) — mirrors
 * `lib/flags-admin.ts`'s split (server/network logic stays out of this file) so the
 * flag-gating decision is unit-testable in the Playwright `api` runner with zero
 * network/DB (`e2e/growth-track.spec.ts`).
 */

export interface GrowthTrackInput {
  userId: string
  event: string
  featureId?: string
  tags?: Record<string, unknown>
  metadata?: Record<string, unknown>
  /**
   * The versioned actor/subject context (golden-beans event-destination-router
   * Story 1.1). Additive and optional — every existing caller stays valid, and
   * `userId` above stays required. Callers that set it MUST include
   * `version: 1`: golden-beans rejects a context with an absent or unknown
   * version rather than guessing, and REFUSES unknown top-level keys rather
   * than dropping them (a silently-dropped subject is an honest-looking zero
   * in every downstream projection).
   */
  context?: Record<string, unknown>
}

export type GrowthTrackDecision =
  | { forward: true; payload: GrowthTrackInput }
  | { forward: false; reason: 'flag_off' | 'missing_event' }

/**
 * Decide whether an event should forward to golden-beans. Never throws, never
 * touches the network — the caller (the route handler) owns `isEnabled()` and the
 * actual fetch (`lib/growth-engine.ts`).
 */
export function decideGrowthTrack(flagEnabled: boolean, input: GrowthTrackInput): GrowthTrackDecision {
  if (!input.event) return { forward: false, reason: 'missing_event' }
  if (!flagEnabled) return { forward: false, reason: 'flag_off' }
  return { forward: true, payload: input }
}

/**
 * Golden Frijoles' standard satisfaction rating (golden-frijoles satisfied-ask): a 1–5 score, or "Ahora no". Only the
 * features listed here can be rated, so a forged body cannot attach a rating to an arbitrary feature id in our event
 * stream. The setup guide is the one surface that asks today (SetupGuideSatisfaction).
 */
export const SATISFACTION_FEATURES = ['setup_guide'] as const
export type SatisfactionFeature = (typeof SATISFACTION_FEATURES)[number]
export type SatisfactionAnswer = 1 | 2 | 3 | 4 | 5 | 'dismissed'

export type SatisfactionDecision =
  | { forward: true; userId: string; featureId: SatisfactionFeature; answer: SatisfactionAnswer }
  | { forward: false; reason: 'flag_off' | 'unknown_feature' | 'invalid_answer' }

/** Decide whether a satisfaction answer forwards to Golden Frijoles. Pure: the route owns the flag read and the send. */
export function decideSatisfaction(
  flagEnabled: boolean,
  input: { userId: string; featureId: unknown; answer: unknown },
): SatisfactionDecision {
  const featureId = SATISFACTION_FEATURES.find((f) => f === input.featureId)
  if (!featureId) return { forward: false, reason: 'unknown_feature' }
  const answer = input.answer
  const valid = answer === 'dismissed' || answer === 1 || answer === 2 || answer === 3 || answer === 4 || answer === 5
  if (!valid) return { forward: false, reason: 'invalid_answer' }
  // Validation BEFORE the flag: a malformed body is a 400 whether telemetry is on or not.
  if (!flagEnabled) return { forward: false, reason: 'flag_off' }
  return { forward: true, userId: input.userId, featureId, answer }
}

type ShopMetadata = { settings?: { guide?: { satisfaction_answered?: unknown } & Record<string, unknown> } & Record<string, unknown> } & Record<string, unknown>

/**
 * Whether this shop's merchant already answered (or declined) the setup-guide ask: the key is PRESENT, whatever its
 * value. This is the same rule as the route's claim (`satisfaction_answered IS NULL` in SQL), so a stray `false` or
 * `"true"` can never show an ask the claim then refuses with 409 (Codex, #434). It fails closed: asked never again.
 */
export function satisfactionAnswered(metadata: unknown): boolean {
  const value = (metadata as ShopMetadata | null)?.settings?.guide?.satisfaction_answered
  return value !== undefined && value !== null
}

/** The shop's metadata with `settings.guide.satisfaction_answered: true`, every other key kept. Pure. */
export function withSatisfactionAnswered(metadata: unknown): Record<string, unknown> {
  const meta = (metadata && typeof metadata === 'object' ? metadata : {}) as ShopMetadata
  const settings = (meta.settings && typeof meta.settings === 'object' ? meta.settings : {}) as NonNullable<ShopMetadata['settings']>
  const guide = (settings.guide && typeof settings.guide === 'object' ? settings.guide : {}) as Record<string, unknown>
  return { ...meta, settings: { ...settings, guide: { ...guide, satisfaction_answered: true } } }
}
