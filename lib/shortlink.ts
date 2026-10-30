/**
 * lib/shortlink.ts
 *
 * Pure helpers for the ultra-short branded link domain (mschz.org/[x]). The host
 * 301-redirects a single path segment to the canonical storefront URL — shop slug
 * (or a retired-slug alias) → /s/[slug]; product short-slug/short-code → /l/[id];
 * unknown → branded 404. The actual DB lookups happen in middleware (which can't
 * use unstable_cache); these are the pure, unit-testable bits.
 *
 * We deliberately target the platform canonical paths (`/s/[slug]`, `/l/[id]`) and
 * let those pages do any further custom-domain consolidation — so the short-link
 * layer needs no custom_domain lookup of its own.
 */

import { listingUrlFor, marketBasePath, marketplaceUrl, shopUrlFor } from './market-url'
import { DEFAULT_MARKET } from './markets'

export const PLATFORM_ORIGIN = 'https://miyagisanchez.com'

/** Hosts that act as the short-link redirector. */
export const SHORTLINK_HOSTS = ['mschz.org', 'www.mschz.org']

/** True when this Host is the short-link domain (port-tolerant). */
export function isShortLinkHost(host: string | null | undefined): boolean {
  if (!host) return false
  return SHORTLINK_HOSTS.includes(host.split(':')[0].trim().toLowerCase())
}

/**
 * The first path segment, lowercased + URL-decoded (case-insensitive links).
 * Returns null for an empty path ("/", "") so the caller can send those home.
 */
export function firstSegment(pathname: string): string | null {
  const seg = (pathname || '').split('/').filter(Boolean)[0]
  if (!seg) return null
  try { return decodeURIComponent(seg).trim().toLowerCase() } catch { return seg.trim().toLowerCase() }
}

/** Canonical platform target for a shop slug. */
export function shopTarget(slug: string): string {
  return shopUrlFor(PLATFORM_ORIGIN, slug)
}

/** Canonical platform target for a listing (Medusa product id). */
export function listingTarget(productId: string): string {
  return listingUrlFor(PLATFORM_ORIGIN, productId)
}

/** Where an empty path and an unknown segment go. */
export const HOME_TARGET = marketplaceUrl(PLATFORM_ORIGIN, '/')
export const NOT_FOUND_TARGET = `${PLATFORM_ORIGIN}/404`

/**
 * mschz-full-coverage · Sprint 1 — known-prefix passthrough (Daniel, 2026-07-09).
 * Public, shareable route families that get a 301 to the IDENTICAL path+query on
 * the platform origin instead of a flat single-segment lookup: sweepstakes (/g),
 * events (/e), launchpad voting (/v), shops incl. subpages (/s), listings (/l).
 * Deliberately excludes session-bound/private surfaces (checkout, account,
 * /shop/manage, /admin, API routes) — nothing shareable lives there.
 */
export const PASSTHROUGH_PREFIXES = new Set(['g', 'e', 'v', 's', 'l', 'pagar'])

/** The short domain merchants should share (mschz.org/<prefix>/…). */
export const SHORTLINK_ORIGIN = `https://${SHORTLINK_HOSTS[0]}`


/**
 * Pure matcher for the known-prefix passthrough. Only fires for MULTI-segment
 * paths (single-segment stays on the flat resolver, unchanged) whose first
 * segment (case-insensitive) is in PASSTHROUGH_PREFIXES — returns the identical
 * path + query on the platform origin, verbatim (only the prefix match is
 * lowercased; the rest of the path/query is untouched). Returns null when the
 * path is single-segment (defer to the flat resolver) OR multi-segment but not
 * allowlisted (caller sends it to NOT_FOUND_TARGET).
 */
export function passthroughTarget(pathname: string, search: string): string | null {
  const segments = (pathname || '').split('/').filter(Boolean)
  if (segments.length < 2) return null
  const prefix = segments[0].toLowerCase()
  if (!PASSTHROUGH_PREFIXES.has(prefix)) return null
  // The short domain matches the prefix case-insensitively but preserves the
  // remainder verbatim. `marketplaceUrl` classifies route families
  // case-sensitively, so use its registry-backed base-path seam here after the
  // allowlist has already established that this is an s/l marketplace route.
  const target = prefix === 's' || prefix === 'l'
    ? `${PLATFORM_ORIGIN}${marketBasePath(DEFAULT_MARKET)}${pathname}`
    : `${PLATFORM_ORIGIN}${pathname}`
  return `${target}${search || ''}`
}

// Lowercase base36 (no uppercase, so links stay case-insensitive-safe and tidy).
const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * A random short code for a listing (default 6 chars of lowercase base36 ≈ 2B
 * combinations). Uniqueness is enforced by the caller (retry on collision).
 */
export function generateShortCode(length = 6): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return out
}
