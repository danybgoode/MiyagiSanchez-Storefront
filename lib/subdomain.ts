/**
 * lib/subdomain.ts
 *
 * Maps an incoming Host header to a shop slug for the multi-tenant subdomain
 * channel (`<slug>.miyagisanchez.com`). Pure + dependency-light so it's unit-
 * testable and cheap to call in middleware on every request.
 *
 * The subdomain label IS the shop slug. We only treat single-label subdomains of
 * the root as shops, and never the apex, `www`, Vercel previews, or any reserved/
 * infra label (so platform + auth subdomains like `clerk`/`accounts` are safe).
 */

import { RESERVED_SLUGS, validateSlug } from '@/lib/slug'
import { isLikelyListingId } from '@/lib/route-shape'

export const ROOT_DOMAIN = 'miyagisanchez.com'

/**
 * Infra/platform subdomains that must never resolve to a shop, on top of
 * RESERVED_SLUGS. Includes the live Clerk auth subdomains (`clerk`, `accounts`)
 * and the `api` host — these have their own DNS records and serve other systems.
 */
const INFRA_SUBDOMAINS = new Set<string>([
  'www', 'api', 'app', 'admin', 'clerk', 'accounts', 'mail', 'email', 'smtp',
  'ftp', 'cdn', 'assets', 'static', 'img', 'images', 'media', 'staging', 'stage',
  'dev', 'test', 'preview', 'vercel', 'status', 'docs', 'blog', 'go',
  // Cloudflare→ALB→Cloud Run staging hostname (09-platform-infra
  // frontend-vercel-to-cloudrun, S2.2) — a platform-served proving host, not a
  // tenant shop slug. Found live: shopSlugFromHost() runs BEFORE
  // middleware.ts's isPlatformHost() check, so an unreserved single-label
  // subdomain of the root is treated as a shop slug lookup regardless of
  // isPlatformHost's own allowlist — this is the only place that actually gates it.
  'gcp',
])

/** True when this label is reserved (RESERVED_SLUGS ∪ INFRA) — not a shop. */
export function isReservedSubdomain(label: string): boolean {
  return INFRA_SUBDOMAINS.has(label) || RESERVED_SLUGS.has(label)
}

/**
 * Returns the shop slug for a `<slug>.miyagisanchez.com` host, or null when the
 * host is the apex, `www`, a Vercel preview, a multi-label host, or a reserved/
 * malformed label. Strips any `:port`.
 */
export function shopSlugFromHost(host: string | null | undefined): string | null {
  if (!host) return null
  const h = host.split(':')[0].trim().toLowerCase()
  const suffix = '.' + ROOT_DOMAIN
  if (!h.endsWith(suffix)) return null            // apex, *.vercel.app, localhost, custom domains
  const label = h.slice(0, h.length - suffix.length)
  if (!label || label.includes('.')) return null  // empty or multi-label (e.g. a.b.miyagi…)
  if (isReservedSubdomain(label)) return null      // www / clerk / accounts / api / …
  if (!validateSlug(label).valid) return null      // must be a well-formed slug
  return label
}

/**
 * An absolute `https://<host><pathname>` redirect target on OUR public hosts.
 *
 * Built fresh — never by setting `.host` on a clone of `req.nextUrl`. The WHATWG
 * URL `host` setter KEEPS the existing port when the new value has none, and in
 * production `req.nextUrl` carries the container's internal port, so the clone
 * produced `https://miyagisanchez.com:8080/mx/s/<slug>` — an SSL error for every
 * buyer opening an unentitled shop subdomain (reported live 2026-11-11,
 * `miel-verduras`). A fresh URL has no port to inherit.
 */
export function publicHostRedirectUrl(host: string, pathname: string): URL {
  // A protocol-relative `//elsewhere` path would resolve to ANOTHER host — an open
  // redirect. Today's callers pass constants or shape-checked segments; this keeps
  // the helper safe for the next one.
  if (!pathname.startsWith('/') || pathname.startsWith('//')) {
    throw new Error(`publicHostRedirectUrl: not a same-host path: ${pathname}`)
  }
  return new URL(pathname, `https://${host}`)
}

/**
 * Where an UNENTITLED subdomain request lands on the apex. A product link
 * (`/l/<id>`) keeps pointing at that product — the shop-scoped PDP, which serves
 * owned-shop-only products too — instead of dropping the buyer on the shop home.
 * Everything else goes to the shop home, as before.
 */
export function unentitledSubdomainPath(slug: string, pathname: string): string {
  const product = /^\/l\/([^/]+)\/?$/.exec(pathname)
  if (product && isLikelyListingId(product[1])) return `/mx/s/${slug}/l/${product[1]}`
  return `/mx/s/${slug}`
}
