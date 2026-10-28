/**
 * lib/shop-url-analyzer.ts
 *
 * Comparador de costos (epic 08 · cost-comparator-homepage, Sprint 3 · US-3.1) —
 * the PURE half of the shop-URL analyzer: platform detection + a rough section/
 * catalog inventory from already-fetched HTML, and the attach point for the
 * migrations epic's shared parity-score module. Kept next-free/network-free
 * (mirrors lib/migration-parity.ts and lib/ssrf-guard.ts — same reason: the
 * Playwright `api` runner unit-tests it directly with fixture HTML, no live
 * fetch, no flakiness, no cost). The actual SSRF-hardened server fetch lives in
 * lib/shop-url-analyzer-fetch.ts (`server-only`), which calls into this module
 * once it has HTML in hand.
 *
 * DETECTION IS A HEURISTIC, NOT A CRAWL — same honesty discipline as
 * migration-parity.ts's PARITY_SECTIONS: this reads ONE fetched page (the
 * pasted URL, typically the homepage) and pattern-matches well-known platform
 * fingerprints (CDN hostnames, generator meta tags, common asset paths) plus a
 * rough count of product-shaped JSON-LD / catalog links, nav anchors, and
 * <img> tags. It can under- or over-count on a JS-heavy SPA storefront that
 * renders its catalog client-side — that's why the analyzer degrades to
 * manual entry on low-confidence/no-match, never fabricates a platform.
 *
 * NO FORK OF THE PARITY MODULE — `buildParityReport`/`PARITY_SECTIONS` come
 * from lib/migration-parity.ts as-is. IMPORTANT — every `PARITY_SECTIONS` note
 * is written comparing Miyagi against Shopify SPECIFICALLY (two of the five
 * notes name Shopify by name — see that file's header). Rendering it for a
 * detected WooCommerce/Tiendanube shop would misattribute those notes to the
 * wrong competitor, so `parity` below is only populated when `platform ===
 * 'shopify'` — every other detected platform still gets its section/catalog
 * estimate, just no migration-effort table (honest > complete).
 */

import type { CompetitorPlatform } from './cost-comparator-url'
import { buildParityReport, type ParityReport } from './migration-parity'

// T1 is pickable but not detectable: no verified T1 storefront marker (pricing-page D14).
export type DetectedPlatform = Exclude<CompetitorPlatform, 't1'> | null

export interface ShopInventoryEstimate {
  /** Rough count of distinct catalog/product signals found on the page (JSON-LD
   *  `Product` entries, else distinct `/products/` `/productos/` links). */
  catalogCount: number
  /** Rough count of nav-level links — a proxy for "how many sections" the
   *  storefront exposes (collections, static pages, etc). */
  sectionCount: number
  imageCount: number
  hasPolicies: boolean
}

export interface ShopAnalyzerResult {
  platform: DetectedPlatform
  inventory: ShopInventoryEstimate
  /** True when the fetch layer stopped reading the response early (byte cap) —
   *  inventory counts below are a partial-page estimate when this is true. */
  truncated: boolean
  /** Rendered from lib/migration-parity.ts's shared scorer — see file header
   *  for why this is `null` on every non-Shopify detection. */
  parity: ParityReport | null
}

const PRODUCT_JSONLD_RE = /"@type"\s*:\s*"product"/gi
const PRODUCT_LINK_RE = /href="([^"?#]*\/(?:productos?|products)\/[^"?#]+)"/gi
const IMG_TAG_RE = /<img\b/gi
const NAV_BLOCK_RE = /<nav\b[\s\S]*?<\/nav>/i
const NAV_ANCHOR_RE = /<a\b/gi
const POLICY_LINK_RE = /pol[ií]ticas?|privacidad|t[eé]rminos|privacy[\s-]?policy|terms[\s-]?(of|&)[\s-]?service/i

/**
 * Platform fingerprints — checked in a fixed priority order (Shopify →
 * Tiendanube → WooCommerce → Mercado Libre) so a page that happens to mention
 * more than one platform name (a migration blog post, a "we moved from X"
 * banner) resolves to the FIRST/strongest signal rather than whichever regex
 * happens to match last. Returns `null` (never a guess) when nothing matches
 * — the UI's manual platform picker is always the fallback.
 */
export function detectPlatformFromSignals(html: string, hostname: string): DetectedPlatform {
  const host = hostname.toLowerCase()
  const lower = html.toLowerCase()

  const isShopify =
    host.endsWith('.myshopify.com') ||
    lower.includes('cdn.shopify.com') ||
    lower.includes('shopify.theme') ||
    lower.includes('window.shopify') ||
    lower.includes('content="shopify"')
  if (isShopify) return 'shopify'

  const isTiendanube =
    host.endsWith('.mitiendanube.com') ||
    host.includes('tiendanube.com') ||
    lower.includes('tiendanube') ||
    lower.includes('nuvemshop')
  if (isTiendanube) return 'tiendanube'

  const isWooCommerce =
    lower.includes('woocommerce') ||
    lower.includes('wp-content/plugins/woocommerce')
  if (isWooCommerce) return 'woocommerce'

  const isMercadoLibre = host.includes('mercadolibre.') || host.includes('mercadolivre.')
  if (isMercadoLibre) return 'mercadolibre'

  return null
}

/**
 * A deliberately rough, single-page estimate — see file header. Never throws
 * on malformed/empty HTML (empty regex matches just yield zeros).
 */
export function estimateInventoryFromHtml(html: string): ShopInventoryEstimate {
  const jsonLdCount = html.match(PRODUCT_JSONLD_RE)?.length ?? 0
  const linkMatches = new Set(Array.from(html.matchAll(PRODUCT_LINK_RE), (m) => m[1])).size
  // Whichever signal found more — a theme might emit JSON-LD but not plain
  // catalog links, or vice versa; never let a weaker signal undercut a stronger one.
  const catalogCount = Math.max(jsonLdCount, linkMatches)

  const navBlock = html.match(NAV_BLOCK_RE)?.[0] ?? ''
  const sectionCount = navBlock.match(NAV_ANCHOR_RE)?.length ?? 0

  const imageCount = html.match(IMG_TAG_RE)?.length ?? 0
  const hasPolicies = POLICY_LINK_RE.test(html)

  return { catalogCount, sectionCount, imageCount, hasPolicies }
}

/**
 * Combines detection + inventory + (Shopify-only) the shared parity report
 * into one result. `url` is only used for its hostname (platform signal) —
 * this function does no fetching itself, see lib/shop-url-analyzer-fetch.ts.
 */
export function buildAnalyzerResult(input: { url: string; html: string; truncated: boolean }): ShopAnalyzerResult {
  let hostname = ''
  try {
    hostname = new URL(input.url).hostname
  } catch {
    hostname = ''
  }

  const platform = detectPlatformFromSignals(input.html, hostname)
  const inventory = estimateInventoryFromHtml(input.html)
  const parity =
    platform === 'shopify'
      ? buildParityReport({
          listingCount: inventory.catalogCount,
          imageCount: inventory.imageCount,
          hasPolicies: inventory.hasPolicies,
          truncated: input.truncated,
        })
      : null

  return { platform, inventory, truncated: input.truncated, parity }
}
