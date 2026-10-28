/**
 * Prompt-to-shop — the browser side of `POST /api/p2s/drafts` (epic S2.3, D11).
 *
 * `EventSource` cannot POST (and the request carries a one-shot Turnstile token), so the stream is read with a
 * `ReadableStream` reader. Parsing is split from I/O: `parseSseFrames` is pure and spec-covered; `runDraftRequest`
 * is the thin shell around `fetch` and takes it as a dependency.
 *
 * No JSX and no copy beyond the stream-broke fallback, so this file is not part of the merchant-copy scan.
 */

import type { BlockEvent } from './planner'
import { SHAPING_COPY } from './copy'

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
