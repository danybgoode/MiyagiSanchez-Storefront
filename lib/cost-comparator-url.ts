/**
 * lib/cost-comparator-url.ts
 *
 * Comparador de costos (epic 08 · cost-comparator-homepage, Sprint 2 · US-2.2) — the
 * PURE URL ⇄ state codec for the comparator's full input surface: platform, its
 * tier/band/type/hosting/gateway selection, volume, AOV, selected premium apps, the
 * three Miyagi SKU toggles, and any hand-edited line overrides (US-1.3). Next-free
 * (mirrors `lib/cost-comparator.ts`) so a unit spec can build → parse and assert an
 * exact round trip with zero framework in the require graph.
 *
 * `app/(shell)/comparador/page.tsx` (SSR prefill, US-1.3) and `ComparadorTool`'s
 * "Copiar enlace" share button (US-2.2, client-side) both go through this ONE codec
 * — the promoter/consultant leave-behind link
 * (`app/(shell)/mx/vende/promotor/sell-sheet/page.tsx`) points at `/comparador`
 * generically (no per-visit data to prefill from a static printable page), but a
 * live session's "Copiar enlace" always round-trips through here.
 *
 * LINE OVERRIDES ARE INCLUDED (revised from the original Sprint-2 draft — see PR
 * 278 review): the "Copiar enlace" copy claims "comparación exacta", and a
 * consultant who hand-tuned a competitor's figure before sharing expects that edit
 * to survive the link too. Serialized as a single `ov` param (URI-encoded JSON,
 * `{ [lineKey]: monthlyMxn }`); an unparseable blob or a non-finite value is
 * silently dropped (fail-open, never fabricates — same discipline as
 * `applyDatasetOverrides`). Kept as one param (not one per line) since the key
 * space is dynamic (platform:tier:lineKey / miyagi:lineKey) and unbounded in
 * principle, but realistically tiny (a handful of edited figures at most).
 *
 * PLATFORM-GATED PARSING (fixed in this revision — see PR 278 review): `tier` is
 * shared between Shopify and Tiendanube (both have tier names like "basico"/
 * "avanzado"). Earlier this file parsed BOTH `shopifyTier` and `tnTier` from
 * `sp.tier` unconditionally, so a Shopify link (`?platform=shopify&tier=avanzado`)
 * would silently seed Tiendanube's tier to "avanzado" too — invisible until the
 * visitor switched the platform dropdown client-side. Every platform-specific field
 * now only reads its own query param when `platform` actually matches that
 * platform; otherwise it takes its own default. This mirrors `build`, which already
 * only ever writes the ACTIVE platform's own params — parse and build are now
 * symmetric on this point.
 */

import type {
  ShopifyTier,
  MlBand,
  MlPublicationType,
  WooCommerceHostingTier,
  TiendanubeTier,
  T1Tier,
} from './cost-comparator'

export type CompetitorPlatform = 'shopify' | 'mercadolibre' | 'woocommerce' | 'tiendanube' | 't1'

export const COMPARADOR_PLATFORMS: CompetitorPlatform[] = ['shopify', 'mercadolibre', 'woocommerce', 'tiendanube', 't1']
export const COMPARADOR_SHOPIFY_TIERS: ShopifyTier[] = ['basico', 'crecimiento', 'avanzado']
export const COMPARADOR_ML_BANDS: MlBand[] = ['baja', 'media', 'alta']
export const COMPARADOR_ML_TYPES: MlPublicationType[] = ['clasica', 'premium']
export const COMPARADOR_WOO_TIERS: WooCommerceHostingTier[] = ['entrada', 'crecimiento']
export const COMPARADOR_TN_TIERS: TiendanubeTier[] = ['gratis', 'basico', 'tiendanube', 'avanzado']
// T1's free plan cannot sell online (pricing-page A1), so it is not a comparable tier.
export const COMPARADOR_T1_TIERS: T1Tier[] = ['basico', 'avanzado']

export interface ComparadorMiyagiSkus {
  subdomain: boolean
  customDomain: boolean
  mlSync: boolean
}

export interface ComparadorState {
  platform: CompetitorPlatform
  shopifyTier: ShopifyTier
  mlBand: MlBand
  mlPublicationType: MlPublicationType
  wooTier: WooCommerceHostingTier
  tnTier: TiendanubeTier
  tnOwnGateway: boolean
  t1Tier: T1Tier
  /** T1pagos (true) or an external provider with T1's own cut (false). */
  t1Pagos: boolean
  volume: number
  aov: number
  selectedAppIds: string[]
  miyagiSkus: ComparadorMiyagiSkus
  /** Hand-edited figures (US-1.3), keyed exactly like `ComparadorTool`'s
   * `lineOverrides` state (`${platform}:${tierKey}:${lineKey}` / `miyagi:${lineKey}`). */
  lineOverrides: Record<string, number>
}

/** The shape Next.js hands a Server Component's `searchParams`, and what
 * `URLSearchParams` looks like through a small adapter — either works as `sp`. */
export type SearchParamsLike = Record<string, string | string[] | undefined>

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

function toNumber(v: string | string[] | undefined, fallback: number): number {
  const raw = first(v)
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function pick<T extends string>(v: string | string[] | undefined, allowed: T[], fallback: T): T {
  const raw = first(v)
  return (allowed as string[]).includes(raw ?? '') ? (raw as T) : fallback
}

function boolParam(v: string | string[] | undefined): boolean {
  return first(v) === '1'
}

/** Parses the `ov` param into a validated override map. Never throws: malformed
 * JSON, a non-object payload, or a non-finite value all just drop that entry (or
 * the whole param) rather than fabricating a number — mirrors
 * `applyDatasetOverrides`'s fail-open contract. */
function parseLineOverrides(v: string | string[] | undefined): Record<string, number> {
  const raw = first(v)
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const n = Number(value)
    if (Number.isFinite(n)) out[key] = n
  }
  return out
}

/** `URLSearchParams` → the plain record shape `parseComparadorState` reads. */
export function searchParamsToRecord(params: URLSearchParams): SearchParamsLike {
  const rec: SearchParamsLike = {}
  for (const key of params.keys()) rec[key] = params.get(key) ?? undefined
  return rec
}

/**
 * Parse the comparator's full state from query params. `validAppIds` scopes the
 * `apps` param to app ids the current dataset actually offers — an unknown/typo'd
 * id is silently dropped (never fabricates a selection), same fail-open discipline
 * as `applyDatasetOverrides`.
 */
export function parseComparadorState(sp: SearchParamsLike, validAppIds: readonly string[]): ComparadorState {
  const platform = pick(sp.platform, COMPARADOR_PLATFORMS, 'shopify')

  const appsRaw = first(sp.apps)
  const selectedAppIds = appsRaw
    ? appsRaw.split(',').map((s) => s.trim()).filter((id) => id.length > 0 && validAppIds.includes(id))
    : []

  return {
    platform,
    // Platform-gated: `tier` is shared by Shopify/Tiendanube, so only the ACTIVE
    // platform reads it — the other falls back to its own default, never bleeds
    // the other's value in (see this file's header for the bug this fixes).
    shopifyTier: platform === 'shopify' ? pick(sp.tier, COMPARADOR_SHOPIFY_TIERS, 'basico') : 'basico',
    mlBand: platform === 'mercadolibre' ? pick(sp.band, COMPARADOR_ML_BANDS, 'media') : 'media',
    mlPublicationType: platform === 'mercadolibre' ? pick(sp.type, COMPARADOR_ML_TYPES, 'clasica') : 'clasica',
    wooTier: platform === 'woocommerce' ? pick(sp.hosting, COMPARADOR_WOO_TIERS, 'entrada') : 'entrada',
    tnTier: platform === 'tiendanube' ? pick(sp.tier, COMPARADOR_TN_TIERS, 'basico') : 'basico',
    tnOwnGateway: platform === 'tiendanube' ? first(sp.gateway) !== 'external' : true,
    t1Tier: platform === 't1' ? pick(sp.tier, COMPARADOR_T1_TIERS, 'basico') : 'basico',
    t1Pagos: platform === 't1' ? first(sp.gateway) !== 'external' : true,
    volume: toNumber(sp.volume, 100),
    aov: toNumber(sp.aov, 500),
    selectedAppIds,
    miyagiSkus: {
      subdomain: boolParam(sp.sub),
      customDomain: boolParam(sp.dom),
      mlSync: boolParam(sp.mlsync),
    },
    lineOverrides: parseLineOverrides(sp.ov),
  }
}

/** Build the `/comparador` query string that round-trips `state` through
 * `parseComparadorState` — only the platform's OWN tier/band params are written
 * (no stale params from a platform the visitor already switched away from). */
export function buildComparadorShareParams(state: ComparadorState): URLSearchParams {
  const params = new URLSearchParams()
  params.set('platform', state.platform)

  if (state.platform === 'shopify') {
    params.set('tier', state.shopifyTier)
  } else if (state.platform === 'mercadolibre') {
    params.set('band', state.mlBand)
    params.set('type', state.mlPublicationType)
  } else if (state.platform === 'woocommerce') {
    params.set('hosting', state.wooTier)
  } else if (state.platform === 'tiendanube') {
    params.set('tier', state.tnTier)
    if (!state.tnOwnGateway) params.set('gateway', 'external')
  } else if (state.platform === 't1') {
    params.set('tier', state.t1Tier)
    if (!state.t1Pagos) params.set('gateway', 'external')
  }

  params.set('volume', String(state.volume))
  params.set('aov', String(state.aov))
  if (state.selectedAppIds.length > 0) params.set('apps', state.selectedAppIds.join(','))
  if (state.miyagiSkus.subdomain) params.set('sub', '1')
  if (state.miyagiSkus.customDomain) params.set('dom', '1')
  if (state.miyagiSkus.mlSync) params.set('mlsync', '1')
  if (Object.keys(state.lineOverrides).length > 0) params.set('ov', JSON.stringify(state.lineOverrides))

  return params
}
