/**
 * lib/cost-comparator-report.ts
 *
 * Comparador de costos (epic 08 · cost-comparator-homepage, Sprint 2 · US-2.1) — the
 * PURE report-markdown generator. Next-free/`server-only`-free, same discipline as
 * `lib/cost-comparator.ts` (this file's header explains why: the Playwright `api`
 * runner imports these directly, no framework in the require graph), so a unit spec
 * can hand it a fixed `StackedCost` pair + a fixed sources list and assert the EXACT
 * resulting markdown string byte-for-byte — no `Date.now()`, no randomness, nothing
 * the caller didn't pass in.
 *
 * Consumed by `ComparadorTool`'s "Exportar reporte" button, which builds this
 * markdown from the live on-screen stacks then pipes it through
 * `lib/smalldocs.ts` (client-only: compress + base64url into the `#md=` hash) to
 * open it on smalldocs.org. This file never touches compression or the URL — it
 * only ever returns a markdown string, which is what makes it unit-testable at all.
 *
 * Format decisions (verified against github.com/espressoplease/smalldocs,
 * 2026-07-17 — README.md + chart-gallery.md + CLI.md):
 *   - YAML front matter with a `styles.chart.accent` key set to Miyagi's brand
 *     green (the platform's `--color-accent` / `PLATFORM_OG_COLORS.accent` value,
 *     see the import below) — the documented `styles:` front-matter shape
 *     (CLI.md → "SmallDocs — Styles Schema").
 *   - A ```chart fenced block with a `"type":"bar"` payload — the exact JSON shape
 *     documented in chart-gallery.md's "Bar Charts" section (labels + values +
 *     format:"currency").
 *   - Story order: current spend → Miyagi equivalent → estimated saving → chart →
 *     suggested next step → sources (epic README + sprint-2.md acceptance).
 */

import type { StackedCost } from './cost-comparator'
import { formatMxn } from './cost-comparator'
// The platform's brand accent, sourced from the SAME constant the OG-image
// renderer uses (lib/platform-theme.ts's `PLATFORM_OG_COLORS.accent`) rather
// than a second hand-typed hex literal — one definition, no drift, and this
// file never contains a raw color literal of its own for the design-token
// guard (e2e/design-token-foundation.spec.ts) to catch.
import { PLATFORM_OG_COLORS } from './platform-theme'

export interface ComparatorReportSource {
  label: string
  source: string
  verifiedAt: string
}

/**
 * A rendered line whose figure was hand-edited by the visitor (US-1.3's inline
 * per-figure override) BEFORE this report was exported. `source`/`verifiedAt` are
 * optional — some lines (an aggregate like "apps", or Miyagi's definitionally-$0
 * commission line) have no single dataset figure backing them even before an edit.
 */
export interface ComparatorReportLineOverride {
  originalMxn: number
  source?: string
  verifiedAt?: string
}

export interface ComparatorReportInput {
  /** Human label for the competitor side, e.g. "Shopify (Plan Basic)". */
  platformLabel: string
  volumeMonthly: number
  aovMxn: number
  competitorStack: StackedCost
  miyagiStack: StackedCost
  /** The comparator dataset's overall verified date (`dataset.generatedAt`, ISO). */
  datasetVerifiedAt: string
  /** Every sourced figure that fed the two stacks above, deduped by figure —
   * caller-supplied (see `lib/cost-comparator-dataset.ts`'s `lineSourceFigureKey` +
   * `dataset.figures`) so this file stays a pure function of plain data. An
   * OVERRIDDEN line's figure key must NOT be in this list — see
   * `competitorOverrides`/`miyagiOverrides` below for why. */
  sources: ComparatorReportSource[]
  /** Lines in `competitorStack`/`miyagiStack`, keyed by `StackedCostLine.key`,
   * whose value was hand-edited by the visitor. HONESTY GUARANTEE: a hand-edited
   * figure is annotated inline as "editado por el usuario" instead of silently
   * inheriting the dataset's original source citation — an edited number was
   * never verified by that source, only the ORIGINAL number was. Omit or pass `{}`
   * when nothing was overridden. */
  competitorOverrides?: Record<string, ComparatorReportLineOverride>
  miyagiOverrides?: Record<string, ComparatorReportLineOverride>
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function lineList(stack: StackedCost, overrides: Record<string, ComparatorReportLineOverride> = {}): string {
  return stack.lines
    .map((l) => {
      const o = overrides[l.key]
      if (!o) return `- ${l.label}: ${formatMxn(l.monthlyMxn)}/mes`
      const citation = o.source ? `, fuente: ${o.source}, verificado: ${o.verifiedAt}` : ''
      return `- ${l.label}: ${formatMxn(l.monthlyMxn)}/mes (editado por el usuario — original: ${formatMxn(o.originalMxn)}/mes${citation})`
    })
    .join('\n')
}

function sourcesList(sources: ComparatorReportSource[]): string {
  if (sources.length === 0) {
    return '_Sin cifras de terceros en esta comparación — todo es cálculo derivado._'
  }
  return sources.map((s) => `- **${s.label}** — ${s.source} (verificado: ${s.verifiedAt})`).join('\n')
}

/** Deterministic: same input → byte-identical output, always. No wall-clock read. */
export function buildComparatorReportMarkdown(input: ComparatorReportInput): string {
  const {
    platformLabel, volumeMonthly, aovMxn, competitorStack, miyagiStack, datasetVerifiedAt, sources,
    competitorOverrides = {}, miyagiOverrides = {},
  } = input

  const savingMonthlyMxn = round2(competitorStack.monthlyTotalMxn - miyagiStack.monthlyTotalMxn)
  const savingAnnualMxn = round2(competitorStack.annualTotalMxn - miyagiStack.annualTotalMxn)

  const chart = {
    type: 'bar',
    title: 'Costo mensual: hoy vs. Miyagi Sánchez',
    labels: [platformLabel, 'Miyagi Sánchez'],
    values: [competitorStack.monthlyTotalMxn, miyagiStack.monthlyTotalMxn],
    format: 'currency',
  }

  return `---
title: "Comparador de costos: ${platformLabel} vs. Miyagi Sánchez"
styles:
  chart:
    accent: "${PLATFORM_OG_COLORS.accent}"
---

# Comparador de costos: ${platformLabel} vs. Miyagi Sánchez

Comparación generada en miyagisanchez.com/comparador — ${volumeMonthly} ventas/mes a un ticket promedio de ${formatMxn(aovMxn)}. Datos verificados: ${datasetVerifiedAt}.

## Lo que pagas hoy (${platformLabel})

${lineList(competitorStack, competitorOverrides)}

**Total mensual:** ${formatMxn(competitorStack.monthlyTotalMxn)} · **Total anual:** ${formatMxn(competitorStack.annualTotalMxn)}

## Equivalente en Miyagi Sánchez (0% comisión)

${lineList(miyagiStack, miyagiOverrides)}

**Total mensual:** ${formatMxn(miyagiStack.monthlyTotalMxn)} · **Total anual:** ${formatMxn(miyagiStack.annualTotalMxn)}

## Ahorro estimado

**${formatMxn(savingMonthlyMxn)}/mes** — **${formatMxn(savingAnnualMxn)}/año**

\`\`\`chart
${JSON.stringify(chart)}
\`\`\`

## Siguiente paso sugerido

Migrar de ${platformLabel} a Miyagi Sánchez no cuesta comisión y tus apps premium ya vienen incluidas. Visita miyagisanchez.com para empezar, o pídele a tu agente de IA que revise miyagisanchez.com/agent para automatizar la configuración de tu tienda.

## Fuentes

${sourcesList(sources)}

---

_Generado con el [Comparador de costos — Miyagi Sánchez](https://miyagisanchez.com/comparador). Las tarifas cambian: confírmalas antes de decidir._
`
}
