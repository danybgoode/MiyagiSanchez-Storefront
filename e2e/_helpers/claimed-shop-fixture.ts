import type { APIRequestContext } from '@playwright/test'

/**
 * e2e/_helpers/claimed-shop-fixture.ts
 *
 * Resolves a CLAIMED shop slug from the live public catalog instead of trusting
 * the hand-rotated `MS_TEST_CLAIMED_SLUG` Actions secret.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The nightly browser smoke was red EVERY day from at least 2026-10-15 to
 * 2026-11-03 on one spec (`seller-unclaimed-s3` → "the claim-page primary CTA…").
 * Nothing was wrong with the CTA: the secret pointed at `miyagiprints`, a shop
 * that no longer exists, so `/s/miyagiprints/claim` rendered the 404 page and the
 * locator timed out. Same failure class as gallery-fixture.ts (2026-08-15): a
 * fixture pinned in a secret is a claim about production data nobody re-checks.
 * `collection-isolation.spec.ts` used the same dead slug and stayed GREEN —
 * its assertions expect 404, so a missing shop satisfied them vacuously.
 *
 * ── How "claimed" is decided ────────────────────────────────────────────────
 * The claim page renders the "Ir a mi panel de ventas" link (href="/shop/manage")
 * ONLY in its `shop.clerk_user_id` branch — an unclaimed shop renders the claim
 * form instead, and a missing shop renders the 404 page. So the rendered page is
 * the authoritative probe: it is exactly the state the spec then asserts on.
 *
 * ── The pin is CHECKED, never trusted ───────────────────────────────────────
 * The secret stays an optional override, but it is probed like any candidate;
 * a pin that no longer qualifies falls through to discovery and is NAMED in the
 * reason if discovery also comes up empty.
 *
 * ── Three states, never two ─────────────────────────────────────────────────
 * A slug; or `null` because the catalog has no claimed shop (a DATA gap); or
 * `null` because the catalog could not be read (an OUTAGE). Never collapsed.
 */

export interface ClaimedShopFixture {
  slug: string | null
  reason?: string
  source: 'env' | 'catalog' | 'unavailable'
}

export interface CatalogShopItem {
  shop?: { slug?: string | null } | null
}

/** The marker only the claimed branch of the claim page renders. */
const CLAIMED_MARKER = 'href="/shop/manage"'

/** Probing is one page fetch per shop; cap it so a large unclaimed catalog stays cheap. */
const MAX_PROBES = 12

/**
 * The pure half: which shop slugs to probe, in what order. Unique, and sorted so
 * two runs a day apart probe (and therefore pick) the same shop — a flake in one
 * run must be reproducible in the next.
 */
export function candidateShopSlugs(items: readonly CatalogShopItem[]): string[] {
  const slugs = new Set<string>()
  for (const item of items) {
    const slug = item.shop?.slug
    if (typeof slug === 'string' && /^[a-z0-9-]+$/.test(slug)) slugs.add(slug)
  }
  return [...slugs].sort()
}

/** Pure: does this claim-page HTML belong to a claimed shop? */
export function isClaimedClaimPage(status: number, html: string): boolean {
  return status === 200 && html.includes(CLAIMED_MARKER)
}

async function probeClaimed(request: APIRequestContext, slug: string): Promise<boolean> {
  try {
    const res = await request.get(`/s/${encodeURIComponent(slug)}/claim`)
    return isClaimedClaimPage(res.status(), await res.text())
  } catch {
    return false
  }
}

export async function resolveClaimedShop(
  request: APIRequestContext,
  envOverride?: string,
): Promise<ClaimedShopFixture> {
  if (envOverride && (await probeClaimed(request, envOverride))) {
    return { slug: envOverride, source: 'env' }
  }

  let response
  try {
    response = await request.get('/api/ucp/catalog?limit=50&page=1')
  } catch (error) {
    return {
      slug: null,
      source: 'unavailable',
      reason: `catalog request failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (!response.ok()) {
    return {
      slug: null,
      source: 'unavailable',
      reason: `catalog returned HTTP ${response.status()} — could not look for a claimed shop`,
    }
  }
  const body = (await response.json()) as { items?: CatalogShopItem[] }
  const candidates = candidateShopSlugs(body.items ?? []).slice(0, MAX_PROBES)

  for (const slug of candidates) {
    if (await probeClaimed(request, slug)) return { slug, source: 'catalog' }
  }

  return {
    slug: null,
    source: 'unavailable',
    reason:
      `no claimed shop among the first ${candidates.length} catalog shops` +
      (envOverride ? `, and the pinned MS_TEST_CLAIMED_SLUG "${envOverride}" is no longer a claimed shop` : '') +
      '. That is a gap in the test DATA, not a passing test.',
  }
}
