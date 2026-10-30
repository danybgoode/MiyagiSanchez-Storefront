import { test, expect } from '@playwright/test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  MARKET_PREFIXED_PATH_FAMILIES,
  isMarketPrefixablePath,
} from '../lib/market-url'
import { marketBasePath, openMarketCodes } from '../lib/markets'

const ROOT = path.resolve(import.meta.dirname, '..')

function filesBelow(relativeDir: string): string[] {
  const root = path.join(ROOT, relativeDir)
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const absolute = path.join(root, entry)
    if (statSync(absolute).isDirectory()) out.push(...filesBelow(path.relative(ROOT, absolute)))
    else if (/\.(?:ts|tsx)$/.test(entry)) out.push(absolute)
  }
  return out
}

test.describe('market route population', () => {
  test('literal MX and US routes share the legacy page system while tenant routes remain present', () => {
    const required = [
      'app/(site)/page.tsx',
      'app/(mx-site)/mx/page.tsx',
      'app/(us-site)/us/page.tsx',
      'app/(us-shell)/us/l/page.tsx',
      'app/(us-shell)/us/l/[id]/page.tsx',
      'app/(us-shell)/us/s/[slug]/page.tsx',
      'app/(shell)/l/[id]/page.tsx',
      'app/(shell)/s/[slug]/page.tsx',
      'app/(shell)/c/[collection]/page.tsx',
      'app/(shell)/mx/l/page.tsx',
      'app/(shell)/mx/l/[id]/page.tsx',
      'app/(shell)/mx/s/[slug]/page.tsx',
    ]
    for (const file of required) expect(existsSync(path.join(ROOT, file)), file).toBe(true)

    expect(existsSync(path.join(ROOT, 'app/(shell)/mx/c/[collection]/page.tsx'))).toBe(false)
    expect(MARKET_PREFIXED_PATH_FAMILIES).toEqual(['/l', '/s'])
    expect(isMarketPrefixablePath('/c/editorial')).toBe(false)
  })

  test('the US adapter population mirrors every literal MX catalog route', () => {
    const routeTail = (file: string, market: 'mx' | 'us') => {
      const relative = path.relative(ROOT, file).replace(/\\/g, '/')
      return relative.slice(relative.indexOf(`/${market}/`) + market.length + 2)
    }
    // CATALOG routes — the families that carry a market prefix BECAUSE they are
    // market-scoped inventory, read from `MARKET_PREFIXED_PATH_FAMILIES` rather than
    // restated, so the two lists cannot drift apart.
    //
    // Not every page under `/mx` is one. `/mx/vende` — the Mexican seller landing and
    // its persona pages — also lives there, and it has no US mirror by design: the US
    // landing is `/us/sell`, a different word in a different language with different
    // money claims, not a translated adapter over one shared implementation the way
    // `/us/l` and `/us/s` are. Scanning it here would demand `app/(us-shell)/us/vende`,
    // a Spanish URL on the US market.
    const isCatalogRoute = (tail: string) =>
      MARKET_PREFIXED_PATH_FAMILIES.some((family) => tail.startsWith(`${family.slice(1)}/`))
    const mx = filesBelow('app/(shell)/mx')
      .filter((file) => file.endsWith('/page.tsx'))
      .map((file) => routeTail(file, 'mx'))
      .filter(isCatalogRoute)
      .sort()
    const us = filesBelow('app/(us-shell)/us')
      .filter((file) => file.endsWith('/page.tsx'))
      .map((file) => routeTail(file, 'us'))
      .filter(isCatalogRoute)
      .sort()
    expect(mx.length, 'the MX adapter scan found nothing').toBeGreaterThan(5)
    expect(us).toEqual(mx)
    // The filter must not be what makes this pass: the seller landing IS under
    // `app/(shell)/mx` and IS excluded, and both facts are asserted rather than assumed.
    expect(filesBelow('app/(shell)/mx').some((file) => file.includes('/mx/vende/'))).toBe(true)
    expect(mx.some((tail) => tail.startsWith('vende/'))).toBe(false)
  })

  test('the root selector is a zero-catalog static surface', () => {
    // The selector markup is mounted by `/en` only since root-shop-builder-home (`/` is
    // the Mexico shop builder now), so the no-catalog proof is asserted on the component
    // AND on the route that mounts it — a root that imported listings would otherwise be
    // invisible to this guard.
    const source = readFileSync(path.join(ROOT, 'app/(site)/MarketSelector.tsx'), 'utf8')
    expect(source).toContain('data-testid="market-selector"')
    // One href expression, derived per market from the registry — not two literals.
    expect(source).toContain('href={marketBasePath(code)}')
    const en = readFileSync(path.join(ROOT, 'app/(en-site)/en/page.tsx'), 'utf8')
    expect(en).toContain('<MarketSelector language=')
    expect(en).not.toMatch(/from ['"]@\/lib\/(?:listings|medusa|supabase)['"]/)
    // The honest no-catalog proof is the absence of a data import. This spec used
    // to ALSO assert `not.toMatch(/export const revalidate/)`, using "no
    // revalidate" as a proxy for "no data reads" — and that proxy pinned a live
    // defect in place: no `revalidate` means Next serves `s-maxage=31536000`, the
    // edge pinned `/` for a week, and its build-hashed CSS 404'd into an unstyled
    // homepage. Data-freshness and asset-freshness are different needs; only the
    // import check speaks to the first.
    expect(source).not.toMatch(/from ['"]@\/lib\/(?:listings|medusa|supabase)['"]/)
  })

  test('the root is the Mexico shop builder and still holds no catalog', () => {
    // root-shop-builder-home D1: `/` renders the seller anchor page with the describe box.
    // D7's promise survives the move — the brand's front door is not the Mexico
    // marketplace wearing a pitch — so the same no-data-import proof applies to it.
    const root = readFileSync(path.join(ROOT, 'app/(site)/page.tsx'), 'utf8')
    expect(root).toMatch(/^import DescribeBox from /m)
    expect(root).toMatch(/^import \{ SellerAcquisitionPage \} from /m)
    expect(root).not.toMatch(/^import .*MarketSelector/m)
    expect(root).not.toMatch(/from ['"]@\/lib\/(?:listings|medusa|supabase)['"]/)
    // The page it replaced is gone — moved, not copied — so there is one anchor page.
    expect(existsSync(path.join(ROOT, 'app/(shell)/mx/vende/page.tsx'))).toBe(false)
  })

  test('every static market surface bounds its CDN TTL', () => {
    // Guard the population, not just the page that broke. A prerendered page with
    // no `revalidate` is served with a ONE-YEAR `s-maxage`, so a CDN can keep
    // serving HTML that references `/_next/static/chunks/*` hashes deleted by the
    // next deploy. `/` shipped that way and broke in production 2026-08-06; `/us`
    // had the identical defect and was spared only by edge-cache luck.
    //
    // A page that genuinely must render per-request opts out with `force-dynamic` —
    // banning one thing without allowing its negation trains people to bypass the
    // guard (Roadmap/LEARNINGS.md).
    //
    // ONLY `force-dynamic`, and that precision is load-bearing: an earlier draft of
    // this guard accepted any `export const dynamic = …`, which let
    // `dynamic = 'force-static'` through. `force-static` (like `'error'` and the
    // default `'auto'`) prerenders with `revalidate: false` ⇒ `s-maxage=31536000` —
    // it is the defect wearing the escape hatch's clothes. Caught by the fresh
    // reviewer on PR #345 by mutation, not by reasoning; re-verify the same way.
    //
    // The three `*-site` groups are the whole static population; the language split
    // deliberately moved MX and US out of the shared selector group.
    // `app/(shell)/layout.tsx` reads `headers()`, so everything under `(shell)`
    // renders per-request (verified live — `/mx/vende`, `/terminos` and a 404 all return
    // `private, no-cache, no-store`). A future sibling route group with a static
    // layout WOULD escape this, so it must be added here when one appears.
    // `(en-site)` is the sibling this comment predicted: the English selector at
    // `/en` is a fourth static root, and a static root outside this list is a page
    // that can ship the one-year `s-maxage` again with every gate green.
    const pages = ['app/(site)', 'app/(mx-site)', 'app/(us-site)', 'app/(en-site)']
      .flatMap(filesBelow)
      .filter((file) => file.endsWith('/page.tsx'))

    // A scan that silently finds nothing must not read as a pass — AGENTS.md rule 5.
    // Matches the sibling assertion at the MX-shop-route test below.
    expect(pages.length, 'the (site) page scan found nothing — the guard is inert').toBeGreaterThanOrEqual(4)
    // Named, so a group silently dropped from the list above fails here rather than
    // shrinking the population unnoticed.
    expect(pages.map((f) => path.relative(ROOT, f).replace(/\\/g, '/')))
      .toContain('app/(en-site)/en/page.tsx')

    const offenders = pages.flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      const relative = path.relative(ROOT, file).replace(/\\/g, '/')
      if (/export const dynamic\s*=\s*['"]force-dynamic['"]/.test(source)) return []
      const declared = /export const revalidate\s*=\s*(\d+)\b/.exec(source)
      if (!declared) {
        // Distinguish "never declared" from "declared but not a literal Next can
        // statically analyse" — three states, never two.
        const nonLiteral = /export const revalidate\s*=/.test(source)
        return [`${relative} (${nonLiteral ? 'non-literal revalidate' : 'no revalidate'} — inherits s-maxage=31536000)`]
      }
      // An hour is already far longer than a deploy takes to delete the old chunks.
      const seconds = Number(declared[1])
      return seconds > 3600 ? [`${relative} (revalidate=${seconds} exceeds 3600)`] : []
    })
    expect(offenders).toEqual([])
  })

  test('platform-emitted absolute URLs never point at redirect sources', () => {
    const offenders = filesBelow('app').concat(filesBelow('lib')).flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      return /https:\/\/miyagisanchez\.com\/(?:l|s)(?:\/|['"`])|miyagisanchez\.com\/s\//.test(source)
        ? [path.relative(ROOT, file)]
        : []
    })
    expect(offenders).toEqual([])
  })

  test('platform component links never point at bare marketplace redirect sources', () => {
    const offenders = filesBelow('app').flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      return /href="\/l"|href=\{`\/l\/|href=\{`\/s\//.test(source)
        ? [path.relative(ROOT, file)]
        : []
    })
    expect(offenders).toEqual([])
  })

  test('the global cart always hops from tenant channels to canonical platform destinations', () => {
    const source = readFileSync(path.join(ROOT, 'app/components/CartDrawer.tsx'), 'utf8')
    expect(source).toContain('shopUrlFor(SITE_ORIGIN, seller.sellerSlug)')
    expect(source).toContain("marketplaceUrl(SITE_ORIGIN, '/l')")
    expect(source).toContain('`${SITE_ORIGIN}/checkout/bundle?sellerId=${encodeURIComponent(sellerId)}`')
    expect(source).not.toMatch(/href=\{?['"`]\/mx\//)
    expect(source).not.toMatch(/href=\{`\/checkout\/bundle/)
  })

  test('seller management success surfaces emit canonical marketplace shop URLs', () => {
    const seamBacked = [
      'app/(shell)/shop/manage/import/ImportClient.tsx',
      'app/(shell)/shop/manage/comparte/ComparteClient.tsx',
    ]
    for (const file of seamBacked) {
      const source = readFileSync(path.join(ROOT, file), 'utf8')
      expect(source, file).toContain('shopUrlFor(SITE_ORIGIN,')
      expect(source, file).not.toContain('window.location.origin')
    }

    const convocatoria = readFileSync(
      path.join(ROOT, 'app/(shell)/shop/manage/convocatoria/page.tsx'),
      'utf8',
    )
    expect(convocatoria).toContain(
      'marketplaceUrl(SITE_ORIGIN, `/s/${shop.slug}/convocatoria`)',
    )
    expect(convocatoria).not.toContain('publicUrl={`/mx/s/')

    const comparte = readFileSync(
      path.join(ROOT, 'app/(shell)/shop/manage/comparte/ComparteClient.tsx'),
      'utf8',
    )
    expect(comparte).not.toMatch(/(?:^|\s)\/s\/\{shopSlug\}/)
  })

  test('every literal MX shop route passes a market decision, not only a URL prefix', () => {
    const wrappers = filesBelow('app/(shell)/mx/s')
      .filter((file) => file.endsWith('/page.tsx'))
    expect(wrappers.length).toBeGreaterThan(5)
    const offenders = wrappers
      .filter((file) => !readFileSync(file, 'utf8').includes("market: 'mx'"))
      .map((file) => path.relative(ROOT, file))
    expect(offenders).toEqual([])
  })

  test('every literal US shop route passes a market decision, not only a URL prefix', () => {
    const wrappers = filesBelow('app/(us-shell)/us/s').filter((file) => file.endsWith('/page.tsx'))
    expect(wrappers.length).toBeGreaterThan(5)
    const offenders = wrappers
      .filter((file) => !readFileSync(file, 'utf8').includes("market: 'us'"))
      .map((file) => path.relative(ROOT, file))
    expect(offenders).toEqual([])
  })
})

test.describe('post-authentication destination', () => {
  // `/` is the country SELECTOR. Clerk's signInFallbackRedirectUrl defaults to
  // `/`, so omitting it silently lands every freshly-signed-in user on a country
  // picker — which is what production did until 2026-08-06. The env var that
  // looked like it configured this (NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL) does not
  // exist in @clerk/nextjs v7, so the value must live in the layout.
  test('sign-in lands on a market, never back on the selector', () => {
    const source = readFileSync(path.join(ROOT, 'app/components/MarketDocument.tsx'), 'utf8')
    // An OPEN market, not merely a known one. A future scaffolded market may have a
    // registry-valid code without a live marketplace and must not become a default.
    const openHomes = openMarketCodes().map((code) => marketBasePath(code))
    expect(openHomes, 'no open market to land on').not.toEqual([])
    expect(openHomes).toContain(marketBasePath('mx'))
    expect(source).toContain('isMarketplaceOpen(market) ? market : DEFAULT_MARKET')

    // Both halves wired, or a signed-up user still strands on the selector.
    expect(source).toContain('signInFallbackRedirectUrl={postAuthHome}')
    expect(source).toContain('signUpFallbackRedirectUrl={postAuthHome}')

    // FALLBACK, not FORCE — force overrides `redirect_url` and would break the
    // "sign in to continue" hop back into checkout.
    expect(source).not.toMatch(/sign(?:In|Up)ForceRedirectUrl/)
  })
})
