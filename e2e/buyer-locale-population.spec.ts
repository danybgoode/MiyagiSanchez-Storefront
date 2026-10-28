import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import {
  NON_BUYER_SUBTREES,
  deriveBuyerLocalePopulation,
  hardcodedPresentationCandidates,
  literalUiCandidates,
  serializeBuyerLocalePopulation,
} from '../scripts/derive-buyer-locale-population'

const ROOT = path.resolve(import.meta.dirname, '..')

test.describe('buyer locale population · generated, never hand-counted', () => {
  test('the direct buyer population is re-derived and remains non-empty', () => {
    const population = deriveBuyerLocalePopulation(ROOT)
    // 76 → 93 → 95. Living Shop (epic 07) added the Wall components and nine section
    // routes (/tienda, /colecciones, /eventos × three channel forms), AND widened
    // DIRECT_BUYER_DIRS to the owned-host root routes — which had never been
    // scanned at all, and were hiding a real bilingual leak on /acerca. The public-read
    // extraction added the two rich renderer files without changing the surfaces.
    // → 99: the share kit's catalog page (share-kit S1.2) — its body and four channel routes (/mx, /s, /us, owned host), the owned-host
    // `/catalogo` root joining DIRECT_BUYER_DIRS beside `/tienda`.
    expect(population.direct.length).toBe(99)
    expect(population.direct).toContain('app/(shell)/mx/l/page.tsx')
    expect(population.direct).toContain('app/(shell)/checkout/CheckoutExperience.tsx')
    expect(population.direct).toContain('app/(shell)/s/[slug]/tienda/page.tsx')
    expect(population.direct).toContain('app/(shell)/eventos/page.tsx')
  })

  test('the seller-acquisition family and its pricing page are the named non-buyer subtrees, and they are excluded', () => {
    // `/mx/vende` moved to `/mx/vende`, which put the es-MX seller-acquisition pages
    // inside `app/(shell)/mx` — a buyer scan root. They are excluded by name, not by
    // accident, and this pins BOTH halves: the exclusion list stays a single entry, and
    // the population it produces contains none of those files. Widening the list to
    // silence a future violation now costs a visible edit here.
    expect([...NON_BUYER_SUBTREES]).toEqual(['app/(shell)/mx/vende', 'app/(shell)/mx/precios'])

    const population = deriveBuyerLocalePopulation(ROOT)
    expect(population.direct.filter((file) => file.startsWith('app/(shell)/mx/vende/'))).toEqual([])
    // The sibling buyer routes under the same root are still scanned — an exclusion
    // that swallowed `app/(shell)/mx` wholesale would pass the assertion above and
    // silently stop guarding the browse and shop pages.
    expect(population.direct).toContain('app/(shell)/mx/l/page.tsx')
    expect(population.direct).toContain('app/(shell)/mx/s/[slug]/page.tsx')
  })

  test('the checked manifest is byte-identical to a fresh derivation', () => {
    const expected = serializeBuyerLocalePopulation(deriveBuyerLocalePopulation(ROOT))
    const checked = readFileSync(path.join(ROOT, 'locales/buyer-population.json'), 'utf8')
    expect(checked).toBe(expected)
  })

  test('both active marketplace roots and the literal US adapters are in the buyer population', () => {
    const population = deriveBuyerLocalePopulation(ROOT)
    expect(population.marketRoots).toEqual([
      'app/(mx-site)/mx/page.tsx',
      'app/(us-site)/us/page.tsx',
    ])
    expect(population.direct).toContain('app/(us-shell)/us/l/page.tsx')
    expect(population.direct).toContain('app/(us-shell)/us/s/[slug]/page.tsx')
  })

  test('every render-closure file is classified exactly once', () => {
    const population = deriveBuyerLocalePopulation(ROOT)
    const classified = [
      ...population.copyClassification.dictionaryConsuming,
      ...population.copyClassification.noLiteralUiCopy,
      ...population.copyClassification.needsExtraction.map(({ file }) => file),
    ].sort()
    expect(classified).toEqual(population.closure)
    expect(new Set(classified).size).toBe(classified.length)
  })

  test('the only literal exemption is the referral URL template, named exactly', () => {
    const population = deriveBuyerLocalePopulation(ROOT)
    expect(population.copyClassification.explicitExemptions).toEqual([{
      file: 'app/(shell)/account/referrals/ReferralsClient.tsx',
      candidates: ['{0}/?ref={1}'],
      reason: 'technical_url_template',
    }])
  })

  test('the buyer render closure has no unlocalized literal UI copy', () => {
    const population = deriveBuyerLocalePopulation(ROOT)
    expect(population.copyClassification.needsExtraction).toEqual([])
  })

  test('classification follows rendered literals through expressions instead of accepting source-level evasions', () => {
    const source = `
      const HOISTED = 'Comprar ahora'
      const STATE = true ? 'Cargando…' : 'Enviar oferta'
      export function Fixture({ status }: { status: string }) {
        return <><button>{status === 'paid' ? HOISTED : STATE}</button><style>{\`button { color: red; }\`}</style></>
      }
    `
    expect(literalUiCandidates(source)).toEqual(['Cargando…', 'Comprar ahora', 'Enviar oferta'])
  })

  test('buyer presentation formatting has no hardcoded Mexico locale or timezone', () => {
    const population = deriveBuyerLocalePopulation(ROOT)
    expect(population.presentationFormatting.explicitExemptions).toEqual([])
    expect(population.presentationFormatting.hardcoded).toEqual([])
  })

  test('presentation guard recognizes Intl, toLocale, and timezone evasions', () => {
    const source = `
      const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' })
      const date = value.toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' })
    `
    expect(hardcodedPresentationCandidates(source)).toEqual([
      "Intl.NumberFormat('es-MX')",
      "timeZone: 'America/Mexico_City'",
      "value.toLocaleDateString('es-MX')",
    ])
  })
})
