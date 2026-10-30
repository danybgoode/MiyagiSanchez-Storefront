/**
 * lib/analytics-gating.ts
 *
 * Pure, client-side eligibility gate for the site-wide GTM container
 * (site-wide-analytics-gtm epic, S1.1). Decides WHERE analytics loads from the
 * browser's own `window.location` (hostname + path) — no `headers()`, no network —
 * so the `<SiteAnalytics>` loader can run inside the STATIC root layout without
 * tainting the `(site)` subtree dynamic (marketplace-static-shell constraint).
 *
 * Mirrors the server channel semantics in `app/(shell)/layout.tsx` / `lib/channel.ts`,
 * but derived from hostname/path instead of the middleware-set `x-miyagi-*` headers
 * (which a client can't read). Reuses the pure `shopSlugFromHost` so the subdomain
 * rule can't drift from the real subdomain channel.
 *
 * Load on every platform surface (public marketplace, checkout, account,
 * `/shop/manage` seller dashboard). Skip on the white-label channels — seller
 * custom domains, `<slug>.miyagisanchez.com` subdomains — and the embed widget.
 */

import { shopSlugFromHost } from '@/lib/subdomain'

/** Hosts that ARE the platform itself (apex, www, local dev). Vercel previews are
 *  handled separately so a preview can exercise the loader. */
const PLATFORM_HOSTS = new Set<string>([
  'miyagisanchez.com',
  'www.miyagisanchez.com',
  'localhost',
  '127.0.0.1',
])

export function shouldLoadAnalytics({
  hostname,
  pathname,
}: {
  hostname: string | null | undefined
  pathname: string | null | undefined
}): boolean {
  if (!hostname) return false
  const host = hostname.split(':')[0].trim().toLowerCase()
  const path = pathname ?? ''

  // Embed widget (`/embed/*`) is white-label by PATH — never load, even on the
  // platform host. Middleware tags it `x-miyagi-embed`; client-side we read the path.
  if (path === '/embed' || path.startsWith('/embed/')) return false

  // A payment link's pay page: the URL carries a bearer token and the page shows a CLABE. Neither
  // may reach GA4 or Clarity (in-person-sales S4.2).
  if (path === '/pagar' || path.startsWith('/pagar/')) return false

  // A `<slug>.miyagisanchez.com` shop subdomain is white-label — skip. (Returns null
  // for the apex, www, reserved/infra labels, previews, custom domains.)
  if (shopSlugFromHost(host)) return false

  // The platform itself + Vercel previews → load.
  if (PLATFORM_HOSTS.has(host)) return true
  if (host.endsWith('.vercel.app')) return true

  // Anything else is a seller custom domain (own channel) → white-label → skip.
  return false
}
