import { expect, test } from '@playwright/test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * pricing-page S1.1 — the price SOURCE SWEEP (README D8). A hand-typed MXN price in public copy
 * is how `/acerca` drifted from the price modules (two copies, already disagreeing). In the swept
 * files a price may only enter copy as a `{token}` filled from `lib/pricing-catalog.ts`.
 *
 * The gate covers exactly the ENFORCED paths below (LEARNINGS: a hard gate covers what a sweep
 * actually swept, not the whole tree). Extend the list as more surfaces move to the catalog.
 *
 * It must never reject correct output (LEARNINGS: allow the negation of what you ban) — so the
 * allowed cases are pinned as passing tests too: `{token}`s, USD figures, and competitor figures
 * or worked examples under an explicit, reasoned JSON-path allow-list.
 */

const ROOT = new URL('..', import.meta.url).pathname

const ENFORCED_JSON = ['locales/es.json', 'locales/en.json']
const ENFORCED_SOURCE = [
  'lib/about-content.ts',
  'app/(shell)/mx/vende/_components/page-config.ts',
  'app/(shell)/mx/precios',
]

/** JSON paths whose prices are NOT ours — each with its reason. */
const ALLOWED_PATH_PREFIXES: Array<{ prefix: string; reason: string }> = [
  { prefix: 'sellerAcquisition.anchor.benchmark.', reason: 'competitor figures and the worked "$1,000 MXN product" example' },
  { prefix: 'partnersRecruiting.landing.benchmark.', reason: 'competitor plan prices' },
  { prefix: 'partnersRecruiting.landing.heroLead', reason: "Shopify's monthly fee (en: \"$39 a month\"; es spells it in dollars)" },
]

// `$199 MXN`, `$1,499 MXN`, `$25/mes`, `$499/año`, `$17/mo`, `$199 al año` — a typed MXN price.
const MXN_PRICE = /\$\s?\d[\d,.]*\s?(?:MXN\b|\/\s?(?:año|mes|year|yr|mo|month)\b|al (?:año|mes)\b|a (?:year|month)\b)/i

/** A string that states a typed MXN price — USD figures and `{token}`s are not ours to ban. */
export function typedMxnPrice(text: string): string | null {
  if (/\bUSD\b/.test(text)) return null
  const m = text.match(MXN_PRICE)
  return m ? m[0] : null
}

function isAllowedPath(path: string): boolean {
  return ALLOWED_PATH_PREFIXES.some((a) => path.startsWith(a.prefix))
}

function* jsonStrings(node: unknown, path: string): Generator<[string, string]> {
  if (typeof node === 'string') yield [path, node]
  else if (Array.isArray(node)) for (const [i, v] of node.entries()) yield* jsonStrings(v, `${path}[${i}]`)
  else if (node && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) yield* jsonStrings(v, path ? `${path}.${k}` : k)
}

export function sweepJson(json: unknown): string[] {
  const hits: string[] = []
  for (const [path, text] of jsonStrings(json, '')) {
    if (isAllowedPath(path)) continue
    const hit = typedMxnPrice(text)
    if (hit) hits.push(`${path}: "${hit}"`)
  }
  return hits
}

/** Source files: every string/template literal line is checked (comments carry no copy). */
export function sweepSource(source: string): string[] {
  const hits: string[] = []
  for (const [i, line] of source.split('\n').entries()) {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    const hit = typedMxnPrice(line)
    if (hit) hits.push(`line ${i + 1}: "${hit}"`)
  }
  return hits
}

function filesUnder(rel: string): string[] {
  const abs = join(ROOT, rel)
  if (!statSync(abs).isDirectory()) return [rel]
  return readdirSync(abs).flatMap((name) => filesUnder(join(rel, name)))
}

test.describe('pricing source sweep', () => {
  for (const rel of ENFORCED_JSON) {
    test(`${rel} has no typed MXN price outside the allow-list`, () => {
      expect(sweepJson(JSON.parse(readFileSync(join(ROOT, rel), 'utf8')))).toEqual([])
    })
  }

  for (const rel of ENFORCED_SOURCE.flatMap(filesUnder).filter((f) => /\.(ts|tsx)$/.test(f))) {
    test(`${rel} has no typed MXN price`, () => {
      expect(sweepSource(readFileSync(join(ROOT, rel), 'utf8'))).toEqual([])
    })
  }

  test('every allow-list entry still matches something (no dead exemptions)', () => {
    const es = JSON.parse(readFileSync(join(ROOT, 'locales/es.json'), 'utf8'))
    const paths = [...jsonStrings(es, '')].map(([p]) => p)
    for (const a of ALLOWED_PATH_PREFIXES) expect(paths.some((p) => p.startsWith(a.prefix)), a.prefix).toBe(true)
  })
})

test.describe('pricing source sweep — what it catches and what it allows', () => {
  test('catches the shapes the drift took', () => {
    for (const s of ['Dominio propio: $499 MXN/año', '$25/mes', '$199 MXN al año', '$1,499 MXN', '$17/mo']) {
      expect(typedMxnPrice(s), s).not.toBeNull()
    }
    expect(sweepJson({ acerca: { sections: { pricing: { body: ['Sub: $199 MXN/año'] } } } })).toHaveLength(1)
  })

  test('allows the negation: tokens, USD, non-price numbers and allow-listed competitor figures', () => {
    for (const s of ['Subdominio: {subdomainPrice}', '$39 USD/mes Basic', '0% de comisión', 'hasta 150 productos', '`$${price}`']) {
      expect(typedMxnPrice(s), s).toBeNull()
    }
    expect(sweepJson({ sellerAcquisition: { anchor: { benchmark: { rows: [{ cells: ['~3.5% + $3 MXN por transacción'] }] } } } })).toEqual([])
  })

  test('ignores comments in source, catches string literals', () => {
    expect(sweepSource("// was '$199 MXN/año' before the catalog")).toEqual([])
    expect(sweepSource("const x = '$199 MXN/año'")).toHaveLength(1)
  })
})
