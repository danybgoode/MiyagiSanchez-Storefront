/**
 * The screen's I/O (epic one-front-door-both-markets D1). One `fetch` to TypeSafe; every decision is in `screen.ts`.
 *
 * `TYPESAFE_API_KEY` is server-only. Without it the screen is `unavailable` (D4) — the builder keeps working under
 * today's guards, and the log says so on every request rather than pretending the check ran.
 */

import 'server-only'
import { parseScreenResponse, screenRequestBody, SCREEN_TIMEOUT_MS, type ScreenAnswer, type ScreenDeps } from './screen'

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

export async function askJev(text: string, key: string | undefined = process.env.TYPESAFE_API_KEY): Promise<ScreenAnswer> {
  if (!key) return { ok: false, reason: 'no_key' }
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(screenRequestBody(text)),
      signal: AbortSignal.timeout(SCREEN_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!res.ok) return { ok: false, reason: `http_${res.status}` }
    return parseScreenResponse(await res.json().catch(() => null))
  } catch (e) {
    return { ok: false, reason: e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'fetch_failed' }
  }
}

export function screenDeps(): ScreenDeps {
  return {
    ask: (text) => askJev(text),
    log: (line) => console.info('[p2s-screen]', JSON.stringify(line)),
  }
}
