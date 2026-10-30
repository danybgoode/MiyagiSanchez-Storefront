/**
 * Miyagi Sánchez UCP MCP Server (Stateless HTTP / JSON-RPC 2.0)
 *
 * MCP over HTTP is plain JSON-RPC 2.0. This handler avoids the Node.js HTTP
 * transport layer and works natively with Next.js App Router.
 *
 * To connect from Claude Desktop, add to claude_desktop_config.json:
 * {
 *   "mcpServers": {
 *     "miyagisanchez": {
 *       "type": "http",
 *       "url": "https://miyagisanchez.com/api/ucp/mcp"
 *     }
 *   }
 * }
 *
 * Tools:
 *   search_listings       Browse catalog with filters
 *   get_listing           Full detail for one listing
 *   get_checkout_options  All payment methods for a listing with pre-generated URLs
 *   create_checkout       Generate a single payment URL (MP or Stripe)
 *   make_offer            Submit price offer → returns offer_id
 *   get_shop              Seller profile + their listings
 */

import { filterLinksByState, formatLinkForAgent, mapCancelLinkArgs, mapCreateLinkArgs, type AgentLinkView } from '@/lib/in-person/payment-link-mcp'
import { internalLinkCall } from '@/lib/in-person/payment-link-backend'
import { NextRequest, NextResponse } from 'next/server'
import { toUcpListing } from '@/lib/ucp/schema'
import { getPriceGrid } from '@/lib/listings'
import { resolveTierForQuantity, formatPriceGridAmount, formatOptionsLines, type PriceGrid } from '@/lib/price-grid'
import { ingestArtworkBytes } from '@/lib/artwork-ingest'
import { getCustomFields, MAX_ARTWORK_SIZE_MB, type PersonalizationPayload } from '@/lib/personalization'
import { startCheckout, type CheckoutProvider, type StartCheckoutParams } from '@/lib/cart'
import { isShopClaimed } from '@/lib/claim'
import { shopMustStayPrivate, getPreviewByShop } from '@/lib/preview-access'
import { invalidateIfMaterialChange } from '@/lib/preview-consent'
import { emitPreviewEvent } from '@/lib/preview-lifecycle'
import { computeTrustScore } from '@/lib/ucp/identity'
import { getCalAvailableSlots, createCalBooking } from '@/lib/calcom'
import { ensureUrlProtocol } from '@/lib/url'
import { checkRateLimit, getClientIp, peekRateLimit } from '@/lib/ratelimit'
import { revalidateTag } from 'next/cache'
import type { AgentShop } from '@/lib/agent-auth'
import {
  partnerRecruitingPreflight,
  rememberPartnerRecruitingPreflight,
  resolveToolShop,
  type RoutePartnerPreflight,
} from '@/lib/partner-auth'
import { MCP_SELLER_TOOLS } from '@/lib/ucp/capabilities'
import { isEnabled } from '@/lib/flags'
import {
  agentListWall, agentCreateWallEntry, agentUpdateWallEntry, agentDeleteWallEntry,
  type WallToolOutcome,
} from '@/lib/wall/agent'
import { recordAgentWallChange } from '@/lib/agent-audit'
import { readPublicWall } from '@/lib/wall/public'
import { resolvePublicWallShop } from '@/lib/wall/store'
import { normalizeSections, navEntries } from '@/lib/shop-presentation/sections'
import { resolveSectionAvailability } from '@/lib/shop-presentation/availability'

/** Bounded agent Wall view — enough to understand the shop, never its whole history. */
const AGENT_WALL_LIMIT = 6
import { listSubmissionsForShop, getLaunchpadShopBySlug, transitionSubmission, publishSubmission } from '@/lib/launchpad'
import { REVIEWABLE_TARGET_STATUSES, type SubmissionStatus } from '@/lib/launchpad-types'
import {
  listCampaignsForShop, createCampaign, updateCampaign, activateCampaign, cancelCampaign,
  type SellerContext,
} from '@/lib/launchpad-campaigns'
import { thresholdReached } from '@/lib/launchpad-campaign-types'
import { campaignErrorMessage } from '@/app/api/sell/launchpad/campaigns/route'
import type { MedusaSellerForMirror } from '@/lib/provisioning'
import { resolveDomainEntitlement } from '@/lib/domain-entitlement-server'
import { startCustomDomainCheckout } from '@/lib/domain-subscription-checkout'
import { stageShopifyBatch } from '@/lib/shopify-import-bridge'
import { isPublicDomainShape } from '@/lib/ssrf-guard'
import { downloadArtworkBytes } from '@/lib/artwork-url-fetch'
import { CUSTOM_DOMAIN_PRICE_LABEL } from '@/lib/domain-pricing'
import { asDomainCadence } from '@/lib/domain-cadence'
import { CAMPAIGN_COUPON_CODE } from '@/lib/domain-coupon'
import { resolveSubdomainEntitlement } from '@/lib/subdomain-entitlement-server'
import { startSubdomainCheckout } from '@/lib/subdomain-subscription-checkout'
import { switchSubdomainCadence } from '@/lib/subdomain-switch'
import { coerceSubdomainInterval } from '@/lib/subdomain-billing'
import { SUBDOMAIN_PRICE_LABEL, SUBDOMAIN_PRICE_MONTHLY_LABEL } from '@/lib/subdomain-pricing'
import { buildStoreConfigSnapshot } from '@/lib/store-config'
import { stageBulkActionAsAgent, applyBulkBatchAsAgent, getBulkBatch, type BulkActionPayload, type BulkFilterParams } from '@/lib/catalog-bulk'
import { applyStoreConfig } from '@/lib/apply-config-manifest'
import { recordAgentConfigChange, recordAgentOfferAction, recordAgentListingAction, recordAgentListingCreate } from '@/lib/agent-audit'
import { listShopOffers, respondToOffer } from '@/lib/offer-respond'
import { listShopOrdersViaInternal } from '@/lib/agent-orders'
import { listShopListings, shopOwnsProduct, patchSellerProductViaInternal, createSellerProductViaInternal, createSellerCollectionViaInternal, listingActivationBlock, deleteSellerProductViaInternal, applySellerPriceViaInternal, renameSellerCollectionViaInternal, deleteSellerCollectionViaInternal, reorderSellerCollectionsViaInternal, patchSellerSlugViaInternal, type SellerProductPatch } from '@/lib/seller-products'
import { validateSlug, buildSlugAliasHistory } from '@/lib/slug'
import { SLUG_REDIRECT_TAG } from '@/lib/slug-redirect'
import { resolvePrefs, audienceTelegramInUse, EVENT_GROUPS, CHANNELS, type PrefRow } from '@/lib/notifications/preferences'
import { genLinkToken, LINK_TOKEN_TTL_MS } from '@/lib/notifications/telegram-link'
import { getBotUsername, tgSend, tg } from '@/lib/telegram'
import { validateFeedbackInput } from '@/lib/feedback'
import { getShop, getShopCollections } from '@/lib/listings'
import { readPublicSellerMarket } from '@/lib/owned-market'
import { agentMarketplacePublicationBlock } from '@/lib/market-publication'
import { shortCollectionSlug, validateCollectionName, validateListingTitle } from '@/lib/collection-derive'
import { validateRows, CATALOG_CATEGORY_KEYS, IMPORT_LISTING_TYPES, IMPORT_CONDITIONS, IMPORT_CURRENCIES, type CatalogImportRow } from '@/lib/catalog-import'
import { ingestImageUrls } from '@/lib/image-ingest'
import { syncSupabaseListingMirror } from '@/lib/provisioning'
import { db } from '@/lib/supabase'
import { closeMlProduct } from '@/lib/ml-publish-bridge'
import { MANUAL_SECTIONS, type StoreConfigManifest } from '@/lib/settings-import'
import { getNeighborhoodPulseAgentView } from '@/lib/neighborhood-pulse-agent'
import { aboutMcpResource, RELAY_LANGUAGE_DIRECTIVE } from '@/lib/about-agent'
import { getOverriddenAboutSections } from '@/lib/about-content-overrides'
import { buildSetupSpec } from '@/lib/setup-spec'
import { publicCatalogModel } from '@/lib/share-kit/catalog-server'
import { buildMetaFeed, metaFeedExcludedCount } from '@/lib/share-kit/meta-feed'
import type { Listing } from '@/lib/types'
import {
  computeShopifyCost, computeMercadoLibreCost, computeWooCommerceCost, computeTiendanubeCost, computeMiyagiCost,
  computeSelectedAppsMonthlyMxn, formatMxn,
  type ShopifyTier, type MlBand, type MlPublicationType, type WooCommerceHostingTier, type TiendanubeTier,
} from '@/lib/cost-comparator'
import { getComparatorDataset } from '@/lib/cost-comparator-data'
import {
  shopifyRatesFromDataset, mercadoLibreRatesFromDataset, wooCommerceRatesFromDataset, tiendanubeRatesFromDataset,
  miyagiRatesFromDataset, premiumAppsFromDataset, fxUsdToMxnFromDataset, lineSourceFigureKey,
  type ComparatorPlatform as CostComparatorPlatform, type LineSourceContext, type ComparatorDataset,
} from '@/lib/cost-comparator-dataset'
// Baseline dataset import ONLY to derive the compare_costs tool schema's `apps`
// enum at module init (second-opinion review, PR 278 — "don't hardcode the apps
// enum, derive it from premiumAppsFromDataset"). Runtime computation still reads
// the LIVE dataset via getComparatorDataset() inside the handler; this baseline
// read is schema-time only, so an admin content-override can never add a NEW app
// id anyway (applyDatasetOverrides only replaces existing figures' VALUES, never
// adds new ones — see that file's header), making the baseline's id set always
// correct for the schema too.
import costComparatorBaselineDataset from '@/lib/cost-comparator-dataset.json' with { type: 'json' }
import { isMarketUnavailable, planMarketCatalogRead, verifyMarketFilter } from '@/lib/market-catalog'
import { MARKETS, type MarketCode } from '@/lib/markets'
import { PROCESS_MARKET_ENV, resolvePublishableKeyForMarket } from '@/lib/market-medusa'
import { normalizeShippingDestination, resolveUcpFulfillmentSelection } from '@/lib/ucp/fulfillment'
import { fetchBackendCheckoutOptions, fetchBackendShippingRates } from '@/lib/ucp/fulfillment-server'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const PUB_KEY = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''
const MEDUSA_HEADERS = { 'x-publishable-api-key': PUB_KEY }

function marketMedusaHeaders(market: MarketCode): Record<string, string> | null {
  const key = resolvePublishableKeyForMarket(market, PROCESS_MARKET_ENV)
  return key.status === 'resolved' ? { 'x-publishable-api-key': key.token } : null
}

function marketKeyUnavailable(market: (typeof MARKETS)[MarketCode]) {
  return {
    unavailable: true as const,
    market_code: market.code,
    marketplace_status: market.marketplace_status,
    reason: 'market_filter_unavailable' as const,
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, Mcp-Session-Id',
}

// ── JSON-RPC types ─────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function err(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

// compare_costs' `apps` enum, derived from the baseline dataset once at module
// init rather than hand-duplicated (second-opinion review, PR 278).
const COMPARE_COSTS_APP_IDS = premiumAppsFromDataset(costComparatorBaselineDataset as ComparatorDataset).map((a) => a.id)

const SHIPPING_DESTINATION_SCHEMA = {
  type: 'object',
  description: 'Dirección MX completa para cotizar envío. Usa los mismos campos que el checkout web; ext_number es obligatorio para la guía.',
  properties: {
    name: { type: 'string', description: 'Nombre de quien recibe' },
    phone: { type: 'string', description: 'Teléfono de contacto' },
    line1: { type: 'string', description: 'Calle, sin número exterior' },
    ext_number: { type: 'string', description: 'Número exterior' },
    int_number: { type: 'string', description: 'Número interior, opcional' },
    line2: { type: 'string', description: 'Colonia, opcional' },
    city: { type: 'string', description: 'Municipio o alcaldía' },
    state: { type: 'string', description: 'Estado mexicano' },
    state_code: { type: 'string', description: 'Código estatal de dos letras si se conoce' },
    postal_code: { type: 'string', description: 'Código postal' },
    country: { type: 'string', enum: ['MX'], default: 'MX' },
  },
} as const

const PICKUP_APPOINTMENT_SCHEMA = {
  type: 'object',
  description: 'Horario que propone el comprador para recoger; no es una confirmación del vendedor.',
  required: ['date', 'window'],
  properties: {
    date: { type: 'string', description: 'Fecha propuesta, YYYY-MM-DD' },
    window: { type: 'string', description: 'Ventana propuesta, por ejemplo 10:00–12:00' },
  },
} as const

// ── Tool definitions ───────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'search_listings',
    description: 'Search an active Miyagi Sánchez country-market catalog. Pass `market=mx` or `market=us`; omitted market retains the legacy mx default. Returns listings with market_code, localized prices, trust signals, commerce readiness, and canonical URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        market:       { type: 'string', enum: ['mx', 'us'], default: 'mx', description: 'Active country market code. Legacy default: mx.' },
        q:            { type: 'string', description: 'Search query in the selected market language' },
        category:     { type: 'string', enum: ['autos','inmuebles','electronica','hogar','moda','deportes','servicios','mascotas','herramientas','negocios','otros'], description: 'Product category' },
        listing_type: { type: 'string', enum: ['product','service','rental','digital'], description: 'Type of listing' },
        state:        { type: 'string', description: 'State in the selected market, e.g. "Jalisco" or "New York"' },
        location:     { type: 'string', description: 'City or neighborhood e.g. "Polanco", "Monterrey"' },
        condition:    { type: 'string', enum: ['new','like_new','good','fair','parts'], description: 'Item condition' },
        min_price:    { type: 'number', description: 'Minimum amount in the selected market currency (MXN or USD)' },
        max_price:    { type: 'number', description: 'Maximum amount in the selected market currency (MXN or USD)' },
        limit:        { type: 'number', minimum: 1, maximum: 20, default: 10, description: 'Number of results' },
        sort:         { type: 'string', enum: ['reciente','precio_asc','precio_desc','popular','year_desc','year_asc','marca'], default: 'reciente', description: 'Sort order (year_desc/year_asc/marca are autos-specific)' },
        brand:        { type: 'string', description: 'Car marca — alias/casing-aware, e.g. "Volkswagen" also matches "VW" (use with category=autos)' },
        model:        { type: 'string', description: 'Car modelo, partial match (use with category=autos)' },
        year_from:    { type: 'number', description: 'Car year minimum (use with category=autos)' },
        year_to:      { type: 'number', description: 'Car year maximum (use with category=autos)' },
        km_from:      { type: 'number', description: 'Odometer km minimum (use with category=autos)' },
        km_to:        { type: 'number', description: 'Odometer km maximum (use with category=autos)' },
        transmission: { type: 'string', enum: ['automatico','manual','cvt'], description: 'Transmission (use with category=autos)' },
        fuel:         { type: 'string', enum: ['gasolina','diesel','hibrido','electrico','gas_lp'], description: 'Fuel type (use with category=autos)' },
      },
    },
  },
  {
    name: 'get_neighborhood_pulse',
    description: 'Read one active country market’s public neighborhood pulse: opted-in community items, trending listings, and merchants gaining local attention. Omitted market retains the legacy mx default.',
    inputSchema: {
      type: 'object',
      properties: {
        market: { type: 'string', enum: ['mx', 'us'], default: 'mx', description: 'Active country market code. Legacy default: mx.' },
        community_limit: { type: 'number', minimum: 1, maximum: 24, default: 12, description: 'Number of community items to return' },
        trending_limit: { type: 'number', minimum: 1, maximum: 20, default: 8, description: 'Number of trending listings to return' },
        shop_limit: { type: 'number', minimum: 1, maximum: 12, default: 6, description: 'Number of merchant spotlights to return' },
      },
    },
  },
  {
    name: 'get_listing',
    description: 'Get full market-scoped details for a listing, including market_code, trust signals, seller info, payment methods, commerce readiness, and checkout URLs when ready.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Listing UUID from search_listings results' },
        market: { type: 'string', enum: ['mx', 'us'], default: 'mx', description: 'Country market code. Legacy default: mx.' },
      },
    },
  },
  {
    name: 'get_checkout_options',
    description: 'Get ALL payment and physical fulfillment choices for a listing in one call. For MX shipping, pass shipping_destination to receive current Envía/Correos option ids and centavo totals; without it the response names destination_required instead of pretending no rates exist. Pickup destinations are returned when configured. Bank coordinates are intentionally omitted here and remain private until after checkout starts. Always call this before create_checkout. For a RENTAL listing, pass check_in/check_out for the exact nights×rate+deposit quote.',
    inputSchema: {
      type: 'object',
      required: ['listing_id'],
      properties: {
        listing_id:  { type: 'string', description: 'Listing UUID' },
        market:      { type: 'string', enum: ['mx', 'us'], default: 'mx', description: 'Active country market code. US returns named checkout_not_available until its direct-charge rail ships.' },
        offer_id:    { type: 'string', description: 'Accepted offer UUID — session will use negotiated price' },
        buyer_email: { type: 'string', description: 'Buyer email (optional)' },
        shipping_destination: SHIPPING_DESTINATION_SCHEMA,
        check_in:    { type: 'string', description: 'Rental check-in date, YYYY-MM-DD. Only applies to rental listings — send with check_out for an exact bookable total.' },
        check_out:   { type: 'string', description: 'Rental check-out date, YYYY-MM-DD. Send with check_in.' },
      },
    },
  },
  {
    name: 'create_checkout',
    description: 'Generate a payment checkout URL for one instant method. For physical delivery, first call get_checkout_options, then pass its fulfillment method/destination/option ids. Shipping also requires the same shipping_destination; the server re-quotes and derives every money field from the fresh Medusa result. Pickup requires its returned destination when structured spots exist plus pickup_appointment. Calls without fulfillment ids preserve the legacy flat checkout. For configurator listings, pass variant_id + quantity/artwork_url as before. Rentals must use the dated checkout_url from get_checkout_options.',
    inputSchema: {
      type: 'object',
      required: ['listing_id'],
      properties: {
        listing_id:  { type: 'string', description: 'Listing UUID' },
        market:      { type: 'string', enum: ['mx', 'us'], default: 'mx', description: 'Active country market code. US returns named checkout_not_available until its direct-charge rail ships.' },
        method:      { type: 'string', enum: ['mercadopago','stripe'], default: 'mercadopago', description: 'Payment method' },
        buyer_email: { type: 'string', description: 'Buyer email (optional, pre-fills checkout form)' },
        offer_id:    { type: 'string', description: 'Accepted offer UUID — uses negotiated price instead of list price' },
        fulfillment_method_id: { type: 'string', enum: ['shipping', 'pickup'], description: 'Method id returned by get_checkout_options fulfillment.methods[].id' },
        fulfillment_destination_id: { type: 'string', description: 'Returned shipping/pickup destination id; required for structured pickup spots' },
        fulfillment_option_id: { type: 'string', description: 'Current shipping option id returned by get_checkout_options; required for shipping' },
        shipping_destination: SHIPPING_DESTINATION_SCHEMA,
        pickup_appointment: PICKUP_APPOINTMENT_SCHEMA,
        variant_id:  { type: 'string', description: 'Configurator variant id from get_listing.price_grid.variants[].id — required for a listing that has a price_grid' },
        quantity:    { type: 'number', description: 'Units to buy, resolves the quantity price tier from price_grid. Only used with variant_id. Defaults to 1.' },
        artwork_url: { type: 'string', description: 'Publicly reachable URL to the buyer\'s artwork file. The server downloads it, validates format/size against the listing\'s real requirement, and stores its own copy — only used with variant_id.' },
      },
    },
  },
  {
    name: 'get_support_options',
    description: 'Discover a seller support widget by publishable embed key. Returns public shop identity, preset support amounts, min/max custom amount, default visibility, and available hosted payment providers.',
    inputSchema: {
      type: 'object',
      required: ['embed_key'],
      properties: {
        embed_key: { type: 'string', description: 'Publishable support/embed key, shaped like emb_pk_...' },
      },
    },
  },
  {
    name: 'create_support_checkout',
    description: 'Initiate a guest support contribution checkout for a seller support widget. Uses the same validation and hosted Stripe/Mercado Pago handoff as <miyagi-support-widget>; no Miyagi account is required.',
    inputSchema: {
      type: 'object',
      required: ['embed_key', 'amount_cents', 'supporter_email'],
      properties: {
        embed_key: { type: 'string', description: 'Publishable support/embed key, shaped like emb_pk_...' },
        amount_cents: { type: 'number', description: 'Contribution amount in centavos (e.g. 10000 = $100 MXN)' },
        provider: { type: 'string', enum: ['mercadopago', 'stripe'], default: 'mercadopago' },
        supporter_email: { type: 'string', description: 'Email for receipt' },
        supporter_name: { type: 'string', description: 'Optional display name' },
        message: { type: 'string', description: 'Optional message, max 250 characters' },
        visibility: { type: 'string', enum: ['public', 'private'], default: 'public' },
      },
    },
  },
  {
    name: 'make_offer',
    description: "Submit a price offer on a listing in one active country market. Omitted market retains the legacy mx default. Requires an authenticated Miyagi buyer session. The seller is notified and has 48 hours to accept, counter, or decline. If accepted, read commerce_readiness before attempting checkout.",
    inputSchema: {
      type: 'object',
      required: ['listing_id', 'offer_amount', 'buyer_name', 'buyer_email'],
      properties: {
        market:        { type: 'string', enum: ['mx', 'us'], default: 'mx', description: 'Active country market code. Legacy default: mx.' },
        listing_id:    { type: 'string', description: 'Listing UUID' },
        offer_amount:  { type: 'number', description: 'Your offer in the selected market currency (MXN or USD), in major units.' },
        buyer_name:    { type: 'string', description: 'Your name' },
        buyer_email:   { type: 'string', description: 'Buyer email for account matching and receipts; do not expose it as seller contact info' },
        message:       { type: 'string', description: 'Optional message to the seller' },
      },
    },
  },
  {
    name: 'get_shop',
    description: "Get a seller's shop profile and listings in one active country market. Omitted market retains the legacy mx default.",
    inputSchema: {
      type: 'object',
      required: ['shop_slug'],
      properties: {
        market:    { type: 'string', enum: ['mx', 'us'], default: 'mx', description: 'Active country market code. Legacy default: mx.' },
        shop_slug: { type: 'string', description: 'Shop slug from listing.shop.slug in search results' },
        limit:     { type: 'number', minimum: 1, maximum: 20, default: 10, description: 'Number of listings to return' },
      },
    },
  },
  {
    name: 'check_availability',
    description: "Check available appointment slots for a listing in one country market. `market` temporarily defaults to `mx`. Returns the next available days and time slots from the seller's Cal.com calendar. Use before book_appointment to show the buyer what times are available.",
    inputSchema: {
      type: 'object',
      required: ['listing_id'],
      properties: {
        market:     { type: 'string', enum: ['mx', 'us'], default: 'mx', description: 'Country market code. Temporarily defaults to mx.' },
        listing_id: { type: 'string', description: 'Listing UUID' },
        date_from:  { type: 'string', description: 'Start date to check (YYYY-MM-DD). Defaults to today.' },
        date_to:    { type: 'string', description: 'End date to check (YYYY-MM-DD). Defaults to 7 days from today.' },
        timezone:   { type: 'string', description: 'IANA timezone. Defaults to the selected market timezone.' },
      },
    },
  },
  {
    name: 'book_appointment',
    description: 'Book an appointment slot for a listing in one country market — schedules a visit, test drive, or meeting with the seller. `market` temporarily defaults to `mx`. Returns booking confirmation with a unique ID.',
    inputSchema: {
      type: 'object',
      required: ['listing_id', 'start_time', 'buyer_name', 'buyer_email'],
      properties: {
        market:       { type: 'string', enum: ['mx', 'us'], default: 'mx', description: 'Country market code. Temporarily defaults to mx.' },
        listing_id:  { type: 'string', description: 'Listing UUID' },
        start_time:  { type: 'string', description: 'ISO 8601 datetime of the desired slot (from check_availability)' },
        buyer_name:  { type: 'string', description: 'Full name of the person booking' },
        buyer_email: { type: 'string', description: 'Email to send booking confirmation to' },
        notes:       { type: 'string', description: 'Optional notes for the seller (e.g., "Interested in test driving")' },
        timezone:    { type: 'string', description: 'IANA timezone. Defaults to the selected market timezone.' },
      },
    },
  },
  {
    name: 'get_buyer_trust',
    description: 'Check the OmniReputation trust score for a buyer by email address or Clerk user ID. Returns a 0–100 score, trust level (unverified/basic/trusted/verified/elite), and the individual signals that make up the score. Use before making a transaction recommendation to assess buyer trustworthiness.',
    inputSchema: {
      type: 'object',
      required: ['identifier'],
      properties: {
        identifier: { type: 'string', description: 'Email address (e.g. "juan@example.com") or Clerk user ID (e.g. "user_abc123")' },
      },
    },
  },
  {
    name: 'get_store_configuration',
    description: "SELLER TOOL. Read YOUR OWN shop's declarative configuration — profile/brand, shipping, negotiation, notifications, order handling, returns policy, scheduling links, and content pages (Acerca/FAQ). Requires a seller agent token (Authorization: Bearer ms_agent_…) generated in the shop's “Agentes e integraciones” settings; it is scoped to that one shop. Never returns secrets (no payment keys, bank CLABE, Stripe/MercadoPago tokens, or Cal.com keys). Call this before patch_store_configuration to see current values and which sections still need a manual step.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'patch_store_configuration',
    description: "SELLER TOOL. Update YOUR OWN shop's configuration. Requires the seller agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Send only the blocks you want to change inside `configuration` — untouched blocks are preserved (partial patch). Every value is strictly re-validated server-side before anything is written; invalid fields are dropped and reported, and a malformed block can never break the live storefront. Payments, custom domain, and Cal.com are OAuth-bound and are ignored here — they always need a manual step. Returns a per-block report of what was applied vs. skipped.",
    inputSchema: {
      type: 'object',
      required: ['configuration'],
      properties: {
        configuration: {
          type: 'object',
          description: 'Partial store config. Include only the blocks to change. Mirrors the shape returned by get_store_configuration.',
          properties: {
            profile:        { type: 'object', description: 'name, description, state, city, tagline, accent_color (#rrggbb), logo_url, banner_url (absolute http/https URLs — ingested to our storage), social {instagram,facebook,whatsapp,tiktok,twitter}. Also carries the own-shop premium presentation fields: theme_preset (a curated visual preset key, e.g. "papel"/"pizarra"/"lienzo"/"terracota", or null for the default look), announcement ({text, link?} or null to clear), hero ({mode:"listings"|"promo", pinned_listing_ids?, promo_image_url?, promo_cta_text?, promo_cta_link?} or null to clear).' },
            shipping:       { type: 'object', description: 'local_pickup, envia_enabled, correos_enabled (Correos de México Impresos manual-economy opt-in — only takes effect once the platform flag shipping.correos_enabled is on), allowed_carriers[], rate_display (recommended|cheapest|all), handling_fee_cents, package_defaults, origin_address, pickup_spots[]' },
            offers:         { type: 'object', description: 'min_buyer_trust_level, negotiation {enabled, auto_accept_pct, auto_decline_pct, auto_counter_pct} (percentages 0–100)' },
            notifications:  { type: 'object', description: 'email_new_view, email_new_message (booleans)' },
            orders:         { type: 'object', description: 'processing_time, auto_accept, dispatch_window_days, auto_confirm_days' },
            returns_policy: { type: 'object', description: 'window, conditions, shipping_paid_by (buyer|seller), custom_note' },
            scheduling:     { type: 'object', description: 'links: [{label, url}] — booking links (Cal.com connection is separate/manual)' },
            content:        { type: 'object', description: 'about {body}, faq {items: [{question, answer}]} — the shop\'s public Acerca/FAQ pages. Políticas has no field here; it mirrors returns_policy above.' },
            launchpad:      { type: 'object', description: 'Bookshop launchpad opt-in: accepts_manuscripts (boolean), guidelines (string, max 2000 chars, or null to clear) — the convocatoria rules shown on /s/[slug]/convocatoria.' },
            support:        { type: 'object', description: 'Support-widget (tips) config: enabled (boolean), preset_amount_cents (EXACTLY 3 integers), custom_min_cents (≥100), custom_max_cents (≤500000, min≤max, presets in range), currency (3-letter ISO code, e.g. MXN — the platform default), default_visibility (public|private). ⚠️ Enabling it PROVISIONS A REAL, purchasable support product in the shop catalog — the response names its product_id. support_product_id is server-assigned and ignored if sent.' },
            checkout:       { type: 'object', description: 'Checkout presentation: escrow_mode (off|optional|required), whatsapp_cta (boolean), show_phone (boolean), cash_pickup {enabled: boolean}. bank_transfer (CLABE) and contact_email are NEVER settable here — manual/server-derived only, ignored if sent.' },
          },
        },
      },
    },
  },
  {
    name: 'list_offers',
    description: "SELLER TOOL. List the open price offers on YOUR OWN shop's listings so you can decide how to respond. Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Returns each offer's amount, % of asking price, a quality read, the buyer name + message, status, time left, and listing — no secrets. Use before respond_to_offer.",
    inputSchema: {
      type: 'object',
      properties: {
        pending_only: { type: 'boolean', description: 'If true, return only offers awaiting your response (status "pending"). Default false (all non-terminal offers).' },
      },
    },
  },
  {
    name: 'respond_to_offer',
    description: "SELLER TOOL. Respond to a buyer's price offer on YOUR OWN listing: accept, counter, or decline. Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. ACCEPTING commits a sale at the offered price and sends the buyer a checkout link — same effect as accepting in the portal. A counter must be ABOVE the buyer's offer and BELOW the list price. Get offer_id from list_offers.",
    inputSchema: {
      type: 'object',
      required: ['offer_id', 'action'],
      properties: {
        offer_id:            { type: 'string', description: 'Offer UUID from list_offers' },
        action:              { type: 'string', enum: ['accept', 'counter', 'decline'], description: 'accept (commits a sale at the offer price), counter, or decline' },
        counter_amount_mxn:  { type: 'number', description: 'Required for action=counter. Counter price in MXN pesos (must be > the buyer offer and < the list price).' },
        counter_message:     { type: 'string', description: 'Optional message to the buyer with a counter.' },
      },
    },
  },
  {
    name: 'create_listing',
    description: "SELLER TOOL. Create a brand-new listing in YOUR OWN shop. Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Price is in MXN pesos (price_mxn, not centavos). Image URLs are fetched into our storage. A physical `product` whose shop hasn't configured both a delivery method AND a payment method is saved as a draft (paused) with an explanation — it won't go live until the shop is sale-ready. For category=autos, the vehicle-spec and financing/trust fields below feed the facet browse, $/mes display, and inspection/warranty PDP surfaces — omit any you don't have. Returns the new product_id (use it with update_listing / set_listing_status).",
    inputSchema: {
      type: 'object',
      required: ['title', 'category'],
      properties: {
        title:        { type: 'string', description: '5–100 characters.' },
        category:     { type: 'string', description: `One of: ${CATALOG_CATEGORY_KEYS.join(', ')}.` },
        description:  { type: 'string', description: 'Improves quality + SEO.' },
        price_mxn:    { type: 'number', description: 'Price in MXN pesos (1500 = $1,500). Omit for "a convenir".' },
        currency:     { type: 'string', enum: [...IMPORT_CURRENCIES], description: 'Default MXN.' },
        listing_type: { type: 'string', enum: [...IMPORT_LISTING_TYPES], description: 'Default product.' },
        condition:    { type: 'string', enum: [...IMPORT_CONDITIONS], description: 'Physical products only.' },
        quantity:     { type: 'number', description: 'Units available. Default 1 (physical products).' },
        state:        { type: 'string', description: 'Mexican state, e.g. "Jalisco".' },
        city:         { type: 'string', description: 'City / municipio / alcaldía.' },
        images:       { type: 'array', items: { type: 'string' }, description: 'Absolute image URLs (http/https). The first is the cover. Max 6.' },
        weight_grams: { type: 'number', description: 'Shipping weight in grams (improves shipping quotes).' },
        // Autos vehicle specs + financing/trust (cars-vertical-tratocar-parity S3) — only
        // used when category=autos; feeds the same metadata.attrs.* bag the seller capture
        // form and bulk import write (lib/listing-attributes.ts / lib/catalog-import.ts).
        make:                        { type: 'string', description: 'Autos only. Car brand, e.g. "Volkswagen".' },
        model:                       { type: 'string', description: 'Autos only. Car model, e.g. "Jetta".' },
        year:                        { type: 'number', description: 'Autos only. Model year.' },
        km:                          { type: 'number', description: 'Autos only. Odometer reading.' },
        fuel_type:                   { type: 'string', description: 'Autos only. e.g. gasolina, diesel, hibrido, electrico, gas_lp.' },
        transmission:                { type: 'string', description: 'Autos only. e.g. automatico, manual, cvt.' },
        color:                       { type: 'string', description: 'Autos only. Exterior color.' },
        financing_down_payment_pct:  { type: 'number', description: 'Autos only. Down payment as a % of price, for the $/mes display.' },
        financing_months:            { type: 'number', description: 'Autos only. Financing term in months, for the $/mes display.' },
        warranty_text:               { type: 'string', description: 'Autos only. Warranty description, e.g. "6 meses motor y transmisión".' },
        warranty_months:             { type: 'number', description: 'Autos only. Warranty length in months.' },
        inspection_report_url:       { type: 'string', description: 'Autos only. Absolute http(s) URL to the inspection report (PDF or page).' },
      },
    },
  },
  {
    name: 'list_my_listings',
    description: "SELLER TOOL. List YOUR OWN shop's listings (all statuses, incl. paused) so you can manage them. Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Returns each listing's product_id, title, price, status, and type. Use product_id with update_listing / set_listing_status.",
    inputSchema: { type: 'object', properties: {} },
  },
  // ── Share kit (share-kit S3.3, D19) ─────────────────────────────────────────
  {
    name: 'get_share_kit',
    description: "SELLER TOOL. Get YOUR OWN shop's share kit: the catalog page link (and its short form), the catalog PDF link, and the Meta product-feed URL for Instagram Shopping and WhatsApp Business catalogs, with how many products the feed leaves out and why. Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop — another shop's slug is never reachable. Mexico shops only. Hand the links to your human, or post them for them.",
    inputSchema: { type: 'object', properties: {} },
  },
  // ── Payment links (in-person-sales S4.4, D16) ───────────────────────────────
  {
    name: 'create_payment_link',
    description: "SELLER TOOL. Create a payment link on YOUR OWN shop that anyone can open to pay, for products or for any amount. Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop — another shop is never reachable. Mexico shops only. kind='products' needs `lines` ([{variant_id, quantity}], from YOUR OWN catalog; the price is the catalog price) and `uses` 'single' (default) or 'multi'. kind='amount' needs `concept` (3-80 letters) and `amount_mxn` in pesos ($10 to $50,000) and is single-use. `expires_in_days` is 1 to 30 (default 7). Returns the link with its full URL and its short mschz.org URL; hand it to your human or post it.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['products', 'amount'] },
        lines: { type: 'array', items: { type: 'object', properties: { variant_id: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 999 } }, required: ['variant_id', 'quantity'] } },
        uses: { type: 'string', enum: ['single', 'multi'] },
        concept: { type: 'string' },
        amount_mxn: { type: 'number', description: 'Pesos, not centavos.' },
        expires_in_days: { type: 'integer', minimum: 1, maximum: 30 },
      },
      required: ['kind'],
    },
  },
  {
    name: 'list_payment_links',
    description: "SELLER TOOL. List YOUR OWN shop's payment links with their state (pending, paid, expired, cancelled), URLs and how many orders paid each. Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Optionally filter by `state`.",
    inputSchema: { type: 'object', properties: { state: { type: 'string', enum: ['pending', 'paid', 'expired', 'cancelled'] } } },
  },
  {
    name: 'cancel_payment_link',
    description: "SELLER TOOL. Cancel one of YOUR OWN shop's payment links so it can no longer be paid. Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. A payment already made is not undone. Get link_id from list_payment_links.",
    inputSchema: { type: 'object', properties: { link_id: { type: 'string' } }, required: ['link_id'] },
  },
  // ── Living Shop — the Wall (epic 07, Story 6.3) ─────────────────────────────
  // Four tools, one validator: these share `lib/wall/validate.ts` with the human
  // HTTP route (epic D12), so an agent cannot reach a laxer rule than a person.
  {
    name: 'list_wall_entries',
    description: "SELLER TOOL. List YOUR OWN shop's Wall — the storefront homepage narrative — including drafts and scheduled entries. Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Each entry has a kind (post/product/collection/event), a status (draft/published/scheduled), and for the three referenced kinds a reference_id pointing at YOUR product, collection or event.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_wall_entry',
    description: "SELLER TOOL. Publish to YOUR OWN shop's Wall. A `post` carries text and up to 4 images already uploaded to Miyagi Sánchez (https URLs only — remote images are NOT fetched). A `product`, `collection` or `event` carries a reference_id that MUST belong to your shop, plus an optional seller note; price, availability and event details are resolved live and never copied. Scheduling requires an explicit timezone offset (e.g. 2026-09-01T18:00:00-06:00) — a bare local datetime is refused on purpose.",
    inputSchema: {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['post', 'product', 'collection', 'event'], description: 'What kind of entry this is.' },
        status: { type: 'string', enum: ['draft', 'published', 'scheduled'], description: 'Defaults to draft.' },
        body: { type: 'string', description: 'Text. Required for a post with no images; optional seller note otherwise. Max 2000 characters.' },
        media: { type: 'array', description: 'Post only. Up to 4 { url, alt } images already hosted by Miyagi Sánchez.', items: { type: 'object' } },
        reference_id: { type: 'string', description: 'Product id, collection handle, or event slug — must belong to YOUR shop.' },
        scheduled_for: { type: 'string', description: 'ISO 8601 WITH an explicit offset or Z. Required when status is scheduled.' },
        pinned: { type: 'boolean', description: 'Pin to the top. One pinned entry per shop; pinning a new one unpins the previous.' },
      },
    },
  },
  {
    name: 'update_wall_entry',
    description: "SELLER TOOL. Edit, publish, unpublish, reschedule or pin one of YOUR OWN Wall entries. `kind` is immutable — create a new entry instead. Omitted fields keep their current value, and the WHOLE resulting entry is validated, so a status change cannot leave a stranded schedule.",
    inputSchema: {
      type: 'object',
      required: ['entry_id'],
      properties: {
        entry_id: { type: 'string', description: 'The entry id from list_wall_entries.' },
        status: { type: 'string', enum: ['draft', 'published', 'scheduled'] },
        body: { type: 'string' },
        media: { type: 'array', items: { type: 'object' } },
        reference_id: { type: 'string' },
        scheduled_for: { type: 'string', description: 'ISO 8601 with an explicit offset or Z.' },
        pinned: { type: 'boolean' },
      },
    },
  },
  {
    name: 'delete_wall_entry',
    description: "SELLER TOOL. Permanently delete one of YOUR OWN Wall entries. The product, collection or event it referenced is untouched — the Wall only ever held a reference.",
    inputSchema: {
      type: 'object',
      required: ['entry_id'],
      properties: { entry_id: { type: 'string', description: 'The entry id from list_wall_entries.' } },
    },
  },
  {
    name: 'list_my_collections',
    description: "SELLER TOOL. List YOUR OWN shop's collections (Die-cut, Zines…) so you can assign listings to them. Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Returns each collection's name and short slug — pass the name(s) to update_listing's collection_names to assign a listing.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_collection',
    description: "SELLER TOOL. Create a new collection for YOUR OWN shop (e.g. \"Zines\", \"Stickers\"). Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Returns the created collection's name and short slug — pass it to list_my_collections or update_listing's collection_names to assign listings to it.",
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Collection name, 2–60 characters (e.g. "Historias").' },
      },
    },
  },
  {
    name: 'update_collection',
    description: "SELLER TOOL. Rename one of YOUR OWN shop's collections. Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. The collection's short slug and /c/… URL stay stable across a rename — only the display name changes. Use list_my_collections to find the collection_slug.",
    inputSchema: {
      type: 'object',
      required: ['collection_slug', 'name'],
      properties: {
        collection_slug: { type: 'string', description: 'The collection short slug (from list_my_collections).' },
        name: { type: 'string', description: 'New collection name, 2–60 characters.' },
      },
    },
  },
  {
    name: 'delete_collection',
    description: "SELLER TOOL. Delete one of YOUR OWN shop's collections. Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Member listings are NOT deleted — they only stop being grouped under this collection. Use list_my_collections to find the collection_slug.",
    inputSchema: {
      type: 'object',
      required: ['collection_slug'],
      properties: {
        collection_slug: { type: 'string', description: 'The collection short slug (from list_my_collections).' },
      },
    },
  },
  {
    name: 'reorder_collections',
    description: "SELLER TOOL. Set the display order of YOUR OWN shop's collections (the storefront nav strip). Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Pass the FULL list of your collection slugs in the desired order — a partial or duplicated list is rejected, nothing is applied.",
    inputSchema: {
      type: 'object',
      required: ['ordered_slugs'],
      properties: {
        ordered_slugs: { type: 'array', items: { type: 'string' }, description: 'Every collection short slug (from list_my_collections), each exactly once, in display order.' },
      },
    },
  },
  {
    name: 'set_listing_repuve',
    description: "SELLER TOOL. Set the REPUVE (Registro Público Vehicular) verification data on one of YOUR OWN vehicle listings. Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Records the check result shown on the listing's trust panel.",
    inputSchema: {
      type: 'object',
      required: ['product_id', 'status'],
      properties: {
        product_id: { type: 'string', description: 'The listing product_id (from list_my_listings).' },
        status: { type: 'string', enum: ['sin_reporte', 'con_reporte'], description: 'REPUVE check result: sin_reporte (clean) or con_reporte (has a report).' },
        folio: { type: 'string', description: 'Optional REPUVE folio/reference (uppercased).' },
        notes: { type: 'string', description: 'Optional free-form verification notes.' },
      },
    },
  },
  {
    name: 'set_shop_slug',
    description: "SELLER TOOL. Change YOUR OWN shop's public platform URL slug (miyagisanchez.com/mx/s/<slug>). Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. The old slug keeps 301-redirecting to the new one for 90 days. Format: 3–40 chars, lowercase letters/numbers/hyphens; reserved words rejected; taken slugs rejected.",
    inputSchema: {
      type: 'object',
      required: ['slug'],
      properties: {
        slug: { type: 'string', description: 'The new shop slug.' },
      },
    },
  },
  {
    name: 'set_notification_preferences',
    description: "SELLER TOOL. Toggle one cell of YOUR OWN shop's notification-preference grid (event group × channel). Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Channels: email, push, telegram (telegram requires a linked chat — see link_telegram). Event groups: orders, offers, payments, returns. Returns the full resolved grid.",
    inputSchema: {
      type: 'object',
      required: ['channel', 'event_group', 'enabled'],
      properties: {
        channel: { type: 'string', enum: ['email', 'push', 'telegram'] },
        event_group: { type: 'string', enum: ['orders', 'offers', 'payments', 'returns'] },
        enabled: { type: 'boolean' },
      },
    },
  },
  {
    name: 'create_content',
    description: "SELLER TOOL. Create a content post for YOUR OWN shop's subscriber/launchpad content area (beyond the about/faq blocks patch_store_configuration already covers). Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Optionally attach it to one of your listings.",
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'Post title, 2–200 characters.' },
        body: { type: 'string', description: 'Optional post body text.' },
        product_id: { type: 'string', description: 'Optional listing product_id (from list_my_listings) to attach the post to.' },
        file_url: { type: 'string', description: 'Optional file/media URL.' },
        file_type: { type: 'string', description: 'Optional file MIME type or kind.' },
        is_published: { type: 'boolean', description: 'Publish immediately (default true).' },
      },
    },
  },
  {
    name: 'update_content',
    description: "SELLER TOOL. Update one of YOUR OWN shop's content posts (title, body, file, publish state). Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop.",
    inputSchema: {
      type: 'object',
      required: ['content_id'],
      properties: {
        content_id: { type: 'string', description: 'The content post id (returned by create_content).' },
        title: { type: 'string', description: 'New title, 2–200 characters.' },
        body: { type: 'string' },
        file_url: { type: 'string' },
        file_type: { type: 'string' },
        is_published: { type: 'boolean' },
      },
    },
  },
  {
    name: 'delete_content',
    description: "SELLER TOOL. Delete one of YOUR OWN shop's content posts. Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop.",
    inputSchema: {
      type: 'object',
      required: ['content_id'],
      properties: {
        content_id: { type: 'string', description: 'The content post id.' },
      },
    },
  },
  {
    name: 'link_telegram',
    description: "SELLER TOOL. Start linking YOUR OWN shop's Telegram notifications. Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Returns a t.me deep link — the SELLER must open it and press Start in Telegram to complete the link (an agent cannot finish this step). Once linked, enable telegram cells via set_notification_preferences.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'unlink_telegram',
    description: "SELLER TOOL. Disconnect YOUR OWN shop's Telegram notifications (turns off all seller telegram preferences; keeps the person's buyer-side Telegram if they use it). Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'test_telegram',
    description: "SELLER TOOL. Send a test message to YOUR OWN shop's linked Telegram chat to confirm delivery. Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Fails with a clear message when no chat is linked.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_orders',
    description: "SELLER TOOL. List YOUR OWN shop's orders across every sales channel — native Miyagi sales and Mercado Libre sales materialized into Medusa (ml-orders-native) — with source/channel attribution and tags. Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Returns each order's id, status, buyer, amount, source (miyagi|mercadolibre), tags, and shipment/tracking.",
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by order status (e.g. "shipped", "delivered")' },
        source: { type: 'string', enum: ['miyagi', 'mercadolibre'], description: 'Filter by sales channel' },
        limit:  { type: 'number', minimum: 1, maximum: 50, description: 'Max orders to return (default 20)' },
      },
    },
  },
  {
    name: 'list_manuscript_submissions',
    description: "SELLER TOOL. List the writer manuscripts submitted to YOUR OWN bookshop's convocatoria (bookshop-launchpad). Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Read-only. Returns each submission's title, author, genre, curation status (submitted/in_review/approved/rejected/changes_requested), and format. Use review_submission to move it through curation and publish_submission to mint an approved one as a digital product.",
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['submitted', 'in_review', 'approved', 'rejected', 'changes_requested'], description: 'Filter by curation status' },
      },
    },
  },
  {
    name: 'review_submission',
    description: "SELLER TOOL. Move a manuscript submission through curation (bookshop-launchpad). Requires the shop agent token, scoped to one shop. Valid targets: in_review, approved, rejected, changes_requested. A `note` is REQUIRED when rejecting or requesting changes (emailed to the writer). Emails the writer on every transition. Get the submission id from list_manuscript_submissions.",
    inputSchema: {
      type: 'object',
      required: ['submission_id', 'status'],
      properties: {
        submission_id: { type: 'string', description: 'Submission id from list_manuscript_submissions' },
        status: { type: 'string', enum: ['in_review', 'approved', 'rejected', 'changes_requested'], description: 'The curation status to move it to' },
        note: { type: 'string', description: 'Message to the writer — required for rejected / changes_requested' },
      },
    },
  },
  {
    name: 'publish_submission',
    description: "SELLER TOOL. Mint an APPROVED manuscript submission as a draft digital product under your shop (bookshop-launchpad). Requires the shop agent token, scoped to one shop. Idempotent — calling it again on an already-published submission returns the existing product, never a duplicate. The product is created as DRAFT (no price/cover yet) — use update_listing + set_listing_status to finish and publish it.",
    inputSchema: {
      type: 'object',
      required: ['submission_id'],
      properties: {
        submission_id: { type: 'string', description: 'Submission id from list_manuscript_submissions (must be status=approved)' },
      },
    },
  },
  {
    name: 'list_launchpad_campaigns',
    description: "SELLER TOOL. List YOUR OWN bookshop's voting campaigns (bookshop-launchpad). Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Read-only. Returns each campaign's title, status (draft/active/closed_met/closed_unmet/cancelled), vote count vs threshold, reward discount %, candidate-work count, public /v/[slug] URL, and — when unlocked — the minted coupon code. Use create_campaign/update_campaign/activate_campaign/cancel_campaign to manage one.",
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['draft', 'active', 'closed_met', 'closed_unmet', 'cancelled'], description: 'Filter by campaign status' },
      },
    },
  },
  {
    name: 'create_campaign',
    description: "SELLER TOOL. Create a DRAFT voting campaign for YOUR OWN bookshop (bookshop-launchpad). Requires the shop agent token, scoped to one shop. `work_product_ids` and `reward_product_id` are optional at draft time (can be set later with update_campaign) but both must already be products owned by your shop when provided — the reward must also be a CPP-configured product (multiple size/binding options or quantity-price tiers, set from the portal's Opciones screen). `reward_percent` defaults to 50. Returns the new campaign id — use activate_campaign once it's complete.",
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'Campaign title' },
        description: { type: 'string', description: 'Campaign description shown on the public voting page' },
        terms: { type: 'string', description: 'Optional terms/rules text' },
        vote_threshold: { type: 'number', description: 'Votes needed to unlock the reward (must be > 0 to activate)' },
        ends_at: { type: 'string', description: 'ISO end date/time (must be in the future to activate)' },
        reward_percent: { type: 'number', minimum: 1, maximum: 100, description: 'Discount % the winning coupon grants (default 50)' },
        reward_product_id: { type: 'string', description: 'Product id of the print listing the vote unlocks a discount on — must be owned by your shop and CPP-configured' },
        work_product_ids: { type: 'array', items: { type: 'string' }, description: 'Product ids of the published works readers vote between — must be owned by your shop' },
      },
    },
  },
  {
    name: 'update_campaign',
    description: "SELLER TOOL. Edit a DRAFT voting campaign for YOUR OWN bookshop (bookshop-launchpad). Requires the shop agent token, scoped to one shop. Only draft campaigns are editable — once activated, terms are locked (an honest-campaign guarantee to voters). Passing `work_product_ids` fully replaces the candidate-work list. Get campaign_id from list_launchpad_campaigns.",
    inputSchema: {
      type: 'object',
      required: ['campaign_id'],
      properties: {
        campaign_id: { type: 'string', description: 'Campaign id from list_launchpad_campaigns' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        terms: { type: 'string', description: 'New terms/rules text' },
        vote_threshold: { type: 'number', description: 'New vote threshold' },
        ends_at: { type: 'string', description: 'New ISO end date/time' },
        reward_percent: { type: 'number', minimum: 1, maximum: 100, description: 'New discount %' },
        reward_product_id: { type: 'string', description: 'New reward product id — must be owned by your shop and CPP-configured' },
        work_product_ids: { type: 'array', items: { type: 'string' }, description: 'Full replacement set of candidate-work product ids — must be owned by your shop' },
      },
    },
  },
  {
    name: 'activate_campaign',
    description: "SELLER TOOL. Take a DRAFT campaign live at its public /v/[slug] voting page (bookshop-launchpad). Requires the shop agent token, scoped to one shop. Runs the full activation gate: title, description, a threshold > 0, a future end date, at least one candidate work, and an owned CPP-configured reward product. On failure returns exactly which fields are missing. Get campaign_id from list_launchpad_campaigns.",
    inputSchema: {
      type: 'object',
      required: ['campaign_id'],
      properties: {
        campaign_id: { type: 'string', description: 'Campaign id from list_launchpad_campaigns' },
      },
    },
  },
  {
    name: 'cancel_campaign',
    description: "SELLER TOOL. Cancel a draft or active voting campaign for YOUR OWN bookshop (bookshop-launchpad). Requires the shop agent token, scoped to one shop. Terminal — a cancelled campaign can't be reactivated. Get campaign_id from list_launchpad_campaigns.",
    inputSchema: {
      type: 'object',
      required: ['campaign_id'],
      properties: {
        campaign_id: { type: 'string', description: 'Campaign id from list_launchpad_campaigns' },
      },
    },
  },
  {
    name: 'update_listing',
    description: "SELLER TOOL. Update one of YOUR OWN listings: title, description, price, stock quantity, and/or collection membership. Requires the shop agent token, scoped to one shop. Changing the price changes what buyers pay — it's audited and the seller is alerted. Get product_id from list_my_listings; get collection names from list_my_collections.",
    inputSchema: {
      type: 'object',
      required: ['product_id'],
      properties: {
        product_id:  { type: 'string', description: 'Product id from list_my_listings' },
        title:       { type: 'string', description: 'New title (max 100 chars)' },
        description: { type: 'string', description: 'New description' },
        price_mxn:   { type: 'number', description: 'New price in MXN pesos (e.g. 1500 = $1,500)' },
        quantity:    { type: 'number', description: 'New stock quantity (physical products only)' },
        collection_names: {
          type: 'array', items: { type: 'string' },
          description: 'Full replacement set of collection names (from list_my_collections) this listing should belong to. Omit to leave unchanged; pass [] to clear.',
        },
      },
    },
  },
  {
    name: 'set_listing_status',
    description: "SELLER TOOL. Activate (publish) or pause (unpublish) one of YOUR OWN listings. Requires the shop agent token, scoped to one shop. Activating a physical product is blocked unless the shop has a delivery method AND a payment method configured (same rule as the portal). Get product_id from list_my_listings.",
    inputSchema: {
      type: 'object',
      required: ['product_id', 'status'],
      properties: {
        product_id: { type: 'string', description: 'Product id from list_my_listings' },
        status:     { type: 'string', enum: ['active', 'paused'], description: 'active = publish, paused = unpublish' },
      },
    },
  },
  {
    name: 'configure_listing_options',
    description: "SELLER TOOL. Configure one of YOUR OWN listings as a print-configurator product: priced option dimensions (e.g. Tamaño/Material) with a price per combination, and/or a quantity-break price ladder for one variant. Requires the shop agent token, scoped to one shop. TWO MUTUALLY EXCLUSIVE modes per call — (1) option_dimensions + variant_prices together: converts the listing to one variant per combination (one-way; dimensions can be re-defined later but never removed); (2) variant_tiers (+ variant_id when the product has several variants): replaces that variant's quantity-price ladder. Prices are integer CENTS. Changing prices changes what buyers pay — it's audited and the seller is alerted. Get product_id from list_my_listings.",
    inputSchema: {
      type: 'object',
      required: ['product_id'],
      properties: {
        product_id: { type: 'string', description: 'Product id from list_my_listings' },
        option_dimensions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['title', 'values'],
            properties: {
              title:  { type: 'string', description: 'Dimension name shown to buyers, e.g. "Tamaño" (max 40 chars)' },
              values: { type: 'array', items: { type: 'string' }, description: 'Option values, e.g. ["Chico","Grande"] (max 40 chars each, unique)' },
            },
          },
          description: 'Max 3 dimensions, max 60 total combinations. Requires variant_prices in the SAME call (one price per combination). Cannot be combined with variant_tiers.',
        },
        variant_prices: {
          type: 'object',
          additionalProperties: { type: 'number' },
          description: 'Price in integer CENTS (>0) per combination, keyed by the ALPHABETICALLY-SORTED combo key "Título:Valor|Título:Valor" — e.g. {"Tamaño:Chico": 5000, "Tamaño:Grande": 9000} is $50.00/$90.00 MXN. Every combination implied by option_dimensions must have a price. Only valid alongside option_dimensions.',
        },
        variant_id: {
          type: 'string',
          description: 'Variant to target with variant_tiers — REQUIRED when the product has more than one variant (variant ids appear in the get_listing price grid). Omit for a single-variant product.',
        },
        variant_tiers: {
          type: 'array',
          items: {
            type: 'object',
            required: ['min_quantity', 'max_quantity', 'amount'],
            properties: {
              min_quantity: { type: 'number', description: 'Tier start (first tier must start at 1)' },
              max_quantity: { type: ['number', 'null'], description: 'Tier end inclusive; null = sin límite (the last tier must be null)' },
              amount:       { type: 'number', description: 'Unit price in integer CENTS for this tier (>0)' },
            },
          },
          description: 'Full-replacement quantity-break ladder for ONE variant: gapless, non-overlapping, starts at 1, last tier open-ended (max_quantity null). E.g. [{min_quantity:1,max_quantity:2,amount:20000},{min_quantity:3,max_quantity:null,amount:15000}]. Cannot be combined with option_dimensions.',
        },
      },
    },
  },
  {
    name: 'delete_listing',
    description: "SELLER TOOL. Delete (soft-delete) one of YOUR OWN listings — it disappears from your catalog, search, and the storefront, while past order history stays intact (the deletion is a native soft-delete, so orders that included it keep resolving). Requires the shop agent token, scoped to one shop. This cannot be undone from the portal. Get product_id from list_my_listings.",
    inputSchema: {
      type: 'object',
      required: ['product_id'],
      properties: {
        product_id: { type: 'string', description: 'Product id from list_my_listings' },
      },
    },
  },
  {
    name: 'apply_price',
    description: "SELLER TOOL. Apply a computed price to ONE variant of YOUR OWN listings — the same pipeline as the Profit Analyzer's one-click Apply: writes the Miyagi price, then (only if the product is linked to Mercado Libre and publishing is enabled) pushes the new price to ML too, logging the attempt either way. Returns the honest partial state (miyagi ok + ml ok/skipped/failed) — a Miyagi success is never rolled back on an ML failure. Changing the price changes what buyers pay — it's audited and the seller is alerted. Requires the shop agent token, scoped to one shop.",
    inputSchema: {
      type: 'object',
      required: ['product_id', 'variant_id', 'new_price_cents'],
      properties: {
        product_id:        { type: 'string', description: 'Product id from list_my_listings' },
        variant_id:        { type: 'string', description: 'Variant to reprice (variant ids appear in the get_listing price grid)' },
        new_price_cents:   { type: 'number', description: 'New unit price in integer CENTS (>0), e.g. 15000 = $150.00 MXN' },
        target_margin_pct: { type: 'number', description: 'Optional: the margin target that produced this price — recorded in the activity log for traceability' },
      },
    },
  },
  {
    name: 'stage_bulk_action',
    description: "SELLER TOOL. Propose a bulk change across many of YOUR OWN listings at once (e.g. \"sube 10% los precios de la colección Zines\") — resolves the matching products and returns a before/after diff PREVIEW for each one, WITHOUT changing anything yet. Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Target EITHER explicit product_ids (from list_my_listings) OR a filter (category/channel/stock/status — same filters the Catálogo table uses). One action per call: price_set (fixed price_mxn), price_pct (percent, e.g. 10 or -10), category (category_handle, e.g. \"autos\"), collection_assign (collection_ids — full replacement, get ids from list_my_collections), or inventory_mode (mode: tracked/unlimited/backorder, + dispatch_estimate for backorder). NOT supported by this tool: pausing/activating, deleting, or Mercado Libre publish toggles in bulk — use set_listing_status / update_listing one at a time for those. Returns a batch_id + counts (total/valid/invalid) + a short sample of the diff — pass batch_id to apply_bulk_action to actually apply it (the confirm step; nothing changes until then).",
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        product_ids: { type: 'array', items: { type: 'string' }, description: 'Explicit product ids from list_my_listings (use this OR filter, not both)' },
        filter: {
          type: 'object',
          description: 'Target every listing matching this filter instead of an explicit list',
          properties: {
            category: { type: 'string', description: 'Category handle (e.g. "autos")' },
            channel:  { type: 'string', enum: ['miyagi', 'ml'], description: 'Only listings visible on this channel' },
            stock:    { type: 'string', enum: ['in_stock', 'agotado', 'unlimited'], description: 'Stock state' },
            status:   { type: 'string', enum: ['activo', 'agotado', 'borrador', 'pausado', 'sobre_pedido'], description: 'Listing status' },
          },
        },
        action: {
          type: 'object',
          description: 'Exactly one bulk action to preview',
          required: ['type'],
          properties: {
            type: { type: 'string', enum: ['price_set', 'price_pct', 'category', 'collection_assign', 'inventory_mode'] },
            price_mxn: { type: 'number', description: "For type='price_set' — the fixed new price in MXN pesos" },
            percent: { type: 'number', description: "For type='price_pct' — e.g. 10 for +10%, -10 for -10%" },
            category_handle: { type: 'string', description: "For type='category' — the target category handle (e.g. \"autos\")" },
            collection_ids: { type: 'array', items: { type: 'string' }, description: "For type='collection_assign' — full replacement set, from list_my_collections" },
            mode: { type: 'string', enum: ['tracked', 'unlimited', 'backorder'], description: "For type='inventory_mode'" },
            dispatch_estimate: { type: 'string', description: "For type='inventory_mode' with mode='backorder' — e.g. '1-3d'" },
          },
        },
      },
    },
  },
  {
    name: 'apply_bulk_action',
    description: 'SELLER TOOL. Apply a batch previously staged by stage_bulk_action — the confirm step. Requires the shop agent token, scoped to one shop; the batch_id itself acts as the confirmation token (you already saw the diff from stage_bulk_action before calling this). Idempotent: re-running on an already-applied batch reports "ya aplicado" for those rows rather than re-executing. Returns counts: applied / failed / skipped.',
    inputSchema: {
      type: 'object',
      required: ['batch_id'],
      properties: {
        batch_id: { type: 'string', description: 'batch_id returned by stage_bulk_action' },
      },
    },
  },
  {
    name: 'start_shopify_migration',
    description: "SELLER TOOL. Pull a Shopify shop's catalog (+ policies text, best-effort) into YOUR OWN shop's import staging, as a first step toward migrating off Shopify (epic 03 · platform-migrations). Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. No Shopify account/credentials needed — just the shop's domain (e.g. \"mitienda.com\" or \"mitienda.myshopify.com\"); works on any public Shopify storefront. Nothing is imported yet: returns a batch_id + item count. The seller reviews the staged products in the web app (/shop/manage/shopify/import) and confirms which ones to import — this tool does not publish anything to Miyagi on its own.",
    inputSchema: {
      type: 'object',
      required: ['shop_domain'],
      properties: {
        shop_domain: { type: 'string', description: 'The Shopify shop domain to pull from, e.g. "mitienda.com" or "mitienda.myshopify.com"' },
      },
    },
  },
  {
    name: 'get_domain_entitlement',
    description: "SELLER TOOL. Check whether YOUR OWN shop may connect a custom domain (the platform's paid SKU). Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Returns whether the shop is entitled and why (grandfathered / comp grant / one-time grant / active subscription / not entitled), the annual price, and — when not entitled — that the campaign coupon `miyagisan` covers the first year free. The SKU can be bought in two cadences (an annual subscription, or a one-time year up front with no recurring mandate). The subdomain and free shop URL are always free regardless. Use before start_domain_subscription.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'start_domain_subscription',
    description: "SELLER TOOL. Start the Stripe checkout for YOUR OWN shop's custom-domain SKU ($499 MXN/yr). Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Two cadences: `recurring` (default — an annual subscription that auto-renews) or `one_time` (pay one year up front with NO recurring mandate; entitlement is a dated 12-month grant that lapses gracefully at year end with no auto-charge — the cash-friendly option). On the `recurring` cadence you may pass a `coupon` (e.g. `miyagisan`) to comp the first year — capped at 100 redemptions; an exhausted/invalid coupon is refused with a clear message and no checkout is created. Returns a Stripe checkout URL the seller opens to pay (or, with a valid 100%-off coupon, to confirm at $0). Entitlement flips on automatically once checkout completes.",
    inputSchema: {
      type: 'object',
      properties: {
        cadence: { type: 'string', enum: ['recurring', 'one_time'], description: "Payment cadence: 'recurring' (annual subscription, default) or 'one_time' (pay a year up front, no renewal)" },
        coupon: { type: 'string', description: 'Optional campaign coupon code (e.g. miyagisan) to comp the first year — recurring cadence only' },
      },
    },
  },
  {
    name: 'get_subdomain_entitlement',
    description: "SELLER TOOL. Check whether YOUR OWN shop may serve its white-label subdomain <slug>.miyagisanchez.com (the platform's cheaper paid SKU, $199 MXN/yr). Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Returns whether the shop is entitled and why (grandfathered / comp grant / one-time grant / active subscription / not entitled) and the annual price. The free shop URL (/s/slug) is always free regardless. Use before start_subdomain_subscription.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'start_subdomain_subscription',
    description: "SELLER TOOL. Start the Stripe checkout for YOUR OWN shop's subdomain SKU ($199 MXN/yr, or $25 MXN/mo). Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Two cadences: `recurring` (default — a subscription that auto-renews) or `one_time` (pay one year up front with NO recurring mandate; entitlement is a dated 12-month grant that lapses gracefully at year end with no auto-charge — the cash-friendly option). On the `recurring` cadence pick the billing `interval`: `year` (default — $199/yr, the discounted option) or `month` ($25/mo, no annual commitment); `one_time` is always a year. No campaign coupon (that's the custom-domain SKU). Returns a Stripe checkout URL the seller opens to pay. Entitlement flips on automatically once checkout completes.",
    inputSchema: {
      type: 'object',
      properties: {
        cadence: { type: 'string', enum: ['recurring', 'one_time'], description: "Payment cadence: 'recurring' (subscription, default) or 'one_time' (pay a year up front, no renewal)" },
        interval: { type: 'string', enum: ['year', 'month'], description: "Recurring billing interval: 'year' ($199/yr, default) or 'month' ($25/mo). Applies to the 'recurring' cadence only." },
      },
    },
  },
  {
    name: 'switch_subdomain_cadence',
    description: "SELLER TOOL. Switch YOUR OWN shop's ACTIVE recurring subdomain subscription between monthly ($25/mo) and yearly ($199/yr). Requires the shop agent token (Authorization: Bearer ms_agent_…), scoped to one shop. Does a Stripe proration on the SAME subscription — no double charge and no gap in your subdomain (it keeps serving white-label throughout). Refused cleanly if you have no active subscription to switch, or if you're already on the target cadence (no-op). Use start_subdomain_subscription first if you don't have a subscription yet.",
    inputSchema: {
      type: 'object',
      properties: {
        interval: { type: 'string', enum: ['year', 'month'], description: "Target billing interval: 'year' ($199/yr) or 'month' ($25/mo)." },
      },
      required: ['interval'],
    },
  },
  {
    name: 'send_feedback',
    description: "File structured product feedback about Miyagi Sánchez itself or its agent tools — the moment you hit a missing capability, a confusing or wrong tool result, or a bug, file it right then rather than silently working around it or waiting to be asked. Requires a seller shop token (Authorization: Bearer ms_agent_…/ms_connector_…) or a partner token (Authorization: Bearer ms_partner_…, any role incl. viewer) — the author identity is resolved from whichever credential you're using, never taken from your input. category=mcp-tool for a tool that's missing/confusing/broken (pass tool_name), category=bug for something actually broken, category=feature for a capability you wish existed.",
    inputSchema: {
      type: 'object',
      required: ['category', 'message'],
      properties: {
        category:  { type: 'string', enum: ['feature', 'mcp-tool', 'bug'], description: 'feature (capability request), mcp-tool (a tool is missing/confusing/wrong), or bug (something is broken).' },
        message:   { type: 'string', description: 'Free-text report, 5–2000 characters. Be specific — what you expected vs. what happened.' },
        tool_name: { type: 'string', description: 'Optional — the MCP tool name this feedback is about (e.g. "get_checkout_options").' },
      },
    },
  },
  {
    name: 'about_miyagi',
    description: `What miyagisanchez.com is and WHY/HOW to sell here — the supply-side story for a prospective seller (what Miyagi is, why sell, how to start, what it costs). Call this when a user asks about the marketplace itself or whether/how to sell on it. ${RELAY_LANGUAGE_DIRECTIVE}`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_setup_spec',
    description: "Onboarding 0 — get the published, versioned spec + prompt for emitting ONE combined setup file (shop profile + store config + catalog) so a seller's own agent can prepare a Miyagi Sánchez shop BEFORE signup. Returns the schema shape, both sub-schemas (config blocks + catalog fields), the manual-only sections, an example, and the es-MX emit prompt (which instructs you to produce all user-facing copy in the seller's own language). Apply path today: the seller signs up and uploads the file via the existing import flow. No auth.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'compare_costs',
    description: "Comparador de costos — compare a merchant's current platform cost (Shopify, Mercado Libre, WooCommerce, or Tiendanube) against the equivalent Miyagi Sánchez (0% commission) cost, using their own sales volume and average order value. Read-only, no auth. Computed by the EXACT SAME pure model that powers miyagisanchez.com/comparador — never drifts from what the page shows. Every competitor figure is sourced and dated; the response's `sources` array cites each one plus the dataset's overall `verified_at` date. Use this when a seller (or their agent) asks what they'd pay elsewhere, or what switching to Miyagi would save them.",
    inputSchema: {
      type: 'object',
      required: ['platform', 'volume_monthly', 'aov_mxn'],
      properties: {
        platform: { type: 'string', enum: ['shopify', 'mercadolibre', 'woocommerce', 'tiendanube'], description: 'Competitor platform to compare against' },
        volume_monthly: { type: 'number', description: 'Sales per month' },
        aov_mxn: { type: 'number', description: 'Average order value, MXN' },
        shopify_tier: { type: 'string', enum: ['basico', 'crecimiento', 'avanzado'], default: 'basico', description: 'Shopify plan tier — only used when platform=shopify' },
        ml_band: { type: 'string', enum: ['baja', 'media', 'alta'], default: 'media', description: 'Mercado Libre commission band (category-driven) — only used when platform=mercadolibre' },
        ml_publication_type: { type: 'string', enum: ['clasica', 'premium'], default: 'clasica', description: 'Mercado Libre listing type — only used when platform=mercadolibre' },
        woo_hosting_tier: { type: 'string', enum: ['entrada', 'crecimiento'], default: 'entrada', description: 'WooCommerce hosting tier — only used when platform=woocommerce' },
        tiendanube_tier: { type: 'string', enum: ['gratis', 'basico', 'tiendanube', 'avanzado'], default: 'basico', description: 'Tiendanube plan tier — only used when platform=tiendanube' },
        tiendanube_own_gateway: { type: 'boolean', default: true, description: 'true = Pago Nube (their own gateway); false = external gateway — only used when platform=tiendanube' },
        apps: { type: 'array', items: { type: 'string', enum: COMPARE_COSTS_APP_IDS }, description: 'Premium competitor apps the merchant already pays for; each is natively included in Miyagi at $0. An unknown id is dropped from the calculation and reported in the response — never silently echoed as accepted.' },
        miyagi_subdomain: { type: 'boolean', default: false, description: "Include Miyagi's optional subdomain SKU in the Miyagi total" },
        miyagi_custom_domain: { type: 'boolean', default: false, description: "Include Miyagi's optional custom-domain SKU in the Miyagi total" },
        miyagi_ml_sync: { type: 'boolean', default: false, description: "Include Miyagi's optional Mercado Libre sync SKU in the Miyagi total" },
      },
    },
  },
]

// miyagi-partners-mcp S1.4 — every SELLER tool accepts an optional `shop_slug`
// so a multi-shop partner credential (ms_partner_…) can address one of its
// granted shops. Injected once at module init (not 40+ hand-edits) from the
// same MCP_SELLER_TOOLS list the dispatch⇄manifest parity spec enforces.
// Seller credentials ignore the argument entirely (resolveToolShop parity).
for (const tool of TOOLS) {
  if ((MCP_SELLER_TOOLS as readonly string[]).includes(tool.name)) {
    ;(tool.inputSchema as { properties: Record<string, unknown> }).properties = {
      ...(tool.inputSchema as { properties?: Record<string, unknown> }).properties,
      shop_slug: {
        type: 'string',
        description: 'Solo credencial de socio (ms_partner_…): slug de la tienda asignada a operar. Con una sola tienda asignada puede omitirse. Las credenciales de vendedor (ms_agent_/ms_connector_) lo ignoran.',
      },
    }
  }
}

// ── Tool handlers ──────────────────────────────────────────────────────────────

async function handleSearchListings(args: Record<string, unknown>, baseUrl: string) {
  const limit = Math.min(Math.max(1, Number(args.limit ?? 10)), 20)
  const marketDecision = planMarketCatalogRead(args.market)
  if (isMarketUnavailable(marketDecision)) {
    return { content: [{ type: 'text', text: JSON.stringify(marketDecision, null, 2) }] }
  }
  const medusaHeaders = marketMedusaHeaders(marketDecision.market.code)
  if (!medusaHeaders) return { content: [{ type: 'text', text: JSON.stringify(marketKeyUnavailable(marketDecision.market), null, 2) }] }

  const params = new URLSearchParams()
  params.set('market', marketDecision.market.code)
  params.set('limit', String(limit))
  if (args.q)            params.set('q', String(args.q))
  if (args.category)     params.set('category', String(args.category))
  if (args.listing_type) params.set('listing_type', String(args.listing_type))
  if (args.state)        params.set('state', String(args.state))
  if (args.location)     params.set('location', String(args.location))
  if (args.condition)    params.set('condition', String(args.condition))
  if (args.min_price)    params.set('min_price', String(args.min_price))
  if (args.max_price)    params.set('max_price', String(args.max_price))
  if (args.brand)        params.set('brand', String(args.brand))
  if (args.model)        params.set('model', String(args.model))
  if (args.year_from)    params.set('year_from', String(args.year_from))
  if (args.year_to)      params.set('year_to', String(args.year_to))
  if (args.km_from)      params.set('km_from', String(args.km_from))
  if (args.km_to)        params.set('km_to', String(args.km_to))
  if (args.transmission) params.set('transmission', String(args.transmission))
  if (args.fuel)         params.set('fuel', String(args.fuel))
  if (args.sort)         params.set('sort', String(args.sort))

  let data: { listings?: Listing[]; market_code?: unknown }
  try {
    const res = await fetch(`${MEDUSA_BASE}/store/listings?${params.toString()}`, { headers: medusaHeaders })
    if (!res.ok) return { isError: true, content: [{ type: 'text', text: `Search failed: ${res.status}` }] }
    data = await res.json() as { listings?: Listing[]; market_code?: unknown }
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Network error: ${String(e)}` }] }
  }
  const unconfirmedMarket = verifyMarketFilter(marketDecision.market, data)
  if (unconfirmedMarket) {
    return { content: [{ type: 'text', text: JSON.stringify(unconfirmedMarket, null, 2) }] }
  }

  const inventoryChannelsEnabled = await isEnabled('catalog.inventory_channels_enabled')
  const items = await Promise.all((data.listings ?? []).map(async (l: Listing) =>
    toUcpListing(
      l,
      baseUrl,
      await getPriceGrid(l.medusa_product_id ?? l.id, marketDecision.market.code),
      inventoryChannelsEnabled,
      marketDecision.market.code,
    )))
  if (items.length === 0) {
    return { content: [{ type: 'text', text: JSON.stringify({ listings: [], market_code: marketDecision.market.code }, null, 2) }] }
  }

  const english = marketDecision.market.default_locale === 'en-US'
  const summary = items.map(item => {
    const price = item.price ? item.price.formatted : (english ? 'Ask for price' : 'Precio a consultar')
    const flags = [
      item.actions.buy_now && (english ? '💳 buy now' : '💳 comprar ahora'),
      item.actions.make_offer && (english ? '🤝 make an offer' : '🤝 hacer oferta'),
      item.actions.escrow_available && (english ? '🛡️ protected payment' : '🛡️ pago protegido'),
      item.trust.verified_seller && (english ? '✓ verified' : '✓ verificado'),
    ].filter(Boolean).join(' · ')
    return `**${item.title}**\n${price} · ${item.location ?? item.state ?? (english ? 'United States' : 'México')} · ${item.condition ?? item.listing_type}\n${flags}\nID: \`${item.id}\` | ${item.url}`
  }).join('\n\n---\n\n')

  return { content: [{ type: 'text', text: `Found ${items.length} listings in market ${marketDecision.market.code}:\n\n${summary}` }, { type: 'text', text: JSON.stringify({ listings: items, market_code: marketDecision.market.code }, null, 2) }] }
}

async function handleGetNeighborhoodPulse(args: Record<string, unknown>, baseUrl: string) {
  const marketDecision = planMarketCatalogRead(args.market)
  if (isMarketUnavailable(marketDecision)) {
    return { content: [{ type: 'text', text: JSON.stringify(marketDecision, null, 2) }] }
  }
  const medusaHeaders = marketMedusaHeaders(marketDecision.market.code)
  if (!medusaHeaders) return { content: [{ type: 'text', text: JSON.stringify(marketKeyUnavailable(marketDecision.market), null, 2) }] }
  const english = marketDecision.market.default_locale === 'en-US'
  const pulse = await getNeighborhoodPulseAgentView(baseUrl, {
    itemLimit: Number(args.community_limit ?? 12),
    listingLimit: Number(args.trending_limit ?? 8),
    shopLimit: Number(args.shop_limit ?? 6),
  }, marketDecision.market.code)

  const community = pulse.community_items.slice(0, 5).map((item) =>
    `• ${item.caption} — ${item.type_label}, ${item.zone}`,
  )
  const listings = pulse.trending_listings.slice(0, 5).map((item) =>
    `• ${item.title} — ${item.price?.formatted ?? (english ? 'Ask for price' : 'A consultar')} (${item.shop.name})`,
  )
  const shops = pulse.spotlight_shops.slice(0, 5).map((shop) =>
    `• ${shop.name} — ${shop.tagline} · ${shop.colonia}`,
  )

  const summary = [
    english ? '## Neighborhood pulse' : '## Pulso del vecindario',
    '',
    `**${english ? 'Read only' : 'Solo lectura'}:** ${pulse._meta.read_only ? (english ? 'yes' : 'sí') : 'no'}`,
    '',
    english ? '### Community posts' : '### Aportes de la comunidad',
    community.length ? community.join('\n') : (english ? 'No visible community posts yet.' : 'Sin aportes visibles por ahora.'),
    '',
    english ? '### Trending' : '### Tendencias',
    listings.length ? listings.join('\n') : (english ? 'No trends available yet.' : 'Sin tendencias disponibles por ahora.'),
    '',
    english ? '### Shops gaining attention' : '### Comercios que destacan',
    shops.length ? shops.join('\n') : (english ? 'No highlighted shops yet.' : 'Sin comercios destacados por ahora.'),
  ].join('\n')

  return {
    content: [
      { type: 'text', text: summary },
      { type: 'text', text: JSON.stringify(pulse, null, 2) },
    ],
  }
}

async function handleGetListing(args: Record<string, unknown>, baseUrl: string) {
  const id = String(args.id ?? '')
  const marketDecision = planMarketCatalogRead(args.market)
  if (isMarketUnavailable(marketDecision)) {
    return { content: [{ type: 'text', text: JSON.stringify(marketDecision, null, 2) }] }
  }
  const medusaHeaders = marketMedusaHeaders(marketDecision.market.code)
  if (!medusaHeaders) return { content: [{ type: 'text', text: JSON.stringify(marketKeyUnavailable(marketDecision.market), null, 2) }] }

  let listing: Listing | null = null
  try {
    const res = await fetch(`${MEDUSA_BASE}/store/listings/${id}?${marketDecision.query}`, { headers: medusaHeaders })
    if (!res.ok) return { isError: true, content: [{ type: 'text', text: `Listing ${id} not found.` }] }
    const data = await res.json() as { listing?: Listing; market_code?: unknown }
    const unconfirmedMarket = verifyMarketFilter(marketDecision.market, data)
    if (unconfirmedMarket) {
      return { content: [{ type: 'text', text: JSON.stringify(unconfirmedMarket, null, 2) }] }
    }
    listing = data.listing ?? null
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Network error: ${String(e)}` }] }
  }

  if (!listing) return { isError: true, content: [{ type: 'text', text: `Listing ${id} not found.` }] }

  const priceGrid = await getPriceGrid(
    listing.medusa_product_id ?? listing.id,
    marketDecision.market.code,
  )
  const inventoryChannelsEnabled = await isEnabled('catalog.inventory_channels_enabled')
  const item = toUcpListing(listing, baseUrl, priceGrid, inventoryChannelsEnabled, marketDecision.market.code)
  const english = marketDecision.market.default_locale === 'en-US'

  // Configurator options/tiers + the file-upload contract (custom-print-products
  // S4 · 4.2) — spelled out in plain text so an agent doesn't have to parse the
  // JSON blob just to learn a listing needs a variant_id + artwork_url.
  const configuratorLines: string[] = []
  if (item.price_grid && item.price_grid.variants.length > 0) {
    configuratorLines.push('', english ? '**Options and quantity pricing:**' : '**Opciones y precios por cantidad:**')
    for (const v of item.price_grid.variants) {
      const optionsLabel = Object.entries(v.options).map(([k, val]) => `${k}: ${val}`).join(', ')
      const tiers = v.tiers.map(t =>
        `${t.min_quantity}${t.max_quantity ? `–${t.max_quantity}` : '+'} u. → $${(t.amount / 100).toFixed(2)} c/u`,
      ).join(' · ')
      configuratorLines.push(`- **${optionsLabel}** (variant_id: \`${v.id}\`): ${tiers}`)
    }
  }
  const fileField = item.personalization_fields.find(f => f.type === 'file')
  if (fileField) {
    configuratorLines.push(
      '',
      english
        ? `**Artwork:** ${fileField.required ? 'required' : 'optional'} — formats ${(fileField.allowed_formats ?? []).join(', ').toUpperCase() || 'standard'}, max ${fileField.max_size_mb ?? '?'} MB. Pass it as \`artwork_url\` to create_checkout.`
        : `**Arte requerido:** ${fileField.required ? 'obligatorio' : 'opcional'} — formatos ${(fileField.allowed_formats ?? []).join(', ').toUpperCase() || 'estándar'}, máx ${fileField.max_size_mb ?? '?'} MB. Pásalo como \`artwork_url\` en create_checkout (el servidor lo descarga y valida).`,
    )
  }

  const details = [
    `# ${item.title}`,
    `**${english ? 'Price' : 'Precio'}:** ${item.price?.formatted ?? (english ? 'Ask for price' : 'A consultar')}`,
    `**${english ? 'Condition' : 'Condición'}:** ${item.condition ?? (english ? 'Not specified' : 'No especificada')} · **${english ? 'Type' : 'Tipo'}:** ${item.listing_type}`,
    `**${english ? 'Location' : 'Ubicación'}:** ${item.location ?? item.state ?? (english ? 'Not specified' : 'No especificada')}`,
    `**${english ? 'Seller' : 'Vendedor'}:** ${item.shop.name}${item.trust.verified_seller ? (english ? ' ✓ verified' : ' ✓ verificado') : ''}`,
    '',
    `**${english ? 'Actions' : 'Acciones'}:**`,
    item.actions.buy_now ? (english ? '✅ Buy now' : `✅ Comprar ahora`) : (english ? `❌ Buy now unavailable (${item.commerce_readiness.reason})` : `❌ Compra directa no disponible (${item.commerce_readiness.reason})`),
    item.actions.make_offer ? (english ? '✅ Make an offer' : `✅ Hacer oferta`) : (english ? '❌ Offers unavailable' : `❌ Ofertas no disponibles`),
    item.actions.escrow_required ? `🛡️ Pago protegido OBLIGATORIO` : item.actions.escrow_available ? `🛡️ Pago protegido disponible (opcional)` : '',
    `**${english ? 'Methods' : 'Métodos'}:** ${[item.payment_methods.mercadopago && 'Mercado Pago', item.payment_methods.stripe && 'Stripe'].filter(Boolean).join(', ') || (english ? 'None configured' : 'Ninguno configurado')}`,
    item.description ? `\n**${english ? 'Description' : 'Descripción'}:** ${item.description}` : '',
    `**URL:** ${item.url}`,
    ...configuratorLines,
  ].filter(s => s !== '').join('\n')

  return { content: [{ type: 'text', text: details }, { type: 'text', text: JSON.stringify(item, null, 2) }] }
}

async function handleGetCheckoutOptions(args: Record<string, unknown>, baseUrl: string) {
  const listingId = String(args.listing_id ?? '')
  if (!listingId) {
    return { isError: true, content: [{ type: 'text', text: 'listing_id is required' }] }
  }
  const marketDecision = planMarketCatalogRead(args.market)
  if (isMarketUnavailable(marketDecision)) {
    return { content: [{ type: 'text', text: JSON.stringify(marketDecision, null, 2) }] }
  }
  if (marketDecision.market.code === 'us') {
    return { content: [{ type: 'text', text: JSON.stringify({ market_code: 'us', commerce_readiness: { ready: false, market_code: 'us', reason: 'checkout_not_available' } }, null, 2) }] }
  }

  const body: Record<string, unknown> = {
    listing_id: listingId,
    market: marketDecision.market.code,
  }
  if (args.offer_id)    body.offer_id    = String(args.offer_id)
  if (args.buyer_email) body.buyer_email = String(args.buyer_email)
  if (args.shipping_destination && typeof args.shipping_destination === 'object') {
    body.shipping_destination = args.shipping_destination
  }
  if (args.check_in)    body.check_in    = String(args.check_in)
  if (args.check_out)   body.check_out   = String(args.check_out)

  try {
    const res = await fetch(`${baseUrl}/api/ucp/checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const d = await res.json() as { error?: string }
      return { isError: true, content: [{ type: 'text', text: `Failed to get checkout options: ${d.error ?? res.status}` }] }
    }

    const session = await res.json() as {
      price?: { formatted?: string; is_offer_price?: boolean }
      available_count?: number
      recommended_method?: string
      payment_options?: Array<{
        method: string; label: string; description: string; available: boolean;
        instant: boolean; checkout_url?: string; instructions?: string;
        contact_url?: string
        reason_unavailable?: string
      }>
      escrow?: { available: boolean; required: boolean; description: string }
      rental_quote?: {
        check_in: string; check_out: string; nights: number; units: number
        rate_period: string; rent_cents: number; deposit_cents: number
        total_cents: number; formatted: string
      } | null
      rental_pricing_hint?: string | null
      fulfillment?: {
        shipping_quote_state?: string
        methods?: Array<{
          type?: string
          destinations?: Array<{ id?: string; name?: string }>
          groups?: Array<{ options?: Array<{ id?: string; title?: string; description?: string; totals?: Array<{ amount?: number }> }> }>
        }>
      }
    }

    const opts = session.payment_options ?? []
    const available = opts.filter(o => o.available)
    const unavailable = opts.filter(o => !o.available)
    const fulfillment = session.fulfillment
    const shippingOptions = fulfillment?.methods
      ?.filter(method => method.type === 'shipping')
      .flatMap(method => method.groups ?? [])
      .flatMap(group => group.options ?? []) ?? []
    const pickupDestinations = fulfillment?.methods
      ?.filter(method => method.type === 'pickup')
      .flatMap(method => method.destinations ?? []) ?? []
    const fulfillmentLines = !fulfillment ? [] : [
      '## Entrega',
      fulfillment.shipping_quote_state === 'destination_required'
        ? '📍 Falta una dirección MX completa para cotizar envío; vuelve a llamar con shipping_destination.'
        : fulfillment.shipping_quote_state === 'unavailable'
          ? '⚠️ La fuente de entrega/cotización no está disponible; no lo interpretes como cero opciones.'
          : fulfillment.shipping_quote_state === 'known_empty'
            ? 'No hay tarifas vigentes para esta dirección.'
            : '',
      ...shippingOptions.map(option => `🚚 **${option.title ?? 'Envío'}** — ${option.description ?? 'Tarifa vigente'} · ${option.totals?.[0]?.amount ?? 0} centavos · fulfillment_option_id: ${option.id ?? 'no disponible'}`),
      ...pickupDestinations.map(destination => `📦 Recolección: **${destination.name ?? 'Punto de entrega'}** · fulfillment_destination_id: ${destination.id ?? 'no disponible'}`),
    ].filter(Boolean)

    const formatOption = (o: typeof opts[0]) => {
      const lines = [`**${o.label}** ${o.instant ? '⚡ Pago inmediato' : '📋 Coordinación requerida'}`]
      lines.push(o.description)
      if (o.checkout_url) lines.push(`→ Usar create_checkout con method="${o.method}" para generar el enlace de pago`)
      if (o.instructions) lines.push(`📋 ${o.instructions}`)
      if (o.contact_url) lines.push(`📱 ${o.contact_url}`)
      return lines.join('\n')
    }

    const summary = [
      `## Opciones de pago para este anuncio`,
      session.price ? `**Precio:** ${session.price.formatted}${session.price.is_offer_price ? ' (precio negociado ✅)' : ''}` : '',
      session.rental_quote
        ? `🗓️ **Reserva:** ${session.rental_quote.check_in} → ${session.rental_quote.check_out} (${session.rental_quote.nights} noches) — **Total: ${session.rental_quote.formatted}** (renta + depósito). Este es el monto real que se cobrará, usa el checkout_url de un método instantáneo o las instrucciones del método manual arriba.`
        : session.rental_pricing_hint ? `🗓️ ${session.rental_pricing_hint}` : '',
      session.escrow?.available ? `🛡️ ${session.escrow.description}` : '',
      ...fulfillmentLines,
      '',
      `### Disponibles (${available.length})`,
      ...available.map(o => formatOption(o)),
      ...(unavailable.length > 0 ? [
        '',
        `### No disponibles`,
        ...unavailable.map(o => `~~${o.label}~~ — ${o.reason_unavailable ?? 'No disponible'}`),
      ] : []),
      '',
      session.recommended_method
        ? `✨ **Recomendado:** ${available.find(o => o.method === session.recommended_method)?.label ?? session.recommended_method}`
        : '⚠️ No hay métodos de pago disponibles para este anuncio.',
    ].filter(s => s !== '').join('\n\n')

    return { content: [{ type: 'text', text: summary }, { type: 'text', text: JSON.stringify(session, null, 2) }] }
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Network error: ${String(e)}` }] }
  }
}

async function handleCreateCheckout(args: Record<string, unknown>, baseUrl: string) {
  const listingId = String(args.listing_id ?? '')
  if (!listingId) {
    return { isError: true, content: [{ type: 'text', text: 'listing_id is required' }] }
  }
  const marketDecision = planMarketCatalogRead(args.market)
  if (isMarketUnavailable(marketDecision)) {
    return { content: [{ type: 'text', text: JSON.stringify(marketDecision, null, 2) }] }
  }
  if (marketDecision.market.code === 'us') {
    return { content: [{ type: 'text', text: JSON.stringify({ market_code: 'us', commerce_readiness: { ready: false, market_code: 'us', reason: 'checkout_not_available' } }, null, 2) }] }
  }

  // A configured listing must prove its price ladder in the requested market
  // before the general checkout-session lookup. Besides avoiding a redundant
  // write-path attempt, this preserves the configurator's actionable "no price
  // grid" response when the listing is absent or unpublished in this market.
  // The checkout-session boundary still runs below for every grid that exists,
  // so this does not weaken Sales Channel validation before cart creation.
  let configuredPriceGrid: PriceGrid | null = null
  if (args.variant_id) {
    configuredPriceGrid = await getPriceGrid(listingId, marketDecision.market.code)
    if (!configuredPriceGrid) {
      return { isError: true, content: [{ type: 'text', text: `Listing ${listingId} has no configurator price grid — omit variant_id for a plain listing.` }] }
    }
  }

  // All buyer checkout creation starts with the same market-scoped discovery
  // boundary as get_checkout_options. This verifies Sales Channel membership
  // before either a flat gateway checkout or a configured Medusa cart can write.
  let marketSession: {
    listing_id?: string
    listing?: {
      listing_type?: string
      shop?: { id?: string; slug?: string }
    }
    delivery?: { arranged?: boolean }
    price?: { amount_cents?: number; is_offer_price?: boolean }
  }
  try {
    const validationBody: Record<string, unknown> = {
      listing_id: listingId,
      market: marketDecision.market.code,
    }
    if (args.offer_id) validationBody.offer_id = String(args.offer_id)
    const validation = await fetch(`${baseUrl}/api/ucp/checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validationBody),
    })
    const data = await validation.json() as {
      listing_id?: string
      listing?: { listing_type?: string }
      unavailable?: boolean
      error?: unknown
    }
    if (!validation.ok) {
      if (data.unavailable) {
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
      }
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `Checkout failed: ${publicCheckoutError(data.error, `Unable to validate listing (${validation.status})`)}`,
        }],
      }
    }
    marketSession = data
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: `Network error: ${String(error)}` }] }
  }

  // Rental guard (S3.1 cross-review catch): this endpoint charges a bare
  // one-unit rate with no dates — it is NOT rental-aware. A rental listing
  // must go through get_checkout_options(check_in, check_out) instead, whose
  // checkout_url already points at the dated /checkout page (the real S1/S2
  // charge rail). The tool description alone doesn't stop a model from
  // calling this directly, so block it here too. Fail-open on a lookup
  // failure — this is defense-in-depth on top of that primary fix, not the
  // only guard, so a transient Medusa hiccup shouldn't block every OTHER
  // (non-rental) checkout through this endpoint.
  if (marketSession.listing?.listing_type === 'rental') {
    return { isError: true, content: [{ type: 'text', text: 'Este anuncio es una renta — create_checkout no calcula noches × tarifa + depósito y cobraría un monto incorrecto. Usa get_checkout_options con check_in/check_out para obtener el checkout_url correcto.' }] }
  }

  const method = String(args.method ?? 'mercadopago')
  const provider: CheckoutProvider = method === 'stripe' ? 'stripe' : 'mercadopago'
  // checkout-session resolves legacy mirror UUIDs to Medusa's canonical product
  // id. Fulfillment ids and the rate/cart rails are bound to that canonical id.
  const canonicalListingId = marketSession.listing_id ?? listingId
  const hasAnyFulfillmentInput = [
    args.fulfillment_method_id,
    args.fulfillment_destination_id,
    args.fulfillment_option_id,
    args.shipping_destination,
    args.pickup_appointment,
  ].some(value => value !== undefined)
  if (hasAnyFulfillmentInput && !args.fulfillment_method_id) {
    return { isError: true, content: [{ type: 'text', text: 'fulfillment_method_id es obligatorio cuando envías una selección de entrega.' }] }
  }

  let resolvedFulfillment: Pick<
    StartCheckoutParams,
    'fulfillmentMethod' | 'shippingAddress' | 'shippingQuote' | 'pickupSpotId' | 'pickupAppointment'
  > | undefined
  if (args.fulfillment_method_id) {
    if (marketSession.listing?.listing_type !== 'product') {
      return { isError: true, content: [{ type: 'text', text: 'La selección física de fulfillment sólo está disponible para anuncios de producto MX.' }] }
    }
    const sellerRef = marketSession.listing.shop?.slug ?? marketSession.listing.shop?.id
    if (!sellerRef) {
      return { isError: true, content: [{ type: 'text', text: 'No pudimos validar la entrega actual del vendedor. Vuelve a consultar get_checkout_options.' }] }
    }
    const deliveryMode = marketSession.delivery?.arranged === true ? 'arranged' as const : 'carrier' as const
    // The checkout-session call above is discovery, not an authorization to
    // write a cart. Read Medusa again immediately before that write: a seller
    // can disable shipping or alter pickup spots after an agent saw them. The
    // public fulfillment projection deliberately does not expose the backend
    // spot/rate authority needed by startCheckout.
    const checkoutOptions = await fetchBackendCheckoutOptions({
      sellerRef,
      listingType: 'product',
      isDigital: false,
      deliveryMode,
    })
    if (checkoutOptions.state !== 'available') {
      return { isError: true, content: [{ type: 'text', text: 'No pudimos validar la entrega actual del vendedor. Vuelve a intentarlo antes de pagar.' }] }
    }
    const destination = normalizeShippingDestination(args.shipping_destination)
    const rateSource = args.fulfillment_method_id === 'shipping' && destination.complete
      ? await fetchBackendShippingRates({ listingId: canonicalListingId, address: destination.address })
      : { state: 'not_requested' as const }
    const selection = resolveUcpFulfillmentSelection({
      listingId: canonicalListingId,
      methodId: args.fulfillment_method_id,
      destinationId: args.fulfillment_destination_id,
      optionId: args.fulfillment_option_id,
      appointment: args.pickup_appointment,
      destination,
      deliveryMethods: checkoutOptions.deliveryMethods,
      rateSource,
    })
    if (!selection.ok) {
      return { isError: true, content: [{ type: 'text', text: fulfillmentSelectionError(selection.code) }] }
    }
    resolvedFulfillment = selection.value
  }

  if (args.offer_id && marketSession.price?.is_offer_price !== true) {
    return { isError: true, content: [{ type: 'text', text: 'La oferta ya no está aceptada o no pertenece a este anuncio. Vuelve a consultar get_checkout_options.' }] }
  }

  // Configurator path: still resolves price through the same Medusa cart. When
  // fulfillment was selected above, pass only its freshly resolved internal value.
  if (args.variant_id) {
    return handleCreateConfiguredCheckout(
      args,
      marketDecision.market.code,
      configuredPriceGrid!,
      resolvedFulfillment,
    )
  }

  if (resolvedFulfillment) {
    try {
      const result = await startCheckout({
        productId: canonicalListingId,
        provider,
        buyerEmail: args.buyer_email ? String(args.buyer_email) : undefined,
        offerId: args.offer_id ? String(args.offer_id) : undefined,
        offerAmountCents: args.offer_id && marketSession.price?.is_offer_price
          ? marketSession.price.amount_cents
          : undefined,
        market: marketDecision.market.code,
        ...resolvedFulfillment,
      })
      if (!result.redirect_url) {
        return { isError: true, content: [{ type: 'text', text: 'Checkout failed: el proveedor no devolvió un enlace de pago.' }] }
      }
      return { content: [{ type: 'text', text: `✅ Checkout con entrega validada listo vía ${method === 'stripe' ? 'Stripe' : 'Mercado Pago'}.\n\n**Abre este enlace para completar el pago:**\n${result.redirect_url}\n\nEl enlace es válido por 30 minutos.` }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Checkout failed: ${publicCheckoutError(error, 'No fue posible iniciar el checkout con entrega')}` }] }
    }
  }

  // No fulfillment selection: preserve the existing flat gateway path exactly.
  const endpoint = method === 'stripe' ? `${baseUrl}/api/stripe/checkout` : `${baseUrl}/api/mp/checkout`

  const body: Record<string, string> = { listingId }
  if (args.buyer_email) body.buyerEmail = String(args.buyer_email)
  if (args.offer_id)    body.offerId    = String(args.offer_id)

  try {
    const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json() as { checkoutUrl?: string; error?: unknown }
    if (!res.ok || !data.checkoutUrl) return { isError: true, content: [{ type: 'text', text: `Checkout failed: ${publicCheckoutError(data.error, 'Unknown error')}` }] }
    return { content: [{ type: 'text', text: `✅ Checkout ready via ${method === 'stripe' ? 'Stripe' : 'Mercado Pago'}.\n\n**Abre este enlace para completar el pago:**\n${data.checkoutUrl}\n\nEl enlace es válido por 30 minutos.` }] }
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Network error: ${String(e)}` }] }
  }
}

/**
 * Configurator checkout (custom-print-products S4 · 4.2) — agent parity for
 * "pide 100 stickers de 7.5cm con este arte". Goes through the SAME Medusa
 * cart flow the browser buy box uses (`startCheckout`), never the flat MP/
 * Stripe preference, so the charged price always comes from Medusa's own
 * tier resolution. Artwork is fetched server-side and validated through the
 * IDENTICAL `ingestArtworkBytes` the human upload route uses — never a
 * second, looser copy of that check.
 */
// ONE generic, non-oracular es-MX message for every artwork_url download or
// validation failure (Roadmap/00-ideas/seeds/ssrf-artwork-url-mcp.md). This
// endpoint has no auth, so three distinguishable strings (an HTTP status, a
// content-length-derived size, a raw network-error string) would let an
// anonymous caller use it to port-scan internal hosts. Never split this back
// into per-cause strings.
const ARTWORK_DOWNLOAD_ERROR = 'No pudimos descargar o validar el archivo de artwork_url. Usa una URL pública https:// que apunte directo a la imagen.'

function fulfillmentSelectionError(code: string): string {
  const messages: Record<string, string> = {
    method_not_current: 'Ese método de entrega ya no está disponible. Vuelve a consultar get_checkout_options.',
    shipping_address_required: 'shipping_destination debe incluir nombre, calle, número exterior, municipio, estado y código postal MX.',
    shipping_destination_required: 'fulfillment_destination_id es obligatorio para envío y debe venir de get_checkout_options.',
    shipping_destination_not_current: 'La dirección elegida ya no corresponde a shipping_destination. Vuelve a consultar get_checkout_options.',
    shipping_source_unavailable: 'No pudimos volver a cotizar el envío. No se creó carrito ni enlace de pago; inténtalo de nuevo.',
    shipping_option_required: 'fulfillment_option_id es obligatorio para envío y debe venir de get_checkout_options.',
    option_not_current: 'La tarifa elegida ya no corresponde a este anuncio/dirección. Vuelve a consultar get_checkout_options.',
    pickup_destination_required: 'fulfillment_destination_id es obligatorio para los puntos de recolección de este vendedor.',
    pickup_destination_not_current: 'Ese punto de recolección ya no está disponible. Vuelve a consultar get_checkout_options.',
    pickup_appointment_required: 'pickup_appointment requiere date (YYYY-MM-DD) y window.',
  }
  return messages[code] ?? 'No pudimos validar la selección de entrega. Vuelve a consultar get_checkout_options.'
}

/**
 * Convert the deliberately loose error shapes returned by gateway/session
 * boundaries into one short public message. Read only `message`/`error`; never
 * stringify the full object, whose sibling fields may contain request details
 * or credentials. Common credential assignments are redacted as a final guard.
 */
function publicCheckoutError(value: unknown, fallback: string): string {
  const readMessage = (candidate: unknown, depth = 0): string | null => {
    if (typeof candidate === 'string') {
      const normalized = candidate.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
      return normalized || null
    }
    if (!candidate || typeof candidate !== 'object' || depth >= 2) return null
    const record = candidate as Record<string, unknown>
    return readMessage(record.message, depth + 1) ?? readMessage(record.error, depth + 1)
  }
  return (readMessage(value) ?? fallback)
    .replace(/\b(Bearer)\s+\S+/gi, '$1 [redacted]')
    .replace(/\b(api[_ -]?key|authorization|password|secret|token)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .slice(0, 240)
}

async function handleCreateConfiguredCheckout(
  args: Record<string, unknown>,
  marketCode: MarketCode,
  priceGrid: PriceGrid,
  fulfillment?: Pick<
    StartCheckoutParams,
    'fulfillmentMethod' | 'shippingAddress' | 'shippingQuote' | 'pickupSpotId' | 'pickupAppointment'
  >,
) {
  const listingId = String(args.listing_id ?? '')
  const variantId = String(args.variant_id ?? '')
  const quantity = Math.max(1, Math.floor(Number(args.quantity ?? 1)) || 1)
  const method = String(args.method ?? 'mercadopago')
  const provider: CheckoutProvider = method === 'stripe' ? 'stripe' : 'mercadopago'
  const buyerEmail = args.buyer_email ? String(args.buyer_email) : undefined

  const variant = priceGrid.variants.find(v => v.id === variantId)
  if (!variant) {
    return { isError: true, content: [{ type: 'text', text: `variant_id "${variantId}" was not found on this listing's price_grid — call get_listing again for the current variant ids.` }] }
  }
  const tier = resolveTierForQuantity(variant.tiers, quantity)
  if (!tier) {
    return { isError: true, content: [{ type: 'text', text: `No price tier covers a quantity of ${quantity} for this variant.` }] }
  }

  let listing: Listing | null = null
  try {
    const headers = marketMedusaHeaders(marketCode)
    if (!headers) return { content: [{ type: 'text', text: JSON.stringify(marketKeyUnavailable(MARKETS[marketCode]), null, 2) }] }
    const res = await fetch(`${MEDUSA_BASE}/store/listings/${listingId}?market=${marketCode}`, { headers })
    if (res.ok) {
      const data = await res.json() as { listing?: Listing; market_code?: unknown }
      if (!verifyMarketFilter(MARKETS[marketCode], data)) {
        listing = data.listing ?? null
      }
    }
  } catch { /* currency/custom-field checks below degrade if this fails */ }

  const customFields = getCustomFields(listing?.metadata ?? null)
  const fileField = customFields.find(f => f.type === 'file')
  const currency = listing?.currency ?? 'MXN'

  let personalization: PersonalizationPayload | null = null
  if (args.artwork_url) {
    if (!fileField) {
      return { isError: true, content: [{ type: 'text', text: 'This listing has no artwork field — remove artwork_url.' }] }
    }
    // SSRF-hardened per Roadmap/00-ideas/seeds/ssrf-artwork-url-mcp.md — this
    // is an UNAUTHENTICATED call site (create_checkout is in MCP_BUYER_TOOLS),
    // so every download/validation failure below collapses to the SAME
    // generic message. Do not reintroduce a status/size/network-error string
    // here — that reopens the internal-host oracle the seed found.
    const download = await downloadArtworkBytes(String(args.artwork_url), MAX_ARTWORK_SIZE_MB * 1024 * 1024)
    if (!download.ok) {
      return { isError: true, content: [{ type: 'text', text: ARTWORK_DOWNLOAD_ERROR }] }
    }
    const ingest = await ingestArtworkBytes(download.bytes, listingId, fileField.id)
    if (!ingest.ok) {
      return { isError: true, content: [{ type: 'text', text: `Artwork rejected: ${ingest.error}` }] }
    }
    personalization = { fields: [{ id: fileField.id, label: fileField.label, value: ingest.url, type: 'file' }] }
  } else if (fileField?.required) {
    return { isError: true, content: [{ type: 'text', text: `This listing requires artwork ("${fileField.label}") — pass artwork_url.` }] }
  }

  const restatement = `${formatOptionsLines(variant.options).join(' · ')} · Cantidad: ${quantity} · Precio: ${formatPriceGridAmount(tier.amount * quantity, currency)}`

  try {
    const result = await startCheckout({
      productId: listingId,
      variantId,
      quantity,
      personalization,
      provider,
      buyerEmail,
      market: marketCode,
      ...fulfillment,
    })
    if (result.redirect_url) {
      return { content: [{ type: 'text', text: `✅ Checkout ready via ${method === 'stripe' ? 'Stripe' : 'Mercado Pago'}.\n\n${restatement}\n\n**Abre este enlace para completar el pago:**\n${result.redirect_url}` }] }
    }
    return { content: [{ type: 'text', text: `✅ Order created (pago directo).\n\n${restatement}\n\nOrder: ${result.cart_id}` }] }
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Checkout failed: ${publicCheckoutError(e, 'Unable to create configured checkout')}` }] }
  }
}

async function handleGetSupportOptions(args: Record<string, unknown>, baseUrl: string) {
  const embedKey = String(args.embed_key ?? '')
  if (!embedKey) {
    return { isError: true, content: [{ type: 'text', text: 'embed_key es obligatorio.' }] }
  }

  try {
    const res = await fetch(`${baseUrl}/api/embed/support?key=${encodeURIComponent(embedKey)}`, {
      headers: { 'x-miyagi-embed-key': embedKey },
    })
    const data = await res.json()
    if (!res.ok || !data.valid) {
      return { isError: true, content: [{ type: 'text', text: 'Apoyos no disponibles para esta llave.' }] }
    }

    const support = data.support ?? {}
    const providers = data.payment_providers ?? {}
    const presets = Array.isArray(support.preset_amount_cents)
      ? support.preset_amount_cents.map((amount: number) => `$${Math.round(amount / 100)} ${support.currency ?? 'MXN'}`).join(', ')
      : 'No configurados'
    const availableProviders = [
      providers.mercadopago && 'Mercado Pago',
      providers.stripe && 'Stripe',
    ].filter(Boolean).join(', ') || 'Ninguno'

    const summary = [
      `## Apoyos para ${data.shop?.name ?? 'esta tienda'}`,
      `**Montos sugeridos:** ${presets}`,
      `**Rango personalizado:** $${Math.round((support.custom_min_cents ?? 0) / 100)} - $${Math.round((support.custom_max_cents ?? 0) / 100)} ${support.currency ?? 'MXN'}`,
      `**Visibilidad predeterminada:** ${support.default_visibility === 'private' ? 'privado' : 'público'}`,
      `**Métodos disponibles:** ${availableProviders}`,
    ].join('\n\n')

    return { content: [{ type: 'text', text: summary }, { type: 'text', text: JSON.stringify(data, null, 2) }] }
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Network error: ${String(e)}` }] }
  }
}

async function handleCreateSupportCheckout(args: Record<string, unknown>, baseUrl: string) {
  const embedKey = String(args.embed_key ?? '')
  const amountCents = Math.round(Number(args.amount_cents ?? 0))
  const supporterEmail = String(args.supporter_email ?? '')
  const provider = String(args.provider ?? 'mercadopago')
  if (!embedKey || !amountCents || !supporterEmail) {
    return { isError: true, content: [{ type: 'text', text: 'Faltan campos requeridos: embed_key, amount_cents, supporter_email.' }] }
  }

  try {
    const res = await fetch(`${baseUrl}/api/embed/support/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-miyagi-embed-key': embedKey },
      body: JSON.stringify({
        embed_key: embedKey,
        amount_cents: amountCents,
        provider,
        supporter_email: supporterEmail,
        supporter_name: args.supporter_name ? String(args.supporter_name) : undefined,
        message: args.message ? String(args.message) : undefined,
        visibility: args.visibility === 'private' ? 'private' : 'public',
      }),
    })
    const data = await res.json() as { checkout_url?: string; redirect_url?: string; error?: string }
    const checkoutUrl = data.checkout_url ?? data.redirect_url
    if (!res.ok || !checkoutUrl) {
      return { isError: true, content: [{ type: 'text', text: `Support checkout failed: ${data.error ?? 'Unknown error'}` }] }
    }
    return { content: [{ type: 'text', text: `✅ Checkout de apoyo listo.\n\n**Abre este enlace para completar el apoyo:**\n${checkoutUrl}` }] }
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Network error: ${String(e)}` }] }
  }
}

async function handleMakeOffer(args: Record<string, unknown>, baseUrl: string, authHeader?: string | null) {
  const listingId  = String(args.listing_id ?? '')
  const amount     = Number(args.offer_amount)
  const buyerName  = String(args.buyer_name ?? '')
  const buyerEmail = String(args.buyer_email ?? '')

  if (!listingId || isNaN(amount) || !buyerName || !buyerEmail) {
    return { isError: true, content: [{ type: 'text', text: 'Missing required fields: listing_id, offer_amount, buyer_name, buyer_email' }] }
  }
  const marketDecision = planMarketCatalogRead(args.market)
  if (isMarketUnavailable(marketDecision)) {
    return { content: [{ type: 'text', text: JSON.stringify(marketDecision, null, 2) }] }
  }
  const medusaHeaders = marketMedusaHeaders(marketDecision.market.code)
  if (!medusaHeaders) return { content: [{ type: 'text', text: JSON.stringify(marketKeyUnavailable(marketDecision.market), null, 2) }] }

  let listing: { id: string; title: string; price_cents: number | null; listing_type: string; currency?: string | null } | null = null
  try {
    const res = await fetch(`${MEDUSA_BASE}/store/listings/${listingId}?${marketDecision.query}`, { headers: medusaHeaders })
    if (res.ok) {
      const data = await res.json() as { listing?: Listing; market_code?: unknown }
      const unconfirmedMarket = verifyMarketFilter(marketDecision.market, data)
      if (unconfirmedMarket) {
        return { content: [{ type: 'text', text: JSON.stringify(unconfirmedMarket, null, 2) }] }
      }
      if (data.listing?.status === 'active') listing = data.listing
    }
  } catch { /* listing stays null */ }

  if (!listing) return { isError: true, content: [{ type: 'text', text: 'Listing not found or no longer active.' }] }
  if (listing.listing_type === 'digital') return { isError: true, content: [{ type: 'text', text: 'Digital products do not accept offers. Use create_checkout instead.' }] }

  const offerCents = Math.round(amount * 100)
  if (listing.price_cents && offerCents > listing.price_cents) {
    return { isError: true, content: [{ type: 'text', text: `Offer ($${amount}) exceeds list price ($${(listing.price_cents/100).toFixed(2)}). Use create_checkout to buy at list price.` }] }
  }

  const res = await fetch(`${baseUrl}/api/offers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify({ listingId, offerAmountCents: offerCents, buyerName, buyerEmail, message: args.message }),
  })
  const data = await res.json() as { offerId?: string; id?: string; error?: string; requiresAuth?: boolean }
  const offerId = data.offerId ?? data.id
  if (res.status === 401 || data.requiresAuth) {
    return { isError: true, content: [{ type: 'text', text: 'Offer requires an authenticated Miyagi buyer session. Sign in at miyagisanchez.com, then retry from the authenticated client.' }] }
  }
  if (!res.ok || !offerId) return { isError: true, content: [{ type: 'text', text: `Offer failed: ${data.error ?? 'Unknown error'}` }] }

  const english = marketDecision.market.default_locale === 'en-US'
  const currency = (listing.currency ?? marketDecision.market.currency_code).toUpperCase()
  const formattedAmount = new Intl.NumberFormat(marketDecision.market.default_locale, { style: 'currency', currency }).format(amount)
  return { content: [{ type: 'text', text: english
    ? `✅ Offer submitted!\n\n**Offer ID:** \`${offerId}\`\n**Amount:** ${formattedAmount}\n**Listing:** ${listing.title}\n\nThe seller has 48 hours to respond. If accepted, read commerce_readiness before attempting checkout.`
    : `✅ Oferta enviada.\n\n**ID de oferta:** \`${offerId}\`\n**Monto:** ${formattedAmount}\n**Anuncio:** ${listing.title}\n\nEl vendedor tiene 48 horas para responder. Si acepta, revisa commerce_readiness antes de intentar el checkout.` }] }
}

async function handleGetShop(args: Record<string, unknown>, baseUrl: string) {
  const slug  = String(args.shop_slug ?? '')
  const limit = Math.min(Math.max(1, Number(args.limit ?? 10)), 20)
  const marketDecision = planMarketCatalogRead(args.market)
  if (isMarketUnavailable(marketDecision)) {
    return { content: [{ type: 'text', text: JSON.stringify(marketDecision, null, 2) }] }
  }
  const medusaHeaders = marketMedusaHeaders(marketDecision.market.code)
  if (!medusaHeaders) return { content: [{ type: 'text', text: JSON.stringify(marketKeyUnavailable(marketDecision.market), null, 2) }] }

  let seller: Record<string, unknown> | null = null
  try {
    const res = await fetch(`${MEDUSA_BASE}/store/sellers/${slug}`, { headers: medusaHeaders })
    if (!res.ok) return { isError: true, content: [{ type: 'text', text: `Shop "${slug}" not found.` }] }
    const d = await res.json() as { seller?: Record<string, unknown> }
    seller = d.seller ?? null
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Network error: ${String(e)}` }] }
  }

  if (!seller) return { isError: true, content: [{ type: 'text', text: `Shop "${slug}" not found.` }] }
  if (seller.market_code !== marketDecision.market.code) {
    return { isError: true, content: [{ type: 'text', text: `Shop "${slug}" not found in market "${marketDecision.market.code}".` }] }
  }

  let listings: ReturnType<typeof toUcpListing>[] = []
  try {
    const params = new URLSearchParams({
      seller_slug: slug,
      limit: String(limit),
    })
    params.set('market', marketDecision.market.code)
    const res = await fetch(`${MEDUSA_BASE}/store/listings?${params.toString()}`, { headers: medusaHeaders })
    if (!res.ok) {
      return { isError: true, content: [{ type: 'text', text: `Shop catalog failed: ${res.status}` }] }
    }
    const data = await res.json() as { listings?: Listing[]; market_code?: unknown }
    const unconfirmedMarket = verifyMarketFilter(marketDecision.market, data)
    if (unconfirmedMarket) {
      return { content: [{ type: 'text', text: JSON.stringify(unconfirmedMarket, null, 2) }] }
    }
    const inventoryChannelsEnabled = await isEnabled('catalog.inventory_channels_enabled')
    listings = await Promise.all((data.listings ?? []).map(async l =>
      toUcpListing(
        l,
        baseUrl,
        await getPriceGrid(l.medusa_product_id ?? l.id, marketDecision.market.code),
        inventoryChannelsEnabled,
        marketDecision.market.code,
      )))
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: `Shop catalog unavailable: ${String(error)}` }] }
  }

  const isClaimed = isShopClaimed({ clerk_user_id: seller.clerk_user_id == null ? null : String(seller.clerk_user_id) })

  // ── The living storefront, structurally (Living Shop, epic 07 · Story 6.4) ───
  // A shopping agent should be able to read what is HAPPENING at a shop, not
  // only what is for sale — a merchant who posted "new batch Friday" is telling
  // a buyer something a catalog listing cannot.
  //
  // PUBLISHED-AND-EFFECTIVE ONLY. This goes through `readPublicWall`, the same
  // function the human page renders, so a draft or a not-yet-due scheduled entry
  // cannot leak here. A second read path is exactly how one eventually would.
  const wallShop = await resolvePublicWallShop(String(seller.slug))
  const wall = wallShop
    ? await readPublicWall({
        shopId: wallShop.id,
        shopSlug: wallShop.slug,
        basePath: `/${marketDecision.market.code}/s/${wallShop.slug}`,
        // An agent following a product link must reach the real PDP, which is
        // not shop-scoped on the marketplace. See `ShopBases`.
        listingBase: `/${marketDecision.market.code}`,
        locale: marketDecision.market.default_locale,
        pageSize: AGENT_WALL_LIMIT,
      })
    : { entries: [], hasMore: false, total: 0 }

  const settings = ((seller.metadata as Record<string, unknown> | null)?.settings ?? {}) as Record<string, unknown>
  const sectionConfig = normalizeSections(settings.sections)
  const sectionAvailability = await resolveSectionAvailability({
    shopId: wallShop?.id ?? null,
    settings,
    collectionCount: 0,
  })
  const destinations = navEntries(
    sectionConfig,
    // The catalog is always a real destination even when the collections read
    // above was skipped; `collections` is reported from its own availability.
    sectionAvailability,
    `/${marketDecision.market.code}/s/${String(seller.slug)}`,
  )

  const english = marketDecision.market.default_locale === 'en-US'
  const profile = [
    `# ${seller.name}${seller.verified ? (english ? ' ✓ verified' : ' ✓ verificado') : ''}`,
    seller.description ? `\n${seller.description}\n` : '',
    `**${english ? 'Location' : 'Ubicación'}:** ${seller.location ?? (english ? 'Not specified' : 'No especificada')}`,
    `**${english ? 'Claimed shop' : 'Tienda reclamada'}:** ${isClaimed ? (english ? 'Yes' : 'Sí') : 'No'}`,
    `**URL:** ${baseUrl}/${marketDecision.market.code}/s/${seller.slug}`,
    `\n**${listings.length} ${english ? 'active listings' : 'anuncios activos'}:**`,
    ...listings.map(item => `• ${item.title} — ${item.price?.formatted ?? (english ? 'Ask for price' : 'A consultar')} (ID: \`${item.id}\`)`),
    ...(wall.entries.length
      ? [`\n**${english ? 'Recently on this shop\'s wall' : 'Últimamente en el muro'}:**`,
         ...wall.entries.map(e => `• ${e.kind}${e.pinned ? ' (pinned)' : ''} — ${(e.body ?? '').slice(0, 120) || e.reference.state}`)]
      : []),
  ].filter(s => s !== '').join('\n')

  return {
    content: [
      { type: 'text', text: profile },
      { type: 'text', text: JSON.stringify({
        market_code: marketDecision.market.code,
        shop: seller,
        listings,
        // Typed, bounded, and free of drafts — see the comment above the read.
        wall: { entries: wall.entries, total: wall.total, has_more: wall.hasMore },
        sections: destinations,
      }, null, 2) },
    ],
  }
}

async function getShopCalcom(listingId: string, marketCode: MarketCode): Promise<{
  apiKey: string; eventTypeId: number; bookingUrl: string; listing: { title: string; category: string | null }
} | null> {
  try {
    const headers = marketMedusaHeaders(marketCode)
    if (!headers) return null
    const res = await fetch(`${MEDUSA_BASE}/store/listings/${listingId}?market=${marketCode}`, { headers })
    if (!res.ok) return null
    const data = await res.json() as { listing?: Listing; market_code?: unknown }
    if (verifyMarketFilter(MARKETS[marketCode], data)) return null
    const listing = data.listing
    if (!listing?.shop) return null
    const shopMeta = (listing.shop.metadata ?? {}) as Record<string, unknown>
    const calcomApiKey = (shopMeta.calcom_api_key as string | null) ?? null
    if (!calcomApiKey) return null
    const calcomSettings = ((shopMeta.settings as Record<string, unknown> | undefined)?.calcom) as {
      event_type_id?: number; booking_url?: string; connected?: boolean
    } | undefined
    if (!calcomSettings?.connected || !calcomSettings.event_type_id) return null
    return {
      apiKey: calcomApiKey,
      eventTypeId: calcomSettings.event_type_id,
      bookingUrl: ensureUrlProtocol(calcomSettings.booking_url) ?? '',
      listing: { title: listing.title, category: listing.category },
    }
  } catch {
    return null
  }
}

// ── Link-only scheduling fallback ─────────────────────────────────────────────

async function getShopSchedulingLinks(
  listingId: string,
  marketCode: MarketCode,
): Promise<{ bookingUrl: string; label: string; title: string } | null> {
  try {
    const headers = marketMedusaHeaders(marketCode)
    if (!headers) return null
    const res = await fetch(`${MEDUSA_BASE}/store/listings/${listingId}?market=${marketCode}`, { headers })
    if (!res.ok) return null
    const data = await res.json() as { listing?: Listing; market_code?: unknown }
    if (verifyMarketFilter(MARKETS[marketCode], data)) return null
    const listing = data.listing
    if (!listing?.shop) return null
    const shopMeta = (listing.shop.metadata ?? {}) as Record<string, unknown>
    const schedulingMeta = ((shopMeta.settings as Record<string, unknown> | undefined)?.scheduling ?? {}) as { links?: Array<{ label: string; url: string }> }
    const firstLink = schedulingMeta.links?.[0]
    if (!firstLink?.url) return null
    return { bookingUrl: ensureUrlProtocol(firstLink.url) ?? firstLink.url, label: firstLink.label || 'Reservas en línea', title: listing.title }
  } catch {
    return null
  }
}

async function handleCheckAvailability(args: Record<string, unknown>) {
  const listingId = String(args.listing_id ?? '')
  if (!listingId) return { isError: true, content: [{ type: 'text', text: 'listing_id is required' }] }
  const marketDecision = planMarketCatalogRead(args.market)
  if (isMarketUnavailable(marketDecision)) {
    return { content: [{ type: 'text', text: JSON.stringify(marketDecision, null, 2) }] }
  }
  const english = marketDecision.market.default_locale === 'en-US'

  const cal = await getShopCalcom(listingId, marketDecision.market.code)
  if (!cal) {
    // Try link-only fallback — seller pasted a booking link without an API key
    const linkSchedule = await getShopSchedulingLinks(listingId, marketDecision.market.code)
    if (!linkSchedule) {
      return { isError: true, content: [{ type: 'text', text: 'This listing does not have scheduling enabled. Use the booking_url from get_listing to book directly.' }] }
    }
    return {
      content: [{
        type: 'text',
        text: [
          `## ${english ? 'Scheduling' : 'Agendamiento'} — ${linkSchedule.title}`,
          '',
          `This seller uses a **manual booking link** (${linkSchedule.label}). Real-time availability checking is not available, but you can book directly:`,
          '',
          `🔗 **${linkSchedule.bookingUrl}**`,
          '',
          'Open the link to see available times and complete your booking. The seller will receive a confirmation notification.',
          '',
          `> **Note:** If the buyer prefers AI-assisted booking with real-time availability, suggest the seller connect their Cal.com API key in their shop settings.`,
        ].join('\n'),
      }, {
        type: 'text',
        text: JSON.stringify({ listing_id: listingId, mode: 'link_only', booking_url: linkSchedule.bookingUrl }, null, 2),
      }],
    }
  }

  const today    = new Date()
  const dateFrom = String(args.date_from ?? today.toISOString().slice(0, 10))
  const dateTo   = String(args.date_to ?? new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10))
  const timezone = String(args.timezone ?? marketDecision.market.timezone)

  let slots: Record<string, Array<{ time: string }>>
  try {
    slots = await getCalAvailableSlots(cal.apiKey, cal.eventTypeId, dateFrom, dateTo, timezone)
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Could not fetch availability: ${String(err)}` }] }
  }

  const days = Object.entries(slots).filter(([, daySlots]) => daySlots.length > 0)
  if (days.length === 0) {
    return { content: [{ type: 'text', text: `No available slots for **${cal.listing.title}** between ${dateFrom} and ${dateTo}.\n\nTry a wider date range or contact the seller directly.` }] }
  }

  const summary = [
    `## ${english ? 'Availability for' : 'Disponibilidad para'} ${cal.listing.title}`,
    `📅 **${days.length} ${english ? `available day${days.length === 1 ? '' : 's'}` : `día${days.length > 1 ? 's' : ''} disponibles`}** (${dateFrom} → ${dateTo})`,
    '',
    ...days.map(([date, daySlots]) => {
      const d = new Date(date)
      const dayLabel = d.toLocaleDateString(marketDecision.market.default_locale, { weekday: 'long', month: 'long', day: 'numeric', timeZone: timezone })
      const times = daySlots.slice(0, 8).map(s => {
        const t = new Date(s.time)
        return t.toLocaleTimeString(marketDecision.market.default_locale, { hour: '2-digit', minute: '2-digit', timeZone: timezone })
      }).join(' · ')
      return `**${dayLabel}**\n${times}${daySlots.length > 8 ? ` +${daySlots.length - 8} ${english ? 'more' : 'más'}` : ''}`
    }),
    '',
    '→ Use `book_appointment` with the `start_time` in ISO 8601 format to confirm a slot.',
  ].join('\n')

  return { content: [{ type: 'text', text: summary }, { type: 'text', text: JSON.stringify({ listing_id: listingId, slots }, null, 2) }] }
}

async function handleBookAppointment(args: Record<string, unknown>) {
  const listingId  = String(args.listing_id ?? '')
  const startTime  = String(args.start_time ?? '')
  const buyerName  = String(args.buyer_name ?? '')
  const buyerEmail = String(args.buyer_email ?? '')

  if (!listingId || !startTime || !buyerName || !buyerEmail) {
    return { isError: true, content: [{ type: 'text', text: 'Required: listing_id, start_time, buyer_name, buyer_email' }] }
  }
  const marketDecision = planMarketCatalogRead(args.market)
  if (isMarketUnavailable(marketDecision)) {
    return { content: [{ type: 'text', text: JSON.stringify(marketDecision, null, 2) }] }
  }
  const timezone = String(args.timezone ?? marketDecision.market.timezone)
  const english = marketDecision.market.default_locale === 'en-US'

  const cal = await getShopCalcom(listingId, marketDecision.market.code)
  if (!cal) {
    // Try link-only fallback
    const linkSchedule = await getShopSchedulingLinks(listingId, marketDecision.market.code)
    if (!linkSchedule) {
      return { isError: true, content: [{ type: 'text', text: 'This listing does not have scheduling enabled.' }] }
    }
    return {
      content: [{
        type: 'text',
        text: [
          `## Booking Required — ${linkSchedule.title}`,
          '',
          `This seller manages their own booking via ${linkSchedule.label}. I cannot book on your behalf, but here's the direct link:`,
          '',
          `🔗 **${linkSchedule.bookingUrl}**`,
          '',
          `Share this link with the buyer so they can select their preferred time. The confirmation will be sent to their email.`,
        ].join('\n'),
      }],
    }
  }

  let booking
  try {
    booking = await createCalBooking(
      cal.apiKey,
      cal.eventTypeId,
      startTime,
      buyerName,
      buyerEmail,
      timezone,
      args.notes ? String(args.notes) : undefined
    )
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Booking failed: ${String(err)}` }] }
  }

  const startDate = new Date(booking.startTime)
  const formattedDate = startDate.toLocaleString(marketDecision.market.default_locale, {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: timezone,
  })
  const agendarLabel = cal.listing.category === 'autos' ? 'prueba de manejo'
    : cal.listing.category === 'inmuebles' ? 'visita' : 'cita'

  const englishAppointment = cal.listing.category === 'autos' ? 'Test drive'
    : cal.listing.category === 'inmuebles' ? 'Visit' : 'Appointment'
  const summary = [
    `## ✅ ${english ? `${englishAppointment} booked` : `${agendarLabel.charAt(0).toUpperCase() + agendarLabel.slice(1)} agendada`}`,
    '',
    `**${english ? 'Listing' : 'Anuncio'}:** ${cal.listing.title}`,
    `**${english ? 'Date' : 'Fecha'}:** ${formattedDate}`,
    `**${english ? 'Confirmation sent to' : 'Confirmación enviada a'}:** ${buyerEmail}`,
    `**Booking ID:** \`${booking.uid}\``,
    '',
    english ? 'The seller was notified too. Check your email for details.' : 'El vendedor también recibió una notificación. Revisa tu correo para más detalles.',
  ].join('\n')

  return { content: [{ type: 'text', text: summary }, { type: 'text', text: JSON.stringify(booking, null, 2) }] }
}

async function handleGetBuyerTrust(args: Record<string, unknown>) {
  const identifier = String(args.identifier ?? '').trim()
  if (!identifier) {
    return { isError: true, content: [{ type: 'text', text: 'identifier is required (email or Clerk user ID)' }] }
  }

  const isClerkId = identifier.startsWith('user_')
  const isEmail   = !isClerkId && identifier.includes('@')
  if (!isClerkId && !isEmail) {
    return { isError: true, content: [{ type: 'text', text: 'identifier must be an email address or Clerk user ID (user_xxx)' }] }
  }

  const trust = await computeTrustScore(identifier)

  const earned   = trust.signals.filter(s => s.earned)
  const unearned = trust.signals.filter(s => !s.earned)

  const summary = [
    `## OmniReputation — ${trust.level_label}`,
    `**Score:** ${trust.score}/100 · **Nivel:** ${trust.level}`,
    `**Buyer:** ${identifier}`,
    '',
    `### Señales obtenidas (${earned.length})`,
    ...earned.map(s => `✅ ${s.label} (+${s.points} pts) — ${s.description}`),
    ...(unearned.length > 0 ? [
      '',
      `### Señales no obtenidas (${unearned.length})`,
      ...unearned.map(s => `⬜ ${s.label} (+${s.points} pts) — ${s.description}`),
    ] : []),
    '',
    `*Calculado: ${trust.computed_at}*`,
  ].join('\n')

  return { content: [{ type: 'text', text: summary }, { type: 'text', text: JSON.stringify(trust, null, 2) }] }
}

// ── Seller-side config tools (Sprint 4) ───────────────────────────────────────

const AGENT_AUTH_HINT =
  'This is a seller tool. Provide your shop agent token as `Authorization: Bearer ms_agent_…`. ' +
  'Generate or rotate it under “Agentes e integraciones” in your Miyagi Sánchez shop settings. ' +
  'The token is scoped to a single shop.'

async function handleGetStoreConfiguration(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'get_store_configuration')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop

  // Agent credentials resolve a mirror row. That row may enumerate/identify the
  // shop, but cannot become market truth; read the public Medusa seller projection
  // before presenting operating-market data to the agent.
  const publicSeller = shop.slug ? await getShop(shop.slug) : null
  const snapshot = buildStoreConfigSnapshot(shop, readPublicSellerMarket(publicSeller))
  const manualLines = snapshot.manual_sections.map((m) => `- ${m.label}: ${m.why}`).join('\n')
  const summary = [
    `## Configuración de ${shop.name ?? 'tu tienda'}`,
    `**Mercado operativo:** ${snapshot.operating_market
      ? `${snapshot.operating_market.market_code.toUpperCase()} · ${snapshot.operating_market.marketplace_status}`
      : 'no disponible (no se asumió MX)'}`,
    `**Bloques con datos:** ${snapshot.configured_blocks.length ? snapshot.configured_blocks.join(', ') : 'ninguno aún'}`,
    '',
    'Estos bloques son editables con `patch_store_configuration`. Lo siguiente requiere un paso manual y NO se puede cambiar por agente:',
    manualLines,
  ].join('\n')

  return {
    content: [
      { type: 'text', text: summary },
      { type: 'text', text: JSON.stringify(snapshot, null, 2) },
    ],
  }
}

async function handlePatchStoreConfiguration(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'patch_store_configuration')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop

  // Accept either { configuration: {...} } or the manifest at the top level.
  const raw = (args.configuration && typeof args.configuration === 'object' && !Array.isArray(args.configuration))
    ? args.configuration as Record<string, unknown>
    : args
  if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) {
    return { isError: true, content: [{ type: 'text', text: 'Provide a `configuration` object with at least one block to change.' }] }
  }

  // Flag OAuth/manual blocks the agent tried to set — we ignore them by design.
  const manualKeys = new Set(MANUAL_SECTIONS.map((m) => m.key))
  const ignoredManual = Object.keys(raw).filter((k) => manualKeys.has(k))

  // HIGH-risk blocks each behind their own kill-switch (mcp-parity-core S4) —
  // refuse the whole call rather than silently dropping the block, so the
  // agent knows exactly why nothing changed and can retry without it.
  if ('support' in raw && !(await isEnabled('mcp.support_config.enabled'))) {
    return { isError: true, content: [{ type: 'text', text: 'El bloque "support" aún no está disponible por agente. Reintenta sin ese bloque, o configúralo desde el portal.' }] }
  }
  if ('checkout' in raw && !(await isEnabled('mcp.checkout_config.enabled'))) {
    return { isError: true, content: [{ type: 'text', text: 'El bloque "checkout" aún no está disponible por agente. Reintenta sin ese bloque, o configúralo desde el portal.' }] }
  }

  const result = await applyStoreConfig(shop.clerk_user_id, null, raw as StoreConfigManifest)

  if (!result.ok) {
    const issues = result.blocks.flatMap((b) => b.issues.map((i) => `- ${b.label}: ${i}`)).join('\n')
    return {
      isError: true,
      content: [{ type: 'text', text: `No se aplicó ningún cambio. ${result.error ?? ''}${issues ? `\n\n${issues}` : ''}` }],
    }
  }

  // Refresh storefront/PDP caches so the change shows immediately.
  revalidateTag('listings', 'default')
  revalidateTag('shops', 'default')

  // Operational audit log + security notifications (best-effort, never blocks).
  await recordAgentConfigChange(shop, result)

  const lines = result.blocks.map((b) =>
    b.status === 'applied'
      ? `✅ ${b.label}: ${b.appliedFields.join(', ')}${b.issues.length ? ` (omitidos: ${b.issues.join('; ')})` : ''}`
      : `⏭️ ${b.label}: sin cambios válidos${b.issues.length ? ` (${b.issues.join('; ')})` : ''}`,
  )
  const summary = [
    `## Configuración actualizada — ${shop.name ?? 'tu tienda'}`,
    ...lines,
    // NOT pure config — a real, purchasable Medusa product now exists (or was
    // re-confirmed) in the shop's catalog. The agent caller must be told
    // (mcp-parity-core S4.1 acceptance).
    ...(result.supportProduct
      ? ['', `⚠️ Al activar los apoyos se ${result.supportProduct.reused ? 'reutilizó' : 'CREÓ'} un producto real de apoyos en tu catálogo (product_id: ${result.supportProduct.product_id}) — no es solo configuración.`]
      : []),
    ...(ignoredManual.length ? ['', `⚠️ Ignorado (requiere paso manual): ${ignoredManual.join(', ')}`] : []),
  ].join('\n')

  return {
    content: [
      { type: 'text', text: summary },
      { type: 'text', text: JSON.stringify({ ok: true, blocks: result.blocks, ignored_manual: ignoredManual, ...(result.supportProduct ? { support_product: result.supportProduct } : {}) }, null, 2) },
    ],
  }
}

// ── Living Shop — Wall tools (epic 07, Story 6.3) ─────────────────────────────
// Thin dispatchers. The behaviour lives in `lib/wall/agent.ts` so it is
// reachable from a spec, and so this route stays a router rather than growing a
// fifth copy of the Wall's rules.

async function resolveWallShop(args: Record<string, unknown>, authHeader: string | null | undefined, tool: string) {
  const agentAuth = await resolveToolShop(authHeader, args, tool)
  if (!agentAuth.ok) return { ok: false as const, message: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }
  const shop = agentAuth.shop
  if (!shop.id || !shop.slug) {
    return { ok: false as const, message: 'Esta credencial no resuelve una tienda con muro.' }
  }
  return { ok: true as const, shop: { id: shop.id, slug: shop.slug, name: shop.name ?? shop.slug }, clerkUserId: shop.clerk_user_id }
}

function wallToolResponse(outcome: WallToolOutcome) {
  if (!outcome.ok) return { isError: true, content: [{ type: 'text', text: outcome.message }] }
  return {
    content: [
      { type: 'text', text: outcome.message },
      { type: 'text', text: JSON.stringify(outcome.data, null, 2) },
    ],
  }
}

async function handleListWallEntries(args: Record<string, unknown>, authHeader?: string | null) {
  const resolved = await resolveWallShop(args, authHeader, 'list_wall_entries')
  if (!resolved.ok) return { isError: true, content: [{ type: 'text', text: resolved.message }] }
  return wallToolResponse(await agentListWall(resolved.shop))
}

async function handleCreateWallEntry(args: Record<string, unknown>, authHeader?: string | null) {
  const resolved = await resolveWallShop(args, authHeader, 'create_wall_entry')
  if (!resolved.ok) return { isError: true, content: [{ type: 'text', text: resolved.message }] }
  const outcome = await agentCreateWallEntry(resolved.shop, resolved.clerkUserId ?? 'agent', args)
  if (outcome.ok) {
    revalidateTag('listings', 'default')
    // Every Wall write is audited, same as a config patch: an agent changing what
    // a merchant's storefront SAYS is at least as consequential as changing how
    // it looks, and the log is the only after-the-fact record either way.
    await recordAgentWallChange(resolved.shop, 'create_wall_entry', outcome.data)
  }
  return wallToolResponse(outcome)
}

async function handleUpdateWallEntry(args: Record<string, unknown>, authHeader?: string | null) {
  const resolved = await resolveWallShop(args, authHeader, 'update_wall_entry')
  if (!resolved.ok) return { isError: true, content: [{ type: 'text', text: resolved.message }] }
  const entryId = String(args.entry_id ?? '')
  if (!entryId) return { isError: true, content: [{ type: 'text', text: 'Falta entry_id.' }] }
  const outcome = await agentUpdateWallEntry(resolved.shop, entryId, args)
  if (outcome.ok) {
    revalidateTag('listings', 'default')
    await recordAgentWallChange(resolved.shop, 'update_wall_entry', outcome.data)
  }
  return wallToolResponse(outcome)
}

async function handleDeleteWallEntry(args: Record<string, unknown>, authHeader?: string | null) {
  const resolved = await resolveWallShop(args, authHeader, 'delete_wall_entry')
  if (!resolved.ok) return { isError: true, content: [{ type: 'text', text: resolved.message }] }
  const entryId = String(args.entry_id ?? '')
  if (!entryId) return { isError: true, content: [{ type: 'text', text: 'Falta entry_id.' }] }
  const outcome = await agentDeleteWallEntry(resolved.shop, entryId)
  if (outcome.ok) {
    revalidateTag('listings', 'default')
    await recordAgentWallChange(resolved.shop, 'delete_wall_entry', outcome.data)
  }
  return wallToolResponse(outcome)
}

async function handleListOffers(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'list_offers')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop

  const offers = await listShopOffers(shop.id, { actionableOnly: args.pending_only === true })
  if (offers.length === 0) {
    return { content: [{ type: 'text', text: 'No hay ofertas abiertas en este momento.' }] }
  }

  const lines = offers.map((o) =>
    `• **${o.listing_title}** — ${o.offer_amount} (${o.pct_of_asking}% de ${o.list_price}, ${o.quality}) ` +
    `· ${o.buyer_name} · ${o.status}${o.status === 'countered' && o.counter_amount ? ` (contraoferta ${o.counter_amount})` : ''} ` +
    `· vence en ${o.expires_in}\n  id: \`${o.id}\`${o.message ? `\n  «${o.message}»` : ''}`,
  )
  const summary = [`## Ofertas abiertas (${offers.length})`, ...lines].join('\n')

  return {
    content: [
      { type: 'text', text: summary },
      { type: 'text', text: JSON.stringify({ offers }, null, 2) },
    ],
  }
}

async function handleRespondToOffer(args: Record<string, unknown>, baseUrl: string, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'respond_to_offer')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop

  const offerId = String(args.offer_id ?? '')
  const action = String(args.action ?? '') as 'accept' | 'counter' | 'decline'
  if (!offerId || !['accept', 'counter', 'decline'].includes(action)) {
    return { isError: true, content: [{ type: 'text', text: 'Provide offer_id and action (accept | counter | decline).' }] }
  }
  const counterAmountCents = action === 'counter' && typeof args.counter_amount_mxn === 'number'
    ? Math.round(args.counter_amount_mxn * 100)
    : undefined

  const result = await respondToOffer({
    offerId,
    authorizedClerkUserId: shop.clerk_user_id,
    origin: baseUrl,
    action,
    counterAmountCents,
    counterMessage: args.counter_message ? String(args.counter_message) : undefined,
  })

  if (!result.ok) {
    return { isError: true, content: [{ type: 'text', text: `No se pudo responder la oferta: ${result.error}` }] }
  }

  // Audit + admin notification (best-effort; never fails the response).
  await recordAgentOfferAction(shop, { offerId, action, counterAmountCents })

  const msg = result.status === 'accepted'
    ? '✅ Oferta aceptada. Se envió al comprador el enlace de pago — la venta queda comprometida a ese precio.'
    : result.status === 'countered'
      ? '✅ Contraoferta enviada al comprador.'
      : '✅ Oferta rechazada.'
  return {
    content: [
      { type: 'text', text: msg },
      { type: 'text', text: JSON.stringify({ ok: true, status: result.status, offer_id: offerId }, null, 2) },
    ],
  }
}

/**
 * ── Consent-safe previews: the MCP listing-write boundary ──────────────────────
 *
 * A shop awaiting its merchant's approval (founding-merchant-consent-previews)
 * must not be published or reshaped through the agent surface. This matters
 * concretely, not theoretically: `autoGrantPartnerOnClose` mints the promoter a
 * `manager` partner grant on the very shop `shop/setup` just anchored private, and
 * `resolveToolShop`'s partner branch resolves shops straight from `partner_grants`
 * with no anchor or claim check. So the promoter who created the proposal can reach
 * every tool below with a partner credential.
 *
 * An earlier revision guarded only `create_listing` — a comment there even named
 * this vector — which left `set_listing_status` able to publish a merchant's
 * products with no approval, no checklist and no consent record at all. Guarding
 * one known door per vector is what produced that gap, so these two helpers exist
 * to be applied to EVERY listing-write tool, and the rule is chosen per what the
 * write actually does:
 *
 *   REFUSE   — writes that publish or destroy. Publication is activation's
 *              exclusive job (it is the only path that checks approval + the
 *              readiness checklist), and a delete removes content the merchant
 *              approved, which also strands activation's replay path.
 *   INVALIDATE — content edits. The edit is allowed (the promoter still needs to
 *              fix a title or price before sending the preview), but any current
 *              approval no longer describes what would be published, so it is
 *              invalidated exactly as `close/listing` does.
 *
 * Both fail CLOSED via `shopMustStayPrivate`, which treats an unreadable anchor as
 * private.
 */
async function refusePreviewPrivateWrite(
  shopId: string,
  action: string,
): Promise<{ isError: true; content: Array<{ type: string; text: string }> } | null> {
  if (!(await shopMustStayPrivate(shopId))) return null
  return {
    isError: true,
    content: [{
      type: 'text',
      text: `Esta tienda está en vista previa privada, esperando la aprobación del comerciante. `
        + `No se puede ${action} hasta que el comerciante apruebe y se active la tienda.`,
    }],
  }
}

/**
 * Seller-agent credentials identify a mirror row, but a mirror is not market
 * truth. Resolve the public Medusa seller projection before any action that can
 * create or reactivate a marketplace listing. Failed resolution intentionally
 * blocks publication rather than treating the shop as MX by default.
 */
async function refuseMarketplacePublication(
  shop: AgentShop,
  action: string,
): Promise<{ isError: true; content: Array<{ type: string; text: string }> } | null> {
  const publicSeller = shop.slug ? await getShop(shop.slug) : null
  const block = agentMarketplacePublicationBlock(readPublicSellerMarket(publicSeller))
  if (!block) return null
  return {
    isError: true,
    content: [{ type: 'text', text: `No se puede ${action}. ${block}` }],
  }
}

/**
 * A content edit landed on a previewed shop — any current approval is now stale.
 * Idempotent and best-effort: a shop with no anchor, or one whose snapshot didn't
 * materially change, is left completely alone, and a failure here never fails the
 * edit that already succeeded (same posture as `close/listing`).
 */
async function invalidatePreviewApprovalAfterEdit(shopId: string): Promise<void> {
  try {
    const preview = await getPreviewByShop(shopId)
    if (!preview) return
    const outcome = await invalidateIfMaterialChange(preview)
    if (outcome.invalidated) {
      await emitPreviewEvent('preview_invalidated', {
        shopId,
        previewId: preview.id,
        version: preview.currentVersion,
      })
    }
  } catch {
    // Observability-grade step; never break the write that already landed.
  }
}

async function handleCreateListing(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'create_listing')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!shop.slug) return { isError: true, content: [{ type: 'text', text: 'Tu tienda no tiene un identificador (slug) configurado.' }] }

  // create_listing publishes a viable listing by default, so this has to run
  // before image ingestion or any durable catalog work.
  const marketRefused = await refuseMarketplacePublication(shop, 'crear un anuncio')
  if (marketRefused) return marketRefused

  // Shape the agent's args into a catalog-import row and re-validate server-side
  // (never trust the agent) — reuses the exact rules the bulk importer enforces.
  // Autos fields flow through unchanged: stageRow() (called inside validateRows)
  // already assembles metadata.attrs.* from these flat columns when
  // category==='autos' (cars-vertical-tratocar-parity S2.3) — same path bulk
  // import uses, so no new attrs-building logic is needed here.
  const raw: Record<string, unknown> = {
    title: args.title,
    category: args.category,
    description: args.description,
    price: args.price_mxn,
    currency: args.currency,
    listing_type: args.listing_type,
    condition: args.condition,
    quantity: args.quantity,
    state: args.state,
    city: args.city,
    images: args.images,
    weight_grams: args.weight_grams,
    make: args.make,
    model: args.model,
    year: args.year,
    km: args.km,
    fuel_type: args.fuel_type,
    transmission: args.transmission,
    color: args.color,
    financing_down_payment_pct: args.financing_down_payment_pct,
    financing_months: args.financing_months,
    warranty_text: args.warranty_text,
    warranty_months: args.warranty_months,
    inspection_report_url: args.inspection_report_url,
  }
  const [staged] = validateRows([raw])
  if (!staged?.valid) {
    const reason = staged?.issues.find((i) => i.level === 'error')?.message ?? 'Datos del anuncio inválidos.'
    return { isError: true, content: [{ type: 'text', text: `No se pudo crear el anuncio: ${reason}` }] }
  }
  const row: CatalogImportRow = staged.row
  const listingType = row.listing_type ?? 'product'
  const isStockable = listingType === 'product'

  // Pull any remote image URLs into our R2 pipeline (SSRF-guarded, capped,
  // graceful per-image fallback — same path as bulk import).
  const ingest = await ingestImageUrls(shop.clerk_user_id, row.images ?? [], row.title)

  // Viability guardrail: a physical product the shop can't actually sell yet
  // (no delivery AND/OR no payment) is created as a draft, never a live listing
  // no buyer could check out.
  const block = isStockable ? listingActivationBlock(shop.metadata, 'product') : null
  // Consent-safe previews: a shop still awaiting its merchant's approval must
  // never receive a PUBLISHED listing, from any writer. This seam matters
  // specifically because `autoGrantPartnerOnClose` hands a partner MCP credential
  // to the promoter on the very shops this epic anchors — and
  // `listingActivationBlock` returns null for every non-`product` listing type,
  // so a service/rental/digital listing would otherwise publish straight into a
  // private proposal.
  const previewPrivate = await shopMustStayPrivate(shop.id)
  const status: 'published' | 'draft' = block || previewPrivate ? 'draft' : 'published'

  const priceCents = row.price != null ? Math.round(row.price * 100) : null
  const location = [row.city?.trim(), row.state?.trim()].filter(Boolean).join(', ') || null

  const result = await createSellerProductViaInternal(shop.slug, {
    title: row.title,
    description: row.description ?? null,
    price_cents: priceCents,
    currency: row.currency ?? 'MXN',
    condition: isStockable ? (row.condition ?? null) : null,
    listing_type: listingType,
    category: row.category,
    state: row.state || null,
    municipio: row.city || null,
    location,
    quantity: isStockable ? Math.max(1, Math.floor(row.quantity ?? 1)) : 1,
    weight_grams: row.weight_grams ?? null,
    status,
    images: ingest.images,
    ...(row.attrs && Object.keys(row.attrs).length > 0 ? { attrs: row.attrs } : {}),
  })
  if (!result.ok || !result.product_id) {
    return { isError: true, content: [{ type: 'text', text: `No se pudo crear el anuncio: ${result.error}` }] }
  }
  const productId = result.product_id

  // Mirror to the Supabase storefront copy so it shows in the portal + list_my_listings.
  await syncSupabaseListingMirror(shop.id, {
    id: productId,
    title: row.title,
    description: row.description ?? null,
    price_cents: priceCents,
    currency: row.currency ?? 'MXN',
    condition: isStockable ? (row.condition ?? null) : null,
    listing_type: listingType,
    category: row.category,
    state: row.state || null,
    municipio: row.city || null,
    location,
    images: ingest.images,
    // A consent-private listing mirrors as 'draft' (the state the preview
    // presentation reads), not 'paused' — pausing is a seller action on a live
    // listing and would hide it from the merchant's own proposal.
    status: status === 'published' ? 'active' : previewPrivate ? 'draft' : 'paused',
  })

  // Adding a product changes the set the merchant reviewed — parity with
  // close/listing, which invalidates on the same event.
  if (previewPrivate) await invalidatePreviewApprovalAfterEdit(shop.id)
  await recordAgentListingCreate(shop, { productId, title: row.title, status })
  revalidateTag('listings', 'default')
  revalidateTag('shops', 'default')

  const imgNote = ingest.failed > 0 ? ` (${ingest.failed} imagen(es) no se pudieron importar)` : ''
  const draftNote = status !== 'draft'
    ? ''
    : previewPrivate
      // The shop is awaiting its merchant's approval — say so plainly rather than
      // reporting the unrelated delivery/payment guardrail (`block` is null here).
      ? '\n⚠️ Guardado como borrador privado: esta tienda espera la aprobación del comerciante antes de publicarse.'
      : `\n⚠️ Guardado como borrador (pausado). ${block}`
  return {
    content: [
      { type: 'text', text: `✅ Anuncio creado${status === 'published' ? ' y publicado' : ''}: «${row.title}».${imgNote}${draftNote}\n\nproduct_id: \`${productId}\`` },
    ],
  }
}

async function handleListMyListings(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'list_my_listings')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop

  const listings = await listShopListings(shop.id)
  if (listings.length === 0) return { content: [{ type: 'text', text: 'No tienes anuncios todavía.' }] }

  const lines = listings.map((l) =>
    `• **${l.title}** — ${l.price ?? 'sin precio'} · ${l.status} · ${l.listing_type}\n  product_id: \`${l.product_id}\``,
  )
  return {
    content: [
      { type: 'text', text: [`## Tus anuncios (${listings.length})`, ...lines].join('\n') },
      { type: 'text', text: JSON.stringify({ listings }, null, 2) },
    ],
  }
}

/**
 * get_share_kit (share-kit S3.3, D19). The shop comes from `resolveToolShop` alone (seller credentials ignore any
 * slug argument), and the links from the same public model the catalog page, PDF and feed read, so an agent is
 * handed nothing a buyer could not open.
 */
async function handleGetShareKit(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'get_share_kit')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const slug = agentAuth.shop.slug
  const model = slug ? await publicCatalogModel(slug) : null
  if (!model) {
    return { isError: true, content: [{ type: 'text', text: 'El kit para compartir es para tiendas de México con catálogo público. Esta tienda no tiene uno.' }] }
  }
  const feed = model.shop.claimed ? buildMetaFeed(model) : null
  const kit = {
    shop_slug: model.shop.slug,
    products: model.items.length,
    catalog_url: model.links.catalog,
    catalog_short_url: model.links.catalogShort,
    catalog_pdf_url: model.links.pdf,
    meta_feed_url: feed ? model.links.feed : null,
    meta_feed: feed ? { included: feed.included, excluded: feed.excluded } : null,
  }
  const lines = [
    `## Kit para compartir — ${model.shop.name}`,
    `• Catálogo: ${kit.catalog_url} (corto: ${kit.catalog_short_url})`,
    `• Catálogo PDF: ${kit.catalog_pdf_url}`,
    feed
      ? `• Feed para Instagram y WhatsApp (Meta Commerce Manager): ${kit.meta_feed_url} — ${feed.included} productos${metaFeedExcludedCount(feed) > 0 ? `; ${metaFeedExcludedCount(feed)} no aparecen (sin foto: ${feed.excluded.no_photo}, sin precio: ${feed.excluded.no_price})` : ''}`
      : '• Feed para Meta: disponible cuando la tienda esté reclamada.',
  ]
  return { content: [{ type: 'text', text: lines.join('\n') }, { type: 'text', text: JSON.stringify(kit, null, 2) }] }
}

async function handleListMyCollections(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'list_my_collections')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!shop.slug) return { isError: true, content: [{ type: 'text', text: 'Tu tienda no tiene un identificador (slug) configurado.' }] }

  const collections = await getShopCollections(shop.slug)
  if (collections.length === 0) return { content: [{ type: 'text', text: 'Aún no tienes colecciones. Usa create_collection para crear una.' }] }

  const shaped = collections.map((c) => ({ name: c.name, slug: shortCollectionSlug(c.handle, shop.slug!) }))
  const lines = shaped.map((c) => `• **${c.name}** (slug: \`${c.slug}\`)`)
  return {
    content: [
      { type: 'text', text: [`## Tus colecciones (${shaped.length})`, ...lines].join('\n') },
      { type: 'text', text: JSON.stringify({ collections: shaped }, null, 2) },
    ],
  }
}

async function handleCreateCollection(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'create_collection')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!shop.slug) return { isError: true, content: [{ type: 'text', text: 'Tu tienda no tiene un identificador (slug) configurado.' }] }

  const validated = validateCollectionName(args.name)
  if (!validated.ok) return { isError: true, content: [{ type: 'text', text: validated.error }] }

  const result = await createSellerCollectionViaInternal(shop.slug, validated.name)
  if (!result.ok || !result.collection) {
    return { isError: true, content: [{ type: 'text', text: `No se pudo crear la colección: ${result.error}` }] }
  }

  revalidateTag('listings', 'default')
  revalidateTag('shops', 'default')

  const shaped = { name: result.collection.name, slug: shortCollectionSlug(result.collection.handle, shop.slug) }
  return {
    content: [
      { type: 'text', text: `✅ Colección creada: «${shaped.name}» (slug: \`${shaped.slug}\`).\n\nUsa este nombre en collection_names de update_listing para asignarle anuncios.` },
      { type: 'text', text: JSON.stringify({ collection: shaped }, null, 2) },
    ],
  }
}

/** Resolve a collection short slug → the shop's collection row (id/handle/name), or null. */
async function resolveOwnCollection(shopSlug: string, collectionSlug: string) {
  const collections = await getShopCollections(shopSlug)
  return collections.find((c) => shortCollectionSlug(c.handle, shopSlug) === collectionSlug) ?? null
}

async function handleUpdateCollection(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'update_collection')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!shop.slug) return { isError: true, content: [{ type: 'text', text: 'Tu tienda no tiene un identificador (slug) configurado.' }] }

  const validated = validateCollectionName(args.name)
  if (!validated.ok) return { isError: true, content: [{ type: 'text', text: validated.error }] }

  const collectionSlug = String(args.collection_slug ?? '')
  const collection = await resolveOwnCollection(shop.slug, collectionSlug)
  if (!collection) return { isError: true, content: [{ type: 'text', text: `No encontré la colección \`${collectionSlug}\` en tu tienda. Usa list_my_collections para ver tus colecciones.` }] }

  const result = await renameSellerCollectionViaInternal(shop.slug, collection.id, validated.name)
  if (!result.ok) return { isError: true, content: [{ type: 'text', text: `No se pudo renombrar la colección: ${result.error}` }] }

  revalidateTag('listings', 'default')
  revalidateTag('shops', 'default')

  return {
    content: [
      { type: 'text', text: `✅ Colección renombrada: «${collection.name}» → «${validated.name}» (slug: \`${collectionSlug}\`, sin cambios — las URLs /c/… se mantienen).` },
    ],
  }
}

async function handleDeleteCollection(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'delete_collection')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!shop.slug) return { isError: true, content: [{ type: 'text', text: 'Tu tienda no tiene un identificador (slug) configurado.' }] }

  const collectionSlug = String(args.collection_slug ?? '')
  const collection = await resolveOwnCollection(shop.slug, collectionSlug)
  if (!collection) return { isError: true, content: [{ type: 'text', text: `No encontré la colección \`${collectionSlug}\` en tu tienda. Usa list_my_collections para ver tus colecciones.` }] }

  const result = await deleteSellerCollectionViaInternal(shop.slug, collection.id)
  if (!result.ok) return { isError: true, content: [{ type: 'text', text: `No se pudo eliminar la colección: ${result.error}` }] }

  revalidateTag('listings', 'default')
  revalidateTag('shops', 'default')

  return {
    content: [
      { type: 'text', text: `✅ Colección eliminada: «${collection.name}». Sus anuncios NO se eliminaron — solo dejaron de estar agrupados en esa colección.` },
    ],
  }
}

async function handleReorderCollections(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'reorder_collections')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!shop.slug) return { isError: true, content: [{ type: 'text', text: 'Tu tienda no tiene un identificador (slug) configurado.' }] }

  const ordered = args.ordered_slugs
  if (!Array.isArray(ordered) || ordered.length === 0 || ordered.some((s) => typeof s !== 'string')) {
    return { isError: true, content: [{ type: 'text', text: 'ordered_slugs debe ser una lista de slugs de colección (usa list_my_collections).' }] }
  }
  if (new Set(ordered).size !== ordered.length) {
    return { isError: true, content: [{ type: 'text', text: 'ordered_slugs contiene slugs repetidos — incluye cada colección exactamente una vez.' }] }
  }

  const collections = await getShopCollections(shop.slug)
  const bySlug = new Map(collections.map((c) => [shortCollectionSlug(c.handle, shop.slug!), c]))
  const unknown = (ordered as string[]).filter((s) => !bySlug.has(s))
  if (unknown.length > 0) {
    return { isError: true, content: [{ type: 'text', text: `No encontré esta(s) colección(es) en tu tienda: ${unknown.map((s) => `\`${s}\``).join(', ')}. Usa list_my_collections.` }] }
  }

  const orderedIds = (ordered as string[]).map((s) => bySlug.get(s)!.id)
  const result = await reorderSellerCollectionsViaInternal(shop.slug, orderedIds)
  if (!result.ok) return { isError: true, content: [{ type: 'text', text: `No se pudo reordenar: ${result.error}` }] }

  revalidateTag('listings', 'default')
  revalidateTag('shops', 'default')

  return {
    content: [
      { type: 'text', text: `✅ Colecciones reordenadas:\n${(ordered as string[]).map((s, i) => `${i + 1}. ${bySlug.get(s)!.name}`).join('\n')}` },
    ],
  }
}

/**
 * set_listing_repuve (mcp-parity-config S1.3) — mirrors the portal
 * PATCH /api/sell/listing/:id/repuve verbatim: same status vocabulary, same
 * folio/notes normalization, same metadata.repuve write. Deliberately no
 * category guard — the portal route has none (parity, not policy; the UI just
 * only surfaces REPUVE on autos listings).
 */
async function handleSetListingRepuve(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'set_listing_repuve')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop

  const productId = String(args.product_id ?? '')
  if (!productId) return { isError: true, content: [{ type: 'text', text: 'product_id es obligatorio.' }] }
  const status = String(args.status ?? '')
  if (!['sin_reporte', 'con_reporte'].includes(status)) {
    return { isError: true, content: [{ type: 'text', text: 'Estado inválido. Usa "sin_reporte" o "con_reporte".' }] }
  }

  const { data: listing } = await db
    .from('marketplace_listings')
    .select('id, metadata')
    .eq('shop_id', shop.id)
    .eq('medusa_product_id', productId)
    .maybeSingle()
  if (!listing) return { isError: true, content: [{ type: 'text', text: 'Ese anuncio no pertenece a tu tienda.' }] }

  const existingMeta = (listing.metadata ?? {}) as Record<string, unknown>
  const folio = typeof args.folio === 'string' ? args.folio : undefined
  const notes = typeof args.notes === 'string' ? args.notes : undefined
  const repuve = {
    status,
    folio: folio?.trim().toUpperCase() || null,
    notes: notes?.trim() || null,
    verified_at: new Date().toISOString(),
  }

  const { error } = await db
    .from('marketplace_listings')
    .update({ metadata: { ...existingMeta, repuve } })
    .eq('id', listing.id)
  if (error) return { isError: true, content: [{ type: 'text', text: 'Error al guardar.' }] }

  // Buyer-facing trust-panel claim ("sin reporte" = clean vehicle) — every agent
  // listing mutation is audited (fresh-review catch, mcp-parity-config).
  await recordAgentListingAction(shop, { productId, fields: ['repuve'] })

  return {
    content: [
      { type: 'text', text: `✅ REPUVE actualizado (${status === 'sin_reporte' ? 'sin reporte' : 'con reporte'}).` },
      { type: 'text', text: JSON.stringify({ repuve }, null, 2) },
    ],
  }
}

/**
 * set_shop_slug (mcp-parity-config S2.1) — same pipeline as the portal
 * PATCH /api/sell/shop/slug: frontend validateSlug (format + reserved),
 * shared buildSlugAliasHistory, authoritative Medusa write (uniqueness →
 * 409) via the internal door, Supabase mirror, cache bust. The old slug
 * 301-redirects for 90 days (custom-slugs US-4), unchanged.
 */
async function handleSetShopSlug(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'set_shop_slug')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!shop.slug) return { isError: true, content: [{ type: 'text', text: 'Tu tienda no tiene un identificador (slug) configurado.' }] }

  const newSlug = String(args.slug ?? '').trim().toLowerCase()
  const check = validateSlug(newSlug)
  if (!check.valid) return { isError: true, content: [{ type: 'text', text: check.reason }] }
  if (newSlug === shop.slug) {
    return { content: [{ type: 'text', text: `Tu tienda ya usa el slug \`${newSlug}\` — no hay nada que cambiar.` }] }
  }

  const { previousSlugs, previousSlugKeys } = buildSlugAliasHistory(shop.metadata ?? {}, shop.slug, newSlug)

  const result = await patchSellerSlugViaInternal(shop.slug, newSlug, previousSlugs, previousSlugKeys)
  if (!result.ok) return { isError: true, content: [{ type: 'text', text: `No se pudo cambiar el slug: ${result.error}` }] }

  const meta = (shop.metadata ?? {}) as Record<string, unknown>
  const { error: mirrorError } = await db
    .from('marketplace_shops')
    .update({
      slug: newSlug,
      metadata: { ...meta, previous_slugs: previousSlugs, previous_slug_keys: previousSlugKeys },
      updated_at: new Date().toISOString(),
    })
    .eq('id', shop.id)
  if (mirrorError) console.error('[set_shop_slug] mirror update failed (non-fatal):', mirrorError)

  revalidateTag('listings', 'default')
  revalidateTag('shops', 'default')
  revalidateTag(SLUG_REDIRECT_TAG, 'default')

  // The shop's public URL is a high-value config change — audit + ops notify,
  // same rail as patch_store_configuration (fresh-review catch).
  await recordAgentConfigChange(shop, {
    ok: true,
    appliedAny: true,
    blocks: [{ key: 'slug', label: 'Slug de la tienda', status: 'applied', appliedFields: [`${shop.slug} → ${newSlug}`], issues: [] }],
  }, 'set_shop_slug')

  return {
    content: [
      { type: 'text', text: `✅ Slug cambiado: \`${shop.slug}\` → \`${newSlug}\`.\n\nTu tienda ahora vive en https://miyagisanchez.com/mx/s/${newSlug} — el slug anterior seguirá redirigiendo (301) durante 90 días.${mirrorError ? '\n⚠ El espejo del catálogo puede tardar en reflejarlo.' : ''}` },
    ],
  }
}

/**
 * set_notification_preferences (mcp-parity-config S2.2) — the granular
 * event-group × channel grid (PATCH /api/sell/notification-preferences),
 * which is a different store from the two email booleans the `notifications`
 * config block in patch_store_configuration already covers. Mirrors the
 * portal PATCH verbatim, including the telegram-requires-linked-chat guard.
 */
async function handleSetNotificationPreferences(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'set_notification_preferences')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!shop.clerk_user_id) return { isError: true, content: [{ type: 'text', text: 'Tu tienda aún no tiene una cuenta vinculada — reclámala primero para configurar notificaciones.' }] }

  const { channel, event_group: eventGroup, enabled } = args
  const validChannel = typeof channel === 'string' && (CHANNELS as readonly string[]).includes(channel)
  const validGroup = typeof eventGroup === 'string' && (EVENT_GROUPS as readonly string[]).includes(eventGroup)
  if (!validChannel || !validGroup || typeof enabled !== 'boolean') {
    return { isError: true, content: [{ type: 'text', text: `Parámetros inválidos. channel: ${CHANNELS.join('|')}; event_group: ${EVENT_GROUPS.join('|')}; enabled: boolean.` }] }
  }

  if (channel === 'telegram') {
    const { data: link } = await db
      .from('telegram_links')
      .select('chat_id')
      .eq('clerk_user_id', shop.clerk_user_id)
      .maybeSingle()
    if (!link) {
      return { isError: true, content: [{ type: 'text', text: 'Conecta Telegram para activar este canal (usa link_telegram).' }] }
    }
  }

  const { error } = await db.from('notification_preferences').upsert(
    {
      clerk_user_id: shop.clerk_user_id,
      channel,
      event_group: eventGroup,
      enabled,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'clerk_user_id,channel,event_group' },
  )
  if (error) return { isError: true, content: [{ type: 'text', text: 'No se pudo guardar.' }] }

  const { data: rows } = await db
    .from('notification_preferences')
    .select('channel, event_group, enabled')
    .eq('clerk_user_id', shop.clerk_user_id)

  return {
    content: [
      { type: 'text', text: `✅ Preferencia guardada: ${eventGroup} × ${channel} → ${enabled ? 'activado' : 'desactivado'}.` },
      { type: 'text', text: JSON.stringify({ prefs: resolvePrefs((rows as PrefRow[] | null) ?? []) }, null, 2) },
    ],
  }
}

async function handleCreateContent(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'create_content')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop

  const titleClean = String(args.title ?? '').trim()
  if (titleClean.length < 2) return { isError: true, content: [{ type: 'text', text: 'El título debe tener al menos 2 caracteres.' }] }
  if (titleClean.length > 200) return { isError: true, content: [{ type: 'text', text: 'El título no puede superar los 200 caracteres.' }] }

  // Optional listing attach — the agent-facing arg is product_id (the id
  // list_my_listings returns); resolve it to the mirror row the content
  // table references, ownership included.
  let listingId: string | null = null
  if (args.product_id) {
    const { data: listing } = await db
      .from('marketplace_listings')
      .select('id')
      .eq('shop_id', shop.id)
      .eq('medusa_product_id', String(args.product_id))
      .maybeSingle()
    if (!listing) return { isError: true, content: [{ type: 'text', text: 'Ese anuncio no pertenece a tu tienda.' }] }
    listingId = listing.id
  }

  const { data: content, error } = await db
    .from('marketplace_subscription_content')
    .insert({
      shop_id: shop.id,
      listing_id: listingId,
      title: titleClean,
      body: typeof args.body === 'string' ? args.body.trim() : null,
      file_url: typeof args.file_url === 'string' ? args.file_url : null,
      file_type: typeof args.file_type === 'string' ? args.file_type : null,
      is_published: typeof args.is_published === 'boolean' ? args.is_published : true,
    })
    .select('id')
    .single()
  if (error || !content) return { isError: true, content: [{ type: 'text', text: 'Error al crear el contenido.' }] }

  return {
    content: [
      { type: 'text', text: `✅ Contenido creado: «${titleClean}».\n\ncontent_id: \`${content.id}\`` },
    ],
  }
}

async function handleUpdateContent(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'update_content')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop

  const contentId = String(args.content_id ?? '')
  if (!contentId) return { isError: true, content: [{ type: 'text', text: 'content_id es obligatorio.' }] }

  const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (args.title !== undefined) {
    const t = String(args.title).trim()
    if (t.length < 2 || t.length > 200) return { isError: true, content: [{ type: 'text', text: 'Título inválido (2–200 caracteres).' }] }
    updatePayload.title = t
  }
  if (args.body !== undefined) updatePayload.body = typeof args.body === 'string' ? args.body.trim() : null
  if (args.file_url !== undefined) updatePayload.file_url = args.file_url
  if (args.file_type !== undefined) updatePayload.file_type = args.file_type
  if (args.is_published !== undefined) {
    if (typeof args.is_published !== 'boolean') return { isError: true, content: [{ type: 'text', text: 'is_published debe ser booleano.' }] }
    updatePayload.is_published = args.is_published
  }

  const { data: updated, error } = await db
    .from('marketplace_subscription_content')
    .update(updatePayload)
    .eq('id', contentId)
    .eq('shop_id', shop.id)  // ownership check (same as the portal PATCH)
    .select('id')
  if (error) return { isError: true, content: [{ type: 'text', text: 'Error al actualizar.' }] }
  if (!updated || updated.length === 0) return { isError: true, content: [{ type: 'text', text: 'Contenido no encontrado en tu tienda.' }] }

  return { content: [{ type: 'text', text: '✅ Contenido actualizado.' }] }
}

async function handleDeleteContent(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'delete_content')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop

  const contentId = String(args.content_id ?? '')
  if (!contentId) return { isError: true, content: [{ type: 'text', text: 'content_id es obligatorio.' }] }

  const { data: deleted, error } = await db
    .from('marketplace_subscription_content')
    .delete()
    .eq('id', contentId)
    .eq('shop_id', shop.id)  // ownership check (same as the portal DELETE)
    .select('id')
  if (error) return { isError: true, content: [{ type: 'text', text: 'Error al eliminar.' }] }
  if (!deleted || deleted.length === 0) return { isError: true, content: [{ type: 'text', text: 'Contenido no encontrado en tu tienda.' }] }

  return { content: [{ type: 'text', text: '✅ Contenido eliminado.' }] }
}

/**
 * link_telegram (mcp-parity-config S2.4) — mints the same single-use t.me
 * deep link the portal POST /api/sell/telegram/link does. The link is a
 * two-step handshake by design: the SELLER must open the link and press
 * Start; the bot webhook redeems the token. An agent can only mint the link.
 * Rate-limited per shop account (the portal keys on user+IP; MCP handlers
 * have no request IP, so the account id alone is the key).
 */
async function handleLinkTelegram(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'link_telegram')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!shop.clerk_user_id) return { isError: true, content: [{ type: 'text', text: 'Tu tienda aún no tiene una cuenta vinculada — reclámala primero para conectar Telegram.' }] }

  const rl = await checkRateLimit('telegram_link', `${shop.clerk_user_id}:mcp`)
  if (!rl.allowed) return { isError: true, content: [{ type: 'text', text: 'Demasiados intentos. Espera un momento.' }] }

  const username = await getBotUsername()
  if (!username) return { isError: true, content: [{ type: 'text', text: 'Telegram no está disponible por ahora. Inténtalo más tarde.' }] }

  const token = genLinkToken()
  const { error } = await db.from('telegram_link_tokens').insert({
    token,
    clerk_user_id: shop.clerk_user_id,
    expires_at: new Date(Date.now() + LINK_TOKEN_TTL_MS).toISOString(),
  })
  if (error) return { isError: true, content: [{ type: 'text', text: 'No se pudo generar el enlace.' }] }

  return {
    content: [
      { type: 'text', text: `Enlace de vinculación (válido 10 minutos, un solo uso):\n\nhttps://t.me/${username}?start=${token}\n\n⚠ Este paso lo debe completar la persona dueña de la tienda: abre el enlace en Telegram y pulsa «Iniciar». Después activa los avisos con set_notification_preferences (canal telegram).` },
    ],
  }
}

async function handleUnlinkTelegram(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'unlink_telegram')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!shop.clerk_user_id) return { isError: true, content: [{ type: 'text', text: 'Tu tienda aún no tiene una cuenta vinculada.' }] }

  // Audience-safe unlink — same semantics as the portal DELETE: turn off all
  // seller-group telegram prefs, then remove the shared chat row ONLY when the
  // buyer audience doesn't still use Telegram.
  await db
    .from('notification_preferences')
    .delete()
    .eq('clerk_user_id', shop.clerk_user_id)
    .eq('channel', 'telegram')
    .in('event_group', [...EVENT_GROUPS])

  const { data } = await db
    .from('notification_preferences')
    .select('channel, event_group, enabled')
    .eq('clerk_user_id', shop.clerk_user_id)

  let rowDeleted = false
  if (!audienceTelegramInUse((data as PrefRow[] | null) ?? [], 'buyer')) {
    const { error } = await db.from('telegram_links').delete().eq('clerk_user_id', shop.clerk_user_id)
    if (error) return { isError: true, content: [{ type: 'text', text: 'No se pudo desconectar.' }] }
    rowDeleted = true
  }

  return {
    content: [
      { type: 'text', text: `✅ Telegram desconectado para los avisos de tu tienda.${rowDeleted ? '' : ' (La cuenta compradora sigue usando Telegram, así que el chat queda vinculado para ella.)'}` },
    ],
  }
}

async function handleTestTelegram(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'test_telegram')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!shop.clerk_user_id) return { isError: true, content: [{ type: 'text', text: 'Tu tienda aún no tiene una cuenta vinculada.' }] }

  const { data } = await db
    .from('telegram_links')
    .select('chat_id')
    .eq('clerk_user_id', shop.clerk_user_id)
    .maybeSingle()
  if (!data?.chat_id) return { isError: true, content: [{ type: 'text', text: 'Conecta Telegram primero (usa link_telegram).' }] }

  await tgSend(
    data.chat_id,
    '🔔 <b>Prueba</b>\nTu Telegram está conectado a tu tienda de Miyagi Sánchez. Aquí te llegarán los avisos que actives.',
  )

  return { content: [{ type: 'text', text: '✅ Mensaje de prueba enviado a tu Telegram.' }] }
}

/**
 * Payment-link tools (in-person-sales S4.4, D16). The shop is the one `resolveToolShop` returns for the
 * token and nothing else (a slug argument is never read); the backend internal route validates with the
 * same core as the web, so the answers' codes and messages are surfaced as they are.
 */
async function paymentLinkTool(
  name: 'create_payment_link' | 'list_payment_links' | 'cancel_payment_link',
  args: Record<string, unknown>,
  authHeader?: string | null,
) {
  const agentAuth = await resolveToolShop(authHeader, args, name)
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const slug = agentAuth.shop.slug
  if (!slug) return { isError: true, content: [{ type: 'text', text: 'Tu tienda no tiene un identificador (slug) configurado.' }] }
  const fail = (r: { status: number; body: { code?: string; message?: string } }) => ({
    isError: true,
    content: [{ type: 'text', text: `${r.body.message ?? `Error ${r.status}`}${r.body.code ? ` (${r.body.code})` : ''}` }],
  })

  if (name === 'create_payment_link') {
    const mapped = mapCreateLinkArgs(args)
    if (!mapped.ok) return { isError: true, content: [{ type: 'text', text: mapped.message }] }
    const r = await internalLinkCall('POST', '/internal/sellers/payment-links', slug, mapped.body)
    if (!r.ok) return fail(r)
    const link = formatLinkForAgent(r.body.payment_link as AgentLinkView)
    return { content: [{ type: 'text', text: `Link creado: ${link.short_url}\n(${link.url})` }, { type: 'text', text: JSON.stringify({ payment_link: link }, null, 2) }] }
  }
  if (name === 'list_payment_links') {
    const r = await internalLinkCall('GET', '/internal/sellers/payment-links', slug)
    if (!r.ok) return fail(r)
    const links = filterLinksByState((r.body.payment_links ?? []) as AgentLinkView[], args.state).map(formatLinkForAgent)
    if (links.length === 0) return { content: [{ type: 'text', text: 'No tienes links de cobro que coincidan.' }] }
    return { content: [{ type: 'text', text: `## Tus links de cobro (${links.length})` }, { type: 'text', text: JSON.stringify({ payment_links: links }, null, 2) }] }
  }
  const id = mapCancelLinkArgs(args)
  if (!id.ok) return { isError: true, content: [{ type: 'text', text: id.message }] }
  const r = await internalLinkCall('POST', `/internal/sellers/payment-links/${encodeURIComponent(id.id)}/cancel`, slug, {})
  if (!r.ok) return fail(r)
  return { content: [{ type: 'text', text: 'Link cancelado: ya no se puede pagar.' }, { type: 'text', text: JSON.stringify({ payment_link: formatLinkForAgent(r.body.payment_link as AgentLinkView) }, null, 2) }] }
}

async function handleListOrders(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'list_orders')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!shop.slug) return { isError: true, content: [{ type: 'text', text: 'Tu tienda no tiene un identificador (slug) configurado.' }] }

  const result = await listShopOrdersViaInternal(shop.slug)
  if (!result.ok) return { isError: true, content: [{ type: 'text', text: `No se pudieron leer los pedidos: ${result.error}` }] }

  const statusFilter = typeof args.status === 'string' ? args.status : null
  const sourceFilter = args.source === 'mercadolibre' || args.source === 'miyagi' ? args.source : null
  const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 20

  let orders = result.orders ?? []
  if (statusFilter) orders = orders.filter((o) => o.status === statusFilter)
  if (sourceFilter) orders = orders.filter((o) => o.source === sourceFilter)
  orders = orders.slice(0, limit)

  if (orders.length === 0) return { content: [{ type: 'text', text: 'No tienes pedidos que coincidan con ese filtro.' }] }

  const lines = orders.map((o) => {
    const tags = o.tags.length ? ` · tags: ${o.tags.join(', ')}` : ''
    return `• **${o.id}** — ${o.status} · ${o.source} · ${(o.amount_cents / 100).toFixed(2)} ${o.currency}${tags}\n  comprador: ${o.buyer_name ?? o.buyer_email ?? '—'}`
  })
  return {
    content: [
      { type: 'text', text: [`## Tus pedidos (${orders.length})`, ...lines].join('\n') },
      { type: 'text', text: JSON.stringify({ orders }, null, 2) },
    ],
  }
}

async function handleListManuscriptSubmissions(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'list_manuscript_submissions')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!(await isEnabled('launchpad.enabled'))) {
    return { content: [{ type: 'text', text: 'La convocatoria de manuscritos no está disponible en tu tienda.' }] }
  }

  const statusFilter = typeof args.status === 'string' ? args.status : null
  let subs = await listSubmissionsForShop(shop.id)
  if (statusFilter) subs = subs.filter((s) => s.status === statusFilter)

  if (subs.length === 0) return { content: [{ type: 'text', text: 'No tienes manuscritos que coincidan con ese filtro.' }] }

  // Read-only agent view — never expose the private manuscript storage key.
  const shaped = subs.map((s) => ({
    id: s.id,
    title: s.title,
    author_name: s.author_name,
    genre: s.genre,
    status: s.status,
    format: s.manuscript_format,
    published_product_id: s.published_product_id,
    created_at: s.created_at,
  }))
  const lines = shaped.map((s) =>
    `• **${s.title}** — ${s.author_name} · ${s.status}${s.genre ? ` · ${s.genre}` : ''} (${s.format.toUpperCase()})`,
  )
  return {
    content: [
      { type: 'text', text: [`## Manuscritos recibidos (${shaped.length})`, ...lines].join('\n') },
      { type: 'text', text: JSON.stringify({ submissions: shaped }, null, 2) },
    ],
  }
}

/** es-MX message for a submission transition failure reason (mirrors the portal route's inline switch). */
function submissionTransitionErrorMessage(reason: string): string {
  switch (reason) {
    case 'note_required': return 'Escribe un mensaje para el autor (obligatorio al rechazar o pedir cambios).'
    case 'invalid_transition': return 'Ese cambio de estado no es válido.'
    case 'not_found': return 'Manuscrito no encontrado.'
    default: return 'No se pudo actualizar.'
  }
}

async function handleReviewSubmission(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'review_submission')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const agentShop = agentAuth.shop
  if (!(await isEnabled('launchpad.enabled'))) {
    return { isError: true, content: [{ type: 'text', text: 'La convocatoria de manuscritos no está disponible en tu tienda.' }] }
  }
  if (!agentShop.slug) return { isError: true, content: [{ type: 'text', text: 'Tu tienda no tiene un identificador (slug) configurado.' }] }

  const submissionId = String(args.submission_id ?? '')
  if (!submissionId) return { isError: true, content: [{ type: 'text', text: 'submission_id es obligatorio.' }] }
  const to = args.status as SubmissionStatus | undefined
  if (!to || !REVIEWABLE_TARGET_STATUSES.includes(to)) {
    return { isError: true, content: [{ type: 'text', text: `status debe ser uno de: ${REVIEWABLE_TARGET_STATUSES.join(', ')}.` }] }
  }
  const note = typeof args.note === 'string' ? args.note : undefined

  const shop = await getLaunchpadShopBySlug(agentShop.slug)
  if (!shop) return { isError: true, content: [{ type: 'text', text: 'Tienda no encontrada.' }] }

  const result = await transitionSubmission({ shop, id: submissionId, to, note })
  if (!result.ok) {
    return { isError: true, content: [{ type: 'text', text: submissionTransitionErrorMessage(result.error) }] }
  }
  return {
    content: [{ type: 'text', text: `✅ Manuscrito actualizado a **${result.submission.status}**.` }, { type: 'text', text: JSON.stringify({ submission: { id: result.submission.id, status: result.submission.status, review_note: result.submission.review_note } }, null, 2) }],
  }
}

async function handlePublishSubmission(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'publish_submission')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const agentShop = agentAuth.shop
  if (!(await isEnabled('launchpad.enabled'))) {
    return { isError: true, content: [{ type: 'text', text: 'La convocatoria de manuscritos no está disponible en tu tienda.' }] }
  }
  if (!agentShop.slug) return { isError: true, content: [{ type: 'text', text: 'Tu tienda no tiene un identificador (slug) configurado.' }] }

  const submissionId = String(args.submission_id ?? '')
  if (!submissionId) return { isError: true, content: [{ type: 'text', text: 'submission_id es obligatorio.' }] }

  const shop = await getLaunchpadShopBySlug(agentShop.slug)
  if (!shop) return { isError: true, content: [{ type: 'text', text: 'Tienda no encontrada.' }] }

  const result = await publishSubmission({ shop, id: submissionId })
  if (!result.ok) {
    const msg = result.error === 'not_approved'
      ? 'Solo puedes publicar un manuscrito aprobado.'
      : result.error === 'not_found'
      ? 'Manuscrito no encontrado.'
      : result.error === 'shop_slug_missing'
      ? 'Tu tienda no tiene un identificador (slug) configurado.'
      : result.error === 'already_publishing'
      ? 'Este manuscrito ya se está publicando. Espera un momento y vuelve a intentar.'
      : 'No se pudo publicar el manuscrito. Inténtalo de nuevo.'
    return { isError: true, content: [{ type: 'text', text: msg }] }
  }

  revalidateTag('listings', 'default')
  revalidateTag('shops', 'default')

  return {
    content: [
      { type: 'text', text: `✅ Manuscrito publicado como producto borrador: \`${result.productId}\`. Usa update_listing para ponerle precio/portada y set_listing_status para activarlo.` },
      { type: 'text', text: JSON.stringify({ ok: true, product_id: result.productId, manage_url: result.manageUrl }, null, 2) },
    ],
  }
}

async function handleListLaunchpadCampaigns(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'list_launchpad_campaigns')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!(await isEnabled('launchpad.enabled'))) {
    return { content: [{ type: 'text', text: 'Las campañas de votación no están disponibles en tu tienda.' }] }
  }

  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com').replace(/\/+$/, '')
  const statusFilter = typeof args.status === 'string' ? args.status : null
  let campaigns = await listCampaignsForShop(shop.id)
  if (statusFilter) campaigns = campaigns.filter((c) => c.status === statusFilter)

  if (campaigns.length === 0) return { content: [{ type: 'text', text: 'No tienes campañas que coincidan con ese filtro.' }] }

  const shaped = campaigns.map((c) => ({
    id: c.id,
    slug: c.slug,
    title: c.title,
    status: c.status,
    vote_count: c.vote_count,
    vote_threshold: c.vote_threshold,
    threshold_reached: thresholdReached(c.vote_count, c.vote_threshold),
    reward_percent: c.reward_percent,
    reward_product_id: c.reward_product_id,
    work_count: c.works.length,
    coupon_code: c.status === 'closed_met' ? c.coupon_code : null,
    ends_at: c.ends_at,
    public_url: `${site}/v/${c.slug}`,
  }))
  const lines = shaped.map((c) =>
    `• **${c.title ?? '(sin título)'}** — ${c.status} · ${c.vote_count}/${c.vote_threshold} votos · ${c.reward_percent}% · ${c.work_count} obra(s)${c.coupon_code ? ` · cupón: ${c.coupon_code}` : ''}`,
  )
  return {
    content: [
      { type: 'text', text: [`## Campañas de votación (${shaped.length})`, ...lines].join('\n') },
      { type: 'text', text: JSON.stringify({ campaigns: shaped }, null, 2) },
    ],
  }
}

/**
 * Bridge an MCP-authenticated `AgentShop` into the `SellerContext` shape
 * `lib/launchpad-campaigns.ts`'s write functions expect (built for a Clerk
 * session via `resolveCampaignSeller`). `context.shop.id` is the Supabase
 * `marketplace_shops.id` (same id space as `AgentShop.id`), but
 * `context.seller.id` must be the MEDUSA seller id — a DIFFERENT id space,
 * confirmed live against Supabase during planning — since
 * `productBelongsToShop` compares it against `getListing().shop_id`, which
 * Medusa itself returns. Returns null when the shop's metadata is missing
 * `medusa_seller_id` (shouldn't happen for a real shop; fails closed rather
 * than silently comparing ownership against an empty string).
 */
function toCampaignSellerContext(shop: AgentShop): SellerContext | null {
  const meta = (shop.metadata ?? {}) as Record<string, unknown>
  const medusaSellerId = meta.medusa_seller_id
  if (typeof medusaSellerId !== 'string' || !medusaSellerId) return null
  const seller: MedusaSellerForMirror = {
    id: medusaSellerId,
    slug: shop.slug ?? '',
    name: shop.name ?? shop.slug ?? '',
  }
  return {
    userId: shop.clerk_user_id,
    seller,
    shop: { id: shop.id, slug: shop.slug ?? '', metadata: shop.metadata },
  }
}

async function handleCreateCampaign(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'create_campaign')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const agentShop = agentAuth.shop
  if (!(await isEnabled('launchpad.enabled'))) {
    return { isError: true, content: [{ type: 'text', text: 'Las campañas de votación no están disponibles en tu tienda.' }] }
  }
  const context = toCampaignSellerContext(agentShop)
  if (!context) return { isError: true, content: [{ type: 'text', text: 'No se pudo resolver tu tienda en Medusa.' }] }

  const title = typeof args.title === 'string' ? args.title : ''
  if (!title.trim()) return { isError: true, content: [{ type: 'text', text: 'El título es obligatorio.' }] }

  const result = await createCampaign({
    context,
    title,
    description: typeof args.description === 'string' ? args.description : null,
    terms: typeof args.terms === 'string' ? args.terms : null,
    vote_threshold: Number(args.vote_threshold ?? 0),
    ends_at: typeof args.ends_at === 'string' ? args.ends_at : null,
    reward_percent: typeof args.reward_percent === 'number' ? args.reward_percent : null,
    reward_product_id: typeof args.reward_product_id === 'string' ? args.reward_product_id : null,
    work_product_ids: Array.isArray(args.work_product_ids) ? args.work_product_ids.filter((x): x is string => typeof x === 'string') : [],
  })
  if (!result.ok) {
    return { isError: true, content: [{ type: 'text', text: campaignErrorMessage(result.error) }] }
  }
  return {
    content: [
      { type: 'text', text: `✅ Campaña creada en borrador: «${result.campaign.title}» (id: \`${result.campaign.id}\`). Usa activate_campaign cuando esté completa.` },
      { type: 'text', text: JSON.stringify({ campaign: result.campaign }, null, 2) },
    ],
  }
}

async function handleUpdateCampaign(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'update_campaign')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const agentShop = agentAuth.shop
  if (!(await isEnabled('launchpad.enabled'))) {
    return { isError: true, content: [{ type: 'text', text: 'Las campañas de votación no están disponibles en tu tienda.' }] }
  }
  const context = toCampaignSellerContext(agentShop)
  if (!context) return { isError: true, content: [{ type: 'text', text: 'No se pudo resolver tu tienda en Medusa.' }] }

  const campaignId = String(args.campaign_id ?? '')
  if (!campaignId) return { isError: true, content: [{ type: 'text', text: 'campaign_id es obligatorio.' }] }

  const result = await updateCampaign(context, campaignId, {
    title: typeof args.title === 'string' ? args.title : undefined,
    description: typeof args.description === 'string' ? args.description : undefined,
    terms: typeof args.terms === 'string' ? args.terms : undefined,
    vote_threshold: typeof args.vote_threshold === 'number' ? args.vote_threshold : undefined,
    ends_at: typeof args.ends_at === 'string' ? args.ends_at : undefined,
    reward_percent: typeof args.reward_percent === 'number' ? args.reward_percent : undefined,
    reward_product_id: typeof args.reward_product_id === 'string' ? args.reward_product_id : undefined,
    work_product_ids: Array.isArray(args.work_product_ids) ? args.work_product_ids.filter((x): x is string => typeof x === 'string') : undefined,
  })
  if (!result.ok) {
    return { isError: true, content: [{ type: 'text', text: campaignErrorMessage(result.error) }] }
  }
  return {
    content: [
      { type: 'text', text: `✅ Campaña actualizada: «${result.campaign.title}».` },
      { type: 'text', text: JSON.stringify({ campaign: result.campaign }, null, 2) },
    ],
  }
}

async function handleActivateCampaign(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'activate_campaign')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const agentShop = agentAuth.shop
  if (!(await isEnabled('launchpad.enabled'))) {
    return { isError: true, content: [{ type: 'text', text: 'Las campañas de votación no están disponibles en tu tienda.' }] }
  }
  const context = toCampaignSellerContext(agentShop)
  if (!context) return { isError: true, content: [{ type: 'text', text: 'No se pudo resolver tu tienda en Medusa.' }] }

  const marketRefused = await refuseMarketplacePublication(agentShop, 'activar una campaña')
  if (marketRefused) return marketRefused

  // Activating a campaign publishes its product — same publication boundary as
  // set_listing_status, so a shop awaiting consent must refuse it too.
  const refused = await refusePreviewPrivateWrite(agentShop.id, 'activar una campaña')
  if (refused) return refused

  const campaignId = String(args.campaign_id ?? '')
  if (!campaignId) return { isError: true, content: [{ type: 'text', text: 'campaign_id es obligatorio.' }] }

  const result = await activateCampaign(context, campaignId)
  if (!result.ok) {
    const missing = result.missing?.length ? ` Falta: ${result.missing.join(', ')}.` : ''
    return { isError: true, content: [{ type: 'text', text: `${campaignErrorMessage(result.error)}${missing}` }] }
  }
  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com').replace(/\/+$/, '')
  return {
    content: [
      { type: 'text', text: `✅ Campaña activa: «${result.campaign.title}». Página pública: ${site}/v/${result.campaign.slug}` },
      { type: 'text', text: JSON.stringify({ campaign: result.campaign }, null, 2) },
    ],
  }
}

async function handleCancelCampaign(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'cancel_campaign')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const agentShop = agentAuth.shop
  if (!(await isEnabled('launchpad.enabled'))) {
    return { isError: true, content: [{ type: 'text', text: 'Las campañas de votación no están disponibles en tu tienda.' }] }
  }
  const context = toCampaignSellerContext(agentShop)
  if (!context) return { isError: true, content: [{ type: 'text', text: 'No se pudo resolver tu tienda en Medusa.' }] }

  const campaignId = String(args.campaign_id ?? '')
  if (!campaignId) return { isError: true, content: [{ type: 'text', text: 'campaign_id es obligatorio.' }] }

  const result = await cancelCampaign(context, campaignId)
  if (!result.ok) {
    return { isError: true, content: [{ type: 'text', text: campaignErrorMessage(result.error) }] }
  }
  return {
    content: [{ type: 'text', text: `✅ Campaña cancelada: «${result.campaign.title}».` }, { type: 'text', text: JSON.stringify({ campaign: result.campaign }, null, 2) }],
  }
}

async function handleUpdateListing(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'update_listing')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!shop.slug) return { isError: true, content: [{ type: 'text', text: 'Tu tienda no tiene un identificador (slug) configurado.' }] }

  const productId = String(args.product_id ?? '')
  if (!productId) return { isError: true, content: [{ type: 'text', text: 'product_id es obligatorio.' }] }
  const owned = await shopOwnsProduct(shop.id, productId)
  if (!owned) return { isError: true, content: [{ type: 'text', text: 'Ese anuncio no pertenece a tu tienda.' }] }

  const patch: { title?: string; description?: string | null; price_cents?: number | null; quantity?: number | null; collection_ids?: string[] } = {}
  const fields: string[] = []
  if (typeof args.title === 'string') {
    const validatedTitle = validateListingTitle(args.title)
    if (!validatedTitle.ok) return { isError: true, content: [{ type: 'text', text: validatedTitle.error }] }
    patch.title = validatedTitle.title
    fields.push('title')
  }
  if (typeof args.description === 'string') { patch.description = args.description; fields.push('description') }
  if (typeof args.price_mxn === 'number') { patch.price_cents = Math.round(args.price_mxn * 100); fields.push('price') }
  if (typeof args.quantity === 'number') { patch.quantity = Math.max(0, Math.floor(args.quantity)); fields.push('quantity') }
  if (Array.isArray(args.collection_names)) {
    const requestedNames = args.collection_names.filter((n): n is string => typeof n === 'string')
    const shopCollections = await getShopCollections(shop.slug)
    const byName = new Map(shopCollections.map((c) => [c.name.toLowerCase(), c]))
    const unknown = requestedNames.filter((n) => !byName.has(n.toLowerCase()))
    if (unknown.length > 0) {
      return { isError: true, content: [{ type: 'text', text: `No reconozco estas colecciones: ${unknown.join(', ')}. Usa list_my_collections para ver los nombres exactos.` }] }
    }
    patch.collection_ids = requestedNames.map((n) => byName.get(n.toLowerCase())!.id)
    fields.push('collections')
  }
  if (fields.length === 0) {
    return { isError: true, content: [{ type: 'text', text: 'Indica al menos un campo a cambiar: title, description, price_mxn, quantity o collection_names.' }] }
  }

  const result = await patchSellerProductViaInternal(shop.slug, productId, patch)
  if (!result.ok) return { isError: true, content: [{ type: 'text', text: `No se pudo actualizar el anuncio: ${result.error}` }] }

  // Mirror to the Supabase storefront copy (matches the portal route).
  const mirror: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.title !== undefined) mirror.title = patch.title.trim()
  if (patch.description !== undefined) mirror.description = patch.description
  if (patch.price_cents !== undefined) mirror.price_cents = patch.price_cents
  if (Object.keys(mirror).length > 1) {
    await db.from('marketplace_listings').update(mirror).eq('medusa_product_id', productId)
  }

  // A title/price/image edit changes what would be published — stale any approval.
  await invalidatePreviewApprovalAfterEdit(shop.id)
  await recordAgentListingAction(shop, { productId, fields, title: patch.title })
  revalidateTag('listings', 'default')
  revalidateTag('shops', 'default')

  return { content: [{ type: 'text', text: `✅ Anuncio actualizado: ${fields.join(', ')}.` }] }
}

async function handleSetListingStatus(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'set_listing_status')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!shop.slug) return { isError: true, content: [{ type: 'text', text: 'Tu tienda no tiene un identificador (slug) configurado.' }] }

  const productId = String(args.product_id ?? '')
  const status = String(args.status ?? '')
  if (!productId || !['active', 'paused'].includes(status)) {
    return { isError: true, content: [{ type: 'text', text: 'Indica product_id y status ("active" o "paused").' }] }
  }
  const owned = await shopOwnsProduct(shop.id, productId)
  if (!owned) return { isError: true, content: [{ type: 'text', text: 'Ese anuncio no pertenece a tu tienda.' }] }

  // Publication is activation's exclusive job — it is the only path that verifies
  // a current merchant approval and a complete readiness checklist. Without this,
  // a partner credential could publish a merchant's products with no consent at all.
  const refused = await refusePreviewPrivateWrite(shop.id, 'cambiar el estado de un anuncio')
  if (refused) return refused

  if (status === 'active') {
    const marketRefused = await refuseMarketplacePublication(shop, 'activar un anuncio')
    if (marketRefused) return marketRefused

    const block = listingActivationBlock(shop.metadata, owned.listing_type)
    if (block) return { isError: true, content: [{ type: 'text', text: block }] }
  }

  const result = await patchSellerProductViaInternal(shop.slug, productId, { status: status === 'active' ? 'published' : 'draft' })
  if (!result.ok) return { isError: true, content: [{ type: 'text', text: `No se pudo cambiar el estado: ${result.error}` }] }

  await db.from('marketplace_listings').update({ status, updated_at: new Date().toISOString() }).eq('medusa_product_id', productId)
  await recordAgentListingAction(shop, { productId, fields: [`status:${status}`] })
  revalidateTag('listings', 'default')
  revalidateTag('shops', 'default')

  return { content: [{ type: 'text', text: `✅ Anuncio ${status === 'active' ? 'activado' : 'pausado'}.` }] }
}

/**
 * configure_listing_options (mcp-parity-core S2) — the agent door to the
 * portal's "Opciones" screen. All REAL validation (mutual exclusivity,
 * restructure/order-history guards, dimension/combo caps, the tier-ladder
 * rules) lives in the backend's shared `updateSellerProduct`; this handler
 * only shape-checks (mirroring the PUT /api/sell/listing/[id] proxy's checks,
 * same es-MX messages) and surfaces the backend's 4xx messages verbatim so
 * every named failure mode reaches the agent legibly, never a generic error.
 * After a successful write it syncs the Supabase mirror the same way the PUT
 * route does: a convert stamps `has_variants` + the cheapest combo price; a
 * tier edit recomputes the "desde $X" price from the live price-grid.
 */
async function handleConfigureListingOptions(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'configure_listing_options')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!shop.slug) return { isError: true, content: [{ type: 'text', text: 'Tu tienda no tiene un identificador (slug) configurado.' }] }
  if (!(await isEnabled('mcp.configure_options.enabled'))) {
    return { isError: true, content: [{ type: 'text', text: 'Esta función aún no está disponible.' }] }
  }

  const productId = String(args.product_id ?? '')
  if (!productId) return { isError: true, content: [{ type: 'text', text: 'product_id es obligatorio.' }] }
  const owned = await shopOwnsProduct(shop.id, productId)
  if (!owned) return { isError: true, content: [{ type: 'text', text: 'Ese anuncio no pertenece a tu tienda.' }] }

  const patch: SellerProductPatch = {}
  const fields: string[] = []

  if (args.option_dimensions !== undefined) {
    const dims = args.option_dimensions
    const valid = Array.isArray(dims) && dims.length > 0 && dims.every((d) =>
      d && typeof d === 'object' && typeof (d as Record<string, unknown>).title === 'string'
      && Array.isArray((d as Record<string, unknown>).values)
      && ((d as Record<string, unknown>).values as unknown[]).every((v) => typeof v === 'string'))
    if (!valid) {
      return { isError: true, content: [{ type: 'text', text: 'option_dimensions debe ser una lista de { title, values[] } (títulos y valores de texto).' }] }
    }
    patch.option_dimensions = dims as Array<{ title: string; values: string[] }>
    fields.push('option_dimensions')
  }
  if (args.variant_prices !== undefined) {
    const vp = args.variant_prices
    const vals = vp && typeof vp === 'object' && !Array.isArray(vp) ? Object.values(vp as Record<string, unknown>) : []
    if (vals.length === 0 || vals.some((v) => !Number.isInteger(v) || (v as number) <= 0)) {
      return { isError: true, content: [{ type: 'text', text: 'Cada combinación necesita un precio entero en centavos mayor a 0.' }] }
    }
    patch.variant_prices = vp as Record<string, number>
    fields.push('variant_prices', 'price')
  }
  if (args.variant_id !== undefined) {
    patch.variant_id = String(args.variant_id)
  }
  if (args.variant_tiers !== undefined) {
    const tiers = args.variant_tiers
    if (!Array.isArray(tiers) || tiers.some((t) => !t || typeof t !== 'object'
      || !Number.isInteger((t as Record<string, unknown>).amount) || ((t as Record<string, unknown>).amount as number) <= 0)) {
      return { isError: true, content: [{ type: 'text', text: 'Cada nivel necesita un precio entero en centavos mayor a 0.' }] }
    }
    patch.variant_tiers = tiers as Array<{ min_quantity: number; max_quantity: number | null; amount: number }>
    fields.push('variant_tiers', 'price')
  }

  if (!patch.option_dimensions && !patch.variant_tiers) {
    return { isError: true, content: [{ type: 'text', text: 'Indica option_dimensions + variant_prices (convertir a combinaciones con precio) o variant_tiers (niveles por cantidad).' }] }
  }

  const result = await patchSellerProductViaInternal(shop.slug, productId, patch)
  if (!result.ok) {
    // The backend's es-MX 4xx message IS the contract (mutual exclusivity,
    // restructure/order-history refusal, caps, tier-ladder errors) — verbatim.
    return { isError: true, content: [{ type: 'text', text: `No se pudo configurar el anuncio: ${result.error}` }] }
  }

  // ── Mirror sync — parity with PUT /api/sell/listing/[id] ────────────────────
  const mirror: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.option_dimensions !== undefined) {
    // Dimensions can never be removed, so has_variants never needs clearing.
    const { data: row } = await db
      .from('marketplace_listings').select('metadata').eq('medusa_product_id', productId).maybeSingle()
    const meta = ((row?.metadata ?? {}) as Record<string, unknown>)
    meta.has_variants = true
    mirror.metadata = meta
  }
  let minVariantPrice = patch.option_dimensions !== undefined && patch.variant_prices
    ? Math.min(...Object.values(patch.variant_prices))
    : undefined
  if (patch.variant_tiers !== undefined && minVariantPrice === undefined) {
    // "desde $X" = min across variants of each variant's lowest-min_quantity
    // tier — best-effort, same as the PUT route (a failed read keeps the
    // current mirror price rather than failing the save).
    try {
      const gridRes = await fetch(`${MEDUSA_BASE}/store/listings/${productId}/price-grid`, {
        headers: MEDUSA_HEADERS,
        cache: 'no-store',
      })
      if (gridRes.ok) {
        const grid = (await gridRes.json())?.price_grid as
          | { variants?: Array<{ tiers?: Array<{ amount?: number }> }> }
          | undefined
        const basePrices = (grid?.variants ?? [])
          .map((v) => v.tiers?.[0]?.amount)
          .filter((a): a is number => typeof a === 'number' && a > 0)
        if (basePrices.length > 0) minVariantPrice = Math.min(...basePrices)
      }
    } catch { /* best-effort — keep the current mirror price */ }
  }
  if (minVariantPrice !== undefined && Number.isFinite(minVariantPrice)) mirror.price_cents = minVariantPrice
  // The Medusa write already landed — a mirror failure must not fail the call,
  // but the success message must not promise a "desde" update that didn't
  // happen (Codex cross-review catch): report the honest partial state so the
  // agent/seller knows listing cards may briefly show the old price.
  const { error: mirrorError } = await db
    .from('marketplace_listings').update(mirror).eq('medusa_product_id', productId)
  if (mirrorError) console.error('[configure_listing_options] mirror update failed (non-fatal):', mirrorError)

  // Option dimensions and variant prices change the published price surface —
  // stale any approval that covered the previous shape.
  await invalidatePreviewApprovalAfterEdit(shop.id)
  await recordAgentListingAction(shop, { productId, fields })
  revalidateTag('listings', 'default')
  revalidateTag('shops', 'default')

  const mirrorNote = mirrorError
    ? ' ⚠ El precio "desde" de las tarjetas puede tardar en reflejarse (falló la sincronización del espejo; el precio real de compra ya quedó actualizado).'
    : ''
  const summary = patch.option_dimensions !== undefined
    ? `✅ Anuncio convertido a combinaciones con precio (${Object.keys(patch.variant_prices ?? {}).length} combinación(es))${mirrorError ? '.' : '; precio "desde" actualizado.'}${mirrorNote}`
    : `✅ Niveles de precio por cantidad actualizados (${patch.variant_tiers!.length} nivel(es)).${mirrorNote}`
  return { content: [{ type: 'text', text: summary }] }
}

/**
 * delete_listing (mcp-parity-core S3.1) — the agent door to the portal's
 * listing delete. Same native Medusa soft-delete (via the internal service
 * route), so past order line-items keep resolving — there is deliberately no
 * order-linked refusal guard, matching the portal exactly (parity, not
 * policy). Mirror + best-effort ML-close mirror lib/listing-status.ts's
 * deleteListing (which needs a Clerk JWT this path doesn't have).
 */
async function handleDeleteListing(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'delete_listing')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!shop.slug) return { isError: true, content: [{ type: 'text', text: 'Tu tienda no tiene un identificador (slug) configurado.' }] }
  if (!(await isEnabled('mcp.delete_listing.enabled'))) {
    return { isError: true, content: [{ type: 'text', text: 'Esta función aún no está disponible.' }] }
  }

  const productId = String(args.product_id ?? '')
  if (!productId) return { isError: true, content: [{ type: 'text', text: 'product_id es obligatorio.' }] }
  const owned = await shopOwnsProduct(shop.id, productId)
  if (!owned) return { isError: true, content: [{ type: 'text', text: 'Ese anuncio no pertenece a tu tienda.' }] }

  // Deleting a product the merchant approved both destroys reviewed content and
  // strands activation: the approved snapshot still lists it, so every retry would
  // try to publish a product that no longer exists and fail permanently.
  const refused = await refusePreviewPrivateWrite(shop.id, 'eliminar un anuncio')
  if (refused) return refused

  const result = await deleteSellerProductViaInternal(shop.slug, productId)
  if (!result.ok) return { isError: true, content: [{ type: 'text', text: `No se pudo eliminar el anuncio: ${result.error}` }] }

  // Mirror + cascade — parity with lib/listing-status.ts deleteListing().
  const { error: mirrorError } = await db
    .from('marketplace_listings')
    .update({ status: 'deleted', updated_at: new Date().toISOString() })
    .eq('medusa_product_id', productId)
  if (mirrorError) console.error('[delete_listing] mirror update failed (non-fatal):', mirrorError)
  try {
    if (await isEnabled('ml.publish_enabled')) await closeMlProduct(shop.slug, productId)
  } catch { /* never block the delete on an ML failure */ }

  await recordAgentListingAction(shop, { productId, fields: ['deleted'] })
  revalidateTag('listings', 'default')
  revalidateTag('shops', 'default')

  return { content: [{ type: 'text', text: `✅ Anuncio eliminado.${mirrorError ? ' ⚠ Las tarjetas del catálogo pueden tardar en reflejarlo (falló la sincronización del espejo).' : ''}` }] }
}

/**
 * apply_price (mcp-parity-core S3.2) — the agent door to the Profit
 * Analyzer's one-click Apply. The whole pipeline (ownership re-check, Miyagi
 * write, conditional ML push, price_apply activity log) is the backend's
 * shared applySellerPrice core, reached via the internal service route; this
 * handler surfaces the honest partial-state result verbatim and mirrors the
 * new price to the Supabase listing card (single-variant semantics: the
 * mirror's price_cents is the "desde" price, so only update it when the
 * backend confirms the Miyagi write).
 */
async function handleApplyPrice(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'apply_price')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!shop.slug) return { isError: true, content: [{ type: 'text', text: 'Tu tienda no tiene un identificador (slug) configurado.' }] }
  if (!(await isEnabled('mcp.apply_price.enabled'))) {
    return { isError: true, content: [{ type: 'text', text: 'Esta función aún no está disponible.' }] }
  }

  const productId = String(args.product_id ?? '')
  const variantId = String(args.variant_id ?? '')
  const newPriceCents = args.new_price_cents
  if (!productId || !variantId || !Number.isInteger(newPriceCents) || (newPriceCents as number) <= 0) {
    return { isError: true, content: [{ type: 'text', text: 'Indica product_id, variant_id y new_price_cents (entero en centavos, mayor a 0).' }] }
  }
  const owned = await shopOwnsProduct(shop.id, productId)
  if (!owned) return { isError: true, content: [{ type: 'text', text: 'Ese anuncio no pertenece a tu tienda.' }] }

  const result = await applySellerPriceViaInternal(shop.slug, {
    product_id: productId,
    variant_id: variantId,
    new_price_cents: newPriceCents as number,
    ...(typeof args.target_margin_pct === 'number' ? { target_margin_pct: args.target_margin_pct } : {}),
  })
  if (!result.ok) return { isError: true, content: [{ type: 'text', text: `No se pudo aplicar el precio: ${result.error}` }] }

  const body = result.body ?? {}
  // Mirror the card's "desde" price. On a MULTI-variant product the applied
  // variant may not be the cheapest one, so blindly writing new_price_cents
  // could show a wrong starting price on catalog cards (Codex cross-review
  // catch) — recompute the true min base price from the live price-grid
  // instead (the backend already confirmed the Miyagi write, so the grid
  // reflects it). Best-effort: a failed read skips the price write and keeps
  // the current mirror price rather than writing a possibly-wrong one.
  let mirrorPriceCents: number | undefined
  try {
    const gridRes = await fetch(`${MEDUSA_BASE}/store/listings/${productId}/price-grid`, {
      headers: MEDUSA_HEADERS,
      cache: 'no-store',
    })
    if (gridRes.ok) {
      const grid = (await gridRes.json())?.price_grid as
        | { variants?: Array<{ tiers?: Array<{ amount?: number }> }> }
        | undefined
      const basePrices = (grid?.variants ?? [])
        .map((v) => v.tiers?.[0]?.amount)
        .filter((a): a is number => typeof a === 'number' && a > 0)
      if (basePrices.length > 0) mirrorPriceCents = Math.min(...basePrices)
    }
  } catch { /* best-effort — keep the current mirror price */ }
  const mirrorUpdate: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (mirrorPriceCents !== undefined && Number.isFinite(mirrorPriceCents)) mirrorUpdate.price_cents = mirrorPriceCents
  const { error: mirrorError } = await db
    .from('marketplace_listings')
    .update(mirrorUpdate)
    .eq('medusa_product_id', productId)
  if (mirrorError) console.error('[apply_price] mirror update failed (non-fatal):', mirrorError)

  // A price change is material — stale any approval that covered the old price.
  await invalidatePreviewApprovalAfterEdit(shop.id)
  await recordAgentListingAction(shop, { productId, fields: ['price'] })
  revalidateTag('listings', 'default')
  revalidateTag('shops', 'default')

  const mlNote = body.ml === 'ok'
    ? ` También se actualizó en Mercado Libre${body.permalink ? ` (${body.permalink})` : ''}.`
    : body.ml === 'failed'
      ? ` ⚠ Mercado Libre NO se actualizó: ${body.ml_reason ?? 'error desconocido'} — el precio de Miyagi sí quedó aplicado.`
      : ''
  return {
    content: [
      { type: 'text', text: `✅ Precio aplicado: $${((newPriceCents as number) / 100).toFixed(2)} MXN.${mlNote}${mirrorError ? ' ⚠ Las tarjetas del catálogo pueden tardar en reflejarlo (falló la sincronización del espejo).' : ''}` },
      { type: 'text', text: JSON.stringify({ ok: true, ...body }, null, 2) },
    ],
  }
}

const BULK_CATEGORY_LABELS: Record<string, string> = {
  autos: 'Autos y motos', inmuebles: 'Inmuebles', electronica: 'Electrónica', hogar: 'Hogar y jardín',
  moda: 'Moda y ropa', deportes: 'Deportes', servicios: 'Servicios', mascotas: 'Mascotas',
  herramientas: 'Herramientas', negocios: 'Negocios B2B', cursos: 'Cursos y talleres',
  comunidad: 'Membresía / comunidad', creatividad: 'Arte y diseño', otros: 'Otros',
}

/**
 * Translate the MCP tool's plain args shape into the internal
 * `BulkActionPayload` the staging pipeline expects — mirrors
 * `BulkActionBar.tsx`'s equivalent translation on the web-portal side, so
 * both actors stage the exact same action shape (catalog-management epic,
 * Sprint 3 · Story 3.3).
 */
async function buildBulkActionPayload(
  shop: { slug: string | null },
  raw: Record<string, unknown>,
): Promise<{ ok: true; action: BulkActionPayload } | { ok: false; error: string }> {
  const type = String(raw.type ?? '')
  if (type === 'price_set') {
    const priceMxn = raw.price_mxn
    if (typeof priceMxn !== 'number' || priceMxn <= 0) return { ok: false, error: 'price_mxn debe ser un número mayor a 0.' }
    return { ok: true, action: { type: 'price_set', price_cents: Math.round(priceMxn * 100) } }
  }
  if (type === 'price_pct') {
    const percent = raw.percent
    if (typeof percent !== 'number' || percent === 0) return { ok: false, error: 'percent debe ser un número distinto de 0 (ej. 10 o -10).' }
    return { ok: true, action: { type: 'price_pct', percent } }
  }
  if (type === 'category') {
    const categoryHandle = String(raw.category_handle ?? '')
    if (!categoryHandle) return { ok: false, error: 'category_handle es requerido.' }
    return { ok: true, action: { type: 'category', category_handle: categoryHandle, category_label: BULK_CATEGORY_LABELS[categoryHandle] ?? categoryHandle } }
  }
  if (type === 'collection_assign') {
    const ids = Array.isArray(raw.collection_ids) ? raw.collection_ids.filter((i): i is string => typeof i === 'string') : []
    const shopCollections = shop.slug ? await getShopCollections(shop.slug) : []
    const byId = new Map(shopCollections.map((c) => [c.id, c.name]))
    return { ok: true, action: { type: 'collection_assign', collection_ids: ids, collection_labels: ids.map((id) => byId.get(id) ?? id) } }
  }
  if (type === 'inventory_mode') {
    const mode = raw.mode
    if (mode !== 'tracked' && mode !== 'unlimited' && mode !== 'backorder') {
      return { ok: false, error: 'mode debe ser "tracked", "unlimited" o "backorder".' }
    }
    return { ok: true, action: { type: 'inventory_mode', mode, dispatch_estimate: typeof raw.dispatch_estimate === 'string' ? raw.dispatch_estimate : undefined } }
  }
  return { ok: false, error: 'type de acción no reconocido o no disponible por el agente (usa la app web para pausar/activar, eliminar, o publicar en Mercado Libre en bloque).' }
}

async function handleStageBulkAction(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'stage_bulk_action')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!(await isEnabled('catalog.bulk_enabled'))) {
    return { isError: true, content: [{ type: 'text', text: 'Esta función aún no está disponible.' }] }
  }

  const rawAction = args.action as Record<string, unknown> | undefined
  if (!rawAction?.type) return { isError: true, content: [{ type: 'text', text: 'action es requerido.' }] }
  const built = await buildBulkActionPayload(shop, rawAction)
  if (!built.ok) return { isError: true, content: [{ type: 'text', text: built.error }] }

  const productIds = Array.isArray(args.product_ids) ? args.product_ids.filter((i): i is string => typeof i === 'string') : undefined
  const filter = args.filter as BulkFilterParams | undefined
  if (!productIds?.length && !filter) {
    return { isError: true, content: [{ type: 'text', text: 'Indica product_ids o filter.' }] }
  }

  const result = await stageBulkActionAsAgent(shop, { ids: productIds, filter }, built.action)
  if (!result.ok) return { isError: true, content: [{ type: 'text', text: result.error }] }

  const found = await getBulkBatch(result.batch_id, shop.clerk_user_id)
  const sample = (found?.items ?? []).slice(0, 5).map((i) => {
    const afterStr = Object.values(i.after).join(', ') || '—'
    const beforeStr = Object.values(i.before).join(', ') || '—'
    return i.valid ? `• ${i.title}: ${beforeStr} → ${afterStr}` : `• ${i.title}: ⚠ ${i.error_message}`
  }).join('\n')

  return {
    content: [{
      type: 'text',
      text: `Lote preparado (batch_id: ${result.batch_id}) — ${result.total} producto(s), ${result.valid_count} válido(s)` +
        (result.invalid_count > 0 ? `, ${result.invalid_count} con error` : '') +
        `.\n\nMuestra:\n${sample || '(sin productos)'}` +
        `\n\nNada se ha aplicado todavía. Llama a apply_bulk_action con batch_id="${result.batch_id}" para confirmar y aplicar.`,
    }],
  }
}

async function handleApplyBulkAction(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'apply_bulk_action')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!(await isEnabled('catalog.bulk_enabled'))) {
    return { isError: true, content: [{ type: 'text', text: 'Esta función aún no está disponible.' }] }
  }

  const batchId = String(args.batch_id ?? '')
  if (!batchId) return { isError: true, content: [{ type: 'text', text: 'batch_id es requerido.' }] }

  const result = await applyBulkBatchAsAgent(batchId, shop)
  if (!result.ok) return { isError: true, content: [{ type: 'text', text: result.error }] }

  revalidateTag('listings', 'default')
  revalidateTag('shops', 'default')

  const parts = [`✅ ${result.applied} aplicado(s)`]
  if (result.failed > 0) parts.push(`⚠ ${result.failed} falló/fallaron`)
  if (result.skipped > 0) parts.push(`${result.skipped} ya aplicado(s) previamente`)
  return { content: [{ type: 'text', text: parts.join(' · ') + '.' }] }
}

// ── Shopify migration connector (epic 03 · platform-migrations S1) ───────────
// `isPublicDomainShape` is a friendly early-reject only — the real SSRF
// boundary (DNS-resolve + private/reserved-range check) is enforced once,
// centrally, inside lib/shopify-mcp-client.ts, shared with the HTTP route.

async function handleStartShopifyMigration(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'start_shopify_migration')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop
  if (!(await isEnabled('migrations.connector_enabled'))) {
    return { isError: true, content: [{ type: 'text', text: 'Esta función aún no está disponible.' }] }
  }
  if (!shop.slug) return { isError: true, content: [{ type: 'text', text: 'Tu tienda no tiene slug configurado.' }] }

  const domain = String(args.shop_domain ?? '').trim()
  if (!domain || !isPublicDomainShape(domain)) {
    return { isError: true, content: [{ type: 'text', text: 'shop_domain inválido. Usa un dominio como "mitienda.com" o "mitienda.myshopify.com".' }] }
  }

  // The SAME shared staging function the HTTP route uses — no duplicated logic.
  const staged = await stageShopifyBatch({ id: shop.id, slug: shop.slug }, domain)
  if (!staged.ok) return { isError: true, content: [{ type: 'text', text: staged.error }] }

  return {
    content: [{
      type: 'text',
      text: `Lote preparado (batch_id: ${staged.batchId}) — ${staged.itemCount} producto(s) de "${domain}" listos para revisar` +
        (staged.hasPolicies ? ', incluyendo texto de políticas.' : '.') +
        (staged.truncated ? ' (Catálogo muy grande: se trajo solo una parte.)' : '') +
        ` Nada se ha importado todavía. Revisa y confirma en /shop/manage/shopify/import.`,
    }],
  }
}

// ── Custom-domain paywall (epic 07 · S3) — seller-agent domain SKU tools ──────

async function handleGetDomainEntitlement(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'get_domain_entitlement')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop

  const ent = await resolveDomainEntitlement(shop.metadata, { sellerClerkId: shop.clerk_user_id })
  const summary = ent.entitled
    ? `✅ ${shop.name ?? 'Tu tienda'} puede conectar un dominio propio (motivo: ${ent.reason}).`
    : `🔒 El dominio propio es una función premium (${CUSTOM_DOMAIN_PRICE_LABEL.es}). Tu tienda aún no está habilitada. ` +
      `El cupón “${CAMPAIGN_COUPON_CODE}” cubre gratis el primer año (sujeto a disponibilidad). El subdominio y tu URL gratis siempre son gratis. ` +
      `Usa start_domain_subscription para activar.`

  return {
    content: [
      { type: 'text', text: summary },
      {
        type: 'text',
        text: JSON.stringify(
          {
            entitled: ent.entitled,
            reason: ent.reason,
            price_label: CUSTOM_DOMAIN_PRICE_LABEL.es,
            campaign_coupon: CAMPAIGN_COUPON_CODE,
          },
          null,
          2,
        ),
      },
    ],
  }
}

async function handleStartDomainSubscription(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'start_domain_subscription')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop

  const couponCode = typeof args.coupon === 'string' ? args.coupon : null
  const cadence = asDomainCadence(args.cadence) ?? 'recurring'
  const result = await startCustomDomainCheckout({
    shopId: shop.id,
    sellerClerkId: shop.clerk_user_id,
    channel: 'api',
    couponCode,
    cadence,
  })

  if (!result.ok) {
    return { isError: true, content: [{ type: 'text', text: result.error }] }
  }

  const cadenceNote = cadence === 'one_time'
    ? ' (pago único por un año, sin renovación automática)'
    : ''
  return {
    content: [
      {
        type: 'text',
        text:
          `Abre este enlace para activar tu dominio propio${cadenceNote}${couponCode ? ` con el cupón “${couponCode}”` : ''}:\n${result.url}\n\n` +
          'La habilitación se activa automáticamente al completar el checkout.',
      },
      { type: 'text', text: JSON.stringify({ checkout_url: result.url, cadence }, null, 2) },
    ],
  }
}

// ── Subdomain paywall (epic 07 · subdomain-pricing S2) — seller-agent SKU tools ─

async function handleGetSubdomainEntitlement(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'get_subdomain_entitlement')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop

  const ent = await resolveSubdomainEntitlement(shop.metadata, { sellerClerkId: shop.clerk_user_id })
  const summary = ent.entitled
    ? `✅ ${shop.name ?? 'Tu tienda'} puede servir su subdominio white-label (motivo: ${ent.reason}).`
    : `🔒 El subdominio propio es una función premium (${SUBDOMAIN_PRICE_LABEL.es}). Tu tienda aún no está habilitada. ` +
      `Tu URL gratis (/s/tu-tienda) siempre es gratis. Usa start_subdomain_subscription para activar.`

  return {
    content: [
      { type: 'text', text: summary },
      {
        type: 'text',
        text: JSON.stringify(
          {
            entitled: ent.entitled,
            reason: ent.reason,
            price_label: SUBDOMAIN_PRICE_LABEL.es,
            monthly_price_label: SUBDOMAIN_PRICE_MONTHLY_LABEL.es,
          },
          null,
          2,
        ),
      },
    ],
  }
}

async function handleStartSubdomainSubscription(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'start_subdomain_subscription')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop

  const cadence = asDomainCadence(args.cadence) ?? 'recurring'
  const interval = coerceSubdomainInterval(args.interval)
  const result = await startSubdomainCheckout({
    shopId: shop.id,
    sellerClerkId: shop.clerk_user_id,
    channel: 'api',
    cadence,
    interval,
  })

  if (!result.ok) {
    return { isError: true, content: [{ type: 'text', text: result.error }] }
  }

  const cadenceNote = cadence === 'one_time'
    ? ' (pago único por un año, sin renovación automática)'
    : interval === 'month'
      ? ' (suscripción mensual, $25 MXN/mes)'
      : ' (suscripción anual, $199 MXN/año)'
  return {
    content: [
      {
        type: 'text',
        text:
          `Abre este enlace para activar tu subdominio propio${cadenceNote}:\n${result.url}\n\n` +
          'La habilitación se activa automáticamente al completar el checkout.',
      },
      { type: 'text', text: JSON.stringify({ checkout_url: result.url, cadence, interval }, null, 2) },
    ],
  }
}

async function handleSwitchSubdomainCadence(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'switch_subdomain_cadence')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const shop = agentAuth.shop

  // Pass the raw arg — the switch builder validates it strictly (a billing mutation
  // rejects a missing/invalid interval rather than defaulting).
  const result = await switchSubdomainCadence({
    sellerClerkId: shop.clerk_user_id,
    targetInterval: args.interval,
  })

  if (!result.ok) {
    return { isError: true, content: [{ type: 'text', text: result.error }] }
  }

  const label = result.interval === 'month' ? '$25 MXN/mes' : '$199 MXN/año'
  const text = result.switched
    ? `✅ Tu suscripción al subdominio cambió a ${label}. Se prorrateó el cambio (sin cargo doble) y tu subdominio siguió activo sin interrupción.`
    : `Tu suscripción al subdominio ya está en ${label}. No se hizo ningún cambio ni cargo.`
  return {
    content: [
      { type: 'text', text },
      { type: 'text', text: JSON.stringify({ switched: result.switched, interval: result.interval }, null, 2) },
    ],
  }
}

/**
 * `send_feedback` — miyagi-partners-mcp S3. Available to BOTH credential shapes
 * `resolveToolShop` resolves (seller ms_agent_/ms_connector_, and partner
 * ms_partner_ — any role, incl. viewer, since filing feedback isn't a shop
 * mutation: PARTNER_READ_TOOLS in lib/partner-tools.ts includes it). The author
 * identity is ALWAYS derived from which credential resolved, never taken from
 * caller input — `agentAuth.partner` present ⇒ 'partner', absent ⇒ 'seller'.
 * `platform_feedback.author_kind` also permits 'agent' at the schema level for a
 * future unauthenticated path; no caller mints that value yet (see lib/feedback.ts).
 * Best-effort Telegram notify — never fails the tool (tg.feedbackFiled → tgNotify
 * never throws; see lib/telegram.ts).
 */
async function handleSendFeedback(args: Record<string, unknown>, authHeader?: string | null) {
  const agentAuth = await resolveToolShop(authHeader, args, 'send_feedback')
  if (!agentAuth.ok) return { isError: true, content: [{ type: 'text', text: agentAuth.message ?? `Unauthorized. ${AGENT_AUTH_HINT}` }] }
  const { shop, partner } = agentAuth

  const validated = validateFeedbackInput(args)
  if (!validated.ok) return { isError: true, content: [{ type: 'text', text: validated.error }] }

  const authorKind: 'seller' | 'partner' = partner ? 'partner' : 'seller'
  const authorId = partner ? partner.id : shop.id
  const authorLabel = partner
    ? (partner.name ? `${partner.name} (${partner.code})` : partner.code)
    : (shop.name ?? shop.slug ?? shop.id)

  const { error } = await db.from('platform_feedback').insert({
    author_kind: authorKind,
    author_id: authorId,
    author_label: authorLabel,
    category: validated.category,
    tool_name: validated.toolName,
    message: validated.message,
  })
  if (error) {
    console.error('[send_feedback] insert failed:', error.message)
    return { isError: true, content: [{ type: 'text', text: 'No se pudo registrar tu feedback — intenta de nuevo.' }] }
  }

  await tg.feedbackFiled(authorLabel, authorKind, validated.category, validated.toolName, validated.message)

  return {
    content: [{ type: 'text', text: 'Gracias — tu feedback quedó registrado.' }],
  }
}

// ── MCP method dispatcher ─────────────────────────────────────────────────────

async function handleAboutMiyagi(baseUrl: string) {
  const sections = await getOverriddenAboutSections()
  const resource = aboutMcpResource(baseUrl, sections)
  // Tool result: the structured story as a JSON text block. The directive is
  // embedded so the client answers in the user's own language.
  return { content: [{ type: 'text', text: resource.text }] }
}

function handleGetSetupSpec() {
  // The full published setup contract: schema shape + both sub-schemas + example +
  // the es-MX emit prompt (which carries the mirror-the-seller's-language directive).
  const spec = buildSetupSpec()
  return { content: [{ type: 'text', text: JSON.stringify(spec, null, 2) }] }
}

const COMPARE_COSTS_PLATFORMS = ['shopify', 'mercadolibre', 'woocommerce', 'tiendanube'] as const
const COMPARE_COSTS_SHOPIFY_TIERS = ['basico', 'crecimiento', 'avanzado'] as const
const COMPARE_COSTS_ML_BANDS = ['baja', 'media', 'alta'] as const
const COMPARE_COSTS_ML_TYPES = ['clasica', 'premium'] as const
const COMPARE_COSTS_WOO_TIERS = ['entrada', 'crecimiento'] as const
const COMPARE_COSTS_TN_TIERS = ['gratis', 'basico', 'tiendanube', 'avanzado'] as const

// es-MX labels for the tool's `platform_label`/summary text (nit, PR 278 —
// raw dataset slugs like "Shopify (basico)" read as unpolished next to the
// page's own es-MX tier names). Deliberately a SEPARATE, shorter label set from
// ComparadorTool.tsx's UI labels (those carry full pricing detail meant for a
// dropdown, e.g. "Plan Basic (~$19 USD/mes)" — redundant here since the actual
// computed MXN total is already in the summary).
const SHOPIFY_TIER_ES: Record<ShopifyTier, string> = { basico: 'Plan Basic', crecimiento: 'Plan Grow', avanzado: 'Plan Advanced' }
const ML_BAND_ES: Record<MlBand, string> = { baja: 'comisión baja', media: 'comisión media', alta: 'comisión alta' }
const ML_TYPE_ES: Record<MlPublicationType, string> = { clasica: 'Clásica', premium: 'Premium' }
const WOO_TIER_ES: Record<WooCommerceHostingTier, string> = { entrada: 'alojamiento de entrada', crecimiento: 'alojamiento de crecimiento' }
const TN_TIER_ES: Record<TiendanubeTier, string> = { gratis: 'Gratis', basico: 'Básico', tiendanube: 'Tiendanube', avanzado: 'Avanzado' }

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Validates an OPTIONAL enum arg: absent/undefined → the default (matches the
 * schema's own `default`); present but not in `allowed` → a clear error instead
 * of a silent fallback (second-opinion + codex review, PR 278 — an agent that
 * typo'd a tier name deserves to know, not get a silently-wrong comparison). */
function validateEnumArg<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): { ok: true; value: T } | { ok: false; error: string } {
  if (args[key] === undefined || args[key] === null) return { ok: true, value: fallback }
  const raw = String(args[key])
  if (!(allowed as readonly string[]).includes(raw)) {
    return { ok: false, error: `${key} must be one of: ${allowed.join(', ')} (got "${raw}")` }
  }
  return { ok: true, value: raw as T }
}

/**
 * Comparador de costos (epic 08 · cost-comparator-homepage, Sprint 2 · US-2.3) —
 * the MCP `compare_costs` tool. Computes via the EXACT SAME pure functions
 * `app/(shell)/comparador/page.tsx` renders from (lib/cost-comparator.ts +
 * lib/cost-comparator-dataset.ts's *RatesFromDataset adapters + the same
 * getComparatorDataset() fail-open dataset reader) — the rental_quote no-drift
 * precedent (epic README). No auth, no flag: same read-only/no-side-effect shape
 * as about_miyagi/get_checkout_options/search_listings (see
 * lib/ucp/capabilities.ts MCP_BUYER_TOOLS) — the mcp.*.enabled flags only gate
 * the newer SELLER write tools (configure_listing_options, delete_listing,
 * apply_price, the support/checkout config blocks), never a stateless calculator.
 */
async function handleCompareCosts(args: Record<string, unknown>) {
  const platform = String(args.platform ?? '')
  if (!(COMPARE_COSTS_PLATFORMS as readonly string[]).includes(platform)) {
    return { isError: true, content: [{ type: 'text', text: 'platform must be one of: shopify, mercadolibre, woocommerce, tiendanube' }] }
  }
  const volumeMonthly = Number(args.volume_monthly)
  const aovMxn = Number(args.aov_mxn)
  if (!Number.isFinite(volumeMonthly) || volumeMonthly < 0 || !Number.isFinite(aovMxn) || aovMxn < 0) {
    return { isError: true, content: [{ type: 'text', text: 'volume_monthly and aov_mxn must both be non-negative numbers' }] }
  }

  const dataset = await getComparatorDataset('es')
  const inputs = { volumeMonthly, aovMxn }
  const apps = premiumAppsFromDataset(dataset)

  // Validate `apps` against the LIVE dataset's actual app ids (never the schema's
  // static enum alone) — an unknown id is dropped from the calculation AND
  // reported back, never silently echoed as if it were accepted (should-fix,
  // codex review PR 278).
  const validAppIds = apps.map((a) => a.id)
  const requestedAppIdsRaw = Array.isArray(args.apps) ? args.apps.map((a) => String(a)) : []
  const acceptedAppIds = requestedAppIdsRaw.filter((id) => validAppIds.includes(id))
  const unknownAppIds = requestedAppIdsRaw.filter((id) => !validAppIds.includes(id))
  const fx = fxUsdToMxnFromDataset(dataset)
  const appsMonthlyMxn = computeSelectedAppsMonthlyMxn(apps, acceptedAppIds, fx)

  let competitorStack: ReturnType<typeof computeShopifyCost>
  let platformLabel: string
  let ctx: LineSourceContext = {}

  if (platform === 'shopify') {
    const tierResult = validateEnumArg(args, 'shopify_tier', COMPARE_COSTS_SHOPIFY_TIERS, 'basico')
    if (!tierResult.ok) return { isError: true, content: [{ type: 'text', text: tierResult.error }] }
    const tier = tierResult.value
    competitorStack = computeShopifyCost(inputs, tier, shopifyRatesFromDataset(dataset), appsMonthlyMxn)
    platformLabel = `Shopify (${SHOPIFY_TIER_ES[tier]})`
    ctx = { shopifyTier: tier }
  } else if (platform === 'mercadolibre') {
    const bandResult = validateEnumArg(args, 'ml_band', COMPARE_COSTS_ML_BANDS, 'media')
    if (!bandResult.ok) return { isError: true, content: [{ type: 'text', text: bandResult.error }] }
    const typeResult = validateEnumArg(args, 'ml_publication_type', COMPARE_COSTS_ML_TYPES, 'clasica')
    if (!typeResult.ok) return { isError: true, content: [{ type: 'text', text: typeResult.error }] }
    const band = bandResult.value
    const type = typeResult.value
    competitorStack = computeMercadoLibreCost(inputs, band, type, mercadoLibreRatesFromDataset(dataset), appsMonthlyMxn)
    platformLabel = `Mercado Libre (${ML_BAND_ES[band]}, ${ML_TYPE_ES[type]})`
    ctx = { mlBand: band, mlPublicationType: type }
  } else if (platform === 'woocommerce') {
    const tierResult = validateEnumArg(args, 'woo_hosting_tier', COMPARE_COSTS_WOO_TIERS, 'entrada')
    if (!tierResult.ok) return { isError: true, content: [{ type: 'text', text: tierResult.error }] }
    const tier = tierResult.value
    competitorStack = computeWooCommerceCost(inputs, tier, wooCommerceRatesFromDataset(dataset), appsMonthlyMxn)
    platformLabel = `WooCommerce (${WOO_TIER_ES[tier]})`
    ctx = { wooTier: tier }
  } else {
    const tierResult = validateEnumArg(args, 'tiendanube_tier', COMPARE_COSTS_TN_TIERS, 'basico')
    if (!tierResult.ok) return { isError: true, content: [{ type: 'text', text: tierResult.error }] }
    const tier = tierResult.value
    const ownGateway = args.tiendanube_own_gateway !== false
    competitorStack = computeTiendanubeCost(inputs, tier, ownGateway, tiendanubeRatesFromDataset(dataset), appsMonthlyMxn)
    platformLabel = `Tiendanube (${TN_TIER_ES[tier]}${ownGateway ? '' : ', pasarela externa'})`
    ctx = { tnTier: tier, tnOwnGateway: ownGateway }
  }

  const miyagiSkus = {
    subdomain: args.miyagi_subdomain === true,
    customDomain: args.miyagi_custom_domain === true,
    mlSync: args.miyagi_ml_sync === true,
  }
  const miyagiStack = computeMiyagiCost(inputs, miyagiSkus, miyagiRatesFromDataset(dataset))

  // Every sourced figure backing either stack, deduped by dataset key.
  const sourceKeys = new Set<string>()
  for (const line of competitorStack.lines) {
    const k = lineSourceFigureKey(platform as CostComparatorPlatform, line.key, ctx)
    if (k) sourceKeys.add(k)
  }
  for (const line of miyagiStack.lines) {
    const k = lineSourceFigureKey('miyagi', line.key, {})
    if (k) sourceKeys.add(k)
  }
  const sources = Array.from(sourceKeys)
    .map((k) => dataset.figures[k])
    .filter((f): f is NonNullable<typeof f> => Boolean(f))
    .map((f) => ({ label: f.label, source: f.source, verified_at: f.verifiedAt }))

  const result = {
    platform,
    platform_label: platformLabel,
    inputs: { volume_monthly: volumeMonthly, aov_mxn: aovMxn, apps: acceptedAppIds },
    // Present ONLY when the caller sent an id this dataset doesn't recognize —
    // never silently dropped, never silently echoed as accepted either.
    ...(unknownAppIds.length > 0 ? { warnings: [`Unknown app id(s) ignored: ${unknownAppIds.join(', ')}. Valid ids: ${validAppIds.join(', ')}.`] } : {}),
    competitor: {
      monthly_total_mxn: competitorStack.monthlyTotalMxn,
      annual_total_mxn: competitorStack.annualTotalMxn,
      lines: competitorStack.lines,
    },
    miyagi: {
      monthly_total_mxn: miyagiStack.monthlyTotalMxn,
      annual_total_mxn: miyagiStack.annualTotalMxn,
      lines: miyagiStack.lines,
    },
    savings: {
      monthly_mxn: round2(competitorStack.monthlyTotalMxn - miyagiStack.monthlyTotalMxn),
      annual_mxn: round2(competitorStack.annualTotalMxn - miyagiStack.annualTotalMxn),
    },
    verified_at: dataset.generatedAt,
    sources,
  }

  const summary = `${platformLabel}: ${formatMxn(competitorStack.monthlyTotalMxn)}/mes vs. Miyagi Sánchez: ${formatMxn(miyagiStack.monthlyTotalMxn)}/mes (0% comisión). Datos verificados: ${dataset.generatedAt}.`

  return { content: [{ type: 'text', text: summary }, { type: 'text', text: JSON.stringify(result, null, 2) }] }
}

async function handleMcpMethod(
  method: string,
  params: Record<string, unknown> | undefined,
  baseUrl: string,
  authHeader?: string | null,
  partnerPreflight?: RoutePartnerPreflight,
) {
  // Standard MCP lifecycle
  if (method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'miyagisanchez', version: '1.0.0' },
      instructions: 'Miyagi Sánchez is a commerce system with active Mexico (`mx`) and United States (`us`) country marketplaces plus independent owned-shop channels. BUYER workflow: search_listings(market) → get_listing(id, market). Read each listing’s commerce_readiness before presenting buy_now: US checkout remains unavailable until the direct-charge rail ships, and the named reason is authoritative. Mexico checkout continues through get_checkout_options → create_checkout or make_offer. If a listing has scheduling: check_availability → book_appointment. SELLER workflow stays shop-scoped and market-neutral: use a shop agent token for get_store_configuration and patch_store_configuration. Payments/domain/Cal.com stay manual.',
    }
  }

  if (method === 'notifications/initialized' || method === 'ping') {
    return {}
  }

  if (method === 'tools/list') {
    return { tools: TOOLS }
  }

  // MCP resources — the about/why-sell story as a native resource.
  if (method === 'resources/list') {
    const sections = await getOverriddenAboutSections()
    const r = aboutMcpResource(baseUrl, sections)
    return { resources: [{ uri: r.uri, name: r.name, title: r.title, description: r.description, mimeType: r.mimeType }] }
  }

  if (method === 'resources/read') {
    const uri = String((params?.uri as string | undefined) ?? '')
    const sections = await getOverriddenAboutSections()
    const r = aboutMcpResource(baseUrl, sections)
    if (uri !== r.uri) return null // unknown resource → MethodNotFound-style miss
    return { contents: [{ uri: r.uri, mimeType: r.mimeType, text: r.text }] }
  }

  if (method === 'tools/call') {
    const name = String((params?.name as string | undefined) ?? '')
    const rawArgs = params?.arguments
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? rawArgs as Record<string, unknown>
      : {}
    if (partnerPreflight) {
      rememberPartnerRecruitingPreflight(args, partnerPreflight)
    }

    switch (name) {
      case 'search_listings':      { const r = await handleSearchListings(args, baseUrl); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'get_neighborhood_pulse': return { content: (await handleGetNeighborhoodPulse(args, baseUrl)).content }
      case 'get_listing':          { const r = await handleGetListing(args, baseUrl); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'get_checkout_options': { const r = await handleGetCheckoutOptions(args, baseUrl); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'create_checkout':      { const r = await handleCreateCheckout(args, baseUrl); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'get_support_options':  { const r = await handleGetSupportOptions(args, baseUrl); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'create_support_checkout': { const r = await handleCreateSupportCheckout(args, baseUrl); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'make_offer':           { const r = await handleMakeOffer(args, baseUrl, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'get_shop':             { const r = await handleGetShop(args, baseUrl); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'check_availability':   { const r = await handleCheckAvailability(args); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'book_appointment':     { const r = await handleBookAppointment(args); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'get_buyer_trust':      { const r = await handleGetBuyerTrust(args); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'about_miyagi':         return { content: (await handleAboutMiyagi(baseUrl)).content }
      case 'get_setup_spec':       return { content: handleGetSetupSpec().content }
      case 'compare_costs':        { const r = await handleCompareCosts(args); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'get_store_configuration':   { const r = await handleGetStoreConfiguration(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'patch_store_configuration': { const r = await handlePatchStoreConfiguration(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'list_offers':               { const r = await handleListOffers(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'respond_to_offer':          { const r = await handleRespondToOffer(args, baseUrl, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'create_listing':            { const r = await handleCreateListing(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'list_my_listings':          { const r = await handleListMyListings(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'list_wall_entries':         { const r = await handleListWallEntries(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'create_wall_entry':         { const r = await handleCreateWallEntry(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'update_wall_entry':         { const r = await handleUpdateWallEntry(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'delete_wall_entry':         { const r = await handleDeleteWallEntry(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'get_share_kit':             { const r = await handleGetShareKit(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'list_my_collections':       { const r = await handleListMyCollections(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'create_collection':         { const r = await handleCreateCollection(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'update_collection':         { const r = await handleUpdateCollection(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'delete_collection':         { const r = await handleDeleteCollection(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'reorder_collections':       { const r = await handleReorderCollections(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'set_listing_repuve':        { const r = await handleSetListingRepuve(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'set_shop_slug':             { const r = await handleSetShopSlug(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'set_notification_preferences': { const r = await handleSetNotificationPreferences(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'create_content':            { const r = await handleCreateContent(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'update_content':            { const r = await handleUpdateContent(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'delete_content':            { const r = await handleDeleteContent(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'link_telegram':             { const r = await handleLinkTelegram(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'unlink_telegram':           { const r = await handleUnlinkTelegram(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'test_telegram':             { const r = await handleTestTelegram(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'create_payment_link':
      case 'list_payment_links':
      case 'cancel_payment_link':       { const r = await paymentLinkTool(name, args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'list_orders':               { const r = await handleListOrders(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'list_manuscript_submissions': { const r = await handleListManuscriptSubmissions(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'review_submission':        { const r = await handleReviewSubmission(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'publish_submission':       { const r = await handlePublishSubmission(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'list_launchpad_campaigns': { const r = await handleListLaunchpadCampaigns(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'create_campaign':          { const r = await handleCreateCampaign(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'update_campaign':          { const r = await handleUpdateCampaign(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'activate_campaign':        { const r = await handleActivateCampaign(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'cancel_campaign':          { const r = await handleCancelCampaign(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'update_listing':            { const r = await handleUpdateListing(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'set_listing_status':        { const r = await handleSetListingStatus(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'configure_listing_options': { const r = await handleConfigureListingOptions(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'delete_listing':            { const r = await handleDeleteListing(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'apply_price':               { const r = await handleApplyPrice(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'stage_bulk_action':         { const r = await handleStageBulkAction(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'apply_bulk_action':         { const r = await handleApplyBulkAction(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'start_shopify_migration':   { const r = await handleStartShopifyMigration(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'get_domain_entitlement':    { const r = await handleGetDomainEntitlement(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'start_domain_subscription': { const r = await handleStartDomainSubscription(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'get_subdomain_entitlement':    { const r = await handleGetSubdomainEntitlement(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'start_subdomain_subscription': { const r = await handleStartSubdomainSubscription(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'switch_subdomain_cadence':     { const r = await handleSwitchSubdomainCadence(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      case 'send_feedback':                { const r = await handleSendFeedback(args, authHeader); return { content: r.content, ...(r.isError ? { isError: true } : {}) } }
      default:                     return null  // will become MethodNotFound error
    }
  }

  return null  // MethodNotFound
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS })
}

// GET — minimal server info for browser / discovery
export async function GET(req: NextRequest) {
  const host = req.headers.get('host') ?? 'miyagisanchez.com'
  const proto = host.includes('localhost') ? 'http' : 'https'
  const base  = `${proto}://${host}`

  return NextResponse.json(
    {
      name: 'miyagisanchez',
      version: '1.0.0',
      protocol: 'MCP/2024-11-05',
      transport: 'http-json-rpc',
      instructions: 'POST JSON-RPC 2.0 requests to this endpoint.',
      tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
      manifest: `${base}/api/ucp/manifest`,
    },
    { headers: CORS }
  )
}

function isPartnerSellerToolCall(request: JsonRpcRequest): boolean {
  if (request.method !== 'tools/call') return false
  const name = String((request.params?.name as string | undefined) ?? '')
  return (MCP_SELLER_TOOLS as readonly string[]).includes(name)
}

// POST — JSON-RPC 2.0 dispatcher
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)

  // Reject an already-exhausted caller without any pre-auth DB work. This read
  // does not consume a token; the normal limiter call below remains the atomic
  // consume/race check after the recruiting rollback decision.
  const ratePeek = await peekRateLimit('mcp', ip)

  let body: JsonRpcRequest | JsonRpcRequest[]
  try {
    body = await req.json() as JsonRpcRequest | JsonRpcRequest[]
  } catch {
    return NextResponse.json(
      err(null, -32700, 'Parse error'),
      { status: 400, headers: CORS }
    )
  }
  const requests = Array.isArray(body) ? body : [body]
  const partnerToolCall = requests.some(isPartnerSellerToolCall)

  let partnerPreflight: RoutePartnerPreflight
  try {
    partnerPreflight = partnerToolCall ? await partnerRecruitingPreflight(
        req.headers.get('authorization'),
        async () => (await checkRateLimit('mcp_partner_preflight', ip)).allowed,
      ) : { kind: 'not_partner' }
  } catch (error) {
    // Identity storage unavailable is not an absent token. Fail closed before
    // consuming the shared bucket or dispatching a seller operation.
    console.error('[partner-auth] MCP preflight unavailable:', error)
    return NextResponse.json(
      err(null, -32003, 'Service unavailable'),
      { status: 503, headers: CORS },
    )
  }

  if (partnerPreflight.kind === 'partner_preflight_limited') {
    return NextResponse.json(
      err(null, -32001, 'Unauthorized.'),
      { status: 401, headers: CORS },
    )
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────
  if (partnerPreflight.kind !== 'operator_rolled_back' && partnerPreflight.kind !== 'partner_mcp_disabled') {
    // The read happens before any possible OFF-path identity query, but its
    // denial is deferred until rollback is classified. Thus an exhausted OFF
    // operator is still indistinguishable from a bad credential, never a 429.
    if (!ratePeek.allowed) {
      return NextResponse.json(
        err(null, -32029, 'Rate limit exceeded — too many requests'),
        { status: 429, headers: { ...CORS, 'Retry-After': String(ratePeek.retryAfter) } },
      )
    }
    const rl = await checkRateLimit('mcp', ip)
    if (!rl.allowed) {
      return NextResponse.json(
        err(null, -32029, 'Rate limit exceeded — too many requests'),
        { status: 429, headers: { ...CORS, 'Retry-After': String(rl.retryAfter) } },
      )
    }
  }

  const host    = req.headers.get('host') ?? 'miyagisanchez.com'
  const proto   = host.includes('localhost') ? 'http' : 'https'
  const baseUrl = `${proto}://${host}`

  // Support batch requests
  if (Array.isArray(body)) {
    const authHeader = req.headers.get('authorization')
    const results = await Promise.all(body.map(r => dispatchOne(r, baseUrl, authHeader, partnerPreflight)))
    const responses = results.filter((r): r is JsonRpcResponse => r !== null)
    return NextResponse.json(responses, { headers: CORS })
  }

  const response = await dispatchOne(body, baseUrl, req.headers.get('authorization'), partnerPreflight)
  if (response === null) {
    // Notification — no response per JSON-RPC spec
    return new Response(null, { status: 204, headers: CORS })
  }
  return NextResponse.json(response, { headers: CORS })
}

async function dispatchOne(
  req: JsonRpcRequest,
  baseUrl: string,
  authHeader?: string | null,
  partnerPreflight?: RoutePartnerPreflight,
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null

  if (req.jsonrpc !== '2.0' || !req.method) {
    return err(id, -32600, 'Invalid Request')
  }

  // Notifications (no id) — don't send response
  const isNotification = req.id === undefined

  try {
    const result = await handleMcpMethod(req.method, req.params, baseUrl, authHeader, partnerPreflight)
    if (result === null) {
      if (isNotification) return null
      return err(id, -32601, `Method not found: ${req.method}`)
    }
    if (isNotification) return null
    return ok(id, result)
  } catch (e) {
    if (isNotification) return null
    return err(id, -32603, `Internal error: ${String(e)}`)
  }
}
