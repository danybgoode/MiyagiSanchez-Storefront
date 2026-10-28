/**
 * Prompt-to-shop — Gemini through Vertex AI with a service account (no SDK, no new dependency).
 *
 * Why this exists: the account with credit is a Google Cloud project whose credential is a service-account JSON.
 * The Gemini API (generativelanguage.googleapis.com) REFUSES service-account tokens outright ("Access to Gemini
 * API is restricted with service accounts", measured 2026-10-28); Vertex AI accepts them. Same request body,
 * different URL and auth, so only the I/O shell changes.
 *
 * The network and the clock are injected so the token cache and the JWT are spec-covered without Google.
 */

import { createSign } from 'node:crypto'

export interface ServiceAccount {
  client_email: string
  private_key: string
  project_id: string
  token_uri: string
}

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token'
/** Google issues 1-hour tokens; refresh with margin so a long generation never starts on a dying token. */
const REFRESH_MARGIN_S = 300
/**
 * The token exchange gets its own deadline. The model call's timeout starts only AFTER a token is in hand, and the
 * exchange is shared by every caller waiting on it, so one stalled oauth2 response would otherwise hang every
 * generation in the process for minutes — far past the 20 s narration budget.
 */
export const TOKEN_TIMEOUT_MS = 5_000

/**
 * The env holds the JSON either raw or base64-encoded (env files are line-based, and a private key is not).
 * Anything that is not a complete service account is null, never a partial credential.
 */
export function parseServiceAccount(raw: string | undefined): ServiceAccount | null {
  const value = raw?.trim()
  if (!value) return null
  const candidates = [value]
  if (!value.startsWith('{')) {
    try {
      candidates.push(Buffer.from(value, 'base64').toString('utf8'))
    } catch {
      return null
    }
  }
  for (const c of candidates) {
    try {
      const j = JSON.parse(c) as Record<string, unknown>
      if (
        j.type === 'service_account' &&
        typeof j.client_email === 'string' && j.client_email &&
        typeof j.private_key === 'string' && j.private_key.includes('PRIVATE KEY') &&
        typeof j.project_id === 'string' && j.project_id
      ) {
        return {
          client_email: j.client_email,
          private_key: j.private_key,
          project_id: j.project_id,
          // Pinned, never read from the file: Google service accounts always use this endpoint, and honouring an
          // arbitrary `token_uri` would send a signed assertion wherever the JSON points (agy security lens, #437).
          token_uri: GOOGLE_TOKEN_URI,
        }
      }
    } catch {
      // try the next form
    }
  }
  return null
}

export function vertexGenerateUrl(projectId: string, model: string, location = 'global'): string {
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`
  return `https://${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${location}/publishers/google/models/${encodeURIComponent(model)}:generateContent`
}

export function signedAssertion(sa: ServiceAccount, nowS: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri, iat: nowS, exp: nowS + 3600 })}`
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url')
  return `${unsigned}.${sig}`
}

export interface TokenSource {
  /** A bearer token, or null when Google refused (logged by the caller as a failed attempt). */
  get: () => Promise<string | null>
}

export function vertexTokenSource(
  sa: ServiceAccount,
  deps: { fetch: typeof fetch; nowS: () => number } = { fetch, nowS: () => Math.floor(Date.now() / 1000) },
): TokenSource {
  let cached: { token: string; expiresAt: number } | null = null
  let inflight: Promise<string | null> | null = null
  return {
    get: async () => {
      if (cached && deps.nowS() < cached.expiresAt - REFRESH_MARGIN_S) return cached.token
      // Concurrent REQUESTS (several merchants at once) share one exchange instead of minting a token each.
      if (inflight) return inflight
      const exchange = (async () => {
        try {
          const now = deps.nowS()
          const res = await deps.fetch(sa.token_uri, {
            method: 'POST',
            body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedAssertion(sa, now) }),
            signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
          })
          if (!res.ok) return null
          const j = (await res.json()) as { access_token?: unknown; expires_in?: unknown }
          if (typeof j.access_token !== 'string' || !j.access_token) return null
          const ttl = typeof j.expires_in === 'number' ? j.expires_in : 3600
          cached = { token: j.access_token, expiresAt: now + ttl }
          return cached.token
        } catch {
          return null
        }
      })()
      // Cleared on settle, not in a `finally` inside the exchange: a synchronous throw (a bad PEM) would run that
      // `finally` before this assignment and leave a settled promise stuck here for good.
      inflight = exchange
      void exchange.then(() => { if (inflight === exchange) inflight = null })
      return exchange
    },
  }
}
