export type PublicReadCandidate =
  | { kind: 'shop'; shopSlug: string; tail?: string }
  | { kind: 'listing'; listingId: string }
  | { kind: 'preview'; shopSlug: string }

/** Exported so the renderer-parity spec iterates THIS set — a tail cached here with no dispatch case is a 404. */
export const MARKETPLACE_SHOP_TAILS: ReadonlySet<string> = new Set([
  'acerca',
  'catalogo',
  'colecciones',
  'eventos',
  'faq',
  'politicas',
  'tienda',
])

/** D9/D10/D19: exact public shapes only; every unrecognised query/path stays dynamic. */
export function marketplacePublicReadCandidate(
  pathname: string,
  search: string,
): PublicReadCandidate | null {
  const shop = /^\/mx\/s\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname)
  if (shop) {
    const [, shopSlug, tail] = shop
    if (search === '?preview=1' && !tail) return { kind: 'preview', shopSlug }
    if (search !== '') return null
    if (tail && !MARKETPLACE_SHOP_TAILS.has(tail)) return null
    return { kind: 'shop', shopSlug, ...(tail ? { tail } : {}) }
  }
  if (search !== '') return null
  const listing = /^\/mx\/l\/([^/]+)\/?$/.exec(pathname)
  return listing ? { kind: 'listing', listingId: listing[1] } : null
}

export function subdomainPublicReadCandidate(
  pathname: string,
  search: string,
): { kind: 'shop' } | { kind: 'listing'; listingId: string } | null {
  if (search !== '') return null
  if (pathname === '/') return { kind: 'shop' }
  const listing = /^\/l\/([^/]+)\/?$/.exec(pathname)
  return listing ? { kind: 'listing', listingId: listing[1] } : null
}

export function embedPublicReadCandidate(
  pathname: string,
  search: string,
): { kind: 'shop'; shopSlug: string } | null {
  if (search !== '') return null
  const shop = /^\/embed\/s\/([^/]+)\/?$/.exec(pathname)
  return shop ? { kind: 'shop', shopSlug: shop[1] } : null
}
