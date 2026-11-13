/**
 * Which Stripe Connect onboarding a shop gets (epic one-front-door-both-markets, fresh review on PR #499).
 *
 * `/api/stripe/connect` was written for Mexico: it creates an Express account with `country: 'MX'`. A US shop needs
 * the backend's Accounts v2 flow (`POST /store/sellers/me/stripe-connect`, us-marketplace D17), which resolves the
 * account server-side from the Clerk seller and requires `account_country: 'us'` for US readiness. Before this the
 * storefront had NO caller of that route, so a US merchant who tapped «Conectar Stripe» got a Mexican account their
 * shop could never charge with. The market comes from Medusa (`getMySeller`), never from the request.
 *
 * Pure: the decision and the reading of the backend's answer. The route does the I/O.
 */

import type { MarketCode } from './markets'

export type ConnectPlan = { kind: 'us_v2' } | { kind: 'mx_express' } | { kind: 'unknown_market' }

/** Three states: a US seller, a Mexican one, and a seller whose market could not be read (never assumed Mexico). */
export function connectPlanFor(seller: { market?: MarketCode | null } | null): ConnectPlan {
  if (!seller || !seller.market) return { kind: 'unknown_market' }
  return seller.market === 'us' ? { kind: 'us_v2' } : { kind: 'mx_express' }
}

/** The backend's `{ onboarding_url }` → a Stripe-hosted https URL to send the seller to, or null. */
export function usOnboardingUrl(json: unknown): string | null {
  const url = (json as { onboarding_url?: unknown } | null)?.onboarding_url
  if (typeof url !== 'string') return null
  try {
    const u = new URL(url)
    // Only Stripe's own hosts: the backend builds this link, but a redirect target is checked where it is used.
    return u.protocol === 'https:' && (u.hostname === 'connect.stripe.com' || u.hostname.endsWith('.stripe.com')) ? u.toString() : null
  } catch {
    return null
  }
}

/**
 * A cross-site navigation must not start a seller's Stripe onboarding (Codex security lens, PR #499): the route is a
 * GET link on our own settings page, so a request another site triggered arrives with `Sec-Fetch-Site: cross-site`.
 * Same-origin, same-site and a typed URL (`none`) are allowed; a browser that sends no header is allowed too — the
 * account is resolved server-side from the seller, so the most a forged request could do is open their own setup.
 */
export function isCrossSiteNavigation(secFetchSite: string | null): boolean {
  return (secFetchSite ?? '').trim().toLowerCase() === 'cross-site'
}
