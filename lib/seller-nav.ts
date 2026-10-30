/**
 * Seller-mode navigation config — pure, next-free.
 *
 * `SellerNav.tsx` renders the desktop left rail + mobile bar from this single
 * source; the api spec (`e2e/seller-mode.spec.ts`) asserts every entry maps to a
 * real `/shop/manage/*` page and that the active matcher resolves correctly — so
 * the nav can't drift from the routes or the test. No new pages are created here:
 * every href targets an existing manage sub-page (or the dashboard).
 *
 * Four rail groups: Operar / Catálogo / Crecer / Configuración (catalog-management
 * epic, Sprint 1 · Story 1.1). "Anuncios" now points at the real `/shop/manage/catalogo`
 * table (Sprint 1 · Story 1.2) instead of the old `/shop/manage#anuncios` jump-link —
 * the dashboard keeps only a compact summary card. "Precios" is deliberately NOT added
 * yet — that page ships in a later catalog-management sprint; the nav never links a 404.
 *
 * `import type` only for `FlagKey` — erased at compile time, so this file stays
 * next-free/pure even though `lib/flags.ts` itself is `server-only` (catalog-management
 * epic, Sprint 5 · Story 5.1 — R13 flag-safe nav parity).
 */

import type { FlagKey } from './flags'
import type { SellerLocale } from './seller-locale'

/**
 * Seller nav labels per LOCALE (us-marketplace S5.1 / D17).
 *
 * Keyed by the render locale rather than the market: the market only defaults
 * the locale (`lib/seller-locale.ts`), and the rail has to follow the seller's
 * explicit choice or a merchant who picks English gets an English page inside a
 * Spanish rail.
 *
 * The rail is the frame a merchant sees on EVERY page of their portal, so it is where
 * an untranslated portal is most obviously untranslated. The es-MX column is copied
 * verbatim from the literals that used to be inline — `/mx` must not move by a
 * character, and the spec asserts that against the exact strings.
 *
 * Brand names stay as authored (AGENTS.md rule 5): "Mercado Libre" is a company, not a
 * phrase to translate.
 */
const NAV_LABELS = {
  es: {
    operar: 'Operar', resumen: 'Resumen', pedidos: 'Pedidos', ofertas: 'Ofertas', venderEnPersona: 'Vender en persona', cobrarConLink: 'Cobrar con un link',
    catalogo: 'Catálogo', anuncios: 'Anuncios', colecciones: 'Colecciones',
    canales: 'Canales', mercadoLibre: 'Mercado Libre', importar: 'Importar catálogo',
    crecer: 'Crecer', cupones: 'Cupones', suscripciones: 'Suscripciones',
    contenido: 'Contenido', eventos: 'Eventos', sorteos: 'Sorteos',
    analiticas: 'Analíticas', ganancias: 'Ganancias', configuracion: 'Configuración',
    miTienda: 'Mi tienda',
  },
  en: {
    operar: 'Operate', resumen: 'Overview', pedidos: 'Orders', ofertas: 'Offers', venderEnPersona: 'Sell in person', cobrarConLink: 'Charge with a link',
    catalogo: 'Catalog', anuncios: 'Listings', colecciones: 'Collections',
    canales: 'Channels', mercadoLibre: 'Mercado Libre', importar: 'Import catalog',
    crecer: 'Grow', cupones: 'Coupons', suscripciones: 'Subscriptions',
    contenido: 'Content', eventos: 'Events', sorteos: 'Giveaways',
    analiticas: 'Analytics', ganancias: 'Earnings', configuracion: 'Settings',
    miTienda: 'My shop',
  },
} as const

export type SellerNavLabelKey = keyof typeof NAV_LABELS['es']

/** The label table for a locale. `es` is the documented default for an unknown one. */
export function sellerNavLabels(locale: SellerLocale = 'es') {
  return locale === 'en' ? NAV_LABELS.en : NAV_LABELS.es
}

/**
 * Re-label a nav tree for a locale.
 *
 * Deliberately a TRANSFORM over the existing constants rather than a second tree: one
 * structure, one set of hrefs, one flag mapping. A parallel English tree would drift
 * the moment someone adds a page to only one of them — and the drift would be
 * invisible, because each tree would still render fine on its own.
 */
export function localizeSellerNav<G extends { label: string; entries: SellerNavEntry[] }>(
  groups: G[],
  locale: SellerLocale,
): G[] {
  const labels = sellerNavLabels(locale)
  const t = (value: string) => LABEL_KEY_BY_ES[value] ? labels[LABEL_KEY_BY_ES[value]] : value
  return groups.map((group) => ({
    ...group,
    label: t(group.label),
    entries: group.entries.map((entry) => ({
      ...entry,
      label: t(entry.label),
      ...(entry.mobileLabel ? { mobileLabel: t(entry.mobileLabel) } : {}),
    })),
  }))
}

export function localizeSellerNavEntries(entries: SellerNavEntry[], locale: SellerLocale): SellerNavEntry[] {
  return localizeSellerNav([{ label: '', entries }], locale)[0].entries
}

/**
 * es-MX label → key. The es column IS the identity of a label, because the constants
 * below are still authored in Spanish; translating is a lookup, and an unrecognised
 * string passes through unchanged rather than rendering blank.
 */
const LABEL_KEY_BY_ES: Record<string, SellerNavLabelKey> = Object.fromEntries(
  Object.entries(NAV_LABELS.es).map(([key, value]) => [value, key as SellerNavLabelKey]),
) as Record<string, SellerNavLabelKey>

export interface SellerNavEntry {
  /** Stable id for keys/tests. */
  key: string
  /** es-MX label (rail + "Más" sheet). */
  label: string
  /** Destination — an existing `/shop/manage*` route, optionally with a `#hash`. */
  href: string
  /** Iconoir class (icons are loaded globally in `app/layout.tsx`). */
  icon: string
  /** When set, the entry only renders while this flag is ON (server-resolved via `isEnabled()`). */
  flag?: FlagKey
  /** Overrides `label` in the mobile primary bar only (rail + "Más" keep `label`). */
  mobileLabel?: string
}

export interface SellerNavGroup {
  key: string
  label: string
  entries: SellerNavEntry[]
}

/** A "Más" sheet section. `layout: 'grid'` renders as a 3-column icon grid (Crecer); default is a plain list. */
export interface SellerNavMobileOverflowGroup {
  key: string
  label: string
  entries: SellerNavEntry[]
  layout?: 'list' | 'grid'
}

export const SELLER_NAV: SellerNavGroup[] = [
  {
    key: 'operar',
    label: 'Operar',
    entries: [
      { key: 'resumen', label: 'Resumen', href: '/shop/manage', icon: 'iconoir-dashboard-dots' },
      { key: 'pedidos', label: 'Pedidos', href: '/shop/manage/orders', icon: 'iconoir-package' },
      { key: 'ofertas', label: 'Ofertas', href: '/shop/manage/offers', icon: 'iconoir-hand-cash' },
      // In-person sales S1.3: the counter. Appended LAST so the indices the mobile bar and
      // the "Más" sheet slice by (Resumen 0, Pedidos 1, Ofertas 2) do not move.
      { key: 'vender', label: 'Vender en persona', href: '/shop/manage/en-persona', icon: 'iconoir-smartphone-device' },
      { key: 'cobros', label: 'Cobrar con un link', href: '/shop/manage/cobros', icon: 'iconoir-link' },
    ],
  },
  {
    key: 'catalogo',
    label: 'Catálogo',
    entries: [
      { key: 'anuncios', label: 'Anuncios', href: '/shop/manage/catalogo', icon: 'iconoir-shopping-bag', mobileLabel: 'Catálogo' },
      { key: 'colecciones', label: 'Colecciones', href: '/shop/manage/collections', icon: 'iconoir-view-grid' },
      // Repointed to the new federation page — dominio propio / subdominio / URL
      // gratis / embed (catalog-management S6.2). Previously this "Canales" label
      // pointed at the Mercado Libre status page (S1's "ML becomes 'Canales'"
      // rename); that page now has its own distinct entry below instead of
      // sharing this label.
      { key: 'canales', label: 'Canales', href: '/shop/manage/canal-propio', icon: 'iconoir-internet' },
      { key: 'mercadolibre', label: 'Mercado Libre', href: '/shop/manage/mercadolibre', icon: 'iconoir-shop' },
      { key: 'importar', label: 'Importar catálogo', href: '/shop/manage/import', icon: 'iconoir-cloud-upload' },
    ],
  },
  {
    key: 'crecer',
    label: 'Crecer',
    entries: [
      { key: 'promociones', label: 'Cupones', href: '/shop/manage/promotions', icon: 'iconoir-percentage-circle' },
      { key: 'suscripciones', label: 'Suscripciones', href: '/shop/manage/subscriptions', icon: 'iconoir-refresh-double' },
      { key: 'contenido', label: 'Contenido', href: '/shop/manage/content', icon: 'iconoir-book' },
      { key: 'eventos', label: 'Eventos', href: '/shop/manage/eventos', icon: 'iconoir-calendar' },
      { key: 'sorteos', label: 'Sorteos', href: '/shop/manage/sweepstakes', icon: 'iconoir-gift' },
      { key: 'analitica', label: 'Analíticas', href: '/shop/manage/analytics', icon: 'iconoir-graph-up' },
      // Gated on ops.profit_enabled: the page itself still notFound()s while the
      // flag is OFF (profit-analyzer S1 · US-3), but the entry is now ALSO hidden
      // nav-side (catalog-management S5 · Story 5.1 — R13) so a seller never taps
      // into that 404 in the first place.
      { key: 'ganancias', label: 'Ganancias', href: '/shop/manage/profit', icon: 'iconoir-coins', flag: 'ops.profit_enabled' },
    ],
  },
  {
    key: 'configuracion',
    label: 'Configuración',
    entries: [
      // Living Shop (epic 07): the Wall/Sections/Theme/Brand studio. A separate
      // entry rather than a settings section — it is authoring, not configuration,
      // and it has its own guarded root (epic D8) so it cannot re-grow Diseno.tsx.
      { key: 'tienda', label: 'Mi tienda', href: '/shop/manage/tienda', icon: 'iconoir-palette' },
      { key: 'ajustes', label: 'Configuración', href: '/shop/manage/settings', icon: 'iconoir-settings' },
    ],
  },
]

/**
 * Mobile bottom bar (catalog-management S5 · Story 5.2 — F5) = 3 data-backed slots
 * — Resumen · Pedidos · Anuncios (rendered as "Catálogo" via `mobileLabel`) — plus
 * two FIXED, non-data UI slots the renderer places around them: a center "Publicar"
 * FAB (→ `/sell`) and a trailing "Más" trigger. 5 visual slots total; Ofertas moved
 * into the "Más" sheet's Operar group below (still ≤2 taps away).
 */
export const SELLER_NAV_MOBILE_PRIMARY: SellerNavEntry[] = [
  SELLER_NAV[0].entries[0], // Resumen
  SELLER_NAV[0].entries[1], // Pedidos
  SELLER_NAV[1].entries[0], // Anuncios ("Catálogo" on mobile)
]

/**
 * The "Más" sheet, grouped with headers (no ungrouped junk drawer). Four groups —
 * Operar remainder, Catálogo remainder, Crecer (rendered as a grid), Configuración
 * — cover every `SELLER_NAV` entry not promoted into the primary bar, so nothing
 * silently loses mobile reachability (see `seller-mode.spec.ts`'s completeness
 * guard, which asserts this against `SELLER_NAV` itself).
 */
export const SELLER_NAV_MOBILE_OVERFLOW_GROUPS: SellerNavMobileOverflowGroup[] = [
  { key: 'operar', label: 'Operar', entries: SELLER_NAV[0].entries.slice(2) }, // Ofertas, Vender en persona
  { key: 'catalogo', label: 'Catálogo', entries: SELLER_NAV[1].entries.slice(1) }, // Colecciones, Canales, Mercado Libre, Importar catálogo
  { key: 'crecer', label: 'Crecer', entries: SELLER_NAV[2].entries, layout: 'grid' },
  { key: 'configuracion', label: 'Configuración', entries: SELLER_NAV[3].entries },
]

/**
 * Drops any entry whose `flag` is set and not present in `enabledFlags`, and any
 * group left with zero entries (defensive — doesn't happen with today's config,
 * but keeps the function correct if a whole group is ever flag-gated later).
 * Pure — the server resolves `enabledFlags` via `isEnabled()`, this just filters.
 * Generic over both the rail's `SellerNavGroup` and the "Más" sheet's
 * `SellerNavMobileOverflowGroup` (spreading `...group` preserves the latter's
 * extra `layout` field untouched).
 */
export function filterNavByEnabledFlags<G extends { entries: SellerNavEntry[] }>(groups: G[], enabledFlags: ReadonlySet<FlagKey>): G[] {
  return groups
    .map(group => ({
      ...group,
      entries: group.entries.filter(entry => !entry.flag || enabledFlags.has(entry.flag)),
    }))
    .filter(group => group.entries.length > 0)
}

/** Same filter as {@link filterNavByEnabledFlags}, for a flat entry list (e.g. the mobile primary bar). */
export function filterEntriesByEnabledFlags(entries: SellerNavEntry[], enabledFlags: ReadonlySet<FlagKey>): SellerNavEntry[] {
  return entries.filter(entry => !entry.flag || enabledFlags.has(entry.flag))
}

/**
 * True when any entry across the (already flag-filtered) "Más" overflow groups
 * carries a nonzero badge count — the signal that lights up the info-colored
 * relay dot on the "Más" trigger itself, fed by the same `badges` map keyed on
 * `SellerNavEntry.key` that the sheet uses to render each entry's own badge.
 */
export function hasRelayBadge(
  overflowGroups: { entries: SellerNavEntry[] }[],
  badges: Readonly<Partial<Record<string, number>>>,
): boolean {
  return overflowGroups.some(group => group.entries.some(entry => (badges[entry.key] ?? 0) > 0))
}

/** Pathname portion of an href (drops any `#hash`). */
function hrefPath(href: string): string {
  const hash = href.indexOf('#')
  return hash === -1 ? href : href.slice(0, hash)
}

/**
 * The single active entry href for a pathname. Longest pathname-prefix wins
 * (so `/shop/manage/orders` highlights Pedidos, not Resumen, and
 * `/shop/manage/catalogo` highlights Anuncios, not Resumen); ties resolve to
 * the first declared. Returns null when nothing matches.
 */
export function activeSellerNavHref(pathname: string): string | null {
  if (!pathname) return null
  let best: { href: string; len: number } | null = null
  for (const group of SELLER_NAV) {
    for (const entry of group.entries) {
      const base = hrefPath(entry.href)
      const matches = pathname === base || pathname.startsWith(base + '/')
      if (!matches) continue
      // Strict `>` keeps the first-declared entry on an equal-length tie.
      if (!best || base.length > best.len) best = { href: entry.href, len: base.length }
    }
  }
  return best?.href ?? null
}

/** One crumb in a seller breadcrumb trail. `href: null` = the current page (not a link). */
export interface SellerCrumb {
  label: string
  href: string | null
}

const DASHBOARD_HREF = '/shop/manage'

/** The nav entry whose route owns this pathname (canonical label lookup). */
function activeSellerNavEntry(pathname: string): SellerNavEntry | null {
  const href = activeSellerNavHref(pathname)
  if (!href) return null
  for (const group of SELLER_NAV) {
    for (const entry of group.entries) {
      if (entry.href === href) return entry
    }
  }
  return null
}

/**
 * The "Resumen / <Section>" breadcrumb trail for a `/shop/manage*` pathname,
 * derived from the same nav SSOT as the rail — so the section label is always the
 * canonical rail label and the two can't drift. On the dashboard (or off the
 * seller surface) it returns the single Resumen crumb.
 *
 * `extra` appends deeper crumbs after the section (e.g. an order id, or a settings
 * sub-section title). The LAST crumb of the returned trail always has `href: null`
 * (it's the current page); every crumb before it keeps its link.
 */
export function sellerBreadcrumbTrail(pathname: string, extra: SellerCrumb[] = []): SellerCrumb[] {
  const trail: SellerCrumb[] = [{ label: 'Resumen', href: DASHBOARD_HREF }]
  const entry = activeSellerNavEntry(pathname)
  // Skip the Resumen entry itself (it'd just duplicate the home crumb).
  if (entry && hrefPath(entry.href) !== DASHBOARD_HREF) {
    trail.push({ label: entry.label, href: hrefPath(entry.href) })
  }
  trail.push(...extra)
  // The page you're on is never a link.
  trail[trail.length - 1] = { ...trail[trail.length - 1], href: null }
  return trail
}
