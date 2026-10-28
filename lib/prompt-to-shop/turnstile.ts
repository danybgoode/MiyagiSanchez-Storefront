/**
 * Cloudflare Turnstile — server-side verification for the public describe box (epic D8).
 *
 * FAILS CLOSED on every path that is not a positive answer from Cloudflare: no secret configured, no token, a
 * network error, a non-200, a body we cannot read, or `success: false`. This box spends money on every accepted
 * request, so "I could not check" must refuse, never pass. That is the opposite of `checkRateLimit`, on purpose.
 */

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** Cloudflare's documented maximum token length; anything longer is not a token. */
const MAX_TOKEN_LENGTH = 2048

export type TurnstileVerdict = { ok: true } | { ok: false; reason: 'not_configured' | 'missing_token' | 'rejected' | 'unreachable' }

export async function verifyTurnstile(
  input: { secret: string | undefined; token: unknown; ip?: string | null },
  deps: { fetch: typeof fetch } = { fetch },
): Promise<TurnstileVerdict> {
  const secret = input.secret?.trim()
  if (!secret) return { ok: false, reason: 'not_configured' }
  if (typeof input.token !== 'string' || !input.token || input.token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: 'missing_token' }
  }
  const form = new URLSearchParams({ secret, response: input.token })
  if (input.ip) form.set('remoteip', input.ip)
  try {
    const res = await deps.fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body: form })
    if (!res.ok) return { ok: false, reason: 'unreachable' }
    const data = (await res.json()) as { success?: unknown }
    return data?.success === true ? { ok: true } : { ok: false, reason: 'rejected' }
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
}
