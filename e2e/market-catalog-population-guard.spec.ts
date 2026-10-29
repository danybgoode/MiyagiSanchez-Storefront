import { expect, test } from '@playwright/test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * POPULATION GUARD for the market catalog boundary — "guard the population, not the
 * door you found" (`Roadmap/LEARNINGS.md`), applied mechanically.
 *
 * The failure this prevents is not "one route forgot the filter". It is the shape
 * of the mistake: a previous epic guarded ONE write tool while seven siblings
 * stayed open, because the list of doors was hand-written. So nothing here is
 * hand-listed as a *discovery*. The scan walks `app/` and `lib/`, finds every file
 * that performs a marketplace catalog read against the Medusa store routes, and
 * requires each one to be CLASSIFIED. A new door added later is not "missed" — it
 * lands in no bucket and this spec goes red until somebody decides what it is.
 *
 * Three buckets, and the difference between them is the epic's whole thesis:
 *
 *   MARKET_SCOPED     — public marketplace browse. Must read through the market
 *                       seam (`lib/market-catalog.ts` → `marketCatalogFetch`).
 *   OWNERSHIP_SCOPED  — a by-id lookup on behalf of an owner, a buyer's own order,
 *                       or a payment webhook. Must NOT gain the market filter
 *                       (epic decision D4): adding it there is exactly the failure
 *                       this epic exists to prevent — an owned shop must keep
 *                       working with no marketplace membership at all.
 *   AGENT_MARKET_SCOPED — UCP/MCP public browse. Sprint 2 expired D10's temporary
 *                         deferral: these surfaces now accept `market`, must plan
 *                         through the same fail-closed seam, and verify the backend
 *                         echo before returning catalog rows.
 *   CHECKOUT_MARKET_SCOPED — a money-path admission read. It proves exact marketplace
 *                            publication BEFORE the cart write, so a guessed product id
 *                            can never use the product endpoint as a bypass.
 *
 * Source-text scanning only: no network, no DB. Comments are stripped before every
 * scan, because a negative-containment guard that fires on a doc comment explaining
 * what the module deliberately avoids punishes the documentation
 * (`LEARNINGS.md`, five separate cases in one epic).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function listSourceFiles(startDir: string): string[] {
  const out: string[] = []
  const skip = new Set(['node_modules', '.next', '.worktrees', '.git'])
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) walk(full)
      else if (extname(entry) === '.ts' || extname(entry) === '.tsx') out.push(full)
    }
  }
  walk(startDir)
  return out
}

/** `[^:]` keeps `https://` intact — see LEARNINGS on source-text guards. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const CATALOG_PATH = '/store/listings'

/**
 * `/store/listings/:id/view` is a write after a marketplace detail read, not a
 * catalog read. Price grids are NOT exempt: their amounts are market-currency data
 * and must use either the marketplace seam or the seller-owned endpoint.
 */
function isSubResourceTail(tail: string): boolean {
  return /^(?:\/\$\{[^}]*\}|\/[\w.-]+)?\/view\b/.test(tail)
}

/** Does this (comment-stripped) source perform a marketplace catalog read? */
function hasCatalogRead(stripped: string): boolean {
  let index = stripped.indexOf(CATALOG_PATH)
  while (index !== -1) {
    if (!isSubResourceTail(stripped.slice(index + CATALOG_PATH.length, index + CATALOG_PATH.length + 60))) {
      return true
    }
    index = stripped.indexOf(CATALOG_PATH, index + 1)
  }
  return false
}

function rel(file: string): string {
  return relative(ROOT, file).replace(/\\/g, '/')
}

// ── The classification. Discovery is mechanical; only the VERDICT is written down ──

const MARKET_SCOPED = new Set([
  'lib/listings.ts',
])

const AGENT_MARKET_SCOPED = new Set([
  'app/api/ucp/catalog/route.ts',
  'app/api/ucp/catalog/[id]/route.ts',
  'app/api/ucp/mcp/route.ts',
])

const CHECKOUT_MARKET_SCOPED = new Set([
  'lib/cart.ts',
])

const OWNERSHIP_SCOPED = new Set([
  // A seller publishing: is this listing actually checkout-viable for its OWNER?
  'lib/listing-status.ts',
  // The seller's own edit form, loading their own product.
  'app/(shell)/sell/edit/[id]/page.tsx',
  // Seller-authenticated edit endpoints. These resolve a product the caller owns.
  'app/api/sell/listing/[id]/route.ts',
  'app/api/sell/listing/[id]/price-grid/route.ts',
  // Post-purchase summary: the shop name for an order the buyer just paid for.
  'app/(shell)/payment/success/page.tsx',
  // Order enrichment and manual shipping, both keyed by an order the caller owns.
  'app/api/orders/[id]/route.ts',
  'app/api/orders/[id]/ship-manual/route.ts',
  // Payment webhooks enriching a paid order. No buyer, no browse, no market.
  'app/api/webhooks/stripe/route.ts',
  'app/api/webhooks/mercadopago/route.ts',
  // Admin supply import resolving a seller slug from a product id.
  'app/api/supply/listing-images/route.ts',
])

const CLASSIFIED = new Set([
  ...MARKET_SCOPED,
  ...AGENT_MARKET_SCOPED,
  ...CHECKOUT_MARKET_SCOPED,
  ...OWNERSHIP_SCOPED,
])

/**
 * Every directory in this app that can contain a catalog read.
 *
 * This list is itself guarded, immediately below. The first version of this scan
 * walked only `app/` and `lib/` — which made the guard commit the very error its
 * doc-comment warns about: a component under `components/` fetching `/store/listings`
 * directly would never have been classified, and the spec would have stayed green
 * while the boundary leaked. Widen this list rather than narrowing a scan.
 */
const SOURCE_ROOTS = ['app', 'lib', 'components', 'services', 'db']

/** Directories with no shippable request path: fixtures, tooling, build output, assets. */
const NON_SOURCE_DIRS = new Set([
  'node_modules', '.next', '.worktrees', '.git', '.vercel', '.claude',
  'e2e', 'scripts', 'test-results', 'playwright-report',
  'public', 'locales', 'artifacts', 'memory', 'tasks', 'supabase', 'docs', 'Roadmap',
])

test.describe('population guard · the SCAN ITSELF covers every source directory', () => {
  // The meta-guard. Without it, adding a new top-level source directory silently
  // shrinks the population every other test in this file reasons about — the guard
  // would keep passing while covering less, which is worse than no guard at all.
  test('no unscanned top-level directory contains TypeScript source', () => {
    const unscanned = readdirSync(ROOT)
      .filter((entry) => !entry.startsWith('.'))
      .filter((entry) => !NON_SOURCE_DIRS.has(entry))
      .filter((entry) => !SOURCE_ROOTS.includes(entry))
      .filter((entry) => statSync(join(ROOT, entry)).isDirectory())
      .filter((entry) => listSourceFiles(join(ROOT, entry)).length > 0)
      .sort()
    // If this fails: add the directory to SOURCE_ROOTS (it ships code), or to
    // NON_SOURCE_DIRS (it does not). Do not delete this test to make it green.
    expect(unscanned).toEqual([])
  })
})

const CATALOG_READERS = SOURCE_ROOTS.map((dir) => join(ROOT, dir))
  .flatMap(listSourceFiles)
  .filter((file) => hasCatalogRead(stripComments(readFileSync(file, 'utf8'))))
  .map(rel)
  .sort()

test.describe('population guard · every marketplace catalog reader is classified', () => {
  test('the scan itself found something (it is not vacuous)', () => {
    expect(CATALOG_READERS.length).toBeGreaterThan(5)
    expect(CATALOG_READERS).toContain('lib/listings.ts')
  })

  test('no UNCLASSIFIED file reads the marketplace catalog', () => {
    const unclassified = CATALOG_READERS.filter((file) => !CLASSIFIED.has(file))
    // If this fails, do not add the file to a set to make it green. Decide what it
    // is first: public browse (market-scoped) or an owner/transaction lookup (D4).
    expect(unclassified).toEqual([])
  })

  test('every classified entry still exists and still reads the catalog', () => {
    // The inverse direction: a stale allow-list entry is a guard that has quietly
    // stopped guarding anything.
    const stale = [...CLASSIFIED].filter((file) => !CATALOG_READERS.includes(file)).sort()
    expect(stale).toEqual([])
  })

  test('the three buckets are disjoint', () => {
    const all = [...MARKET_SCOPED, ...AGENT_MARKET_SCOPED, ...CHECKOUT_MARKET_SCOPED, ...OWNERSHIP_SCOPED]
    expect(all.length).toBe(new Set(all).size)
  })
})

test.describe('population guard · the market-scoped seam has no bare catalog fetch', () => {
  // Every catalog read in `lib/listings.ts` must name its intent through a helper:
  // `marketCatalogFetch` (market-scoped) or `ownershipScopedFetch` (D4-exempt, and
  // documented as such at its definition). A plain `medusaFetch` on a catalog path
  // is the regression this test exists to catch — it is how the filter would get
  // quietly dropped by a later refactor.
  const ALLOWED_CALLEES = new Set(['marketCatalogFetch', 'ownershipScopedFetch', 'fetchListings'])
  const CALL_SITE = /(\w+)\(\s*(?:[^()`'"]*,\s*)?[`'"](\/store\/listings[^`'"]*)[`'"]/g

  for (const file of MARKET_SCOPED) {
    test(`${file} — every catalog read goes through a named helper`, () => {
      const stripped = stripComments(readFileSync(join(ROOT, file), 'utf8'))
      const offenders: string[] = []
      let found = 0
      for (const match of stripped.matchAll(CALL_SITE)) {
        const [, callee, path] = match
        if (isSubResourceTail(path.slice(CATALOG_PATH.length))) continue
        found += 1
        if (!ALLOWED_CALLEES.has(callee)) offenders.push(`${callee}("${path}")`)
      }
      // Non-vacuity: a regex that matched nothing would pass silently.
      expect(found).toBeGreaterThan(5)
      expect(offenders).toEqual([])
    })
  }

  test('lib/listings.ts imports the fail-closed seam rather than re-deriving it', () => {
    const stripped = stripComments(readFileSync(join(ROOT, 'lib', 'listings.ts'), 'utf8'))
    expect(stripped).toContain("from './market-catalog'")
    expect(stripped).toContain('planMarketCatalogRead')
    expect(stripped).toContain('takeMarketScopedField')
  })

  test('owned-shop reads are NOT market-scoped (D4)', () => {
    // `/store/sellers/...` is the owned-shop seam. If a market parameter ever
    // appears on it, an owned shop starts depending on marketplace membership —
    // the precise failure this epic exists to prevent.
    const stripped = stripComments(readFileSync(join(ROOT, 'lib', 'listings.ts'), 'utf8'))
    for (const match of stripped.matchAll(/[`'"](\/store\/sellers[^`'"]*)[`'"]/g)) {
      expect(match[1], match[1]).not.toContain('market')
    }
    expect(stripped).toContain('/store/sellers/')
  })
})

/**
 * Split a source file into its TOP-LEVEL declarations. Nested declarations are
 * indented and a top-level one starts at column 0, so a column-anchored regex is
 * enough here and needs no parser. Each block runs to the start of the next
 * declaration, which is what makes "does THIS function verify" answerable instead
 * of "does the file contain the word somewhere" — the whole-file version is what
 * let a missing check hide next to six correct ones (`LEARNINGS.md`: anchor a
 * source-text guard inside the function, never across the file).
 */
function topLevelBlocks(source: string): Array<{ name: string; body: string }> {
  const lines = source.split('\n')
  const DECL = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type)\s+(\w+)/
  const starts: Array<{ name: string; line: number }> = []
  lines.forEach((line, index) => {
    const match = DECL.exec(line)
    if (match) starts.push({ name: match[1], line: index })
  })
  return starts.map((start, index) => ({
    name: start.name,
    body: lines.slice(start.line, index + 1 < starts.length ? starts[index + 1].line : lines.length).join('\n'),
  }))
}

test.describe('population guard · owned detail is a real seller boundary', () => {
  const LISTINGS = stripComments(readFileSync(join(ROOT, 'lib', 'listings.ts'), 'utf8'))
  const byName = new Map(topLevelBlocks(LISTINGS).map((block) => [block.name, block.body]))
  const OWNER_READERS = [
    'getOwnedShopListingCached',
    'getOwnedShopPriceGridCached',
    'getOwnedListingCustomFieldsUncached',
  ]

  for (const name of OWNER_READERS) {
    test(`${name} uses /store/sellers/:slug/products/:id, never the marketplace endpoint`, () => {
      const body = byName.get(name)
      expect(body, `${name} no longer exists — reclassify the owner read`).toBeTruthy()
      expect(body).toContain('ownershipScopedFetch')
      expect(body).toContain('/store/sellers/')
      expect(body).toContain('/products/')
      expect(body).not.toContain('/store/listings')
      expect(body).not.toContain('marketCatalogFetch')
    })
  }

  test('marketplace price-grid is classified and verifies its market echo', () => {
    const body = byName.get('getPriceGridCached')
    expect(body, 'getPriceGridCached no longer exists — re-point this guard').toBeTruthy()
    expect(body).toContain('marketCatalogFetch')
    expect(body).toContain('takeMarketScopedField')
    expect(body).not.toContain('ownershipScopedFetch')
    expect(body).not.toContain('medusaFetch(')
  })

  test('tenant PDP selection comes only from the trusted middleware header', () => {
    const adapter = stripComments(readFileSync(join(ROOT, 'app', '(shell)', 'l', '[id]', 'page.tsx'), 'utf8'))
    const requestChannel = topLevelBlocks(adapter).find((block) => block.name === 'requestChannel')?.body
    expect(requestChannel, 'requestChannel no longer exists — re-point this guard').toBeTruthy()
    expect(requestChannel).toContain("get('x-miyagi-shop-slug')")
    const renderer = stripComments(readFileSync(join(ROOT, 'app', '(shell)', 'l', '[id]', 'ListingRenderer.tsx'), 'utf8'))
    const listingPage = topLevelBlocks(renderer).find((block) => block.name === 'ListingPage')?.body
    expect(listingPage, 'ListingPage no longer exists — re-point this guard').toBeTruthy()
    expect(listingPage).toContain('getOwnedShopListing(channelSlug, id)')
    expect(listingPage).toContain('getOwnedShopPriceGrid(channelSlug, id)')
    expect(listingPage).toContain('resolveOwnedPriceGridForPdp')
    expect(listingPage).toMatch(/if\s*\(\s*channelSlug\s*&&\s*!priceGrid\s*\)\s*notFound\(\)/)
    expect(listingPage).not.toContain('searchParams')
  })

  test('artwork upload propagates the trusted header and never reads a form seller slug', () => {
    const source = stripComments(readFileSync(join(ROOT, 'app', 'api', 'artwork', 'upload', 'route.ts'), 'utf8'))
    expect(source).toContain("req.headers.get('x-miyagi-shop-slug')")
    expect(source).toContain('sellerSlug: trustedSellerSlug')
    expect(source).not.toMatch(/formData\.get\(['"]sellerSlug['"]\)/)
  })

  test('owned shop display currency is the validated seller contract, with no MXN fallback', () => {
    // The seller-catalog mapping lives in the cached reader since share-kit S3 (getShopListings delegates to it).
    const body = byName.get('getShopListingsCached')
    expect(body, 'getShopListingsCached no longer exists — re-point this guard').toBeTruthy()
    expect(body).toContain('readPublicSellerMarket')
    expect(body).toContain('selectBaseSellerPrice')
    expect(body).toContain('sellerMarket.currency_code.toUpperCase()')
    expect(body).not.toMatch(/['"]mxn['"]/i)
    expect(body).not.toContain('prices[0]')
  })

  test('facet projection is market-echo checked', () => {
    const body = byName.get('getAutoFacets')
    expect(body, 'getAutoFacets no longer exists — re-point this guard').toBeTruthy()
    expect(body).toContain("'facet_pool'")
    expect(body).toContain('takeMarketScopedField')
  })

  for (const name of ['searchListings', 'countListings']) {
    test(`${name} preserves only structured non-2xx market refusals`, () => {
      const body = byName.get(name)
      expect(body, `${name} no longer exists — re-point this guard`).toBeTruthy()
      expect(body).toContain('unavailableResponseOrThrow')
      expect(body).toContain('marketMetaUnavailable')
    })
  }
})

test.describe('population guard · every market-scoped read VERIFIES, not just fetches', () => {
  /**
   * The round-one guard proved every catalog read went THROUGH `marketCatalogFetch`.
   * It did not prove any of them checked the market echo afterwards — and one did
   * not: the curated homepage pool fetched through the seam and returned
   * `data.listings` unverified, on the highest-traffic surface in the app. That is
   * guarding the door instead of the population, one level in.
   *
   * So: every top-level block that CALLS `marketCatalogFetch` must also confirm the
   * market, by either `takeMarketScopedField` (which returns the rows and the
   * verdict together) or a bare `verifyMarketFilter`. An exemption is allowed, but
   * it is not a free pass — it must name the block that does the verifying on its
   * behalf, and that block is then asserted to actually do it.
   */
  // Matched as CALLS, tolerating an explicit generic argument
  // (`takeMarketScopedField<Listing[]>(...)`). Pinning the bare `name(` spelling
  // failed on correct code the first time this ran — a guard must assert the
  // invariant ("this block confirms the market"), not one way of writing it
  // (`LEARNINGS.md`: three of five source-text guard failures were the assertion's
  // fault, not the code's).
  const VERIFIERS = [
    /\btakeMarketScopedField\s*(?:<[^>()]*>)?\s*\(/,
    /\bverifyMarketFilter\s*(?:<[^>()]*>)?\s*\(/,
  ]
  const verifies = (body: string) => VERIFIERS.some((pattern) => pattern.test(body))

  /** block name → the block that verifies for it. Both sides are checked. */
  const VERIFIED_ELSEWHERE: Record<string, { reason: string; verifiedBy: string }> = {
    marketCatalogFetch: {
      reason: 'This IS the fetch helper — its own definition names itself; there is no response here to verify.',
      // Its own body must NOT verify; the check belongs to each caller. Pointing at
      // itself keeps the map total without inventing a fake verifier.
      verifiedBy: 'marketCatalogFetch',
    },
  }

  const LISTINGS = stripComments(readFileSync(join(ROOT, 'lib', 'listings.ts'), 'utf8'))
  const BLOCKS = topLevelBlocks(LISTINGS)
  const byName = new Map(BLOCKS.map((block) => [block.name, block]))

  const fetchers = BLOCKS.filter((block) => block.body.includes('marketCatalogFetch('))

  test('the block scan found the fetchers (it is not vacuous)', () => {
    expect(fetchers.length).toBeGreaterThan(4)
    expect(fetchers.map((block) => block.name)).toContain('fetchListings')
  })

  for (const block of fetchers) {
    test(`${block.name} — fetches the market catalog AND confirms the market`, () => {
      const exemption = VERIFIED_ELSEWHERE[block.name]
      if (exemption && exemption.verifiedBy !== block.name) {
        const verifier = byName.get(exemption.verifiedBy)
        expect(verifier, `${block.name} claims ${exemption.verifiedBy} verifies for it, but no such block exists`).toBeTruthy()
        expect(
          verifies(verifier!.body),
          `${block.name} is exempt because "${exemption.reason}" — but ${exemption.verifiedBy} does not verify either`,
        ).toBe(true)
        return
      }
      if (exemption) return // self-referential exemption: the helper itself, no response in scope
      expect(
        verifies(block.body),
        `${block.name} reads the market catalog but never confirms the market. Use takeMarketScopedField, ` +
        'or add a VERIFIED_ELSEWHERE entry naming the block that verifies on its behalf.',
      ).toBe(true)
    })
  }

  test('no exemption is stale — every entry names a block that still exists', () => {
    for (const [name, exemption] of Object.entries(VERIFIED_ELSEWHERE)) {
      expect(byName.has(name), `exemption for ${name}, which no longer exists`).toBe(true)
      expect(byName.has(exemption.verifiedBy), `${name} points at missing ${exemption.verifiedBy}`).toBe(true)
    }
  })

  test('the PDP read confirms the market BEFORE it records a view', () => {
    /**
     * `getListingCached` records a view as a side effect, and that write is inside
     * the cache wrapper on purpose so a listing accrues roughly one view per
     * revalidation window rather than one per render. Verifying after it meant a
     * listing we then REFUSED to serve still had its view counter incremented —
     * metrics for a product nobody was shown.
     *
     * The fix was ordering, not placement, so the guard is an ordering assertion,
     * sliced to the function body first (`LEARNINGS.md`: an ordering guard compared
     * across a whole file matches the IMPORT of the symbol, which precedes
     * everything).
     */
    const block = byName.get('getListingCached')
    expect(block, 'getListingCached no longer exists — re-point this guard').toBeTruthy()
    const body = block!.body
    const verifyAt = body.search(/\b(?:takeMarketScopedField|verifyMarketFilter)\s*(?:<[^>()]*>)?\s*\(/)
    const viewAt = body.indexOf('/view')
    expect(verifyAt, 'no market confirmation in getListingCached').toBeGreaterThan(-1)
    expect(viewAt, 'no view write in getListingCached — re-point this guard').toBeGreaterThan(-1)
    expect(verifyAt).toBeLessThan(viewAt)
  })

  test('taking rows out of a payload goes through the combined verify+extract call', () => {
    // `takeMarketScopedField` exists so the rows and the verdict cannot be separated.
    // A raw `data.listings` read in a market-scoped block is the two-step shape that
    // regressed once already.
    const offenders = fetchers
      .filter((block) => !VERIFIED_ELSEWHERE[block.name])
      // Catch both `data.listings` and a casted extraction such as
      // `(data as { listings?: Listing[] }).listings`. The first mutation pass
      // found that the simpler regex missed the latter and let the exact curated
      // pool regression shape through.
      .filter((block) => /\bdata(?:\s+as\s+[^)\n]+)?\)?\s*\.(?:listings|facet_pool|listing)\b/.test(block.body))
      .map((block) => block.name)
    expect(offenders).toEqual([])
  })
})

test.describe('population guard · NEXT_PUBLIC inlining cannot be defeated by the resolver seam', () => {
  // Next inlines `NEXT_PUBLIC_*` only where it sees the literal text
  // `process.env.NEXT_PUBLIC_FOO`. Handing the whole `process.env` object to a
  // function bakes in `undefined` in the client bundle — that exact mistake caused
  // a live checkout outage (nextpublic-docker-buildargs-hardening).
  const BARE_PROCESS_ENV = /resolve(?:RegionIdForMarket|MarketplaceChannelId)\([^)]*\bprocess\.env\s*[,)]/

  test('no caller passes bare process.env into the resolvers', () => {
    const offenders = [join(ROOT, 'app'), join(ROOT, 'lib'), join(ROOT, 'components')]
      .flatMap(listSourceFiles)
      .filter((file) => BARE_PROCESS_ENV.test(stripComments(readFileSync(file, 'utf8'))))
      .map(rel)
    expect(offenders).toEqual([])
  })

  test('the snapshot reads each variable by literal member access', () => {
    const stripped = stripComments(readFileSync(join(ROOT, 'lib', 'market-medusa.ts'), 'utf8'))
    expect(stripped).toContain('process.env.NEXT_PUBLIC_MEDUSA_MXN_REGION_ID')
    expect(stripped).toContain('process.env.MEDUSA_MXN_REGION_ID')
    expect(stripped).toContain('process.env.MEDUSA_SALES_CHANNEL_ID')
    expect(stripped).toContain('process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY')
    expect(stripped).toContain('process.env.MEDUSA_US_REGION_ID')
    expect(stripped).toContain('process.env.MEDUSA_US_MARKETPLACE_CHANNEL_ID')
    expect(stripped).toContain('process.env.MEDUSA_US_PUBLISHABLE_KEY')
  })

  test('no single-market region/channel constant survives outside the resolver', () => {
    // `MXN_REGION_ID` as a module constant IS the single-market assumption (D5).
    const offenders = [join(ROOT, 'app'), join(ROOT, 'lib'), join(ROOT, 'components')]
      .flatMap(listSourceFiles)
      .filter((file) => /\b(?:const|let|var)\s+(?:MXN_REGION_ID|DEFAULT_SALES_CHANNEL_ID)\b/
        .test(stripComments(readFileSync(file, 'utf8'))))
      .map(rel)
    expect(offenders).toEqual([])
  })

  test('cart creation resolves its region from a market, not from a constant', () => {
    const stripped = stripComments(readFileSync(join(ROOT, 'lib', 'cart.ts'), 'utf8'))
    expect(stripped).toContain('resolveRegionIdForMarket')
    expect(stripped).toContain('DEFAULT_MARKET')
    expect(stripped).toContain('region_id: regionId')
  })

  test('cart admission proves marketplace publication before any cart write', () => {
    const stripped = stripComments(readFileSync(join(ROOT, 'lib', 'cart.ts'), 'utf8'))
    const preflight = stripped.indexOf('resolveCheckoutLines(')
    const cartWrite = stripped.indexOf("medusaFetch('/store/carts'")
    expect(preflight).toBeGreaterThan(-1)
    expect(cartWrite).toBeGreaterThan(preflight)
    expect(stripped).toContain('isCheckoutListingAdmitted')
  })

  test('the D7 relaxation is gated, and BOTH admission branches precede the cart write', () => {
    // Story 2.3 widens admission from marketplace publication to operating-channel
    // buyability, behind `catalog.owned_shop_only_enabled` (D8). The structural
    // invariant is unchanged by that: whichever branch runs, it runs before any
    // cart exists. A branch that skipped the gate would move one of these indices.
    const stripped = stripComments(readFileSync(join(ROOT, 'lib', 'cart.ts'), 'utf8'))
    const cartWrite = stripped.indexOf("medusaFetch('/store/carts'")
    const marketplaceBranch = stripped.indexOf('isCheckoutListingAdmitted(')
    const operatingBranch = stripped.indexOf('classifyCheckoutAdmission(')
    expect(marketplaceBranch).toBeGreaterThan(-1)
    expect(operatingBranch).toBeGreaterThan(-1)
    expect(cartWrite).toBeGreaterThan(marketplaceBranch)
    expect(cartWrite).toBeGreaterThan(operatingBranch)
    // The relaxation may only be reached through the flag, and the flag's own read
    // lives in the dedicated server module so the inventory derivation can see it.
    expect(stripped).toContain('ownedShopOnlyEnabled')
    expect(stripped).toContain("import('./checkout-admission-flag')")
  })

  test('the variant-ownership proof sits BELOW both branches, exactly once', () => {
    // The proof that the relaxation cannot bypass what is actually BOUGHT. If a
    // future edit moved this check inside one branch, the other branch would buy an
    // unproven variant — so its uniqueness is the assertion, not just its presence.
    const stripped = stripComments(readFileSync(join(ROOT, 'lib', 'cart.ts'), 'utf8'))
    const occurrences = [...stripped.matchAll(/isVariantOwnedByProduct\(/g)]
    expect(occurrences).toHaveLength(1)
    const variantProof = occurrences[0].index!
    expect(variantProof).toBeGreaterThan(stripped.indexOf('isCheckoutListingAdmitted('))
    expect(variantProof).toBeGreaterThan(stripped.indexOf('classifyCheckoutAdmission('))
  })
})

test.describe('population guard · D10 agent surfaces are market-scoped', () => {
  for (const file of AGENT_MARKET_SCOPED) {
    test(`${file} plans and verifies a market-scoped catalog read`, () => {
      const stripped = stripComments(readFileSync(join(ROOT, file), 'utf8'))
      expect(stripped).toContain("from '@/lib/market-catalog'")
      expect(stripped).toContain('planMarketCatalogRead')
      expect(stripped).toContain('verifyMarketFilter')
    })
  }

  const MCP_SOURCE = stripComments(readFileSync(join(ROOT, 'app/api/ucp/mcp/route.ts'), 'utf8'))
  const MCP_BLOCKS = topLevelBlocks(MCP_SOURCE)
  const MCP_OWNER_EXEMPTIONS = new Set([
    // Seller-agent writes recompute the owner's price-grid after an authenticated
    // ownership check. D4: these must not depend on marketplace publication.
    'handleConfigureListingOptions',
    'handleApplyPrice',
  ])
  const MCP_DIRECT_CATALOG_READERS = MCP_BLOCKS.filter((block) =>
    block.body.includes('${MEDUSA_BASE}/store/listings'),
  )

  test('the MCP block scan discovers every direct catalog reader, not only the file', () => {
    const names = MCP_DIRECT_CATALOG_READERS.map((block) => block.name)
    expect(names).toContain('handleMakeOffer')
    expect(names).toContain('getShopCalcom')
    expect(names).toContain('getShopSchedulingLinks')
    expect(names).toContain('handleGetShop')
  })

  for (const block of MCP_DIRECT_CATALOG_READERS) {
    if (MCP_OWNER_EXEMPTIONS.has(block.name)) continue
    test(`MCP ${block.name} carries and verifies a country market`, () => {
      expect(
        block.body,
        `${block.name} reads the public catalog without receiving a planned market`,
      ).toMatch(/marketDecision\.market|marketCode/)
      expect(
        block.body,
        `${block.name} reads the public catalog without putting market on the request`,
      ).toMatch(/[?&]market=|params\.set\('market'|marketDecision\.query/)
      expect(
        block.body,
        `${block.name} reads the public catalog without checking the backend echo`,
      ).toContain('verifyMarketFilter')
    })
  }

  test('every MCP direct-catalog exemption still exists and is seller-owned', () => {
    const names = new Set(MCP_DIRECT_CATALOG_READERS.map((block) => block.name))
    for (const exemption of MCP_OWNER_EXEMPTIONS) {
      expect(names.has(exemption), `stale MCP owner exemption: ${exemption}`).toBe(true)
    }
  })

  const MARKET_PRICE_GRID_READERS = [
    {
      file: 'app/(shell)/l/[id]/ListingRenderer.tsx',
      block: 'ListingPage',
      call: /getPriceGrid\(\s*id\s*,\s*market\s*\)/,
    },
    {
      file: 'app/api/ucp/catalog/route.ts',
      block: 'GET',
      call: /getPriceGrid\([^)]*,\s*marketDecision\.market\.code\s*\)/,
    },
    {
      file: 'app/api/ucp/catalog/[id]/route.ts',
      block: 'GET',
      call: /getPriceGrid\([^)]*,\s*marketDecision\.market\.code\s*,?\s*\)/,
    },
    {
      file: 'app/api/ucp/mcp/route.ts',
      block: 'handleSearchListings',
      call: /getPriceGrid\([^)]*,\s*marketDecision\.market\.code\s*\)/,
    },
    {
      file: 'app/api/ucp/mcp/route.ts',
      block: 'handleGetListing',
      call: /getPriceGrid\([^)]*,\s*marketDecision\.market\.code\s*,?\s*\)/,
    },
  ]

  for (const reader of MARKET_PRICE_GRID_READERS) {
    test(`${reader.file} · ${reader.block} threads the selected market into its price grid`, () => {
      const stripped = stripComments(readFileSync(join(ROOT, reader.file), 'utf8'))
      const body = topLevelBlocks(stripped).find((block) => block.name === reader.block)?.body
      expect(body, `${reader.block} no longer exists in ${reader.file} — re-point this guard`).toBeTruthy()
      expect(body).toMatch(reader.call)
    })
  }
})

test.describe('population guard · marketplace shop routes do not use owner inventory', () => {
  test('the marketplace shop reader filters through the market catalog seam', () => {
    const stripped = stripComments(readFileSync(join(ROOT, 'lib', 'listings.ts'), 'utf8'))
    const body = topLevelBlocks(stripped).find((block) => block.name === 'getMarketplaceShopListings')?.body
    expect(body, 'getMarketplaceShopListings must remain a distinct market-scoped seam').toBeTruthy()
    expect(body).toContain('planMarketCatalogRead')
    expect(body).toContain('marketCatalogFetch')
    expect(body).toContain('takeMarketScopedField')
    expect(body).toContain('seller_slug')
    expect(body).not.toContain('ownershipScopedFetch')
  })

  test('marketplace shop reads preserve unavailable as a third state, never empty success', () => {
    const stripped = stripComments(readFileSync(join(ROOT, 'lib', 'listings.ts'), 'utf8'))
    const body = topLevelBlocks(stripped).find((block) => block.name === 'getMarketplaceShopListings')?.body
    expect(body, 'getMarketplaceShopListings must remain a distinct market-scoped seam').toBeTruthy()
    expect(body).toContain('marketMetaUnavailable')
    expect(body).toContain('marketMetaFor')
    expect(body).not.toMatch(/return\s+\[\]/)
  })

  test('shop home selects owner inventory only when no country market was supplied and surfaces refusal', () => {
    const stripped = stripComments(readFileSync(join(ROOT, 'app', '(shell)', 's', '[slug]', 'ShopRenderer.tsx'), 'utf8'))
    const body = topLevelBlocks(stripped).find((block) => block.name === 'ShopPage')?.body
    expect(body, 'ShopPage no longer exists — re-point this guard').toBeTruthy()
    expect(body).toContain('readPublicSellerMarket')
    expect(body).toContain('getMarketplaceShopListings')
    expect(body).toContain('market_unavailable')
    expect(body).toContain('notFound()')
  })

  test('marketplace collection pages surface catalog refusal instead of claiming an empty collection', () => {
    const stripped = stripComments(readFileSync(
      join(ROOT, 'app', '(shell)', '_shop-collection', 'CollectionPage.tsx'),
      'utf8',
    ))
    const body = topLevelBlocks(stripped).find((block) => block.name === 'CollectionPage')?.body
    expect(body, 'CollectionPage no longer exists — re-point this guard').toBeTruthy()
    expect(body).toContain('getMarketplaceShopListings')
    expect(body).toContain('market_unavailable')
    expect(body).toContain('notFound()')
  })

  test('Mexico shop wrappers pass the market separately from the URL prefix', () => {
    const home = stripComments(readFileSync(join(ROOT, 'app', '(shell)', 'mx', 's', '[slug]', 'page.tsx'), 'utf8'))
    const collection = stripComments(readFileSync(
      join(ROOT, 'app', '(shell)', 'mx', 's', '[slug]', 'c', '[collection]', 'page.tsx'),
      'utf8',
    ))
    expect(home).toContain("market: 'mx'")
    expect(home).toContain("marketBasePath: '/mx'")
    expect(collection).toContain("market: 'mx'")
    expect(collection).toContain("marketBasePath: '/mx'")
  })
})
