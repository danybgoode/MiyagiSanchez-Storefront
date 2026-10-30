import { expect, test } from '@playwright/test'
import { computeShopifyCost, computeMiyagiCost, type ShopifyRates, type MiyagiRates } from '../lib/cost-comparator'
import { buildComparatorReportMarkdown, type ComparatorReportSource } from '../lib/cost-comparator-report'

// Comparador de costos (epic 08 · cost-comparator-homepage, Sprint 2 · US-2.1) — the
// md-generator unit spec sprint-2.md requires: a FIXED input must produce the EXACT
// markdown string, byte for byte. Synthetic rates (not the real dataset) so this
// spec never drifts when a competitor re-prices — same discipline as
// cost-comparator.spec.ts.

test.describe('cost-comparator-report · buildComparatorReportMarkdown', () => {
  const shopifyRates: ShopifyRates = {
    planMonthlyUsd: { basico: 20, crecimiento: 50, avanzado: 400 },
    paymentPct: { basico: 3, crecimiento: 2, avanzado: 1 },
    paymentFixedMxn: 2,
    fxUsdToMxn: 20,
  }
  const miyagiRates: MiyagiRates = {
    subdomainMonthlyMxn: 25,
    customDomainMonthlyMxn: 42,
    mlSyncMonthlyMxn: 30,
    paymentPct: 3.6,
    paymentFixedMxn: 3,
  }
  const inputs = { volumeMonthly: 10, aovMxn: 100 }

  const competitorStack = computeShopifyCost(inputs, 'basico', shopifyRates)
  const miyagiStack = computeMiyagiCost(inputs, { subdomain: false, customDomain: false, mlSync: false }, miyagiRates)

  const sources: ComparatorReportSource[] = [
    { label: 'Plan Basic mensual', source: 'shopify.com/pricing', verifiedAt: '2026-07-01' },
    { label: 'Tarifa de pago Basic', source: 'shopify.com/pricing', verifiedAt: '2026-07-01' },
  ]

  test('a fixed input produces the exact markdown, byte for byte', () => {
    const md = buildComparatorReportMarkdown({
      platformLabel: 'Shopify (Plan Basic)',
      volumeMonthly: inputs.volumeMonthly,
      aovMxn: inputs.aovMxn,
      competitorStack,
      miyagiStack,
      datasetVerifiedAt: '2026-07-01',
      sources,
    })

    const expected = `---
title: "Comparador de costos: Shopify (Plan Basic) vs. Miyagi Sánchez"
styles:
  chart:
    accent: "#1d6f42"
---

# Comparador de costos: Shopify (Plan Basic) vs. Miyagi Sánchez

Comparación generada en miyagisanchez.com/comparador — 10 ventas/mes a un ticket promedio de $100.00. Datos verificados: 2026-07-01.

## Lo que pagas hoy (Shopify (Plan Basic))

- Plan mensual: $400.00/mes
- Procesamiento de pago: $50.00/mes
- Apps premium: $0.00/mes

**Total mensual:** $450.00 · **Total anual:** $5,400.00

## Equivalente en Miyagi Sánchez (0% comisión)

- Comisión de plataforma (0%): $0.00/mes
- Procesamiento de pago (tu pasarela): $66.00/mes
- Apps premium (incluidas): $0.00/mes

**Total mensual:** $66.00 · **Total anual:** $792.00

## Ahorro estimado

**$384.00/mes** — **$4,608.00/año**

\`\`\`chart
{"type":"bar","title":"Costo mensual: hoy vs. Miyagi Sánchez","labels":["Shopify (Plan Basic)","Miyagi Sánchez"],"values":[450,66],"format":"currency"}
\`\`\`

## Siguiente paso sugerido

Migrar de Shopify (Plan Basic) a Miyagi Sánchez no cuesta comisión y tus apps premium ya vienen incluidas. Visita miyagisanchez.com para empezar, o pídele a tu agente de IA que revise miyagisanchez.com/agent para automatizar la configuración de tu tienda.

## Fuentes

- **Plan Basic mensual** — shopify.com/pricing (verificado: 2026-07-01)
- **Tarifa de pago Basic** — shopify.com/pricing (verificado: 2026-07-01)

---

_Generado con el [Comparador de costos — Miyagi Sánchez](https://miyagisanchez.com/comparador). Las tarifas cambian: confírmalas antes de decidir._
`

    expect(md).toBe(expected)
  })

  test('no sources → an honest "no third-party figures" line, not a blank section', () => {
    const md = buildComparatorReportMarkdown({
      platformLabel: 'Shopify (Plan Basic)',
      volumeMonthly: inputs.volumeMonthly,
      aovMxn: inputs.aovMxn,
      competitorStack,
      miyagiStack,
      datasetVerifiedAt: '2026-07-01',
      sources: [],
    })
    expect(md).toContain('_Sin cifras de terceros en esta comparación')
  })

  test('the chart fenced block is valid JSON matching smalldocs\' documented bar-chart shape', () => {
    const md = buildComparatorReportMarkdown({
      platformLabel: 'Shopify (Plan Basic)',
      volumeMonthly: inputs.volumeMonthly,
      aovMxn: inputs.aovMxn,
      competitorStack,
      miyagiStack,
      datasetVerifiedAt: '2026-07-01',
      sources,
    })
    const match = md.match(/```chart\n([\s\S]*?)\n```/)
    expect(match).not.toBeNull()
    const chart = JSON.parse(match![1])
    expect(chart.type).toBe('bar')
    expect(chart.labels).toEqual(['Shopify (Plan Basic)', 'Miyagi Sánchez'])
    expect(chart.values).toEqual([450, 66])
    expect(chart.format).toBe('currency')
  })
})

// BLOCKING codex finding, PR #278 — a hand-edited (US-1.3 inline override) figure
// must NEVER read as if the original dataset citation still verifies it. The
// caller (ComparadorTool.tsx) is responsible for EXCLUDING an overridden line's
// figure key from `sources` — this spec proves the pure generator itself does its
// half: annotates the edited line honestly, with or without a known source.
test.describe('cost-comparator-report · overridden lines never inherit the original source silently', () => {
  const shopifyRates: ShopifyRates = {
    planMonthlyUsd: { basico: 20, crecimiento: 50, avanzado: 400 },
    paymentPct: { basico: 3, crecimiento: 2, avanzado: 1 },
    paymentFixedMxn: 2,
    fxUsdToMxn: 20,
  }
  const miyagiRates: MiyagiRates = {
    subdomainMonthlyMxn: 25, customDomainMonthlyMxn: 42, mlSyncMonthlyMxn: 30, paymentPct: 3.6, paymentFixedMxn: 3,
  }
  const inputs = { volumeMonthly: 10, aovMxn: 100 }
  const competitorStack = computeShopifyCost(inputs, 'basico', shopifyRates)
  const miyagiStack = computeMiyagiCost(inputs, { subdomain: false, customDomain: false, mlSync: false }, miyagiRates)

  test('an overridden competitor line is annotated "editado por el usuario" with its ORIGINAL value + source — not cited as if it verifies the new number', () => {
    // Simulate the visitor having hand-edited the "plan" line to $999.99 — the
    // caller passes the ORIGINAL $400 + its source as the override annotation,
    // and (per the caller's own contract) would NOT put shopify.plan's key in
    // `sources` anymore.
    const editedCompetitorStack = { ...competitorStack, lines: competitorStack.lines.map((l) => (l.key === 'plan' ? { ...l, monthlyMxn: 999.99 } : l)) }
    const md = buildComparatorReportMarkdown({
      platformLabel: 'Shopify (Plan Basic)',
      volumeMonthly: inputs.volumeMonthly,
      aovMxn: inputs.aovMxn,
      competitorStack: editedCompetitorStack,
      miyagiStack,
      datasetVerifiedAt: '2026-07-01',
      sources: [], // the "plan" figure's source is deliberately NOT here anymore
      competitorOverrides: { plan: { originalMxn: 400, source: 'shopify.com/pricing', verifiedAt: '2026-07-01' } },
    })
    expect(md).toContain('- Plan mensual: $999.99/mes (editado por el usuario — original: $400.00/mes, fuente: shopify.com/pricing, verificado: 2026-07-01)')
    // The Fuentes section has nothing to cite for this run (caller passed no sources).
    expect(md).toContain('_Sin cifras de terceros en esta comparación')
  })

  test('an overridden line with NO known dataset source still gets the honest "editado" annotation, without inventing a citation', () => {
    const editedMiyagiStack = { ...miyagiStack, lines: miyagiStack.lines.map((l) => (l.key === 'commission' ? { ...l, monthlyMxn: 50 } : l)) }
    const md = buildComparatorReportMarkdown({
      platformLabel: 'Shopify (Plan Basic)',
      volumeMonthly: inputs.volumeMonthly,
      aovMxn: inputs.aovMxn,
      competitorStack,
      miyagiStack: editedMiyagiStack,
      datasetVerifiedAt: '2026-07-01',
      sources: [],
      miyagiOverrides: { commission: { originalMxn: 0 } }, // no source/verifiedAt — Miyagi's 0% has none
    })
    expect(md).toContain('- Comisión de plataforma (0%): $50.00/mes (editado por el usuario — original: $0.00/mes)')
    expect(md).not.toContain('fuente:') // no fabricated citation
  })

  test('a NON-overridden line is unaffected — no annotation, plain figure', () => {
    const md = buildComparatorReportMarkdown({
      platformLabel: 'Shopify (Plan Basic)',
      volumeMonthly: inputs.volumeMonthly,
      aovMxn: inputs.aovMxn,
      competitorStack,
      miyagiStack,
      datasetVerifiedAt: '2026-07-01',
      sources: [],
      competitorOverrides: {},
    })
    expect(md).toContain('- Plan mensual: $400.00/mes\n')
    expect(md).not.toContain('editado por el usuario')
  })
})
