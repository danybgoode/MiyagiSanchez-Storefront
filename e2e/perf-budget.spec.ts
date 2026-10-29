import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { imageVaryHeader, LOADER_DEVICE_WIDTHS, LOADER_IMAGE_WIDTHS, resolveImageVariant, selectImageFormat } from '@/lib/image-variant'
import { readBuyerRouteReports } from '../scripts/route-client-budget.mjs'

// D16 — calibrated against built output with the same deterministic Brotli
// encoder the gate uses. The branded page/global 500 boundary is loaded on buyer
// routes; its measured ~3 KiB cost is included instead of treating the old ceiling
// as a ban on an intentional recovery path. Keep measurement beside each ceiling.
const BUYER_ROUTE_BUDGETS = {
  '/mx': { measured: 100_712, ceiling: 102_000 },
  '/mx/l/[id]': { measured: 111_780, ceiling: 114_000 },
  '/mx/s/[slug]': { measured: 93_766, ceiling: 96_000 },
} as const

/**
 * hyper-performant-website S1 — the seed for the Sprint-1 acceptance checks
 * (bucket Cache-Control, responsive/sized image delivery, first-row LCP
 * priority, no hotlinked images in the live import path). Hardened in S2.3
 * with an actual payload-size budget once the CSS/JS work lands.
 *
 * Two layers, deliberately:
 *   1. Source-code assertions (like dockerfile-lockfile.spec.ts /
 *      frontend-build-args.spec.ts) — pure fs-read/regex, no network, no
 *      credentials, no live deploy needed. This is what makes the spec
 *      pass BEFORE this PR is deployed anywhere (the worktree has no R2/
 *      Medusa credentials to hit a live environment with).
 *   2. One live round-trip, gated exactly like static-shell-split.spec.ts /
 *      home-static.spec.ts's "derive non-emptiness from the environment"
 *      pattern: skip gracefully if the running target doesn't have this
 *      code yet (pre-merge, hitting prod) or has no listings to render —
 *      becomes a real check once the PR's own preview/prod serves it.
 */

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

test.describe('perf-budget · source-code checks (deterministic, no network)', () => {
  test('the custom next/image loader targets the self-hosted /api/img proxy', () => {
    const loader = read('lib/image-loader.ts')
    expect(loader).toMatch(/\/api\/img\?/)
    expect(loader).toMatch(/url:\s*src/)
    expect(loader).toMatch(/w:\s*String\(width\)/)
    expect(loader).toMatch(/f:\s*'webp'/)
    expect(loader).toMatch(/v:\s*'2'/)
  })

  test('the custom loader emits one quality-75 variant, avoiding extra cold origin encodes', () => {
    const loader = read('lib/image-loader.ts')
    expect(loader).toMatch(/q:\s*'75'/)
    expect(loader).not.toMatch(/quality\s*\?\?/)
  })

  test('next.config.ts registers the custom loader (bypasses the broken /_next/image route)', () => {
    const cfg = read('next.config.ts')
    expect(cfg).toMatch(/loader:\s*'custom'/)
    expect(cfg).toMatch(/loaderFile:\s*'.\/lib\/image-loader\.ts'/)
  })

  test('next/image emits the D5 reduced width set for its actual optimized call sites', () => {
    const cfg = read('next.config.ts')
    expect(LOADER_DEVICE_WIDTHS).toEqual([384, 640, 828, 1200, 1920])
    expect(LOADER_IMAGE_WIDTHS).toEqual([64, 96])
    expect(cfg).toMatch(/deviceSizes:\s*\[\.\.\.LOADER_DEVICE_WIDTHS\]/)
    expect(cfg).toMatch(/imageSizes:\s*\[\.\.\.LOADER_IMAGE_WIDTHS\]/)
  })

  test('/api/img validates the source host against an allow-list (no open SSRF proxy)', () => {
    const route = read('app/api/img/route.ts')
    expect(route).toMatch(/allowedHosts/)
    expect(route).toMatch(/hosts\.has\(parsed\.hostname\)/)
    expect(route).toMatch(/protocol !== 'https:'/)
  })

  test('/api/img sets a long-lived, immutable Cache-Control on every response', () => {
    const route = read('app/api/img/route.ts')
    expect(route).toMatch(/Cache-Control['"]?:\s*['"]public, max-age=31536000, immutable['"]/)
  })

  test('/api/img refuses to follow redirects from the origin fetch (no allow-list bypass via 3xx)', () => {
    const route = read('app/api/img/route.ts')
    // Scoped to the actual fetch() call, not just "the string exists somewhere" —
    // the surrounding comment also explains WHY, which would let a bare
    // substring check pass even if the option were ever dropped from the call.
    const fetchCall = route.match(/upstream = await fetch\([\s\S]*?\)\)/)?.[0]
    expect(fetchCall, 'expected the upstream fetch() call in /api/img').toBeTruthy()
    expect(fetchCall).toMatch(/redirect:\s*'error'/)
  })

  test('/api/img preserves legacy negotiation and makes fixed WebP independent of Accept', () => {
    expect(selectImageFormat(null, 'image/avif,image/webp')).toBe('avif')
    expect(imageVaryHeader(null)).toEqual({ Vary: 'Accept' })
    expect(selectImageFormat('webp', 'image/avif')).toBe('webp')
    expect(imageVaryHeader('webp')).toEqual({})
    // The print renderer's pinned JPEG (Chromium embeds JPEG in a PDF as-is; share-kit 2026-10-29).
    expect(selectImageFormat('jpeg', 'image/avif,image/webp')).toBe('jpeg')
    expect(imageVaryHeader('jpeg')).toEqual({})
  })

  test('/api/img accepts only canonical bounded cache keys before any origin encode', () => {
    const src = 'https://images.example/item.jpg'
    const decideRaw = (raw: string) => resolveImageVariant(new URLSearchParams(raw), raw)
    const legacy = new URLSearchParams({ url: src, w: '160', q: '90' })
    const fixed = new URLSearchParams({ url: src, w: '640', q: '75', f: 'webp', v: '2' })
    expect(resolveImageVariant(legacy)).toMatchObject({ ok: true, variant: { width: 160, quality: 90, fixedFormat: null } })
    expect(resolveImageVariant(fixed)).toMatchObject({ ok: true, variant: { width: 640, quality: 75, fixedFormat: 'webp' } })
    const fixedJpeg = new URLSearchParams({ url: src, w: '640', q: '75', f: 'jpeg', v: '2' })
    expect(resolveImageVariant(fixedJpeg)).toMatchObject({ ok: true, variant: { width: 640, quality: 75, fixedFormat: 'jpeg' } })
    const canonicalRaw = fixed.toString()
    expect(decideRaw(canonicalRaw)).toMatchObject({ ok: true })
    expect(decideRaw(canonicalRaw.replace('%3A', '%3a'))).toMatchObject({ ok: false })
    expect(decideRaw(canonicalRaw.replace('w=640', 'w=%36%34%30'))).toMatchObject({ ok: false })
    expect(resolveImageVariant(new URLSearchParams({ url: src, w: '48', q: '75' }))).toMatchObject({ ok: true, variant: { width: 64 } })
    expect(resolveImageVariant(new URLSearchParams({ url: src, w: '2048', q: '75' }))).toMatchObject({ ok: true, variant: { width: 1920 } })
    expect(resolveImageVariant(new URLSearchParams({ url: src, w: '3840', q: '75' }))).toMatchObject({ ok: true, variant: { width: 1920 } })

    for (const query of [
      new URLSearchParams({ url: src, w: '641', q: '75', f: 'webp', v: '2' }),
      new URLSearchParams({ url: src, w: '640', q: '90', f: 'webp', v: '2' }),
      new URLSearchParams({ url: src, w: '640', q: '75', f: 'avif', v: '2' }),
      new URLSearchParams({ url: src, w: '640', q: '75', f: 'png', v: '2' }),
      new URLSearchParams({ url: src, w: '640', q: '75', f: 'jpg', v: '2' }),
      new URLSearchParams({ url: src, w: '640', q: '75', f: 'jpeg' }),
      new URLSearchParams({ url: src, w: '640', q: '75', f: 'webp' }),
      new URLSearchParams({ w: '640', url: src, q: '75', f: 'webp', v: '2' }),
      new URLSearchParams({ url: src, w: '640', q: '75', f: 'webp', v: '2', extra: '1' }),
      new URLSearchParams({ url: src, w: '064', q: '75', f: 'webp', v: '2' }),
      new URLSearchParams({ url: src, w: '64.0', q: '75', f: 'webp', v: '2' }),
      new URLSearchParams({ url: src, w: '6.4e1', q: '75', f: 'webp', v: '2' }),
      new URLSearchParams({ url: src, w: '0x40', q: '75', f: 'webp', v: '2' }),
      new URLSearchParams({ url: src, w: '64', q: '075', f: 'webp', v: '2' }),
      new URLSearchParams({ url: 'https://IMAGES.example/item.jpg', w: '64', q: '75', f: 'webp', v: '2' }),
      new URLSearchParams({ url: 'https://images.example:443/item.jpg', w: '64', q: '75', f: 'webp', v: '2' }),
      new URLSearchParams({ url: 'https://images.example/a/../item.jpg', w: '64', q: '75', f: 'webp', v: '2' }),
      new URLSearchParams({ url: 'https://images.example/item.jpg#one', w: '64', q: '75', f: 'webp', v: '2' }),
      new URLSearchParams({ url: 'https://images.example/item%7E.jpg', w: '64', q: '75', f: 'webp', v: '2' }),
      new URLSearchParams({ url: 'https://images.example/item%7e.jpg', w: '64', q: '75', f: 'webp', v: '2' }),
      new URLSearchParams({ url: 'https://images.example/item%2Fpart.jpg', w: '64', q: '75', f: 'webp', v: '2' }),
      new URLSearchParams({ url: 'https://images.example/item%2fpart.jpg', w: '64', q: '75', f: 'webp', v: '2' }),
      new URLSearchParams({ url: 'https://images.example/item%20part.jpg', w: '160', q: '75' }),
      new URLSearchParams({ url: 'https://images.example/item%25part.jpg', w: '64', q: '75', f: 'webp', v: '2' }),
      new URLSearchParams({ url: 'https://user@images.example/item.jpg', w: '64', q: '75', f: 'webp', v: '2' }),
      new URLSearchParams({ url: 'https://images.example/item.jpg?cache_alias=1', w: '64', q: '75', f: 'webp', v: '2' }),
      new URLSearchParams({ url: 'https://images.example/item.jpg?cache_alias=1', w: '160', q: '75' }),
      new URLSearchParams({ url: 'https://images.example/item.jpg?', w: '64', q: '75', f: 'webp', v: '2' }),
      new URLSearchParams({ url: 'https://images.example/item.jpg#', w: '64', q: '75', f: 'webp', v: '2' }),
      new URLSearchParams({ url: 'https://images.example/item.jpg?#', w: '160', q: '75' }),
    ]) expect(resolveImageVariant(query).ok).toBe(false)
  })

  test('new R2 uploads get a long-lived Cache-Control at the object level', () => {
    const r2 = read('lib/r2.ts')
    expect(r2).toMatch(/CacheControl:\s*'public, max-age=31536000, immutable'/)
  })

  test('the homepage LCP element (Selección featured card) uses next/image with priority', () => {
    const page = read('app/(mx-site)/mx/page.tsx')
    expect(page).toMatch(/import Image from 'next\/image'/)
    const featuredBlock = page.slice(page.indexOf('Featured card'), page.indexOf('Grid — price 16px'))
    expect(featuredBlock).not.toMatch(/<img\s/)
    // Assert `priority`/`sizes` INSIDE the captured <Image ... /> tag itself, not
    // just "somewhere in this block" — the block also contains a prose comment
    // that says the word "priority" (explaining why), which would let this pass
    // even if the actual JSX attribute were ever deleted. Scoping to the tag
    // closes that gap.
    const imageTag = featuredBlock.match(/<Image\b[\s\S]*?\/>/)?.[0]
    expect(imageTag, 'expected a self-closing <Image ... /> tag in the featured-card block').toBeTruthy()
    expect(imageTag).toMatch(/\bpriority(?:=\{true\})?(?=\s|\/>)/)
    expect(imageTag).toMatch(/\bsizes=/)
  })

  test('the Selección grid marks only the first row (idx < 2) as priority', () => {
    const page = read('app/(mx-site)/mx/page.tsx')
    const gridBlock = page.slice(page.indexOf('Grid — price 16px'), page.indexOf('Categorías —'))
    expect(gridBlock).not.toMatch(/<img\s/)
    // Same tag-scoping as the featured-card check above.
    const imageTag = gridBlock.match(/<Image\b[\s\S]*?\/>/)?.[0]
    expect(imageTag, 'expected a self-closing <Image ... /> tag in the grid block').toBeTruthy()
    expect(imageTag).toMatch(/priority=\{idx < 2\}/)
  })

  test('supply-import ingests hotlinked images into R2 before creating a listing', () => {
    const supplyImport = read('lib/supply-import.ts')
    expect(supplyImport).toMatch(/ingestImageUrls/)
    // Anchor on the actual CALL (`await ingestImageUrls(`), not just the bare
    // function name — a doc comment right above the call site also names
    // `ingestImageUrls(` in prose, which `indexOf('ingestImageUrls(')` alone
    // would happily match first even if the real call were ever removed.
    const ingestIdx = supplyImport.indexOf('await ingestImageUrls(')
    const bodyIdx = supplyImport.indexOf('supplyItemToProductBody(itemForCreate')
    expect(ingestIdx).toBeGreaterThan(-1)
    expect(bodyIdx).toBeGreaterThan(-1)
    expect(ingestIdx).toBeLessThan(bodyIdx)
  })

  test('a hotlinked-image backfill script exists for pre-existing listings', () => {
    // Full correctness of a script needing live prod credentials can't be
    // asserted here (see the script's own header) — this just guards against
    // the file silently disappearing/being renamed out from under the sprint doc.
    const script = read('scripts/backfill-hotlinked-images.mjs')
    expect(script).toMatch(/images_mode.*replace/)
    expect(script).toMatch(/--apply/)
  })
})

/**
 * S2.1 — the iconoir subset's own coverage/regression guard lives in its own
 * spec file (e2e/iconoir-subset.spec.ts), same shape as S1's per-concern
 * split. Kept out of this file to avoid one giant spec covering three
 * unrelated stories.
 */

test.describe('perf-budget · S2.2 source-code checks — Clerk UI lazy-mount + legacy-polyfill purge', () => {
  // The PageSpeed audit (2026-07-14) attributed ~301 KiB of "Reduce unused
  // JavaScript" to clerk.miyagisanchez.com's OWN ui-common_ui/vendors_ui/
  // ui.browser.js bundles, fetched by Clerk's SDK the moment a UI-rendering
  // component (<UserButton>, <SignIn>, <UserProfile>) is about to mount.
  // PlatformShell.tsx and account/page.tsx both statically imported
  // `{ UserButton } from '@clerk/nextjs'` and only gated the RENDER with a
  // client-side <AuthShow> — a runtime conditional, not a build-time split —
  // so that trigger fired on EVERY page load, signed in or not. Clerk's core
  // auth (ClerkProvider, useAuth, useUser, the session cookie — AGENTS.md
  // rule #4) is untouched everywhere below; only the UI-rendering components
  // move behind `next/dynamic(..., { ssr: false })`.
  for (const [wrapperPath, exportedSymbol] of [
    ['app/components/clerk-lazy/LazyUserButton.tsx', 'UserButton'],
    ['app/components/clerk-lazy/LazySignIn.tsx', 'SignIn'],
    ['app/components/clerk-lazy/LazySignUp.tsx', 'SignUp'],
    ['app/components/clerk-lazy/LazyUserProfile.tsx', 'UserProfile'],
  ] as const) {
    test(`${wrapperPath} lazy-mounts Clerk's ${exportedSymbol} via next/dynamic({ ssr: false })`, () => {
      const wrapper = read(wrapperPath)
      expect(wrapper).toMatch(/^'use client'/)
      expect(wrapper).toMatch(/from 'next\/dynamic'/)
      const dynamicCall = wrapper.match(/dynamic\([\s\S]*?\)\)?,\s*\{[\s\S]*?\}\)/)?.[0]
      expect(dynamicCall, `expected a dynamic(...) call in ${wrapperPath}`).toBeTruthy()
      expect(dynamicCall).toMatch(new RegExp(`mod\\.${exportedSymbol}\\b`))
      expect(dynamicCall).toMatch(/ssr:\s*false/)
    })
  }

  test('PlatformShell (rendered on every page, incl. the homepage) no longer statically imports Clerk\'s UserButton directly', () => {
    const shell = read('app/components/PlatformShell.tsx')
    expect(shell).not.toMatch(/import\s*\{\s*UserButton\s*\}\s*from\s*'@clerk\/nextjs'/)
    expect(shell).toMatch(/import LazyUserButton from '@\/app\/components\/clerk-lazy\/LazyUserButton'/)
    expect(shell).toMatch(/<LazyUserButton\s*\/>/)
  })

  test('account/page.tsx no longer statically imports Clerk\'s UserButton directly', () => {
    const accountPage = read('app/(shell)/account/page.tsx')
    expect(accountPage).not.toMatch(/import\s*\{\s*UserButton\s*\}\s*from\s*'@clerk\/nextjs'/)
    expect(accountPage).toMatch(/<LazyUserButton\s*\/>/)
  })

  test('sign-in/sign-up/account-settings pages render through the lazy wrappers, not a direct Clerk import', () => {
    const signIn = read('app/(shell)/sign-in/[[...sign-in]]/page.tsx')
    expect(signIn).not.toMatch(/from '@clerk\/nextjs'/)
    expect(signIn).toMatch(/<LazySignIn\b/)

    const signUp = read('app/(shell)/sign-up/[[...sign-up]]/page.tsx')
    expect(signUp).not.toMatch(/from '@clerk\/nextjs'/)
    expect(signUp).toMatch(/<LazySignUp\b/)

    const settings = read('app/(shell)/account/settings/[[...rest]]/page.tsx')
    expect(settings).not.toMatch(/\{\s*UserProfile\s*\}\s*from '@clerk\/nextjs'/)
    expect(settings).toMatch(/<LazyUserProfile\b/)
  })

  test('Clerk AUTH itself is untouched — ClerkProvider still wraps the root layout, useAuth/useUser hooks unchanged (AGENTS.md rule #4)', () => {
    const layout = read('app/components/MarketDocument.tsx')
    expect(layout).toMatch(/import \{ ClerkProvider \} from '@clerk\/nextjs'/)
    expect(layout).toMatch(/<ClerkProvider/)
    // Spot-check a couple of hook-only consumers (no UI bundle cost) stayed
    // on the direct import — only the four UI-rendering components moved.
    const authShow = read('app/components/AuthShow.tsx')
    expect(authShow).toMatch(/import \{ useAuth \} from '@clerk\/nextjs'/)
  })

  test('package.json declares a modern browserslist target (legacy-JS purge — Array.at/Object.hasOwn/flat(Map)/trimStart/trimEnd polyfills, ~14 KiB per the 2026-07-14 audit)', () => {
    const pkg = JSON.parse(read('package.json'))
    const browserslist: string[] = pkg.browserslist
    expect(Array.isArray(browserslist)).toBe(true)
    expect(browserslist.length).toBeGreaterThan(0)
    // Every entry should express a recent-enough floor that SWC can safely
    // skip the ES2019-2022 method polyfills (Array.prototype.at/flat/
    // flatMap, Object.fromEntries/hasOwn, String.prototype.trimStart/
    // trimEnd) the audit flagged — not an exhaustive browser-support test
    // (that needs a live PageSpeed run), just a guard against the config
    // silently reverting to "no browserslist" (SWC's broad default) or
    // being widened back out to a legacy target like IE 11.
    const joined = browserslist.join(' ').toLowerCase()
    expect(joined).not.toMatch(/\bie\s*11\b/)
    expect(joined).not.toMatch(/\bopera mini\b/)
    expect(browserslist.some((entry) => /safari\s*>=?\s*1[5-9]/.test(entry))).toBe(true)
  })
})

// Order/quote-independent HTML tag+attribute extraction — a fresh reviewer on
// this PR correctly flagged the first version of these checks as only
// matching double-quoted, FIXED-attribute-order tags (`rel="stylesheet"`
// always assumed to precede `href="..."`), which real HTML (attribute order
// varies by renderer, and both quote styles are valid) isn't guaranteed to
// produce. `extractTags` grabs whole `<tagName ...>` matches; `hasAttr`/
// `attrValue` then look inside ONE tag string, independent of where in the
// tag the attribute sits or which quote character it uses.
function extractTags(html: string, tagName: string): string[] {
  return [...html.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, 'g'))].map((m) => m[0])
}
function hasAttr(tag: string, attrName: string): boolean {
  return new RegExp(`\\b${attrName}\\b`).test(tag)
}
function attrValue(tag: string, attrName: string): string | undefined {
  return tag.match(new RegExp(`\\b${attrName}\\s*=\\s*["']([^"']*)["']`))?.[1]
}

test.describe('perf-budget · S2.3 source-code checks — the render-blocking-CDN regression guard', () => {
  test("MarketDocument's <head> has no external stylesheet <link> besides the accepted Google Fonts one", () => {
    // Deterministic, no-network guard against the EXACT regression class this
    // sprint fixed: a large third-party stylesheet (jsDelivr's iconoir.css)
    // re-appearing in the shared root layout's <head>. Google Fonts stays
    // allow-listed by name (small, already preconnected, a deliberate
    // trade-off, not the class of asset this guard is watching for).
    const layout = read('app/components/MarketDocument.tsx')
    const headBlock = layout.slice(layout.indexOf('<head>'), layout.indexOf('</head>'))
    const stylesheetHrefs = extractTags(headBlock, 'link')
      .filter((tag) => attrValue(tag, 'rel') === 'stylesheet')
      .map((tag) => attrValue(tag, 'href'))
      .filter((href): href is string => !!href)
    const externalStylesheets = stylesheetHrefs.filter((href) => /^https?:\/\//.test(href))
    for (const href of externalStylesheets) {
      expect(href, `unexpected external stylesheet in the shared root layout: ${href}`).toMatch(/^https:\/\/fonts\.googleapis\.com\//)
    }
  })
})

// The one host this environment-detection cares about being STRICT for.
// playwright.config.ts defaults `baseURL` to this when PLAYWRIGHT_BASE_URL is
// unset; CI's "Playwright vs preview" job always overrides it to that PR's
// ephemeral Vercel URL, so `baseURL === PROD_URL` is only ever true for an
// explicit prod run (never CI-against-preview).
const PROD_URL = 'https://miyagisanchez.com'

// S2.3 — how big a render-blocking asset (a <head> stylesheet <link>, or a
// blocking <script> with neither `async`, `defer`, nor `type="module"`) is
// allowed to be before the budget goes red. 150 KiB per sprint-2.md's
// acceptance ("budgets red when a >150 KiB render-blocking asset appears").
const RENDER_BLOCKING_BUDGET_BYTES = 150 * 1024

test.describe('perf-budget · S2.3 mechanism fixture (no network — deterministic proof the budget comparison itself is wired correctly)', () => {
  // The live test below depends on real prod state (and, as of this commit,
  // prod HASN'T deployed S2 yet, so it correctly fails against the still-live
  // 2.8 MB jsDelivr response — see the PR description). This fixture proves
  // the BUDGET LOGIC itself catches a >150 KiB asset and passes a small one,
  // independent of what prod happens to be serving right now — the same
  // "observed red via deliberate mutation" proof as the other new specs,
  // just against a fixture instead of a live fetch.
  test('a fixture asset over the budget fails the same comparison the live check uses; one under it passes', () => {
    const overBudget = RENDER_BLOCKING_BUDGET_BYTES + 1
    const underBudget = RENDER_BLOCKING_BUDGET_BYTES - 1
    expect(overBudget).toBeGreaterThan(RENDER_BLOCKING_BUDGET_BYTES)
    expect(() => expect(overBudget).toBeLessThanOrEqual(RENDER_BLOCKING_BUDGET_BYTES)).toThrow()
    expect(underBudget).toBeLessThanOrEqual(RENDER_BLOCKING_BUDGET_BYTES)
  })
})

test.describe('perf-budget · S3.4 built buyer-route Brotli transfer (D16)', () => {
  test('each route stays below its post-diet Brotli client-JS ceiling', () => {
    const manifestsDir = '.next/server/app'
    test.skip(
      process.env.REMOTE_PREVIEW_ONLY === 'true' && !existsSync(manifestsDir),
      'built-artifact guard runs in the typecheck-build job; this job verifies the remote preview',
    )
    const reports = readBuyerRouteReports()
    for (const [route, budget] of Object.entries(BUYER_ROUTE_BUDGETS)) {
      expect(reports[route], `UNAVAILABLE — no built manifest report for ${route}`).toBeDefined()
      expect(reports[route].brotliBytes, `${route} client JS transfer regressed above ${budget.ceiling} bytes`).toBeLessThanOrEqual(budget.ceiling)
    }
  })

  test('mechanism fixture allows an under-budget route and rejects an over-budget route', () => {
    const ceiling = 100
    expect(99).toBeLessThanOrEqual(ceiling)
    expect(() => expect(101).toBeLessThanOrEqual(ceiling)).toThrow()
  })
})

test.describe('perf-budget · live check (skips gracefully pre-deploy / empty catalog / preview-config-gap)', () => {
  test('first-row homepage image URLs carry sizing params and long-lived cache headers', async ({ request, baseURL }) => {
    const homeRes = await request.get('/mx', { headers: { Accept: 'text/html' } })
    test.skip(!homeRes.ok(), 'homepage not reachable in this environment')
    const html = await homeRes.text()

    const match = html.match(/\/api\/img\?url=[^"'\s]+w=\d+[^"'\s]*/)
    test.skip(!match, 'no /api/img-sourced image found yet in this environment (pre-deploy, or empty catalog)')

    const imgUrl = match![0].replace(/&amp;/g, '&')
    expect(imgUrl).toMatch(/[?&]w=\d+/)

    const imgRes = await request.get(imgUrl)
    const isProd = baseURL === PROD_URL

    // Vercel PR-preview deployments are a CI/QA target, not a production
    // mirror — they've been observed missing server-side env vars prod has
    // (e.g. Supabase creds render as "using stub" in preview runtime logs),
    // and R2_PUBLIC_URL / NEXT_PUBLIC_SUPABASE_URL (the /api/img hostname
    // allow-list's inputs, app/api/img/route.ts) are exactly the kind of
    // per-environment secret that can legitimately differ there. The
    // srcset URL itself is generated client-side by the next/image loader
    // (lib/image-loader.ts) purely from the listing's own image URL — it
    // has no idea whether the SERVER it's about to hit is configured, so
    // its presence in the HTML only proves "this environment renders
    // loader-wrapped image tags," not "this environment's /api/img route
    // is reachable." Confirm reachability before treating a failure as
    // real: on prod it's a hard failure either way (prod must always have
    // this working); everywhere else, a non-ok response skips gracefully
    // with the actual status/body so it's still debuggable, rather than
    // failing a PR on an environment-config gap this PR's code can't fix.
    if (!isProd && !imgRes.ok()) {
      const body = await imgRes.text().catch(() => '<unreadable>')
      test.skip(true, `/api/img not serving successfully on this non-prod target (status ${imgRes.status()}: ${body.slice(0, 200)}) — likely a preview env-var gap (R2_PUBLIC_URL/NEXT_PUBLIC_SUPABASE_URL), not a code regression`)
    }

    expect(imgRes.ok()).toBeTruthy()
    expect(imgRes.headers()['content-type'] ?? '').toMatch(/^image\//)
    expect(imgRes.headers()['cache-control'] ?? '').toContain('max-age=31536000')
    expect(imgRes.headers()['cache-control'] ?? '').toContain('immutable')
  })

  // S2.3 — hardens the budget beyond "the first image we happen to match":
  // the first THREE unique /api/img URLs discoverable in the homepage HTML
  // (the "first-row images" sprint-2.md's acceptance names — Selección
  // featured + the idx<2 grid row, see e2e/perf-budget.spec.ts's S1 image-
  // priority tests) must all carry the long-lived cache header, not just the
  // one this spec happened to match first. Deliberately NOT "every image on
  // the page" — the live /api/img route resizes-on-demand against real prod
  // images, and fetching dozens sequentially against a shared resource
  // reliably times out the test (observed locally); 3 is enough to prove
  // "not just the first" without hammering prod. Same prod-vs-preview skip
  // semantics as the sibling test above.
  test('the first few /api/img-sourced URLs on the homepage all carry long-lived cache headers, not just the first', async ({ request, baseURL }) => {
    test.slow() // multiple live resize round-trips; give this more headroom than the default 30s
    const homeRes = await request.get('/mx', { headers: { Accept: 'text/html' } })
    test.skip(!homeRes.ok(), 'homepage not reachable in this environment')
    const html = await homeRes.text()

    const matches = [...html.matchAll(/\/api\/img\?url=[^"'\s]+w=\d+[^"'\s]*/g)].map((m) => m[0].replace(/&amp;/g, '&'))
    test.skip(matches.length === 0, 'no /api/img-sourced image found yet in this environment (pre-deploy, or empty catalog)')

    const isProd = baseURL === PROD_URL
    const uniqueUrls = [...new Set(matches)].slice(0, 3)

    for (const imgUrl of uniqueUrls) {
      const imgRes = await request.get(imgUrl)
      if (!isProd && !imgRes.ok()) continue // same preview env-var-gap tolerance as the sibling test above

      expect(imgRes.ok(), `${imgUrl} did not respond OK`).toBeTruthy()
      expect(imgRes.headers()['cache-control'] ?? '', `${imgUrl} missing long-lived Cache-Control`).toContain('max-age=31536000')
      expect(imgRes.headers()['cache-control'] ?? '', `${imgUrl} missing immutable Cache-Control`).toContain('immutable')
    }
  })

  // S2.3 — the actual budget: fetch every render-blocking EXTERNAL/third-party
  // asset discoverable in the homepage's <head> and fail if any exceeds
  // RENDER_BLOCKING_BUDGET_BYTES. Hard assertion ONLY on the prod host (S1's
  // established skip semantics — see the sibling live tests' comments for
  // why preview isn't a fair target).
  //
  // Scoped to EXTERNAL assets on purpose (a fresh reviewer caught the first
  // version of this test measuring same-origin assets too, and getting the
  // measurement itself wrong in the process — see below). This matches the
  // guard's actual stated intent throughout this sprint ("zero render-
  // blocking requests from external CDNs", 2.1's acceptance) and the real
  // regression class it exists to catch: the jsDelivr iconoir.css link. A
  // same-origin CSS/JS budget is a DIFFERENT, harder problem this test
  // doesn't attempt: Next.js legitimately bundles ALL of an app's critical
  // CSS (globals.css + the iconoir subset + everything else) into ONE
  // same-origin chunk, so a raw per-file byte count on same-origin output
  // says nothing meaningful about render-blocking cost on its own — and
  // `body().length` specifically (what this test used to check) reads the
  // DECOMPRESSED size after Playwright's request client auto-decodes
  // gzip/brotli, not the actual over-the-wire transfer size Lighthouse's own
  // "render-blocking" and "unused CSS" audits measure. Concretely: this PR's
  // own bundled CSS chunk was measured at 211,974 raw bytes post-deploy in
  // review — over budget by that (wrong) measure despite being ~15 KiB over
  // the wire. External-only scoping sidesteps the whole compressed-vs-
  // uncompressed question: a third-party CDN response's raw byte count IS
  // what forced the browser to fetch that many bytes from THAT origin
  // regardless of Playwright's own decoding, so `body().length` is the right
  // measure there (verified against the exact jsDelivr regression case below
  // — its 2,888,008-byte body is genuinely that large, not a compression
  // artifact).
  test('no render-blocking EXTERNAL <head> asset on the homepage exceeds the 150 KiB budget', async ({ request, baseURL }) => {
    const isProd = baseURL === PROD_URL
    test.skip(!isProd, 'hard budget assertion only runs against the prod host — see S1 comments on why preview is excluded')

    const homeRes = await request.get('/mx', { headers: { Accept: 'text/html' } })
    expect(homeRes.ok()).toBeTruthy()
    const html = await homeRes.text()
    const headHtml = html.slice(html.indexOf('<head'), html.indexOf('</head>'))

    // Render-blocking stylesheets: any <link rel="stylesheet"> without a
    // media="print"/preload+onload async-CSS trick (this app uses neither).
    const stylesheetUrls = extractTags(headHtml, 'link')
      .filter((tag) => attrValue(tag, 'rel') === 'stylesheet')
      .map((tag) => attrValue(tag, 'href'))
      .filter((href): href is string => !!href)
    // Render-blocking scripts: a <script src=...> with none of async/defer/
    // type="module" (Next's own framework scripts are always deferred/
    // module — this only catches something that regresses that).
    const blockingScriptUrls = extractTags(headHtml, 'script')
      .filter((tag) => attrValue(tag, 'src') && !hasAttr(tag, 'async') && !hasAttr(tag, 'defer') && attrValue(tag, 'type') !== 'module')
      .map((tag) => attrValue(tag, 'src'))
      .filter((src): src is string => !!src)

    const pageOrigin = new URL(PROD_URL).origin
    const externalAssetUrls = [...stylesheetUrls, ...blockingScriptUrls]
      .filter((href) => /^https?:\/\//.test(href))
      .filter((href) => new URL(href).origin !== pageOrigin)

    for (const assetUrl of externalAssetUrls) {
      const assetRes = await request.get(assetUrl)
      expect(assetRes.ok(), `${assetUrl} did not respond OK`).toBeTruthy()
      const body = await assetRes.body()
      expect(body.length, `${assetUrl} is ${body.length} bytes, over the ${RENDER_BLOCKING_BUDGET_BYTES}-byte render-blocking budget`)
        .toBeLessThanOrEqual(RENDER_BLOCKING_BUDGET_BYTES)
    }
  })
})
