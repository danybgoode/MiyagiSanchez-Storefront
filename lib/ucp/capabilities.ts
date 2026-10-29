/**
 * Canonical catalog of the public agent-facing surface — the SINGLE source of
 * truth for which UCP endpoints and MCP tools exist.
 *
 * Why this module exists: endpoint/tool metadata used to be hand-copied into
 * three places (the `/agent` briefing page, the UCP manifest route, and the MCP
 * server's discovery) and drifted out of sync — the `/agent` page advertised
 * endpoints that 404. Everything that *documents* the API now imports from here,
 * so the docs cannot diverge from reality again.
 *
 * Paths are relative (start with `/api/...`); consumers prefix the request base.
 * The actual MCP tool *definitions* (input schemas, handlers) still live in
 * `app/api/ucp/mcp/route.ts` — this module only names them for discovery docs.
 */

export interface UcpEndpoint {
  id: string
  method: 'GET' | 'POST' | 'GET+POST'
  /** Relative path, e.g. `/api/ucp/catalog`. Prefix with the request base URL. */
  path: string
  description: string
  auth: 'none' | 'clerk_session_or_authorization_header'
}

/** Public REST endpoints an agent can call directly. Must match real routes. */
export const UCP_ENDPOINTS: UcpEndpoint[] = [
  {
    id: 'catalog_search',
    method: 'GET',
    path: '/api/ucp/catalog',
    description: 'Search and filter active listings (full-text es-MX, category, price, location, condition, automotive/real-estate filters). Cursor-paginated.',
    auth: 'none',
  },
  {
    id: 'listing_detail',
    method: 'GET',
    path: '/api/ucp/catalog/{id}',
    description: 'Full UCP detail for one listing: trust signals, seller, images, payment methods, checkout URLs.',
    auth: 'none',
  },
  {
    id: 'neighborhood_pulse',
    method: 'GET',
    path: '/api/ucp/neighborhood-pulse',
    description: 'Read-only neighborhood pulse: opted-in community items, trending listings, and merchants gaining local attention.',
    auth: 'none',
  },
  {
    id: 'checkout_session',
    method: 'POST',
    path: '/api/ucp/checkout-session',
    description: 'Get ALL payment options for a listing in one call (instant: MercadoPago, Stripe — with ready URLs; contact-first: SPEI/CLABE, cash, WhatsApp).',
    auth: 'none',
  },
  {
    id: 'checkout_mercadopago',
    method: 'POST',
    path: '/api/mp/checkout',
    description: 'Create a MercadoPago Checkout Pro session (cards, OXXO, wallet, meses sin intereses). Returns checkoutUrl.',
    auth: 'none',
  },
  {
    id: 'checkout_stripe',
    method: 'POST',
    path: '/api/stripe/checkout',
    description: 'Create a Stripe Checkout session for card payments. Returns checkoutUrl.',
    auth: 'none',
  },
  {
    id: 'support_widget',
    method: 'GET+POST',
    path: '/api/embed/support',
    description: 'Discover a seller support widget by embed key and initiate a guest contribution checkout through the same hosted Stripe/MercadoPago handoff used by the widget.',
    auth: 'none',
  },
  {
    id: 'make_offer',
    method: 'POST',
    path: '/api/offers',
    description: 'Submit a price offer on a listing. Seller has 48h to accept, counter, or decline. Requires an authenticated Miyagi buyer session.',
    auth: 'clerk_session_or_authorization_header',
  },
  {
    id: 'buyer_trust',
    method: 'GET',
    path: '/api/ucp/identity/{identifier}',
    description: 'OmniReputation trust score for a buyer by email or Clerk user ID. Returns score, level, and signals (no PII beyond the identifier).',
    auth: 'none',
  },
  {
    id: 'manifest',
    method: 'GET',
    path: '/api/ucp/manifest',
    description: 'Machine-readable capability manifest. Fetch first to discover everything this API can do.',
    auth: 'none',
  },
  {
    id: 'mcp',
    method: 'GET+POST',
    path: '/api/ucp/mcp',
    description: 'Model Context Protocol server (HTTP / JSON-RPC 2.0). Connect from Claude Desktop, Gemini, or any MCP client for native shopping + seller-config tools.',
    auth: 'none',
  },
]

/** MCP buyer/shopping tools (no auth). */
export const MCP_BUYER_TOOLS = [
  'search_listings',
  'get_neighborhood_pulse',
  'get_listing',
  'get_checkout_options',
  'create_checkout',
  'make_offer',
  'get_shop',
  'check_availability',
  'book_appointment',
  'get_buyer_trust',
  'get_support_options',
  'create_support_checkout',
  'about_miyagi',
  'get_setup_spec',
  'compare_costs',   // cost-comparator-homepage S2 · US-2.3 — same pure lib as /comparador, no auth, no flag
] as const

/**
 * MCP seller tools (Sprint 4). Require a per-shop bearer token
 * (`Authorization: Bearer ms_agent_…`) provisioned in the shop's
 * "Agentes e integraciones" settings; scoped to a single shop.
 */
export const MCP_SELLER_TOOLS = [
  'get_store_configuration',
  'patch_store_configuration',
  'list_offers',
  'respond_to_offer',
  'create_listing',
  'list_my_listings',
  'get_share_kit',             // share-kit S3.3 — catalog link, PDF link, Meta feed URL (token-scoped)
  'list_wall_entries',         // living-shop S6.3 — the storefront Wall (token-scoped)
  'create_wall_entry',         // living-shop S6.3 (token-scoped)
  'update_wall_entry',         // living-shop S6.3 (token-scoped)
  'delete_wall_entry',         // living-shop S6.3 (token-scoped)
  'list_my_collections',       // own-shop-premium-presentation S2 (token-scoped)
  'create_collection',         // panfleto-premium-shop S2 (token-scoped)
  'update_collection',         // mcp-parity-config S1.1 — rename a collection (token-scoped)
  'delete_collection',         // mcp-parity-config S1.1 — delete a collection, listings untouched (token-scoped)
  'reorder_collections',       // mcp-parity-config S1.2 — full-list nav reorder (token-scoped)
  'set_listing_repuve',        // mcp-parity-config S1.3 — REPUVE verification data on a listing (token-scoped)
  'set_shop_slug',             // mcp-parity-config S2.1 — change /s/[slug], old slug 301s 90 days (token-scoped)
  'set_notification_preferences', // mcp-parity-config S2.2 — granular event-group × channel grid (token-scoped)
  'create_content',            // mcp-parity-config S2.3 — subscriber/launchpad content post (token-scoped)
  'update_content',            // mcp-parity-config S2.3 (token-scoped)
  'delete_content',            // mcp-parity-config S2.3 (token-scoped)
  'link_telegram',             // mcp-parity-config S2.4 — mint the t.me deep link; seller completes it (token-scoped)
  'unlink_telegram',           // mcp-parity-config S2.4 — audience-safe disconnect (token-scoped)
  'test_telegram',             // mcp-parity-config S2.4 — delivery test to the linked chat (token-scoped)
  'update_listing',
  'set_listing_status',
  'configure_listing_options',  // mcp-parity-core S2 — priced option dimensions + quantity tiers (token-scoped, flag mcp.configure_options.enabled)
  'delete_listing',             // mcp-parity-core S3.1 — soft-delete an owned listing (token-scoped, flag mcp.delete_listing.enabled)
  'apply_price',                // mcp-parity-core S3.2 — one-click price apply, Profit Analyzer pipeline (token-scoped, flag mcp.apply_price.enabled)
  'stage_bulk_action',          // catalog-management S? — bulk price/category/collection preview (token-scoped)
  'apply_bulk_action',          // catalog-management S? — confirm a staged bulk batch (token-scoped)
  'start_shopify_migration',    // platform-migrations — stage a Shopify catalog batch (token-scoped)
  'list_orders',                // ml-orders-native S3 · US-9 (token-scoped)
  'list_manuscript_submissions', // bookshop-launchpad S1.2 — writer submissions read (token-scoped)
  'review_submission',          // mcp-parity-core S1.2 — move a submission through curation (token-scoped)
  'publish_submission',         // mcp-parity-core S1.2 — mint an approved submission as a digital product (token-scoped)
  'list_launchpad_campaigns',   // bookshop-launchpad S3.1 — voting campaigns read (token-scoped)
  'create_campaign',            // mcp-parity-core S1.1 — draft a voting campaign (token-scoped)
  'update_campaign',            // mcp-parity-core S1.1 — edit a draft campaign (token-scoped)
  'activate_campaign',          // mcp-parity-core S1.1 — take a draft campaign live (token-scoped)
  'cancel_campaign',            // mcp-parity-core S1.1 — cancel a draft/active campaign (token-scoped)
  'get_domain_entitlement',     // custom-domain paywall S3 (token-scoped)
  'start_domain_subscription',  // custom-domain paywall S3 (token-scoped)
  'get_subdomain_entitlement',     // subdomain-pricing S2 (token-scoped)
  'start_subdomain_subscription',  // subdomain-pricing S2 (token-scoped)
  'switch_subdomain_cadence',      // subdomain-pricing S3 — monthly↔yearly switch (token-scoped)
  'send_feedback',                 // miyagi-partners-mcp S3 — structured product feedback; callable by
                                    // seller AND partner credentials, incl. a viewer-role partner (token-scoped)
] as const

/** Every MCP tool name, in discovery order. */
export const MCP_TOOL_NAMES: string[] = [...MCP_BUYER_TOOLS, ...MCP_SELLER_TOOLS]

/** High-level capability slugs advertised in the manifest. */
export const UCP_CAPABILITIES = [
  'catalog_search',
  'listing_detail',
  'neighborhood_pulse',
  'make_offer',
  'buy_now_mercadopago',
  'buy_now_stripe',
  'escrow',
  'scheduling',          // check_availability + book_appointment
  'buyer_trust',         // OmniReputation
  'support_widget',      // Buy Me a Coffee-style guest support contributions
  'mcp_server',
  'seller_configuration', // get/patch_store_configuration (token-scoped, Sprint 4)
  'seller_orders',        // list_orders — ml-orders-native S3 · US-9 (token-scoped)
  'seller_onboarding',    // Onboarding 0 — published setup spec + emit prompt (get_setup_spec)
  'seller_domain_subscription', // custom-domain SKU — entitlement + checkout over MCP, recurring + one-time cadence (token-scoped)
  'seller_launchpad',     // bookshop launchpad — manuscript review/publish + voting-campaign CRUD over MCP (mcp-parity-core S1, token-scoped)
  'cost_comparator',      // cost-comparator-homepage S2 · US-2.3 — compare_costs MCP tool, same pure lib as /comparador
] as const

/** Build absolute endpoint URLs for a given request base (e.g. https://miyagisanchez.com). */
export function ucpEndpointsWithBase(base: string): Array<UcpEndpoint & { url: string }> {
  return UCP_ENDPOINTS.map((e) => ({ ...e, url: `${base}${e.path}` }))
}
