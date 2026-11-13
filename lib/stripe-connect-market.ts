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
 * Only a navigation from our own pages (or a typed URL) may start a seller's US Stripe onboarding (Codex security
 * lens, PR #499): the route is a GET link on our settings page, so the browser's own `Sec-Fetch-Site` says where the
 * request came from. `same-origin` and `none` pass; `same-site` and `cross-site` do not. A browser that sends no such
 * header (older Safari) passes only when its `Referer` is our own host. The account is still resolved server-side.
 */
export function isAllowedConnectNavigation(input: { secFetchSite: string | null; referer: string | null; siteHost: string }): boolean {
  const site = (input.secFetchSite ?? '').trim().toLowerCase()
  if (site === 'same-origin' || site === 'none') return true
  if (site) return false
  try {
    return !!input.referer && new URL(input.referer).host === input.siteHost
  } catch {
    return false
  }
}
