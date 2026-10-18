/**
 * lib/growth-engine.ts
 *
 * Forwards events to the golden-beans Growth Engine's ingest endpoint — the Next.js
 * route at `apps/web/app/api/v1/track/route.ts` in that repo, which resolves to the
 * URL path `/api/v1/track` (verified live: `POST <deployment>/api/v1/track` returns
 * 201 against golden-beans' production deployment). Roadmap/01-growth-engine/
 * growth-engine-v1, Sprint 1 · Story 1.3. Mirrors `lib/telegram.ts`'s shape exactly:
 * fire-and-forget, never throws, never blocks the request path, silently skips when
 * unconfigured — safe to call even before GROWTH_ENGINE_URL/GROWTH_ENGINE_API_KEY
 * are set.
 *
 * Env vars:
 *   GROWTH_ENGINE_URL      — e.g. https://golden-beans-gamma.vercel.app
 *   GROWTH_ENGINE_API_KEY  — this project's per-project API key (golden-beans Story 1.1)
 */
import 'server-only'
import {
  createGrowthEngineClient,
  type EventContext,
  type FlagEvaluationTelemetryInput,
  type ScenarioExecutionTelemetryInput,
} from '@golden-frijoles/sdk'
import type { GrowthTrackInput } from './growth-track'

const TELEMETRY_TIMEOUT_MS = 5_000

function growthClient(userId: string, flagEvaluationSampleRate?: number) {
  const baseUrl = process.env.GROWTH_ENGINE_URL?.replace(/\/+$/, '')
  const apiKey = process.env.GROWTH_ENGINE_API_KEY
  if (!baseUrl || !apiKey) return undefined
  return createGrowthEngineClient({
    baseUrl,
    apiKey,
    userId,
    flagEvaluationSampleRate,
    fetchImpl: (input, init) =>
      fetch(input, {
        ...init,
        signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
      }),
  })
}

export async function sendGrowthEvent(input: GrowthTrackInput): Promise<void> {
  await sendGrowthEventWithResult(input)
}

/**
 * Same call, but REPORTS whether golden-beans accepted it.
 *
 * `sendGrowthEvent` above is deliberately blind: setup-guide funnel telemetry is
 * observability, and there is nothing a caller could usefully do about a failure.
 * The merchant-lifecycle emitter (lib/merchant-lifecycle-server.ts) is different —
 * it claims a once-only emission slot BEFORE sending, so it has to know whether to
 * release that slot again. A silently-swallowed failure there would burn the
 * milestone permanently: the claim row would say "already emitted" forever while
 * golden-beans never received anything.
 *
 * Returns false when unconfigured, when the request throws, and on any non-2xx —
 * a 401 from a rotated key or a 400 from a rejected context is exactly the case
 * that must not be mistaken for a delivered event.
 */
export async function sendGrowthEventWithResult(
  input: GrowthTrackInput,
): Promise<boolean> {
  try {
    const client = growthClient(input.userId)
    if (!client) return false
    const result = await client.track(input.event, {
      featureId: input.featureId,
      tags: input.tags,
      metadata: input.metadata,
      context: input.context as EventContext | undefined,
    })
    return result.ok
  } catch {
    // Intentionally swallowed — growth telemetry is observability, not critical path
    return false
  }
}

/**
 * A person's satisfaction answer, through the SDK's standard rating call (golden-frijoles satisfied-ask): the
 * `satisfaction_rated` event with the score in `tags.score`, or `satisfaction_dismissed`. Returns whether it landed;
 * never throws.
 */
export async function sendGrowthSatisfaction(
  userId: string,
  featureId: string,
  answer: number | 'dismissed',
): Promise<boolean> {
  try {
    const client = growthClient(userId)
    if (!client) return false
    const result =
      answer === 'dismissed'
        ? await client.dismissSatisfaction(featureId)
        : await client.rateSatisfaction(featureId, answer)
    return result.ok
  } catch {
    return false
  }
}

/**
 * Sampled Golden flag-evaluation fact. The fixed synthetic service subject is deliberately
 * non-personal, and this promise is safe to fire-and-forget beside a flag decision.
 */
export async function trackGoldenFlagEvaluation(
  input: Omit<FlagEvaluationTelemetryInput, 'subject'>,
): Promise<void> {
  try {
    const configuredRate = Number(
      process.env.GOLDEN_BEANS_FLAG_EVALUATION_SAMPLE_RATE ?? '0.1',
    )
    const client = growthClient('miyagi_frontend_flag_provider', configuredRate)
    if (!client) return
    await client.trackFlagEvaluation({
      ...input,
      subject: { type: 'service', id: 'miyagi_frontend' },
    })
  } catch {
    // Analytics can never affect the flag result that has already been computed.
  }
}

/** Canonical assignment + execution fact for the one explicit resilience probe seam. */
export async function trackGoldenScenarioExecution(
  input: ScenarioExecutionTelemetryInput,
): Promise<void> {
  try {
    // Scenario facts are evidence, not sampled hot-path observations.
    const client = growthClient('miyagi_frontend_scenario_probe', 1)
    if (!client) return
    await client.trackScenarioExecution(input)
  } catch {
    // The probe outcome and lease settlement remain authoritative if analytics is unavailable.
  }
}
