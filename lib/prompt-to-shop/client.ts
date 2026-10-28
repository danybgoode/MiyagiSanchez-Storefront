/**
 * Prompt-to-shop — the browser side of `POST /api/p2s/drafts` (epic S2.3, D11).
 *
 * `EventSource` cannot POST (and the request carries a one-shot Turnstile token), so the stream is read with a
 * `ReadableStream` reader. Parsing is split from I/O: `parseSseFrames` is pure and spec-covered; `runDraftRequest`
 * is the thin shell around `fetch` and takes it as a dependency.
 *
 * No JSX and no copy beyond the stream-broke fallback, so this file is not part of the merchant-copy scan.
 */

import type { IdentityBlock } from './blocks'
import type { ClaimOutcome } from './claim'
import type { BlockEvent } from './planner'
import { ARMAR_COPY, CHECKLIST_COPY, KEEP_COPY, OWNER_COPY, PHOTO_COPY, SHAPING_COPY } from './copy'
import type { PhotoSuggestion } from './photo'

const SAVE_FAILED = OWNER_COPY.saveFailed

export type StreamFrame =
  | { event: 'block'; data: BlockEvent }
  | { event: 'done'; data: { draft_id: string; versions_left: number } }
  | { event: 'error'; data: { message?: string; block?: string } }

/**
 * Split a buffer into complete SSE frames plus the unfinished tail. Frames end at a blank line; a frame the server
 * wrote half of stays in `rest` for the next chunk. A malformed or unknown frame is skipped, never thrown: one bad
 * frame must not kill a stream whose blocks are already saved.
 */
export function parseSseFrames(buffer: string): { frames: StreamFrame[]; rest: string } {
  const normalised = buffer.replace(/\r\n/g, '\n')
  const parts = normalised.split('\n\n')
  const rest = parts.pop() ?? ''
  const frames: StreamFrame[] = []
  for (const part of parts) {
    let event = ''
    const data: string[] = []
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trim())
    }
    if (!data.length) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(data.join('\n'))
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    if (event === 'block' || event === 'done' || event === 'error') frames.push({ event, data: parsed } as StreamFrame)
  }
  return { frames, rest }
}

export type DraftRequestBody = { description?: string; draft_id?: string; turnstile_token: string; tone?: string }

export type DraftOutcome =
  /** The server said no, in plain es-MX, with no stream. `message` is the server's own text, verbatim. */
  | { kind: 'refused'; message: string; code?: string }
  | { kind: 'done'; draftId: string; versionsLeft: number }
  /** The stream ended without `done`: an `error` event, or the connection died. */
  | { kind: 'failed'; message: string }

export interface DraftRequestDeps {
  fetch: typeof fetch
}

export async function runDraftRequest(
  body: DraftRequestBody,
  onBlock: (event: BlockEvent) => void,
  deps: DraftRequestDeps = { fetch: (...args) => fetch(...args) },
): Promise<DraftOutcome> {
  let res: Response
  try {
    res = await deps.fetch('/api/p2s/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    })
  } catch {
    return { kind: 'failed', message: SHAPING_COPY.broken }
  }

  if (!res.ok || !res.body) {
    // A refusal is plain JSON `{error, code}` and its `error` is already merchant-facing: show it verbatim.
    const refusal = (await res.json().catch(() => null)) as { error?: unknown; code?: unknown } | null
    const message = typeof refusal?.error === 'string' && refusal.error ? refusal.error : SHAPING_COPY.broken
    return { kind: 'refused', message, code: typeof refusal?.code === 'string' ? refusal.code : undefined }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let outcome: DraftOutcome | null = null
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const { frames, rest } = parseSseFrames(buffer)
      buffer = rest
      for (const frame of frames) {
        if (frame.event === 'block') onBlock(frame.data)
        else if (frame.event === 'done') outcome = { kind: 'done', draftId: frame.data.draft_id, versionsLeft: frame.data.versions_left }
        else outcome = { kind: 'failed', message: frame.data.message || SHAPING_COPY.broken }
      }
    }
  } catch {
    return outcome ?? { kind: 'failed', message: SHAPING_COPY.broken }
  }
  return outcome ?? { kind: 'failed', message: SHAPING_COPY.broken }
}

export type PatchBody = { name?: string; accent_color?: string }

export type PatchOutcome =
  | { ok: true; identity: IdentityBlock }
  /** `message` is the server's own merchant-facing text, verbatim. */
  | { ok: false; status: number; message: string }

/** `PATCH /api/p2s/drafts/[id]` — one autosave. Never throws: a dead connection is an outcome like any other. */
export async function patchDraft(
  draftId: string,
  body: PatchBody,
  deps: DraftRequestDeps = { fetch: (...args) => fetch(...args) },
): Promise<PatchOutcome> {
  try {
    const res = await deps.fetch(`/api/p2s/drafts/${draftId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => null)) as { ok?: unknown; identity?: unknown; error?: unknown } | null
    if (res.ok && data?.ok === true && data.identity && typeof data.identity === 'object') {
      return { ok: true, identity: data.identity as IdentityBlock }
    }
    return { ok: false, status: res.status, message: typeof data?.error === 'string' && data.error ? data.error : SAVE_FAILED }
  } catch {
    return { ok: false, status: 0, message: SAVE_FAILED }
  }
}

/** `POST /api/p2s/link/[id]` — «Mándame el enlace». `message` is the server's own text when it sent one. */
export async function mailDraftLink(
  draftId: string,
  email: string,
  deps: DraftRequestDeps = { fetch: (...args) => fetch(...args) },
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await deps.fetch(`/api/p2s/link/${draftId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email }),
    })
    const data = (await res.json().catch(() => null)) as { ok?: unknown; message?: unknown } | null
    const message = typeof data?.message === 'string' && data.message ? data.message : KEEP_COPY.mailFailed
    return { ok: res.ok && data?.ok === true, message }
  } catch {
    return { ok: false, message: KEEP_COPY.mailFailed }
  }
}

const CLAIM_KINDS: ReadonlyArray<ClaimOutcome['kind']> = ['kept', 'other_phone', 'has_shop', 'incomplete', 'signed_out', 'retry']

/** `POST /api/p2s/claim/[id]` — keep it. A dead connection is a `retry`, never a guess at the outcome. */
export async function claimDraft(
  draftId: string,
  deps: DraftRequestDeps = { fetch: (...args) => fetch(...args) },
): Promise<ClaimOutcome> {
  try {
    const res = await deps.fetch(`/api/p2s/claim/${draftId}`, { method: 'POST', credentials: 'same-origin' })
    const data = (await res.json().catch(() => null)) as { kind?: unknown } | null
    if (data && CLAIM_KINDS.includes(data.kind as ClaimOutcome['kind'])) return data as ClaimOutcome
  } catch {
    // fall through
  }
  return { kind: 'retry', message: ARMAR_COPY.failed }
}

// ── Make it yours (S4) ───────────────────────────────────────────────────────────────────────────────────────────

/** `POST /api/sell/upload` — the merchant's photo to our own storage. The URL it returns is the only one the photo
 *  routes accept. */
export async function uploadPhoto(file: File, deps: DraftRequestDeps = { fetch: (...args) => fetch(...args) }): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  try {
    const form = new FormData()
    form.append('file', file)
    const res = await deps.fetch('/api/sell/upload', { method: 'POST', body: form, credentials: 'same-origin' })
    const data = (await res.json().catch(() => null)) as { url?: unknown; error?: unknown } | null
    if (res.ok && typeof data?.url === 'string') return { ok: true, url: data.url }
    return { ok: false, message: typeof data?.error === 'string' && data.error ? data.error : PHOTO_COPY.uploadFailed }
  } catch {
    return { ok: false, message: PHOTO_COPY.uploadFailed }
  }
}

export type AnalyzeResult =
  | { ok: true; suggestion: PhotoSuggestion | null; message: string | null; photosLeft: number | null }
  | { ok: false; message: string; code: string | null }

/** `POST /api/p2s/photo`. A refusal's `error` is merchant-facing and shown verbatim. */
export async function analyzePhotoRequest(imageUrl: string, deps: DraftRequestDeps = { fetch: (...args) => fetch(...args) }): Promise<AnalyzeResult> {
  try {
    const res = await deps.fetch('/api/p2s/photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ image_url: imageUrl }),
    })
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (res.ok && data?.ok === true) {
      return {
        ok: true,
        suggestion: (data.suggestion as PhotoSuggestion | null) ?? null,
        message: typeof data.message === 'string' ? data.message : null,
        photosLeft: typeof data.photos_left === 'number' ? data.photos_left : null,
      }
    }
    return { ok: false, message: typeof data?.error === 'string' && data.error ? data.error : PHOTO_COPY.fillYourself, code: typeof data?.code === 'string' ? data.code : null }
  } catch {
    return { ok: false, message: PHOTO_COPY.uploadFailed, code: null }
  }
}

export interface ConfirmBody {
  nonce: string
  image_url: string
  card: PhotoSuggestion
  replace?: { index: number; title: string } | null
}

export type ConfirmResult =
  | { ok: true; productId: string; duplicate: boolean; finished: boolean; photosLeft: number | null }
  | { ok: false; status: number; message: string; code: string | null }

/** `POST /api/p2s/photo/confirm`. A dead connection is a failure the merchant retries with the SAME nonce. */
export async function confirmPhotoRequest(body: ConfirmBody, deps: DraftRequestDeps = { fetch: (...args) => fetch(...args) }): Promise<ConfirmResult> {
  try {
    const res = await deps.fetch('/api/p2s/photo/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (res.ok && data?.ok === true && typeof data.product_id === 'string') {
      // `finished: false` = the product exists but the server could not record it on the shop yet; the caller
      // retries the same nonce once (an absent field reads as finished, the shape before this flag existed).
      return { ok: true, productId: data.product_id, duplicate: data.duplicate === true, finished: data.finished !== false, photosLeft: typeof data.photos_left === 'number' ? data.photos_left : null }
    }
    return { ok: false, status: res.status, message: typeof data?.error === 'string' && data.error ? data.error : PHOTO_COPY.createFailed, code: typeof data?.code === 'string' ? data.code : null }
  } catch {
    return { ok: false, status: 0, message: PHOTO_COPY.createFailed, code: null }
  }
}

/** `PATCH /api/sell/shop` from the BROWSER (its own cookie) — the seam every settings section saves through. */
export async function patchShop(payload: Record<string, unknown>, deps: DraftRequestDeps = { fetch: (...args) => fetch(...args) }): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await deps.fetch('/api/sell/shop', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    })
    const data = (await res.json().catch(() => null)) as { error?: unknown } | null
    return { ok: res.ok, message: res.ok ? CHECKLIST_COPY.saved : typeof data?.error === 'string' && data.error ? data.error : CHECKLIST_COPY.saveFailed }
  } catch {
    return { ok: false, message: CHECKLIST_COPY.saveFailed }
  }
}
