/**
 * lib/copy-overrides-routes.ts
 *
 * Pure `namespace`(`.section`) → real page/route lookup (epic 08 ·
 * cms-contenido-restore-and-polish, Story 2.1) — lets the `/admin/contenido`
 * editor tell Daniel exactly where an edit will show up, instead of a bare
 * `namespace.key` dot-path. Kept free of `next/*`/React so it's both
 * client-importable (a plain lookup table, no server dependency) and
 * Playwright-loadable.
 *
 * Verified against the real route files (`grep`, not guessed) — see the
 * epic's Sprint 2 doc. Every `locales/es.json` top-level namespace is covered
 * — a claim this comment made for months while `buyerShell`, `buyerCopy` and
 * `sellerCopy` (2587 of the dictionary's 3372 keys) were all missing, so the
 * editor captioned most of itself "sección no reconocida". It is now an
 * assertion rather than a claim: `e2e/copy-overrides-route-coverage.spec.ts`
 * enumerates the LIVE dictionary and fails on the first section this map
 * cannot resolve. `sellerAcquisition`, `sweepstakes`, and `events` each fan out per-section
 * because their sections genuinely render on DIFFERENT surfaces (Sprint 4 —
 * confirmed `sweepstakes.seller`/`events.seller` are the seller-portal
 * management pages and `sweepstakes.email`/`events.email` are transactional
 * emails, not the same public page every OTHER section of those namespaces
 * once incorrectly resolved to).
 *
 * A `RouteInfo` whose `path` isn't a real URL (a parenthetical like
 * `(correo transaccional, no es una página web)`) is a deliberate, KNOWN
 * no-single-page case — still a real, non-null `RouteInfo` so the caller can
 * render it exactly like any other destination. `null` is reserved for a
 * namespace/section this map does NOT recognize at all (a real drift signal —
 * e.g. a new key added to `locales/*.json` without updating this map) —
 * the caller shows `NO_SINGLE_PAGE_LABEL` only for that case now, never for
 * an intentional no-page namespace.
 */

import { sectionForKey, UNMAPPED_SELLER_SECTION } from './copy-overrides-sections'

export interface RouteInfo {
  /** Short human label, es-MX. */
  label: string
  /** The real path/slug, or a parenthetical description when there's no single URL. */
  path: string
}

const SELLER_ACQUISITION_SECTIONS: Record<string, RouteInfo | null> = {
  anchor: { label: 'Vende (portada)', path: '/mx/vende' },
  // Rendered as part of the /mx/vende portada (`buildAnchorPageConfig` reads
  // `copy.aiChannel` directly, `app/(shell)/mx/vende/_components/page-config.ts`)
  // — same page as `anchor`, not a separate one.
  aiChannel: { label: 'Vende (portada)', path: '/mx/vende' },
  creadores: { label: 'Vende — Creadores', path: '/mx/vende/creadores' },
  negocios: { label: 'Vende — Negocios', path: '/mx/vende/negocios' },
  fundadoras: { label: 'Vende — Fundadoras', path: '/mx/vende/fundadoras' },
  servicios: { label: 'Vende — Servicios', path: '/mx/vende/servicios' },
  autos: { label: 'Vende — Autos', path: '/mx/vende/autos' },
  mundial: { label: 'Vende — Mundial', path: '/mx/vende/mundial' },
  migracion: { label: 'Vende — Migración (hub)', path: '/mx/vende/migracion' },
  migracionShopify: { label: 'Vende — Migración Shopify', path: '/mx/vende/migracion/shopify' },
  migracionTiendanube: { label: 'Vende — Migración Tiendanube', path: '/mx/vende/migracion/tiendanube' },
  migracionWoocommerce: { label: 'Vende — Migración WooCommerce', path: '/mx/vende/migracion/woocommerce' },
  migracionBigcartel: { label: 'Vende — Migración BigCartel', path: '/mx/vende/migracion/bigcartel' },
  // The US recruiting landing is its own page under the US market prefix — same
  // section system, different market, different language. It used to have no URL
  // of its own at all (it rendered as the signed-out branch of `/sell?market=us`),
  // which is why an admin editing this copy had nowhere to go and look at it.
  us: { label: 'Sell — Estados Unidos', path: '/us/sell' },
  promotor: { label: 'Vende — Promotor', path: '/mx/vende/promotor' },
  promotorMigracion: { label: 'Vende — Promotor Migración', path: '/mx/vende/promotor/migracion' },
  // Shared copy (trust lines, FAQ, self-check aside, …) rendered across every
  // /mx/vende/* page above — a KNOWN no-single-page case, not "unrecognized".
  shared: { label: 'Vende — compartido', path: '(aparece en cada página /mx/vende/*)' },
}

/**
 * `sweepstakes`/`events` each fan into 3 sections that render on 3 DIFFERENT
 * surfaces (Sprint 4 fix — confirmed against the real `getDictionary()` call
 * sites, not guessed): the public participant flow, the seller-portal
 * management page, and transactional email templates. Before this fix all 3
 * incorrectly resolved to the public route alone.
 */
const SWEEPSTAKES_SECTIONS: Record<string, RouteInfo | null> = {
  public: { label: 'Sorteos — público', path: '/g/[slug]' },
  seller: { label: 'Sorteos — panel de tienda', path: '/shop/manage/sweepstakes' },
  email: { label: 'Sorteos — correos', path: '(correo transaccional, no es una página web)' },
}

/**
 * `events.seller` genuinely spans TWO seller-portal routes (the list/create
 * page and the `/[id]` roster/attendance page both read this same dictionary
 * section, confirmed at `app/(shell)/shop/manage/eventos/page.tsx:50` and
 * `app/(shell)/shop/manage/eventos/[id]/page.tsx:49`) — the list page is
 * named as the primary destination.
 */
const EVENTS_SECTIONS: Record<string, RouteInfo | null> = {
  public: { label: 'Eventos — público', path: '/e/[slug]' },
  seller: { label: 'Eventos — panel de tienda', path: '/shop/manage/eventos' },
  email: { label: 'Eventos — correos', path: '(correo transaccional, no es una página web)' },
}

/**
 * `landing` and `application` were MISSING here until the coverage spec found
 * them — both render on `/us/operators` (the page reads the whole
 * `partnersRecruiting` namespace and hands `.application` to
 * `FoundingOperatorApplication.tsx`, confirmed by grep). Two nav entries on a
 * live surface had been captioned "sección no reconocida" since the namespace
 * shipped, and nothing said so.
 */
const PARTNERS_RECRUITING_SECTIONS: Record<string, RouteInfo | null> = {
  landing: { label: 'Miyagi Partners — portada', path: '/us/operators' },
  application: { label: 'Miyagi Partners — solicitud', path: '/us/operators' },
  activation: { label: 'Miyagi Partners — activación', path: '/partner/activate/[token]' },
  workspace: { label: 'Miyagi Partners — espacio de trabajo', path: '/partner' },
  email: { label: 'Miyagi Partners — correos', path: '(correo transaccional, no es una página web)' },
}

/**
 * `buyerCopy` — the buyer-facing surfaces. Sections are real first segments
 * here (not hashes), verified by grepping the actual `copyKey="…"` / `buyerCopy
 * [...]` call sites rather than inferred from the key name: `l.*` renders on
 * the PDP and the search bar, `s.*` on the public shop, `account.*` across the
 * buyer account pages, and so on. Three sections have no single page by
 * construction and say so instead of resolving to a lie.
 */
const BUYER_COPY_SECTIONS: Record<string, RouteInfo | null> = {
  account: { label: 'Cuenta del comprador', path: '/account' },
  checkout: { label: 'Pago (checkout)', path: '/checkout' },
  // Rendered by MakeOfferButton, which appears on the PDP and on shop pages.
  offers: { label: 'Oferta — calidad del precio', path: '(botón de oferta, en anuncios y tiendas)' },
  l: { label: 'Anuncio (PDP) y búsqueda', path: '/l/[id]' },
  // Hand-authored labels read from the shop page and its políticas sibling too,
  // not only the PDP — a KNOWN multi-page case.
  listing: { label: 'Etiquetas de anuncio', path: '(anuncios y páginas de tienda)' },
  market: { label: 'Catálogo — estado del mercado', path: '/mx/l' },
  MarketRecommendation: { label: 'Selector de mercado — recomendación', path: '/' },
  messages: { label: 'Mensajes', path: '/messages' },
  page: { label: 'Selector de mercado', path: '/' },
  payment: { label: 'Pago — confirmación', path: '/payment/success' },
  // The shop's own content bodies (acerca, FAQ, políticas, colecciones, convocatoria).
  shop: { label: 'Tienda — contenido', path: '/s/[slug]' },
  s: { label: 'Tienda pública', path: '/s/[slug]' },
  components: { label: 'Componentes compartidos', path: '(se usan en varias páginas)' },
  // Living Shop (epic 07). The Wall renders on the shop homepage across all
  // three owned channels, so its destination is the shop home rather than any
  // one host; the section nav appears on every shop page, which is a KNOWN
  // multi-page case and says so instead of naming a route it does not own.
  wall: { label: 'Muro de la tienda', path: '/s/[slug]' },
  shopNav: { label: 'Navegación de la tienda', path: '(en todas las páginas de la tienda)' },
  shopSections: { label: 'Secciones de la tienda', path: '/s/[slug]/tienda' },
  // Living Shop (epic 07, Sprint 8) — the shop's own header, hero and footer,
  // and the supporting rail beside the Wall. Both render on every page of a
  // merchant's shop, which is a KNOWN multi-page case rather than one route.
  shopChrome: { label: 'Encabezado y portada de la tienda', path: '(en todas las páginas de la tienda)' },
  panels: { label: 'Panel lateral de la tienda', path: '(en todas las páginas de la tienda)' },
}

/**
 * `buyerShell` is the platform chrome — the header, search box, cart drawer,
 * account menu and mobile tab bar that `PlatformShell` renders on EVERY page.
 * Every one of its 15 sections has the same destination, so the namespace
 * resolves uniformly and the nav shows that destination once at the group
 * header (`uniformRoute`) instead of repeating it fifteen times.
 */
const BUYER_SHELL_ROUTE: RouteInfo = {
  label: 'Barra, menús y carrito',
  path: '(aparece en toda la plataforma)',
}

/**
 * `sellerCopy` sections are PAGE DIRECTORIES derived from the source file, not
 * dictionary key segments — see `lib/copy-overrides-sections.ts` for why. So
 * the route is derived from the section itself rather than looked up in a
 * hand-maintained table: a 33-entry table would go stale the first time a
 * seller-portal page is added or renamed, and this map's whole job is to not
 * be the thing that goes stale.
 */
function sellerCopyRoute(section: string): RouteInfo | null {
  if (section === UNMAPPED_SELLER_SECTION) {
    // Recognized, but deliberately NOT a page: these keys are in the dictionary
    // and absent from `locales/seller-population.json`. Reaching a non-empty
    // group here means the two have drifted — that is what the coverage spec asserts.
    return { label: 'Sin página asignada (revisar seller-population.json)', path: '(no derivado de un archivo fuente)' }
  }
  if (!section) return null
  return { label: sellerPageLabel(section), path: `/${section}` }
}

/**
 * `shop/manage/orders/[id]` → `Panel — Pedidos · detalle`. Purely mechanical:
 * the path IS the label's content, so a new page names itself without an edit here.
 */
function sellerPageLabel(section: string): string {
  const segments = section.split('/')
  const prefix = segments[0] === 'shop' && segments[1] === 'manage' ? 'Panel' : 'Publicar'
  const rest = segments.slice(segments[0] === 'shop' && segments[1] === 'manage' ? 2 : 1)
  if (rest.length === 0) return segments[0] === 'sell' ? 'Publicar (asistente)' : 'Panel de tienda'
  return `${prefix} — ${rest.map(humanizeRouteSegment).join(' · ')}`
}

/**
 * es-MX names for the route segments whose directory name is English or an
 * abbreviation. Deliberately NOT exhaustive and deliberately fail-soft: an
 * unlisted segment falls back to the humanized directory name, so a new page
 * appears in the nav with a slightly plain label instead of not appearing at
 * all. A missing entry can only cost polish, never correctness — which is why
 * this table is safe to keep hand-maintained where the 33-entry route table it
 * replaced would not have been.
 */
const SEGMENT_LABELS: Record<string, string> = {
  analytics: 'Métricas',
  catalogo: 'Catálogo',
  collections: 'Colecciones',
  content: 'Contenido',
  edit: 'Editar anuncio',
  import: 'Importar',
  mercadolibre: 'Mercado Libre',
  offers: 'Ofertas',
  orders: 'Pedidos',
  print: 'Edición impresa',
  profit: 'Ganancias',
  promotions: 'Promociones',
  settings: 'Ajustes',
  setup: 'Configuración con agente',
  shopify: 'Shopify',
  subscriptions: 'Suscripciones',
  sweepstakes: 'Sorteos',
  wizard: 'Asistente',
}

/** `[id]` → `detalle`; `canal-propio` → `Canal propio`; `analytics` → `Métricas`. */
function humanizeRouteSegment(segment: string): string {
  if (/^\[.*\]$/.test(segment)) return 'detalle'
  const named = SEGMENT_LABELS[segment]
  if (named) return named
  const words = segment.replace(/-/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A namespace with one single page (no per-section fan-out). */
const SIMPLE_NAMESPACE_ROUTES: Record<string, RouteInfo | null> = {
  // `home.*` is the Mexico marketplace copy. The master-brand root `/` is now
  // the market selector and does not consume this dictionary namespace.
  home: { label: 'Inicio', path: '/mx' },
  terms: { label: 'Términos', path: '/terminos' },
  acerca: { label: 'Acerca (plataforma)', path: '/acerca' },
  precios: { label: 'Precios', path: '/mx/precios' },
  // Site-wide mechanics rendered in the shell on every page — a KNOWN
  // no-single-page case (site config), not "unrecognized".
  platformTheme: { label: 'Tema de la plataforma', path: '(config. de toda la plataforma)' },
  pwaSearch: { label: 'Búsqueda (app)', path: '(config. de toda la plataforma)' },
}

/**
 * Fallback label shown ONLY when `routeFor*` resolves to `null` — a
 * namespace/section this map does not recognize at all (Sprint 4: every
 * KNOWN no-single-page case now gets its own descriptive `RouteInfo` instead
 * of `null`, so reaching this fallback is itself a signal this map is
 * missing a real, new namespace/section — not a normal, expected state).
 */
export const NO_SINGLE_PAGE_LABEL = 'sección no reconocida — revisar lib/copy-overrides-routes.ts'

/** Friendly namespace label for a filter dropdown (top-level, not per-section). */
export function namespaceLabel(namespace: string): string {
  if (namespace === 'sellerAcquisition') return 'Vende (todas las páginas)'
  if (namespace === 'sweepstakes') return 'Sorteos'
  if (namespace === 'events') return 'Eventos'
  if (namespace === 'partnersRecruiting') return 'Miyagi Partners'
  if (namespace === 'buyerShell') return 'Barra y menús (toda la plataforma)'
  if (namespace === 'buyerCopy') return 'Compra (todas las páginas)'
  if (namespace === 'sellerCopy') return 'Panel de tienda (todas las páginas)'
  return SIMPLE_NAMESPACE_ROUTES[namespace]?.label ?? namespace
}

/**
 * Resolve the route for a namespace + its first key-segment ("section" — the
 * same split `r.key.split('.')[0]` the editor already groups rows by).
 * Returns `null` ONLY for a namespace/section this map doesn't recognize at
 * all — every known case (including every "no single page" one) gets a real
 * `RouteInfo` now (Sprint 4).
 */
export function routeForNamespaceSection(namespace: string, section: string): RouteInfo | null {
  if (namespace === 'sellerAcquisition') return SELLER_ACQUISITION_SECTIONS[section] ?? null
  if (namespace === 'sweepstakes') return SWEEPSTAKES_SECTIONS[section] ?? null
  if (namespace === 'events') return EVENTS_SECTIONS[section] ?? null
  if (namespace === 'partnersRecruiting') return PARTNERS_RECRUITING_SECTIONS[section] ?? null
  if (namespace === 'buyerCopy') return BUYER_COPY_SECTIONS[section] ?? null
  // Every section of the platform chrome resolves to the same destination.
  if (namespace === 'buyerShell') return BUYER_SHELL_ROUTE
  if (namespace === 'sellerCopy') return sellerCopyRoute(section)
  return SIMPLE_NAMESPACE_ROUTES[namespace] ?? null
}

/** Convenience wrapper — derives the section from a full dot-path `key` the same way the editor groups by. */
export function routeForKey(namespace: string, key: string): RouteInfo | null {
  return routeForNamespaceSection(namespace, sectionForKey(namespace, key))
}
