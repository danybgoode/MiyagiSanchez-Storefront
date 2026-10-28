import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Prompt-to-shop S2 — client JS diet for the code THIS epic ships to the browser. The repo's byte budget
// (`perf-budget.spec.ts`) is calibrated against built output for three buyer routes (/mx, /mx/l/[id], /mx/s/[slug]);
// none of the draft routes is one, and no `next build` runs in a builder checkout, so the budget cannot see this
// code. What CAN be held without a build is the cause of bloat: a client module reaching a server or validator
// module. `blocks.ts` alone drags the catalog and settings validators (~60 KB of source) into whatever imports it as
// a value, which is why the shared constant lives in `constants.ts`.

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const CLIENT_FILES = [
  'app/(shell)/mx/vende/_components/DescribeBox.tsx',
  'app/(shell)/p2s/_components/TakingShape.tsx',
  'app/(shell)/p2s/_components/OwnerCanvas.tsx',
  'app/(shell)/p2s/_components/ShopCanvas.tsx',
  'app/(shell)/p2s/_components/ExampleIllustration.tsx',
  'app/(shell)/p2s/_components/TurnstileWidget.tsx',
  'app/(shell)/p2s/_components/KeepSheet.tsx',
  'app/(shell)/p2s/_components/ClaimRunner.tsx',
  'app/(shell)/p2s/_components/KeptShop.tsx',
  'lib/prompt-to-shop/client.ts',
  'lib/prompt-to-shop/copy.ts',
  'lib/prompt-to-shop/view.ts',
  'lib/prompt-to-shop/illustrations.ts',
  'lib/prompt-to-shop/constants.ts',
]

/** Modules that must never be a VALUE import of a browser module. Type imports are erased and are fine. */
const HEAVY = /(^|\/)(blocks|handler|planner|prompts|edit|access|server|read|turnstile|vertex|claim|claim-server|mail-link)$|catalog-import|settings-import|lib\/medusa|lib\/supabase|server-only|@medusajs|@clerk\/nextjs\/server/

function valueImports(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...code.matchAll(/^import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
}

test('no browser module value-imports a server, validator or database module', () => {
  const seen: string[] = []
  const bad: string[] = []
  for (const file of CLIENT_FILES) {
    const imports = valueImports(read(file))
    seen.push(...imports)
    for (const spec of imports) if (HEAVY.test(spec)) bad.push(`${file} → ${spec}`)
  }
  // Not vacuous: the sweep saw a real set of imports, including the light ones it is meant to allow.
  expect(seen.length).toBeGreaterThan(20)
  expect(seen).toContain('@/lib/prompt-to-shop/constants')
  expect(bad).toEqual([])
})

test('the sweep itself can fail: a planted heavy import is caught', () => {
  expect(valueImports(`import { validateRows } from '@/lib/catalog-import'`).some((s) => HEAVY.test(s))).toBe(true)
  expect(valueImports(`import { MAX_DESCRIPTION_CHARS } from './blocks'`).some((s) => HEAVY.test(s))).toBe(true)
  expect(valueImports(`import type { IdentityBlock } from './blocks'`)).toEqual([])
})

test('the taking-shape screen is its own chunk, warmed when the merchant starts typing', () => {
  const box = read('app/(shell)/mx/vende/_components/DescribeBox.tsx')
  expect(box).toContain("dynamic(loadShaping, { ssr: false })")
  expect(box).toContain('onFocus={warmShaping}')
  expect(box).not.toMatch(/^import TakingShape /m)
})

test('the Turnstile script is loaded only by the widget, never site-wide', () => {
  const widget = read('app/(shell)/p2s/_components/TurnstileWidget.tsx')
  expect(widget).toContain('https://challenges.cloudflare.com/turnstile/v0/api.js')
  for (const file of ['app/layout.tsx', 'app/(shell)/layout.tsx', 'middleware.ts', 'next.config.ts']) {
    let src = ''
    try { src = read(file) } catch { continue }
    expect(src, file).not.toContain('challenges.cloudflare.com')
  }
})
