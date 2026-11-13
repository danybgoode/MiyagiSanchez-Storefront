/**
 * Prompt-to-shop — the `POST /api/p2s/drafts` decision sequence (epic D7, D11, D12).
 *
 *   validate → Turnstile → burst limit → (re-run: ownership) → SCREEN → spend → write draft → stream
 *
 * The screen (one-front-door-both-markets D2) sits after Turnstile and the burst limit — it must not be a free oracle
 * for anyone who can POST — and before the spend, so a refused description costs neither the device's versions nor
 * the platform's daily budget. `unavailable` proceeds under the guards that existed before it (D4).
 *
 * Nothing that costs money runs before the spend is claimed, and no refusal reaches the model. Every effect is
 * injected, so the `api` spec records a trace and asserts the ORDER, not only the status: a refusal that happened
 * after a model call would still return the right status code and still have spent the money.
 *
 * No Medusa import, anywhere in this module graph: a draft is not commerce until S3.2 claims it.
 */

import { decideSpend, deviceSubject, P2S_LIMITS, type SpendDecision } from './allowance'
import { MAX_DESCRIPTION_CHARS } from './blocks'
import { isTone, type Tone } from './prompts'
import { isBusinessShape, type BusinessShape } from '../business-shape'
import { generateDraft, type BlockEvent, type ModelRequest, type ModelResult } from './planner'
import type { TurnstileVerdict } from './turnstile'
import { refusalCopyKey, type ScreenVerdict } from './screen'
import { currencyFor, readLocale, readMarketHint, type P2sLocale, type P2sMarketHint } from './locale'
import { sanitizeSeedRows, screenTextFor, type IntakeKind } from './intake'
import type { CatalogImportRow } from '../catalog-import'

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
  // D5 — every non-prohibited refusal reads the same, so an attacker never learns which check fired.
  notABusiness: 'Esto no parece un negocio. Cuéntanos qué vendes o qué ofreces y armamos tu tienda.',
  prohibited: 'No podemos armar tiendas para productos que los pagos en línea no aceptan (por ejemplo medicamentos controlados, armas o réplicas).',
} as const

/** The same refusals in English (D11). `satisfies` makes a key missing here a type error, not a blank message. */
export const P2S_COPY_EN = {
  invalid: 'Tell us in a sentence what you sell (up to 500 characters).',
  verify: "We couldn't verify it's you. Reload the page and try again.",
  rateLimited: "You're going fast. Wait a moment and try again.",
  allowance: `You've used your ${P2S_LIMITS.anonVersions} versions. Keep the one you like best.`,
  budget: "We've built a lot of shops today. Come back tomorrow.",
  notFound: "We couldn't find that shop on this phone. Start a new one.",
  unavailable: "We couldn't build your shop right now. Try again in a moment.",
  notABusiness: "This doesn't look like a business. Tell us what you sell or offer and we'll build your shop.",
  prohibited: "We can't build shops for products online payments don't accept (for example controlled drugs, weapons or replicas).",
} as const satisfies Record<keyof typeof P2S_COPY, string>

export function p2sCopy(locale: P2sLocale): Record<keyof typeof P2S_COPY, string> {
  return locale === 'en' ? P2S_COPY_EN : P2S_COPY
}

export interface DraftRef {
  id: string
  description: string
  /** The draft's stored hint and language (D10). A re-run reuses them: the canvas sends neither (Codex, PR #498). */
  market?: P2sMarketHint | null
  locale?: P2sLocale
}

export interface DraftsDeps {
  verifyTurnstile: (token: unknown) => Promise<TurnstileVerdict>
  /** Per-IP and per-device burst limit. May fail open (D5); the spend below is the hard cap. */
  burstAllowed: (deviceId: string) => Promise<boolean>
  /** `spend_p2s_generation`, raw `{data, error}`; `decideSpend` reads it and fails closed. */
  spend: (args: { subject: string; versionCap: number }) => Promise<{ data: unknown; error: unknown }>
  /** An unclaimed, unexpired draft owned by this device, or null. */
  findOwnedDraft: (draftId: string, deviceId: string) => Promise<DraftRef | null>
  createDraft: (deviceId: string, description: string, versionsUsed: number, meta: DraftMeta) => Promise<DraftRef | null>
  /** D1 — the screen. Resolves a verdict; `unavailable` is a verdict, not a throw. */
  screen: (text: string) => Promise<ScreenVerdict>
  /** Start a new version on an owned draft. Resolves false when no row was updated. */
  startVersion: (draft: DraftRef, deviceId: string, description: string, versionsUsed: number) => Promise<boolean>
  /** Save one block, only while `version` is still the draft's current one (a superseded run stops). */
  saveBlock: (draftId: string, deviceId: string, version: number, event: BlockEvent) => Promise<boolean>
  /** Give a spent generation back. Best effort: a failed refund is logged, never surfaced. */
  refund: (args: { subject: string }) => Promise<void>
  callModel: (req: ModelRequest) => Promise<ModelResult>
  modelConfigured: boolean
  newDeviceId: () => string
  log?: (line: Record<string, unknown>) => void
}

export type Refusal = { kind: 'refuse'; status: number; error: keyof typeof P2S_COPY; message: string }

/** What a new draft is born with besides its description (D10–D12, D9). */
export interface DraftMeta {
  locale: P2sLocale
  market: P2sMarketHint | null
  seedRows: CatalogImportRow[] | null
}

export type Accepted = {
  kind: 'stream'
  draftId: string
  versionsLeft: number
  /** Runs the generation, calling `send` for each SSE event. Never rejects. */
  run: (send: (event: string, data: unknown) => void) => Promise<void>
}

export type DraftsResult = (Refusal | Accepted) & { deviceId: string; mintedDevice: boolean }

function refuse(status: number, error: keyof typeof P2S_COPY, locale: P2sLocale = 'es'): Refusal {
  return { kind: 'refuse', status, error, message: p2sCopy(locale)[error] }
}

export interface ParsedBody {
  description: string | null
  draftId: string | null
  turnstileToken: unknown
  /** Optional voice for the words block («Otra versión» → cercano / formal / divertido). Absent = the default. */
  tone: Tone | null
  /** Optional business shape the merchant picked («Tipo de negocio»). Absent = the model decides. */
  shape: BusinessShape | null
  locale: P2sLocale
  marketHint: P2sMarketHint | null
  /** Which kind of input started it (D19); text when absent. */
  input: IntakeKind | 'text'
  /** The merchant's own rows from an intake, re-validated here (never trusted as sent). Null = none. */
  seedRows: CatalogImportRow[] | null
}

const INPUTS = ['text', 'photo', 'file', 'url'] as const

/** Pure. A new draft needs a description; a re-run needs a draft id and may bring a new description. */
export function parseDraftsBody(body: unknown): ParsedBody | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  const description = typeof b.description === 'string' ? b.description.trim() : null
  if (description !== null && (description.length === 0 || description.length > MAX_DESCRIPTION_CHARS)) return null
  const draftId = b.draft_id === undefined || b.draft_id === null ? null : typeof b.draft_id === 'string' && UUID.test(b.draft_id) ? b.draft_id : undefined
  if (draftId === undefined) return null
  if (!draftId && !description) return null
  // A tone is a closed enum: anything else is a malformed body, not a hint to guess at.
  if (b.tone !== undefined && b.tone !== null && !isTone(b.tone)) return null
  // Same rule for the shape: it is stated to the model outside the data tags, so only our own enum may arrive.
  if (b.shape !== undefined && b.shape !== null && !isBusinessShape(b.shape)) return null
  if (b.input !== undefined && b.input !== null && !(INPUTS as readonly unknown[]).includes(b.input)) return null
  if (b.seed_rows !== undefined && b.seed_rows !== null && !Array.isArray(b.seed_rows)) return null
  const marketHint = readMarketHint(b.market_hint)
  const rows = Array.isArray(b.seed_rows) ? sanitizeSeedRows(b.seed_rows, currencyFor(marketHint)) : []
  return {
    description, draftId, turnstileToken: b.turnstile_token, tone: b.tone ?? null, shape: b.shape ?? null,
    locale: readLocale(b.locale),
    marketHint,
    input: (b.input as ParsedBody['input'] | undefined) ?? 'text',
    seedRows: rows.length ? rows : null,
  }
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
  if (!parsed) return withDevice(refuse(400, 'invalid', readLocale((input.body as { locale?: unknown } | null)?.locale)))
  const L = parsed.locale

  const verdict = await deps.verifyTurnstile(parsed.turnstileToken)
  if (!verdict.ok) {
    deps.log?.({ event: 'turnstile_refused', reason: verdict.reason })
    return withDevice(refuse(403, 'verify', L))
  }

  if (!(await deps.burstAllowed(deviceId))) return withDevice(refuse(429, 'rateLimited', L))

  // Without a model there is nothing to sell the allowance for: refuse BEFORE spending it.
  if (!deps.modelConfigured) return withDevice(refuse(503, 'unavailable', L))

  let draft: DraftRef | null = null
  if (parsed.draftId) {
    // A re-run is only for a draft this device owns. Checked before the spend, so a stranger's draft id cannot
    // cost this device (or the platform) a generation.
    draft = await deps.findOwnedDraft(parsed.draftId, deviceId)
    if (!draft) return withDevice(refuse(404, 'notFound', L))
  }

  // D2 — the screen, on any NEW text: a first description, or a re-run that brings one. A re-run with no new text
  // regenerates words already screened, so it is not asked again.
  if (parsed.description) {
    const verdict = await deps.screen(screenTextFor(parsed.description, parsed.seedRows ?? []))
    if (verdict.verdict === 'refuse') {
      return withDevice(refuse(422, refusalCopyKey(verdict.kind), L))
    }
  }

  const spend: SpendDecision = decideSpend(await deps.spend({ subject: deviceSubject(deviceId), versionCap: P2S_LIMITS.anonVersions }))
  if (!spend.ok) {
    deps.log?.({ event: 'spend_refused', reason: spend.reason })
    if (spend.reason === 'allowance') return withDevice(refuse(429, 'allowance', L))
    if (spend.reason === 'budget') return withDevice(refuse(503, 'budget', L))
    return withDevice(refuse(503, 'unavailable', L))
  }

  // The spend is claimed; if the draft write after it fails, the merchant got nothing, so they pay nothing.
  const refundAndRefuse = async () => {
    await deps.refund({ subject: deviceSubject(deviceId) }).catch(() => {})
    deps.log?.({ event: 'refunded', reason: 'draft_write_failed' })
    return withDevice(refuse(503, 'unavailable', L))
  }
  const description = parsed.description ?? draft?.description ?? ''
  if (draft) {
    if (!(await deps.startVersion(draft, deviceId, description, spend.versionsUsed))) return refundAndRefuse()
  } else {
    draft = await deps.createDraft(deviceId, description, spend.versionsUsed, { locale: L, market: parsed.marketHint, seedRows: parsed.seedRows })
    if (!draft) return refundAndRefuse()
  }

  const draftId = draft.id
  const market = parsed.marketHint ?? draft.market ?? null
  const version = spend.versionsUsed
  const versionsLeft = spend.versionsLeft
  return withDevice({
    kind: 'stream',
    draftId,
    versionsLeft,
    run: async (rawSend) => {
      // The phone may hang up mid-stream. Sending then throws, and that must not abort generation: the blocks are
      // already paid for, and saving them is what lets a reload bring the shop back.
      const send = (event: string, data: unknown) => {
        try {
          rawSend(event, data)
        } catch {
          // client gone — keep generating and saving
        }
      }
      try {
        const outcome = await generateDraft(description, {
          callModel: deps.callModel,
          saveBlock: (event) => deps.saveBlock(draftId, deviceId, version, event),
          emit: (event) => send('block', event),
          log: (line) => deps.log?.({ event: 'block', draft_id: draftId, ...line }),
        }, { tone: parsed.tone ?? undefined, shape: parsed.shape ?? undefined, market })
        if (outcome.ok) send('done', { draft_id: draftId, versions_left: versionsLeft })
        else send('error', { message: p2sCopy(L).unavailable, block: outcome.failedBlock })
      } catch (e) {
        deps.log?.({ event: 'stream_failed', draft_id: draftId, error: e instanceof Error ? e.message : String(e) })
        send('error', { message: p2sCopy(L).unavailable })
      }
    },
  })
}

/** One SSE frame. `data` is JSON on a single line, so a newline in model text can never split a frame. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}
