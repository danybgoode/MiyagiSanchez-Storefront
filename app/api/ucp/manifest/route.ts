/**
 * GET /api/ucp/manifest
 *
 * Machine-readable capability manifest. AI agents and integrators fetch this
 * to understand what the API can do before making catalog or checkout calls.
 *
 * Also serves as the well-known discovery document (link from robots.txt / .well-known).
 */

import { NextRequest, NextResponse } from 'next/server'
import { UCP_CAPABILITIES, MCP_TOOL_NAMES } from '@/lib/ucp/capabilities'
import { aboutManifestBlock } from '@/lib/about-agent'
import { getOverriddenAboutSections } from '@/lib/about-content-overrides'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, s-maxage=3600',
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS })
}

export async function GET(req: NextRequest) {
  const host = req.headers.get('host') ?? 'miyagisanchez.com'
  const proto = host.includes('localhost') ? 'http' : 'https'
  const base = `${proto}://${host}`
  const aboutSections = await getOverriddenAboutSections()

  return NextResponse.json(
    {
      name: 'miyagisanchez-ucp',
      description: 'Miyagi Sánchez — Universal Commerce Protocol API for active Mexico and United States country marketplaces plus independent owned-shop channels.',
      version: '1.0',
      base_url: base,
      default_market: 'mx',
      commerce_readiness: {
        listing_field: 'commerce_readiness',
        direct_checkout: {
          mx: { available: true },
          us: { available: false, reason: 'checkout_not_available', planned_sprint: 4 },
        },
        instruction: 'Treat commerce_readiness as authoritative. Never present buy_now or checkout URLs when ready is false.',
      },

      // Canonical capability slugs — single source of truth in lib/ucp/capabilities.ts.
      capabilities: UCP_CAPABILITIES,

      // Supply-side "about / why-sell" answer for prospective sellers, beside the
      // buyer endpoints. Rendered from the single content source (lib/about-content.ts
      // → lib/about-agent.ts); carries the relay-language directive so the reading
      // agent presents it in the user's own language. See the agent-readable about
      // surface epic (07).
      about: aboutManifestBlock(base, aboutSections),

      endpoints: {
        catalog: {
          method: 'GET',
          url: `${base}/api/ucp/catalog`,
          description: 'Search and filter active listings in one country market. Pass `market=mx` or `market=us`; omitted market retains the documented legacy mx default.',
          auth: 'none',
          params: {
            market:        'mx | us (legacy default: mx)',
            q:            'Full-text search query',
            category:     'autos | inmuebles | electronica | hogar | moda | deportes | servicios | mascotas | herramientas | negocios | otros',
            listing_type: 'product | service | rental | digital',
            state:        'State name in the selected market (e.g. "Jalisco" or "New York")',
            location:     'City or neighborhood (partial match)',
            condition:    'new | like_new | good | fair | parts',
            min_price:    'Minimum amount in the selected market currency (MXN or USD)',
            max_price:    'Maximum amount in the selected market currency (MXN or USD)',
            limit:        '1–50 (default 20)',
            cursor:       'Pagination cursor (created_at of last item from previous response)',
            sort:         'reciente | precio_asc | precio_desc | popular | year_desc | year_asc | marca',
            brand:        'Car marca — alias/casing-aware, e.g. "Volkswagen" also matches "VW" (use with category=autos)',
            model:        'Car modelo (partial match, use with category=autos)',
            year_from:    'Car year minimum (use with category=autos)',
            year_to:      'Car year maximum (use with category=autos)',
            km_from:      'Odometer km minimum (use with category=autos)',
            km_to:        'Odometer km maximum (use with category=autos)',
            transmission: 'automatico | manual | cvt (use with category=autos)',
            fuel:         'gasolina | diesel | hibrido | electrico | gas_lp (use with category=autos)',
          },
        },

        listing_detail: {
          method: 'GET',
          url: `${base}/api/ucp/catalog/{id}`,
          description: 'Get full UCP detail for a single listing including all trust signals, payment methods, and checkout URLs.',
          auth: 'none',
          params: {
            market: 'mx | us (legacy default: mx)',
          },
        },

        neighborhood_pulse: {
          method: 'GET',
          url: `${base}/api/ucp/neighborhood-pulse`,
          description: 'Read-only neighborhood pulse: opted-in community items, trending listings, and merchants gaining local attention.',
          auth: 'none',
          params: {
            community_limit: '1–24 community items (default 12)',
            trending_limit: '1–20 trending listings (default 8)',
            shop_limit: '1–12 merchant spotlights (default 6)',
          },
        },

        checkout_mercadopago: {
          method: 'POST',
          url: `${base}/api/mp/checkout`,
          description: 'Create a MercadoPago Checkout Pro session. Redirects buyer to hosted MP page (cards, OXXO, wallet, meses sin intereses). Returns checkoutUrl.',
          auth: 'none',
          body: { listingId: 'string', buyerEmail: 'string (optional)', offerId: 'string (optional — use accepted offer price)' },
        },

        checkout_stripe: {
          method: 'POST',
          url: `${base}/api/stripe/checkout`,
          description: 'Create a Stripe Checkout session for card payments. Returns checkoutUrl.',
          auth: 'none',
          body: { listingId: 'string' },
        },

        support_widget: {
          method: 'GET+POST',
          url: `${base}/api/embed/support`,
          checkout_url: `${base}/api/embed/support/checkout`,
          description: 'Discover a seller support widget by publishable embed key and initiate a guest support contribution with hosted Stripe or Mercado Pago checkout.',
          auth: 'none',
          body: {
            embed_key: 'emb_pk_...',
            amount_cents: 'number — support amount in centavos',
            supporter_email: 'string — required for receipt',
            supporter_name: 'string (optional)',
            message: 'string (optional, max 250 chars)',
            visibility: 'public | private',
            provider: 'stripe | mercadopago',
          },
        },

        make_offer: {
          method: 'POST',
          url: `${base}/api/offers`,
          description: 'Submit a price offer on a listing. Requires an authenticated Miyagi buyer session. Seller will be notified and has 48 hours to accept, counter, or decline.',
          auth: 'clerk_session_or_authorization_header',
          body: {
            listing_id:        'string',
            offer_amount_cents: 'number — offer in centavos (e.g. 150000 = $1,500 MXN)',
            buyer_name:        'string',
            buyer_email:       'string',
            message:           'string (optional)',
          },
        },

        mcp: {
          method: 'GET+POST',
          url: `${base}/api/ucp/mcp`,
          description: 'Model Context Protocol server (HTTP / JSON-RPC 2.0). Connect from Claude Desktop, Gemini, or any MCP-compatible client for native shopping tools plus seller-side configuration tools.',
          auth: 'none',
          mcp_tools: MCP_TOOL_NAMES,
        },

        seller_configuration: {
          method: 'POST',
          url: `${base}/api/ucp/mcp`,
          description: "A seller's own agent can read and adjust its shop configuration via the MCP tools get_store_configuration and patch_store_configuration. Reads the declarative blocks (profile/brand, presentation, shipping, negotiation, notifications, orders, returns, scheduling) and patches them with strict validation; never exposes secrets. The presentation block covers the shop's section order; how the shop LOOKS is profile.theme_preset — one curated look from a closed list (Clásico, Papel, Pizarra, Lienzo, Terracota, Retro Social), the same field and the same list the seller's own picker uses. There is no field that can carry CSS, HTML, JavaScript or a font URL. Payments, custom domain, and Cal.com are OAuth-bound and stay manual. The shop's Wall — its homepage narrative of posts, products, collections and events — is managed with list/create/update/delete_wall_entry, which share the human API's validator, and its published entries appear in the public get_shop representation.",
          auth: 'authorization_bearer_shop_token',
          note: "Per-shop token (Authorization: Bearer ms_agent_…) generated in the shop's “Agentes e integraciones” settings; scoped to one shop.",
          mcp_tools: ['get_store_configuration', 'patch_store_configuration'],
        },

        seller_payment_links: {
          method: 'POST',
          url: `${base}/api/ucp/mcp`,
          description: "A seller's own agent can charge anyone with a payment link — for products from its catalog or for any amount ($10 to $50,000 MXN) — and list or cancel those links, via the MCP tools create_payment_link, list_payment_links and cancel_payment_link. Mexico shops only. Each link comes back with its full URL and a short mschz.org URL.",
          auth: 'authorization_bearer_shop_token',
          note: "Per-shop token (Authorization: Bearer ms_agent_…) generated in the shop's “Agentes e integraciones” settings; scoped to one shop.",
          mcp_tools: ['create_payment_link', 'list_payment_links', 'cancel_payment_link'],
        },

        seller_orders: {
          method: 'POST',
          url: `${base}/api/ucp/mcp`,
          description: "A seller's own agent can list its own orders across every sales channel — native Miyagi sales and Mercado Libre sales materialized into Medusa (ml-orders-native) — via the MCP tool list_orders. Returns each order's status, buyer, amount, source (miyagi|mercadolibre), tags, and shipment/tracking; filterable by status and source.",
          auth: 'authorization_bearer_shop_token',
          note: "Per-shop token (Authorization: Bearer ms_agent_…) generated in the shop's “Agentes e integraciones” settings; scoped to one shop.",
          mcp_tools: ['list_orders'],
        },

        seller_domain_subscription: {
          method: 'POST',
          url: `${base}/api/ucp/mcp`,
          description: "A seller's own agent can check its custom-domain entitlement and start checkout for the domain SKU (the platform's paid SKU, $499 MXN/yr) via the MCP tools get_domain_entitlement and start_domain_subscription. The SKU has two cadences: `recurring` (annual subscription, default) or `one_time` (pay one year up front with no recurring mandate — a dated 12-month grant that lapses gracefully with no auto-charge). On the recurring cadence pass an optional coupon (e.g. miyagisan) to comp the first year, capped at 100 redemptions. Returns a Stripe checkout URL; entitlement flips on once checkout completes. The free shop URL (/s/slug) stays free; the white-label subdomain is a separate, cheaper SKU (see seller_subdomain_subscription).",
          auth: 'authorization_bearer_shop_token',
          note: "Per-shop token (Authorization: Bearer ms_agent_…) generated in the shop's “Agentes e integraciones” settings; scoped to one shop.",
          mcp_tools: ['get_domain_entitlement', 'start_domain_subscription'],
        },

        seller_subdomain_subscription: {
          method: 'POST',
          url: `${base}/api/ucp/mcp`,
          description: "A seller's own agent can check its subdomain entitlement and start checkout for the subdomain SKU (the platform's cheaper paid SKU, $199 MXN/yr ~ $17/mo, or $25 MXN/mo) via the MCP tools get_subdomain_entitlement and start_subdomain_subscription. This SKU serves the shop white-label at <slug>.miyagisanchez.com as a standalone site (no platform chrome). Two cadences: `recurring` (a subscription, default) or `one_time` (pay one year up front with no recurring mandate — a dated 12-month grant that lapses gracefully with no auto-charge). On the recurring cadence pick the billing interval: `year` ($199/yr, the discount) or `month` ($25/mo); switch between them anytime with switch_subdomain_cadence (Stripe proration, no double charge, no gap). No campaign coupon (that's the custom-domain SKU). Returns a Stripe checkout URL; entitlement flips on once checkout completes. The free shop URL (/s/slug) always stays free.",
          auth: 'authorization_bearer_shop_token',
          note: "Per-shop token (Authorization: Bearer ms_agent_…) generated in the shop's “Agentes e integraciones” settings; scoped to one shop.",
          mcp_tools: ['get_subdomain_entitlement', 'start_subdomain_subscription', 'switch_subdomain_cadence'],
        },

        seller_launchpad: {
          method: 'POST',
          url: `${base}/api/ucp/mcp`,
          description: "A seller's own agent can run the full bookshop launchpad loop — review writer manuscript submissions (list_manuscript_submissions, review_submission), mint an approved one as a draft digital product (publish_submission), and manage voting campaigns (list_launchpad_campaigns, create_campaign, update_campaign, activate_campaign, cancel_campaign). Behind the launchpad.enabled flag; a campaign's reward product must be owned by the shop and CPP-configured (multiple size/binding options or quantity tiers) to activate.",
          auth: 'authorization_bearer_shop_token',
          note: "Per-shop token (Authorization: Bearer ms_agent_…) generated in the shop's “Agentes e integraciones” settings; scoped to one shop.",
          mcp_tools: ['list_manuscript_submissions', 'review_submission', 'publish_submission', 'list_launchpad_campaigns', 'create_campaign', 'update_campaign', 'activate_campaign', 'cancel_campaign'],
        },

        cost_comparator: {
          method: 'POST',
          url: `${base}/api/ucp/mcp`,
          description: "Compare a merchant's current platform cost (Shopify, Mercado Libre, WooCommerce, or Tiendanube) against the equivalent Miyagi Sánchez (0% commission) cost, given their own sales volume and average order value, via the MCP tool compare_costs. Computed by the exact same pure model as the public /comparador page — never drifts from what that page shows. Every competitor figure is sourced and dated; the response carries the dataset's verified_at date plus each figure's source. Read-only, no auth.",
          auth: 'none',
          docs_url: `${base}/agent`,
          human_url: `${base}/comparador`,
          mcp_tools: ['compare_costs'],
        },

        seller_onboarding: {
          method: 'GET',
          url: `${base}/api/ucp/setup-spec`,
          description: "Onboarding 0 — a prospective seller's own agent reads one published, versioned setup spec + prompt and emits a SINGLE combined setup file (shop profile + store config + catalog) BEFORE the seller signs up. The spec composes the catalog-import and store-config schemas into one shape: { miyagi_setup_version, profile, config, catalog }. The emit prompt is es-MX and instructs the agent to produce all user-facing copy in the seller's own language. Apply path today: the seller signs up and uploads the file via the existing import flow (catalog + settings). Payments, custom domain, and Cal.com stay manual.",
          auth: 'none',
          spec_url: `${base}/api/ucp/setup-spec`,
          docs_url: `${base}/agent`,
          mcp_tools: ['get_setup_spec'],
          note: 'Spec only — the guided first-run apply is coming soon; today, apply by signing up and using the import pages.',
        },
      },

      trust_model: {
        escrow: 'Payment held in Stripe until buyer confirms delivery. Configurable per shop (off / optional / required).',
        verified_sellers: 'Shops with clerk_user_id that have completed identity verification.',
        repuve: 'Mexican vehicle history check. Listings with metadata.repuve contain cryptographic proof of REPUVE lookup.',
        offers: 'All offers are time-bounded (48h seller response, 48h buyer payment window). Auto-expired and cancelled via Resend scheduled emails.',
      },

      schema_org_context: 'https://schema.org',
      openapi_hint: `${base}/api/ucp/manifest`,
    },
    { headers: CORS }
  )
}
