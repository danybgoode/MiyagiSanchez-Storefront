/**
 * Resuming a payment-link attempt (in-person-sales S4.2, D15). PURE.
 *
 * A single-use link is held for ~31 minutes while a checkout is open. A buyer who backs out of
 * the provider page, refreshes, times out or switches method would be locked out of their own link
 * (LINK_BUSY), and after a transfer a refresh would offer «Pagar» again with the CLABE gone. So the
 * last successful start is kept per token in sessionStorage and offered back as «Continuar con tu
 * pago» instead of starting over. Nothing here is a payment fact: it is only where to send the
 * buyer, and the backend still decides what is paid.
 */
import type { ManualPayment } from './counter-checkout'

export const ATTEMPT_TTL_MS = 31 * 60_000

export interface PayAttempt {
  at: number
  redirect_url?: string
  manual?: ManualPayment
}

export const attemptKey = (token: string) => `ms.pagar.attempt:${token}`

/** A usable attempt: fresh, with somewhere to go. Anything else is "start over". */
export function usableAttempt(a: PayAttempt | null | undefined, now: number): PayAttempt | null {
  if (!a || !Number.isFinite(a.at) || now - a.at < 0 || now - a.at > ATTEMPT_TTL_MS) return null
  if (typeof a.redirect_url === 'string' && /^https:\/\//.test(a.redirect_url)) return a
  if (a.manual && (a.manual.spei || a.manual.dimo)) return a
  return null
}

export function parseAttempt(raw: string | null, now: number): PayAttempt | null {
  if (!raw) return null
  try { return usableAttempt(JSON.parse(raw) as PayAttempt, now) } catch { return null }
}

/**
 * What the pay buttons do. A usable stored attempt is offered first; LINK_BUSY with one means the
 * hold is this buyer's own, so "continue" replaces "try again".
 */
export function resumeDecision(input: { attempt: PayAttempt | null; now: number; failure?: 'closed' | 'busy' | 'retry' | null }): 'continue' | 'busy_retry' | 'start' {
  if (usableAttempt(input.attempt, input.now)) return 'continue'
  return input.failure === 'busy' ? 'busy_retry' : 'start'
}
