/**
 * Prompt-to-shop — the `POST /api/p2s/drafts` decision sequence (epic D7, D11, D12).
 *
 *   validate → Turnstile → burst limit → (re-run: ownership) → spend → write draft → stream
 *
 * Nothing that costs money runs before the spend is claimed, and no refusal reaches the model. Every effect is
 * injected, so the `api` spec records a trace and asserts the ORDER, not only the status: a refusal that happened
 * after a model call would still return the right status code and still have spent the money.
 *
 * No Medusa import, anywhere in this module graph: a draft is not commerce until S3.2 claims it.
 */

import { decideSpend, deviceSubject, P2S_LIMITS, type SpendDecision } from './allowance'
import { MAX_DESCRIPTION_CHARS } from './blocks'
import { generateDraft, type BlockEvent, type ModelRequest, type ModelResult } from './planner'
import type { TurnstileVerdict } from './turnstile'

export const DEVICE_COOKIE = 'p2s_device'
export const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 30

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const P2S_COPY = {
  invalid: 'Cuéntanos en una frase qué vendes (hasta 500 caracteres).',
  verify: 'No pudimos verificar que eres tú. Recarga la página e inténtalo de nuevo.',
  rateLimited: 'Vas muy rápido. Espera un momento e inténtalo de nuevo.',
  allowance: `Ya usaste tus ${P2S_LIMITS.anonVersions} versiones. Quédate con la que más te guste.`,
  budget: 'Hoy ya armamos muchas tiendas. Vuelve mañana o déjanos tu correo.',
  notFound: 'No encontramos esa tienda en este teléfono. Empieza una nueva.',
  unavailable: 'No pudimos armar tu tienda ahora. Inténtalo de nuevo en un momento.',
} as const

export interface DraftRef {
  id: string
  description: string
}

export interface DraftsDeps {
  verifyTurnstile: (token: unknown) => Promise<TurnstileVerdict>
  /** Per-IP and per-device burst limit. May fail open (D5); the spend below is the hard cap. */
  burstAllowed: (deviceId: string) => Promise<boolean>
  /** `spend_p2s_generation`, raw `{data, error}`; `decideSpend` reads it and fails closed. */
  spend: (args: { subject: string; versionCap: number }) => Promise<{ data: unknown; error: unknown }>
  /** An unclaimed, unexpired draft owned by this device, or null. */
  findOwnedDraft: (draftId: string, deviceId: string) => Promise<DraftRef | null>
  createDraft: (deviceId: string, description: string, versionsUsed: number) => Promise<DraftRef | null>
  /** Start a new version on an owned draft. Resolves false when no row was updated. */
  startVersion: (draft: DraftRef, deviceId: string, description: string, versionsUsed: number) => Promise<boolean>
  saveBlock: (draftId: string, deviceId: string, event: BlockEvent) => Promise<boolean>
  callModel: (req: ModelRequest) => Promise<ModelResult>
  modelConfigured: boolean
  newDeviceId: () => string
  log?: (line: Record<string, unknown>) => void
}

export type Refusal = { kind: 'refuse'; status: number; error: keyof typeof P2S_COPY; message: string }

export type Accepted = {
  kind: 'stream'
  draftId: string
  versionsLeft: number
  /** Runs the generation, calling `send` for each SSE event. Never rejects. */
  run: (send: (event: string, data: unknown) => void) => Promise<void>
}

export type DraftsResult = (Refusal | Accepted) & { deviceId: string; mintedDevice: boolean }

function refuse(status: number, error: keyof typeof P2S_COPY): Refusal {
  return { kind: 'refuse', status, error, message: P2S_COPY[error] }
}

export interface ParsedBody {
  description: string | null
  draftId: string | null
  turnstileToken: unknown
}

/** Pure. A new draft needs a description; a re-run needs a draft id and may bring a new description. */
export function parseDraftsBody(body: unknown): ParsedBody | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  const description = typeof b.description === 'string' ? b.description.trim() : null
  if (description !== null && (description.length === 0 || description.length > MAX_DESCRIPTION_CHARS)) return null
  const draftId = b.draft_id === undefined || b.draft_id === null ? null : typeof b.draft_id === 'string' && UUID.test(b.draft_id) ? b.draft_id : undefined
  if (draftId === undefined) return null
  if (!draftId && !description) return null
  return { description, draftId, turnstileToken: b.turnstile_token }
}

export function readDeviceId(cookieValue: string | undefined | null): string | null {
  return cookieValue && UUID.test(cookieValue) ? cookieValue.toLowerCase() : null
}

export async function handleCreateDraft(
  input: { body: unknown; deviceCookie: string | null | undefined },
  deps: DraftsDeps,
): Promise<DraftsResult> {
  const existingDevice = readDeviceId(input.deviceCookie)
  const deviceId = existingDevice ?? deps.newDeviceId()
  const withDevice = <T extends Refusal | Accepted>(r: T) => ({ ...r, deviceId, mintedDevice: !existingDevice })

  const parsed = parseDraftsBody(input.body)
  if (!parsed) return withDevice(refuse(400, 'invalid'))

  const verdict = await deps.verifyTurnstile(parsed.turnstileToken)
  if (!verdict.ok) {
    deps.log?.({ event: 'turnstile_refused', reason: verdict.reason })
    return withDevice(refuse(403, 'verify'))
  }

  if (!(await deps.burstAllowed(deviceId))) return withDevice(refuse(429, 'rateLimited'))

  // Without a model there is nothing to sell the allowance for: refuse BEFORE spending it.
  if (!deps.modelConfigured) return withDevice(refuse(503, 'unavailable'))

  let draft: DraftRef | null = null
  if (parsed.draftId) {
    // A re-run is only for a draft this device owns. Checked before the spend, so a stranger's draft id cannot
    // cost this device (or the platform) a generation.
    draft = await deps.findOwnedDraft(parsed.draftId, deviceId)
    if (!draft) return withDevice(refuse(404, 'notFound'))
  }

  const spend: SpendDecision = decideSpend(await deps.spend({ subject: deviceSubject(deviceId), versionCap: P2S_LIMITS.anonVersions }))
  if (!spend.ok) {
    deps.log?.({ event: 'spend_refused', reason: spend.reason })
    if (spend.reason === 'allowance') return withDevice(refuse(429, 'allowance'))
    if (spend.reason === 'budget') return withDevice(refuse(503, 'budget'))
    return withDevice(refuse(503, 'unavailable'))
  }

  const description = parsed.description ?? draft?.description ?? ''
  if (draft) {
    if (!(await deps.startVersion(draft, deviceId, description, spend.versionsUsed))) {
      return withDevice(refuse(503, 'unavailable'))
    }
  } else {
    draft = await deps.createDraft(deviceId, description, spend.versionsUsed)
    if (!draft) return withDevice(refuse(503, 'unavailable'))
  }

  const draftId = draft.id
  const versionsLeft = spend.versionsLeft
  return withDevice({
    kind: 'stream',
    draftId,
    versionsLeft,
    run: async (send) => {
      try {
        const outcome = await generateDraft(description, {
          callModel: deps.callModel,
          saveBlock: (event) => deps.saveBlock(draftId, deviceId, event),
          emit: (event) => send('block', event),
          log: (line) => deps.log?.({ event: 'block', draft_id: draftId, ...line }),
        })
        if (outcome.ok) send('done', { draft_id: draftId, versions_left: versionsLeft })
        else send('error', { message: P2S_COPY.unavailable, block: outcome.failedBlock })
      } catch (e) {
        deps.log?.({ event: 'stream_failed', draft_id: draftId, error: e instanceof Error ? e.message : String(e) })
        send('error', { message: P2S_COPY.unavailable })
      }
    },
  })
}

/** One SSE frame. `data` is JSON on a single line, so a newline in model text can never split a frame. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}
