/**
 * Pure partner-role tool classification — no next/*, no server-only, no DB —
 * so the Playwright runner (and any unit test) can import it directly (per
 * LEARNINGS: keep the pure predicate in its own zero-import file; the
 * server-only resolver lib/partner-auth.ts imports *it*).
 *
 * Seller tools that only READ — a `viewer` grant may call these; everything
 * else on the seller surface is treated as a write (safe default: an
 * unclassified new tool denies viewers until someone adds it here).
 */
export const PARTNER_READ_TOOLS = new Set<string>([
  'get_store_configuration',
  'list_offers',
  'list_my_listings',
  'get_share_kit', // share-kit S3.3 — public links + feed counts, no mutation; viewer-safe
  'list_my_collections',
  'list_orders',
  'list_payment_links', // in-person-sales S4.4 — read-only; create/cancel stay writes
  'list_manuscript_submissions',
  'list_launchpad_campaigns',
  'get_domain_entitlement',
  'get_subdomain_entitlement',
  'send_feedback', // miyagi-partners-mcp S3 — product feedback, not a shop mutation; viewer-safe
])
