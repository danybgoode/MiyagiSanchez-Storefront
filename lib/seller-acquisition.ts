import { DEFAULT_MARKET, type MarketCode } from './markets'

export type SellerPersonaId = 'vende' | 'creadores' | 'mundial' | 'negocios' | 'servicios' | 'autos'
export type SellerAcquisitionVariant = 'a' | 'b'

/**
 * Where a merchant's pitch page lives, per market — the ONE place that knows.
 *
 * Before this table there was no such place: `/vende` was hardcoded in the shell
 * header, the shell footer, the marketplace home CTA, the signed-in seller module
 * and the root selector, while the US landing had no URL at all and rendered only
 * as the signed-out branch of `/sell?market=us`. A US visitor who clicked "Post
 * for free" in English chrome therefore landed on a Spanish page, and the US
 * landing could not be linked, shared or indexed. Both are the same defect: the
 * destination was a literal, not a function of the market the visitor is in.
 *
 * Each market's landing sits UNDER its own market prefix, so the URL states the
 * market it is selling and the market chrome (`(mx-site)`/`(us-site)` layouts,
 * `<html lang>`, Clerk localization) follows from the route rather than from a
 * query parameter. `/vende` and `/sell?market=us` still resolve — as 308s in
 * `next.config.ts`, so every printed flyer, ad and inbound link keeps working.
 *
 * NOT `marketBasePath(market) + suffix`: the suffix is a different WORD per market
 * ("vende" in Spanish, "sell" in English) and that is deliberate, not an oversight
 * to be normalized away — a Mexican seller should not be sent to an English URL.
 *
 * Mexico's is the exception, on purpose: since root-shop-builder-home (2026-10-29) its landing
 * is the bare domain, `/`. The domain is what gets said out loud and printed, and a landing
 * nobody can guess (`/mx/vende`) was the one leads never reached. `/mx/vende` and `/vende` are
 * 308s to `/`; the Spanish persona pages stay under `/mx/vende/<persona>`.
 */
export const SELLER_LANDING_PATHS: Readonly<Record<MarketCode, string>> = Object.freeze({
  mx: '/',
  us: '/us/sell',
})

/**
 * The landing a visitor in this market belongs on.
 *
 * Total over `MarketCode` so a new market cannot be added without deciding where
 * its sellers are recruited — an unknown value falls back to the default market
 * rather than to a dead link.
 */
export function sellerLandingPath(market: MarketCode | null | undefined = DEFAULT_MARKET): string {
  return SELLER_LANDING_PATHS[market ?? DEFAULT_MARKET] ?? SELLER_LANDING_PATHS[DEFAULT_MARKET]
}

/** The MX landing — `/` since root-shop-builder-home. */
const MX_LANDING = SELLER_LANDING_PATHS.mx

/**
 * Where the Spanish persona pages live: `/mx/vende/<persona>`. NOT derived from the landing.
 * It was, as `${MX_LANDING}/creadores`, until the landing became `/` — at which point every
 * persona URL would have become `//creadores` (a protocol-relative URL to a host named
 * "creadores"). The landing and the persona family are two facts now; each is stated once.
 */
export const MX_SELLER_PAGES_BASE = '/mx/vende'

/**
 * Where a SIGNED-OUT visitor who asked for `/sell` should be sent.
 *
 * `/sell` is the publish wizard and it always needed an account, so its signed-out
 * branch was a third seller pitch page — a Spanish hero competing with `/mx/vende`
 * for the same visitor, reachable by typing the most obvious URL on the site, and
 * maintained by nobody. It is gone; this is where that request goes instead.
 *
 * Attribution survives the hop. `from`, the A/B `v` and every sanitized UTM are
 * carried onto the landing, because a visitor who arrived from a campaign pointing
 * at `/sell` must still be counted as that campaign's. `market` is deliberately
 * NOT carried: the destination path already states the market, and a stale
 * `?market=` riding along would be a second, weaker authority for the one fact the
 * URL is now responsible for.
 */
export function sellerLandingRedirectPath(
  market: MarketCode | null | undefined,
  input?: QueryInput,
): string {
  const params = new URLSearchParams()

  const source = toSearchParams(input)
  const from = source.get('from')?.trim()
  if (from) params.set('from', from)

  const explicitVariant = readSellerAcquisitionVariant(input)
  if (explicitVariant?.explicit) {
    params.set(SELLER_ACQUISITION_VARIANT_PARAM, explicitVariant.variant)
  }

  const utm = parseSellerAcquisitionUtm(input)
  for (const key of UTM_KEYS) {
    const value = utm[key]
    if (value) params.set(key, value)
  }

  const qs = params.toString()
  const path = sellerLandingPath(market)
  return qs ? `${path}?${qs}` : path
}

const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const

const SELLER_ACQUISITION_VARIANTS = ['a', 'b'] as const
const SELLER_ACQUISITION_VARIANT_PARAM = 'v'

type QueryInput =
  | string
  | URLSearchParams
  | Record<string, string | string[] | undefined | null>
  | null
  | undefined

export type SellerAcquisitionUtm = Partial<Record<typeof UTM_KEYS[number], string>>

export type SellerPersonaRoute = {
  id: SellerPersonaId
  pagePath: string | null
  from: string
  type?: string
  status: 'live' | 'upcoming'
}

const MAX_UTM_VALUE_LENGTH = 140

export const SELLER_PERSONA_ROUTES: Record<SellerPersonaId, SellerPersonaRoute> = {
  vende: {
    id: 'vende',
    pagePath: MX_LANDING,
    from: 'vende',
    status: 'live',
  },
  creadores: {
    id: 'creadores',
    pagePath: `${MX_SELLER_PAGES_BASE}/creadores`,
    from: 'creadores',
    status: 'live',
  },
  mundial: {
    id: 'mundial',
    pagePath: `${MX_SELLER_PAGES_BASE}/mundial`,
    from: 'mundial',
    type: 'service',
    status: 'live',
  },
  negocios: {
    id: 'negocios',
    pagePath: `${MX_SELLER_PAGES_BASE}/negocios`,
    from: 'negocios',
    status: 'live',
  },
  servicios: {
    id: 'servicios',
    pagePath: `${MX_SELLER_PAGES_BASE}/servicios`,
    from: 'servicios',
    type: 'service',
    status: 'live',
  },
  autos: {
    id: 'autos',
    pagePath: `${MX_SELLER_PAGES_BASE}/autos`,
    from: 'autos',
    status: 'live',
  },
}

export function resolveSellerPersonaRoute(id: SellerPersonaId): SellerPersonaRoute {
  return SELLER_PERSONA_ROUTES[id]
}

const SELLER_ACQUISITION_BASE_URL = 'https://miyagisanchez.com'

/**
 * Builds the directive "ask your AI" prompt for a persona page by substituting the page's
 * own absolute URL into the shared `{url}` template. One base prompt, the URL swaps per page
 * so the visitor's agent reads the most relevant landing page when it evaluates the offer.
 */
export function sellerTrustPrompt(id: SellerPersonaId, template: string): string {
  const route = resolveSellerPersonaRoute(id)
  const url = `${SELLER_ACQUISITION_BASE_URL}${route.pagePath ?? MX_LANDING}`
  return template.replaceAll('{url}', url)
}

export function parseSellerAcquisitionUtm(input?: QueryInput): SellerAcquisitionUtm {
  const params = toSearchParams(input)
  const utm: SellerAcquisitionUtm = {}

  for (const key of UTM_KEYS) {
    const value = sanitizeUtmValue(params.get(key))
    if (value) {
      utm[key] = value
    }
  }

  return utm
}

export function resolveSellerAcquisitionVariant(input?: QueryInput): SellerAcquisitionVariant {
  return readSellerAcquisitionVariant(input)?.variant ?? 'a'
}

export function sellerPersonaCtaHref(id: SellerPersonaId, input?: QueryInput): string {
  const route = resolveSellerPersonaRoute(id)
  return buildSellHref(route.from, input, route.type)
}

/**
 * The US recruiting CTA — the `/sell` signed-out landing's primary and closing
 * buttons.
 *
 * Same convert-on-`/sign-up` shape as the MX personas, with one addition: the
 * publish destination carries `market=us`, because a shop's market is IMMUTABLE
 * after creation (us-marketplace S5.2 · D17) and the signup request is the only
 * moment it can be set. `resolveSellerSignupMarket` is the validator that reads
 * it — this function only has to make sure the parameter survives the trip
 * through account creation, which is exactly what `redirect_url` buys.
 */
export function usSellerCtaHref(input?: QueryInput): string {
  const params = new URLSearchParams()
  params.set('market', 'us')
  params.set('from', 'us')
  params.set(SELLER_ACQUISITION_VARIANT_PARAM, resolveSellerAcquisitionVariant(input))

  const utm = parseSellerAcquisitionUtm(input)
  for (const key of UTM_KEYS) {
    const value = utm[key]
    if (value) {
      params.set(key, value)
    }
  }

  return `${SELLER_SIGNUP_PATH}?redirect_url=${encodeURIComponent(`/sell?${params.toString()}`)}`
}

export function sellerPersonaRouterHref(id: SellerPersonaId, input?: QueryInput): string {
  const route = resolveSellerPersonaRoute(id)

  if (!route.pagePath) {
    return buildSellHref(route.from, input, route.type)
  }

  const utm = parseSellerAcquisitionUtm(input)
  const params = new URLSearchParams(utm)
  const explicitVariant = readSellerAcquisitionVariant(input)
  if (explicitVariant?.explicit) {
    params.set(SELLER_ACQUISITION_VARIANT_PARAM, explicitVariant.variant)
  }

  const qs = params.toString()
  return qs ? `${route.pagePath}?${qs}` : route.pagePath
}

export const SELLER_SIGNUP_PATH = '/sign-up'

/**
 * The publish destination a converted visitor lands on *after* creating their
 * account. This is what the CTA used to point at directly.
 */
function buildPublishHref(from: string, input?: QueryInput, type?: string): string {
  const params = new URLSearchParams()
  if (type) {
    params.set('type', type)
  }
  params.set('from', from)
  params.set(SELLER_ACQUISITION_VARIANT_PARAM, resolveSellerAcquisitionVariant(input))

  const utm = parseSellerAcquisitionUtm(input)
  for (const key of UTM_KEYS) {
    const value = utm[key]
    if (value) {
      params.set(key, value)
    }
  }

  return `/sell?${params.toString()}`
}

/**
 * The seller-acquisition CTA target: account creation FIRST, then the wizard.
 *
 * A visitor cannot publish without an account, so `/sell` used to greet them
 * with a second, thinner marketing page before handing them to `/sign-up`
 * anyway. Sending them straight to `/sign-up` removes that speed bump.
 *
 * Attribution — the persona `from`, the A/B `v` variant and every sanitized UTM
 * — is preserved INSIDE `redirect_url` rather than on `/sign-up` itself. Clerk
 * carries that parameter through its hosted flow and drops the new seller on
 * the wizard with exactly the query the CTA would have delivered pre-signup, so
 * variant reporting and UTM attribution are unbroken. `redirect_url` is the same
 * parameter the buyer sign-in CTAs already use, and a component-level
 * `signUpFallbackRedirectUrl` applies only when it is ABSENT — so the two never
 * fight (see MarketDocument.tsx: fallback, never force).
 */
function buildSellHref(from: string, input?: QueryInput, type?: string): string {
  const publishHref = buildPublishHref(from, input, type)
  return `${SELLER_SIGNUP_PATH}?redirect_url=${encodeURIComponent(publishHref)}`
}

function readSellerAcquisitionVariant(input?: QueryInput): {
  variant: SellerAcquisitionVariant
  explicit: boolean
} | null {
  const params = toSearchParams(input)
  const raw = params.get(SELLER_ACQUISITION_VARIANT_PARAM) ?? params.get('variant')
  const value = raw?.trim().toLowerCase()

  if (SELLER_ACQUISITION_VARIANTS.includes(value as SellerAcquisitionVariant)) {
    return { variant: value as SellerAcquisitionVariant, explicit: true }
  }

  return null
}

function toSearchParams(input?: QueryInput): URLSearchParams {
  if (!input) {
    return new URLSearchParams()
  }

  if (typeof input === 'string') {
    return new URLSearchParams(input.startsWith('?') ? input.slice(1) : input)
  }

  if (input instanceof URLSearchParams) {
    return input
  }

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    const first = Array.isArray(value) ? value[0] : value
    if (typeof first === 'string') {
      params.set(key, first)
    }
  }
  return params
}

function sanitizeUtmValue(value: string | null): string | null {
  const clean = value?.trim()
  if (!clean) {
    return null
  }
  return clean.slice(0, MAX_UTM_VALUE_LENGTH)
}
