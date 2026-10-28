import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EDIT_COPY } from '../lib/prompt-to-shop/edit'
import { P2S_COPY } from '../lib/prompt-to-shop/handler'

// Prompt-to-shop S2.4 — the forbidden-word guard for screens 1-3 (describe, taking shape, canvas). The seed's UX
// contract: a merchant never reads «JSON», «CSV», «prompt», «agente», «borrador», «slug» or «SKU». It reads the
// COPY (JSX text, attribute text, string literals, the es.json strings the hero uses), not identifiers or comments,
// and it proves it looked: the scan asserts it found the files and a body of copy, and a negative control shows the
// scanner flags a planted offender.

const ROOT = process.cwd()
const FORBIDDEN = /\b(json|csv|prompts?|agentes?|borradors?|borradores|slugs?|skus?)\b/i

const SCREEN_FILES = [
  'app/(shell)/mx/vende/_components/DescribeBox.tsx',
  'app/(shell)/p2s/_components/TakingShape.tsx',
  'app/(shell)/p2s/_components/ShopCanvas.tsx',
  'app/(shell)/p2s/_components/ExampleIllustration.tsx',
  'app/(shell)/p2s/_components/OwnerCanvas.tsx',
  'app/(shell)/p2s/not-found.tsx',
  'app/(shell)/p2s/_components/KeepSheet.tsx',
  'app/(shell)/p2s/_components/ClaimRunner.tsx',
  'app/(shell)/p2s/_components/KeptShop.tsx',
  'app/(shell)/p2s/_components/OwnerSheet.tsx',
  'app/(shell)/p2s/_components/PhotoSheet.tsx',
  'app/(shell)/sell/armar/page.tsx',
  // S5: the cobros / entregas chooser, its page, and the moment after «Publicar».
  'app/(shell)/p2s/_components/CobrosChooser.tsx',
  'app/(shell)/p2s/_components/PublishedMoment.tsx',
  'app/(shell)/sell/armar/cobros/page.tsx',
  'lib/prompt-to-shop/copy.ts',
  'lib/prompt-to-shop/view.ts',
]

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

/** Everything a merchant can read in a source file: JSX text and every string literal that is not an import path. */
export function userFacingStrings(src: string): string[] {
  const code = stripComments(src).replace(/^\s*(import|export)\b[^\n]*\bfrom\s+['"][^'"]+['"];?\s*$/gm, '')
  const out: string[] = []
  for (const m of code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) out.push(m[1] ?? m[2] ?? m[3])
  for (const m of code.matchAll(/>([^<>{}]+)</g)) {
    const text = m[1].trim()
    // JSX text, not a generic or an expression that happens to sit between two angle brackets.
    if (text && /\p{L}/u.test(text) && !/[;=()]/.test(text)) out.push(text)
  }
  return out.filter((s) => s.trim().length > 0)
}

const offenders = (strings: string[]) => strings.filter((s) => FORBIDDEN.test(s))

test('the scan can fail: a planted offender in each shape is caught', () => {
  expect(offenders(userFacingStrings(`const a = 'Sube tu archivo CSV'`))).toHaveLength(1)
  expect(offenders(userFacingStrings(`<p>Tu borrador está listo</p>`))).toHaveLength(1)
  expect(offenders(userFacingStrings(`const t = \`Copia el prompt\``))).toHaveLength(1)
  expect(offenders(userFacingStrings(`<input placeholder="Tu slug" />`))).toHaveLength(1)
  // …and identifiers, comments and the SKU-free word «ejemplo» are not copy.
  expect(offenders(userFacingStrings(`// el slug del borrador en JSON\nconst slug = draft.slug; const x = 'ok'`))).toHaveLength(0)
})

test('screens 1-3 never show JSON, CSV, prompt, agente, borrador, slug or SKU', () => {
  const found: Record<string, string[]> = {}
  for (const file of SCREEN_FILES) found[file] = userFacingStrings(readFileSync(join(ROOT, file), 'utf8'))

  // Not vacuous: every file was really read and the scan saw real copy.
  for (const file of SCREEN_FILES) expect(found[file].length, `${file} yielded no strings`).toBeGreaterThan(0)
  const all = Object.values(found).flat()
  expect(all.length).toBeGreaterThan(80)
  for (const known of ['Cuéntanos qué vendes', 'Armar mi tienda', 'Otra versión', 'EJEMPLO', 'Guardado', 'Nombre', 'Compartir vista previa']) {
    expect(all, known).toContain(known)
  }

  expect(Object.entries(found).flatMap(([file, strings]) => offenders(strings).map((s) => `${file}: ${s}`))).toEqual([])
})

test('neither does the hero line, the page title, or the refusals the server sends a merchant', () => {
  const es = JSON.parse(readFileSync(join(ROOT, 'locales', 'es.json'), 'utf8')) as {
    sellerAcquisition: { anchor: { heroTitle: string; metadata: { title: string; description: string } } }
  }
  const anchor = es.sellerAcquisition.anchor
  const strings = [anchor.heroTitle, anchor.metadata.title, anchor.metadata.description, ...Object.values(P2S_COPY), ...Object.values(EDIT_COPY)]
  expect(strings.length).toBeGreaterThan(10)
  expect(offenders(strings)).toEqual([])
})
