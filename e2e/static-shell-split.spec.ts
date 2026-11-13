import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

/**
 * marketplace-static-shell S1.3 — guards the route-group split invariant:
 *   • the marketplace `(site)` layout chain (root + `(site)/layout.tsx`) reads NO
 *     request headers, so the Mexico homepage can become a static CDN asset (S2);
 *   • the dynamic `(shell)/layout.tsx` keeps the per-request channel/header logic;
 *   • the split is invisible — the `/mx` homepage still serves platform chrome anonymously,
 *     and a white-label `/embed/*` path still suppresses it.
 *
 * The static invariant is proved by source-introspection (the honest check — an HTTP
 * call can't see "this layout doesn't read headers"). Mirrors the file-read pattern in
 * marketplace-positioning.spec.ts.
 */

const SEARCH_MARKER = '¿Qué estás buscando?' // platform header search — absent on white-label

function source(relPath: string): string {
  return readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8')
}

test.describe('static-shell split · static invariant', () => {
  test('the static `(site)` + root layout chain reads no request headers', () => {
    const rootLayout = source('app/components/MarketDocument.tsx')
    // `(mx-site)` and `(us-site)` left this list on 2026-11-13: the marketplace chrome follows the visitor's stored
    // ES/EN choice, so those roots render per request — see the test below. `/` stays pinned to Spanish.
    const siteLayouts = [
      source('app/(site)/layout.tsx'),
    ]

    // Static-able: no per-request header/auth read anywhere in the homepage's chain.
    expect(rootLayout).not.toContain('next/headers')
    expect(rootLayout).not.toMatch(/\bheaders\(/)
    expect(rootLayout).not.toContain('x-miyagi')
    for (const siteLayout of siteLayouts) {
      expect(siteLayout).not.toContain('next/headers')
      expect(siteLayout).not.toMatch(/\bheaders\(/)
      expect(siteLayout).not.toContain('x-miyagi')
    }
  })

  test('the market roots follow the stored language and therefore never serve from a shared cache', () => {
    // A render that depends on a cookie must never be cached for the next visitor: every market root reads the
    // preference through ONE helper, and its pages say force-dynamic rather than a revalidate that would invite a CDN.
    for (const layout of ['app/(mx-site)/layout.tsx', 'app/(us-site)/layout.tsx', 'app/(us-shell)/layout.tsx', 'app/(shell)/layout.tsx']) {
      expect(source(layout), layout).toContain('await layoutLanguage()')
      expect(source(layout), layout).toMatch(/<MarketDocument market="(?:mx|us)" language=\{language\}>/)
    }
    for (const page of ['app/(mx-site)/mx/page.tsx', 'app/(us-site)/us/page.tsx', 'app/(us-site)/us/sell/page.tsx']) {
      expect(source(page), page).toMatch(/export const dynamic = 'force-dynamic'/)
      expect(source(page), page).not.toMatch(/export const revalidate/)
    }
  })

  test('the dynamic `(shell)` layout still reads the channel headers', () => {
    const shellLayout = source('app/(shell)/layout.tsx')
    expect(shellLayout).toContain('next/headers')
    expect(shellLayout).toMatch(/\bheaders\(/)
    expect(shellLayout).toContain('x-miyagi-channel')
    expect(shellLayout).toContain('x-miyagi-embed')
  })

  // admin-content-and-announcements S1.1 — the copy-override reader is deliberately
  // ISR-safe (unstable_cache, see lib/copy-overrides.ts) SO THAT a future sprint can
  // read it from this static chain without forcing `/mx` dynamic. Sprint 2 (S2.2) is that
  // future sprint: `app/(site)/mx/page.tsx` now imports `getOverriddenDictionary` to key its
  // editorial strings under `home.*` — via the sanctioned unstable_cache-backed primitive,
  // NOT a per-request one, so this no longer needs to forbid the import outright. What
  // still matters: the copy-override read must stay scoped to the PAGE (rendered only for
  // `/mx`), never leak into the SHARED layout chain (rendered for every route under `(site)`)
  // — that would be a much bigger blast-radius change than Sprint 2 intended. `next
  // build`'s route table is the ground truth that `/mx` is still `○` (checked in
  // sprint-2.md's smoke walkthrough); this spec keeps guarding the real header/auth
  // culprits on the two shared layout files (page-level prose can't be regex-matched
  // reliably, hence checking layouts only here — they carry no such comments).
  test('the shared (site) layout chain still imports neither headers nor the copy-override reader', () => {
    const rootLayout = source('app/components/MarketDocument.tsx')
    const siteLayouts = [
      source('app/(site)/layout.tsx'),
      source('app/(mx-site)/layout.tsx'),
      source('app/(us-site)/layout.tsx'),
    ]

    for (const file of [rootLayout, ...siteLayouts]) {
      expect(file).not.toContain('next/headers')
      expect(file).not.toContain('lib/copy-overrides')
    }
    for (const file of [rootLayout, siteLayouts[0]]) expect(file).not.toMatch(/\bheaders\(/)
  })
})

test.describe('static-shell split · channels unbroken', () => {
  test('the marketplace homepage still renders platform chrome anonymously', async ({ request }) => {
    const res = await request.get('/mx', { headers: { Accept: 'text/html' } })
    expect(res.ok()).toBeTruthy()
    const html = await res.text()
    expect(html).toContain(SEARCH_MARKER)
    expect(html).toContain('data-testid="site-footer"')
  })

  test('a white-label /embed path still suppresses platform chrome', async ({ request }) => {
    // The embed surface is framable on ANY slug (next.config sets the CSP per-path).
    const framable = await request.get('/embed/s/__smoke__', { headers: { Accept: 'text/html' } })
    expect((framable.headers()['content-security-policy'] ?? '')).toContain('frame-ancestors')

    // Prove suppression on a REAL embed storefront (not a 404): derive an
    // EMBED-CAPABLE shop and assert the platform header's search box is absent — i.e.
    // the route-group split did not regress the `(shell)` white-label branch. Probe
    // for the first shop whose embed actually renders rather than trusting catalog
    // ordering: `/embed/s/[slug]` 404s for shops whose Medusa seller slug doesn't
    // resolve via `/store/sellers`, so a blind catalog[0] made this hostage to which
    // shop happens to be newest. Skip only if the env has no embed-capable shop.
    const cat = await request.get('/api/ucp/catalog?limit=50')
    expect(cat.ok()).toBeTruthy()
    const items = ((await cat.json())?.items ?? []) as Array<{ shop?: { slug?: unknown } }>
    let shop: Awaited<ReturnType<typeof request.get>> | null = null
    for (const item of items) {
      const s = item.shop?.slug
      if (typeof s !== 'string' || !s) continue
      const probe = await request.get(`/embed/s/${s}`, { headers: { Accept: 'text/html' } })
      if (probe.ok()) { shop = probe; break }
    }
    test.skip(!shop, 'no embed-capable shop in this environment')
    expect(await shop!.text()).not.toContain(SEARCH_MARKER)
  })
})
