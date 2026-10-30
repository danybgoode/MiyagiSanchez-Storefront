/**
 * lib/agent-prompt.ts
 *
 * Pure, dependency-free builder for the "Compra con tu agente IA" hand-off prompt
 * (the navbar card in AIAgentButton.tsx). The prompt is **es-MX only** and is
 * deliberately NOT on the bilingual allow-list (AGENTS rule 5).
 *
 * The agent already resolves listings/shops over UCP/MCP, so a contextual prompt
 * only has to hand it the **canonical URL** of whatever the shopper is looking at
 * (Sprint 1 — URL-only, derived from the path via usePathname/useSearchParams).
 * Sprint 2 layers human-readable title/price/shop on top.
 *
 * Kept dependency-free so the Playwright `api` spec can import it directly.
 */

import { PLATFORM_ORIGIN, listingTarget, shopTarget } from './shortlink'
import { SELLER_LANDING_PATHS } from './seller-acquisition'

/**
 * What the shopper is looking at. The `kind` + URL fields are derived from the path
 * alone (Sprint 1); the optional human-readable fields (`title`/`price`/`shopName`)
 * are layered on by a server page via AgentContext (Sprint 2) so the copied prompt
 * names the actual product/shop. A discriminated union so each kind carries exactly
 * the fields its template needs.
 */
export type AgentPromptContext =
  | { kind: 'generic' }
  | { kind: 'pdp'; listingId: string; title?: string; price?: string }
  | { kind: 'catalog'; search?: string; queryString?: string }
  | { kind: 'shop'; slug: string; shopName?: string }
  | { kind: 'account'; orderRef?: string; title?: string }
  | { kind: 'seller' }
  | { kind: 'promoter' }

/**
 * Human-readable details a server page pushes through AgentContext (Sprint 2).
 * All optional — the prompt degrades to the Sprint-1 URL-only phrasing when absent.
 */
export type AgentPromptDetails = { title?: string; price?: string; shopName?: string }

/** Minimal read-only view of URLSearchParams (so ReadonlyURLSearchParams fits too). */
type ReadonlyParams = Pick<URLSearchParams, 'get'> & { toString(): string }

/**
 * Catalog filter keys we'll echo into the hand-off URL. The prompt is pasted into
 * the user's agent, so we whitelist known params (drop `utm_*`/arbitrary junk) and
 * sanitize free text — never copy the raw query string verbatim.
 */
const CATALOG_PARAMS = [
  'q', 'category', 'state', 'municipio', 'sort', 'brand', 'condition',
  'min', 'max', 'year', 'km', 'transmission', 'fuel', 'rooms', 'surface', 'property',
] as const

/** Collapse whitespace/newlines and cap length so a value can't carry multi-line instructions. */
function sanitizeParamText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

/** Rebuild the catalog query string from the allow-list only, with sanitized values. */
function buildCatalogQuery(sp?: ReadonlyParams | null): string {
  if (!sp) return ''
  const out = new URLSearchParams()
  for (const key of CATALOG_PARAMS) {
    const val = sanitizeParamText(sp.get(key))
    if (val) out.set(key, val)
  }
  return out.toString()
}

/**
 * Cold-agent preambles, keyed off the page kind (epic 08 · promoter-funnel-v2 S1 ·
 * US-1.2). Both cite the same two sources (/agent ficha + the UCP spec) before any
 * page-specific ask; only the framing differs — a buyer's agent shops, a
 * seller/promoter's agent evaluates an opportunity. Splitting by kind (rather than
 * one generic line) keeps the recruiting pages from opening with "soy tu asistente
 * de compras", which reads wrong on a page that isn't about buying.
 */
const SHOPPING_PREAMBLE = `Eres mi asistente de compras para Miyagi Sánchez, el marketplace sin comisiones de México.

Antes de ayudarme, lee estas dos fuentes:
• Ficha del marketplace (endpoint MCP, capacidades UCP y documentación del API): ${PLATFORM_ORIGIN}/agent
• Especificación del Universal Commerce Protocol: https://ucp.dev

Cuando las hayas revisado, podrás buscar productos, hacer ofertas y ayudarme a completar compras o negociaciones a través del API del marketplace. El marketplace admite productos físicos, digitales, servicios, rentas y suscripciones, todos pagables con Stripe, MercadoPago o SPEI.`

const OPPORTUNITY_PREAMBLE = `Eres mi asesor para evaluar esta oportunidad de negocio en Miyagi Sánchez, el marketplace sin comisiones de México.

Antes de ayudarme, lee estas dos fuentes:
• Ficha del marketplace (endpoint MCP, capacidades UCP y documentación del API): ${PLATFORM_ORIGIN}/agent
• Especificación del Universal Commerce Protocol: https://ucp.dev

Cuando las hayas revisado, ayúdame a decidir si me conviene: compara cifras contra las alternativas, explícame los siguientes pasos y resuelve mis dudas.`

/** Buyer-facing kinds get the shopping framing; seller/promoter get the opportunity framing. */
function preambleFor(kind: AgentPromptContext['kind']): string {
  return kind === 'seller' || kind === 'promoter' ? OPPORTUNITY_PREAMBLE : SHOPPING_PREAMBLE
}

const GENERIC_ASK = '¿Qué estás buscando hoy?'

/**
 * Map a URL (pathname + searchParams) to the page context. Pure + URL-only.
 * Route groups like `(shell)`/`(site)` don't appear in the pathname, so the live
 * paths are `/mx/l/<id>` (PDP), `/mx/l` (catalog), `/mx/s/<slug>` (shop);
 * tenant aliases stay unprefixed (`/l`, `/s`). Account, seller, and promoter
 * tools remain outside the country-market namespace.
 * Anything unrecognized falls back to `generic`.
 */
export function resolveAgentContext(
  pathname: string | null | undefined,
  searchParams?: ReadonlyParams | null,
): AgentPromptContext {
  const rawSegments = (pathname || '').split('/').filter(Boolean)
  // `/mx` is the only active catalog namespace. Do not generically discard a
  // first segment: `/us` has no catalog, and treating it as one would invent
  // exactly the market capability the fail-closed contract forbids.
  const seg = rawSegments[0] === 'mx' ? rawSegments.slice(1) : rawSegments

  // PDP: /l/<id>  ·  Catalog: /l (no id)
  if (seg[0] === 'l') {
    const listingId = seg[1]
    if (listingId) return { kind: 'pdp', listingId }
    const search = sanitizeParamText(searchParams?.get('q') || searchParams?.get('category')) || undefined
    const queryString = buildCatalogQuery(searchParams) || undefined
    return { kind: 'catalog', search, queryString }
  }

  // Shop: /s/<slug>
  if (seg[0] === 's' && seg[1]) return { kind: 'shop', slug: seg[1] }

  // Account / orders: /account[/orders[/<id>]]
  if (seg[0] === 'account') {
    const orderRef = seg[1] === 'orders' && seg[2] ? seg[2] : undefined
    return { kind: 'account', orderRef }
  }

  // Promoter: /promotor/* (close workspace, code dashboard) · /mx/vende/promotor
  // (resources mini-site) — checked before the general seller match below. The `/mx`
  // is already stripped above, so this reads the same as it did pre-prefix.
  if (seg[0] === 'promotor') return { kind: 'promoter' }
  if (seg[0] === 'vende' && seg[1] === 'promotor') return { kind: 'promoter' }

  // Seller acquisition: /mx/vende* (persona pages) · /sell* (the portal).
  if (seg[0] === 'vende' || seg[0] === 'sell') return { kind: 'seller' }

  // The bare root `/` — the Mexico shop builder since root-shop-builder-home. Matched on
  // the exact pathname, not on an empty segment list: `/mx` also strips to an empty `seg`
  // (that is the marketplace, which keeps the buyer prompt), and a missing pathname is
  // UNKNOWN, which must stay generic rather than be read as the pitch. Without this the
  // page's own "ask your AI" button would hand a merchant on the pitch the buyer prompt.
  if (pathname === '/') return { kind: 'seller' }

  // `/us/sell` — the US seller landing. It is matched on the RAW segments because
  // `/us` is deliberately not stripped above (the US has no catalog namespace, and
  // discarding its prefix would invent one). Without this it would fall through to
  // `generic`, and the page's own "ask your AI" button would hand a US merchant the
  // buyer prompt — which is what `/sell?market=us` used to avoid only by accident,
  // by having `sell` as its first segment.
  if (rawSegments[0] === 'us' && rawSegments[1] === 'sell') return { kind: 'seller' }

  return { kind: 'generic' }
}

/** Collapse whitespace/newlines and cap length so a detail can't carry multi-line instructions. */
function sanitizeDetail(value: string | null | undefined, max = 120): string | undefined {
  const v = (value || '').replace(/\s+/g, ' ').trim().slice(0, max)
  return v || undefined
}

/**
 * Overlay a server page's human-readable details onto a URL-derived context (Sprint 2).
 * Pure: only the kinds that carry rich fields (`pdp`/`shop`/`account`) absorb them;
 * `catalog`/`generic` and a null/empty `details` return the context unchanged — so the
 * prompt always degrades cleanly to the Sprint-1 URL-only phrasing.
 */
export function withDetails(
  ctx: AgentPromptContext,
  details?: AgentPromptDetails | null,
): AgentPromptContext {
  if (!details) return ctx
  switch (ctx.kind) {
    case 'pdp':
      return { ...ctx, title: sanitizeDetail(details.title), price: sanitizeDetail(details.price, 32) }
    case 'shop':
      return { ...ctx, shopName: sanitizeDetail(details.shopName) }
    case 'account':
      return { ...ctx, title: sanitizeDetail(details.title) }
    default:
      return ctx
  }
}

/**
 * Build the full es-MX hand-off prompt for a given context. Always returns the
 * preamble + a page-specific ask; never empty.
 */
export function buildAgentPrompt(ctx: AgentPromptContext): string {
  return `${preambleFor(ctx.kind)}\n\n${ask(ctx)}`
}

function ask(ctx: AgentPromptContext): string {
  switch (ctx.kind) {
    case 'pdp': {
      // Name the product (+ price) when the page pushed it (S2.2); else URL-only (S1.3).
      const lead = ctx.title
        ? `«${ctx.title}»${ctx.price ? ` (${ctx.price})` : ''}\n${listingTarget(ctx.listingId)}`
        : listingTarget(ctx.listingId)
      return `Quiero que revises este producto del marketplace y me ayudes a decidir o comprarlo:
${lead}
Usa el API del marketplace (UCP/MCP) para ver el detalle, el precio y las opciones de pago, y si quiero, haz una oferta o inicia la compra por mí.`
    }

    case 'shop': {
      // Name the shop when the page pushed it (S2.2); else URL-only (S1.3).
      const lead = ctx.shopName ? `«${ctx.shopName}»\n${shopTarget(ctx.slug)}` : shopTarget(ctx.slug)
      return `Quiero saber qué vende esta tienda del marketplace y que me ayudes a comprar ahí:
${lead}
Usa el API del marketplace (UCP/MCP) para listar sus productos, comparar precios y, si quiero, iniciar una compra o una oferta.`
    }

    case 'catalog': {
      const url = ctx.queryString ? `${PLATFORM_ORIGIN}/mx/l?${ctx.queryString}` : `${PLATFORM_ORIGIN}/mx/l`
      if (ctx.search) {
        return `Estoy explorando el catálogo del marketplace con esta búsqueda: «${ctx.search}».
Revisa estos resultados y ayúdame a encontrar lo mejor: ${url}
Usa la búsqueda del marketplace (UCP/MCP) para refinar por precio, categoría o ubicación.`
      }
      return `Estoy explorando el catálogo del marketplace: ${url}
Usa la búsqueda del marketplace (UCP/MCP) para ayudarme a encontrar lo que busco y refinar por precio, categoría o ubicación.`
    }

    case 'account': {
      // Order-specific help when on a single order (ref from the URL + product name from
      // the page — S2.3); else generic account/orders help. Mirrors the in-page AgentHandoff.
      if (ctx.orderRef) {
        const named = ctx.title ? ` («${ctx.title}»)` : ''
        return `Necesito ayuda con mi pedido ${ctx.orderRef}${named} en el marketplace: rastrear el envío, ver el estado o gestionar un reembolso.
Mi pedido: ${PLATFORM_ORIGIN}/account/orders/${ctx.orderRef}
Usa el API del marketplace (UCP/MCP) para revisar el estado, el envío o el reembolso, y guíame paso a paso.`
      }
      return `Necesito ayuda con mi cuenta y mis pedidos en el marketplace.
Usa el API del marketplace (UCP/MCP) para revisar el estado de un pedido, el envío o un reembolso, y guíame paso a paso.`
    }

    case 'seller':
      return `Estoy pensando en vender en Miyagi Sánchez. Abre ${PLATFORM_ORIGIN}${SELLER_LANDING_PATHS.mx}, dime qué es, cuánto pagaría vs. Mercado Libre y Shopify, qué puedo vender y cómo abro mi tienda.`

    case 'promoter':
      return `Quiero ser promotor de Miyagi Sánchez y ganar comisión abriendo tiendas para negocios en persona. Abre ${PLATFORM_ORIGIN}/mx/vende/promotor, dime cómo funciona, cuánto puedo ganar y cómo empiezo.`

    case 'generic':
    default:
      return GENERIC_ASK
  }
}
