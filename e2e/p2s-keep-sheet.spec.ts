import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// business-infrastructure S1.1 — «Quedármela» opened its sign-up sheet BELOW the button, unreachable by scrolling, and
// the keep bar only showed at the very bottom of the page. One cause: `globals.css` set
// `.platform-main-shell > :not(.platform-theme-spot) { position: relative }` UNLAYERED, and unlayered CSS beats
// Tailwind's `@layer utilities` whatever the specificity — so every direct child of the main shell that asked for
// `fixed` or `sticky` became `relative`. Reproduced in a real browser at 390×844 and 1280×800 (sheet top 661px in an
// 844px viewport, computed position `relative`) and fixed there (sheet 0→844, keep bar bottom = viewport bottom).
//
// A browser spec cannot reach a draft page (it needs a real draft row and its device cookie on the deployed host),
// so the two load-bearing facts are held at the source, like `p2s-keep.spec.ts` holds the Clerk wiring.

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '')

/** The `@layer` name enclosing `index` in `css`, or null when the position is unlayered. Brace-counting is enough for
 *  this file: it has no braces inside strings. */
function enclosingLayer(css: string, index: number): string | null {
  const stack: Array<string | null> = []
  const re = /(@layer\s+([\w-]+)\s*\{)|(\{)|(\})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) && m.index < index) {
    if (m[1]) stack.push(m[2])
    else if (m[3]) stack.push(null)
    else stack.pop()
  }
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i]) return stack[i]
  return null
}

test('every rule that positions the main shell\'s children is layered, so position utilities win', () => {
  const css = stripComments(read('app/globals.css'))
  // `position` OR `z-index`: an unlayered z-index on these children would silently override every `z-*` utility the
  // same way the position did.
  const rule = /\.platform-main-shell\s*>[^{]*\{[^}]*\b(?:position|z-index)\s*:/g
  const hits = [...css.matchAll(rule)]
  // Guard the population, not the one rule we found: any such rule, now or later, must sit in a layer below utilities.
  expect(hits.length).toBeGreaterThan(0)
  for (const hit of hits) {
    const layer = enclosingLayer(css, hit.index!)
    expect(layer, `unlayered rule: ${hit[0].slice(0, 80)}`).not.toBeNull()
    expect(['base', 'components']).toContain(layer)
  }
})

test('the layer helper tells layered from unlayered', () => {
  const css = '.a{x:1} @layer components { .b > c { position: relative } } .d > e { position: relative }'
  expect(enclosingLayer(css, css.indexOf('.b'))).toBe('components')
  expect(enclosingLayer(css, css.indexOf('.d'))).toBeNull()
})

for (const file of ['app/(shell)/p2s/_components/KeepSheet.tsx', 'app/(shell)/p2s/_components/OwnerSheet.tsx', 'app/(shell)/p2s/_components/TakingShape.tsx']) {
  test(`${file.split('/').pop()} mounts its overlay on document.body, above the isolated main shell`, () => {
    const src = read(file)
    expect(src).toMatch(/import BodyPortal from '@\/components\/ui\/BodyPortal'/)
    // The fixed overlay is the portal's first child, and it asks for the overlay z-index, not a page-local one.
    expect(src).toMatch(/<BodyPortal>\s*<div className="fixed inset-0[^"]*"\s+style=\{\{ zIndex: 'var\(--z-overlay\)'/)
  })
}

test('BodyPortal renders into document.body and nothing on the server', () => {
  const src = read('components/ui/BodyPortal.tsx')
  expect(src).toMatch(/createPortal\(children, document\.body\)/)
  expect(src).toMatch(/useSyncExternalStore\(subscribe, onClient, onServer\)/)
})
