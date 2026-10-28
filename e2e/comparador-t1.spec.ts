import { expect, test } from '@playwright/test'
import { computeT1Cost, formatMxn, type T1Rates } from '../lib/cost-comparator'
import { t1RatesFromDataset, lineSourceFigureKey, type ComparatorDataset } from '../lib/cost-comparator-dataset'
import { buildComparadorShareParams, parseComparadorState, searchParamsToRecord } from '../lib/cost-comparator-url'
import dataset from '../lib/cost-comparator-dataset.json' with { type: 'json' }

/**
 * pricing-page S2 — T1 in the comparador (README A1/A2, verified against t1.com/mx/precios
 * 2026-10-28). Pure cost function, the URL codec and the server-rendered prefill.
 */

const RATES: T1Rates = {
  planMonthlyMxn: { basico: 399, avanzado: 1499 },
  t1PagosPct: 3.5,
  t1PagosFixedMxn: 1,
  externalPct: { basico: 2, avanzado: 1 },
}
const INPUTS = { volumeMonthly: 100, aovMxn: 500 }

test.describe('computeT1Cost', () => {
  test('Básico on T1pagos: plan + 3.5% + $1 per sale', () => {
    const r = computeT1Cost(INPUTS, 'basico', true, RATES)
    // 50,000 revenue × 3.5% = 1,750 + 100 × $1 = 1,850; + 399 plan.
    expect(r.lines.find((l) => l.key === 'payment')?.monthlyMxn).toBe(1850)
    expect(r.monthlyTotalMxn).toBe(2249)
    expect(r.annualTotalMxn).toBe(26988)
  })

  test('external provider: T1 takes its own cut by tier, no fixed fee', () => {
    expect(computeT1Cost(INPUTS, 'basico', false, RATES).lines.find((l) => l.key === 'payment')?.monthlyMxn).toBe(1000)
    expect(computeT1Cost(INPUTS, 'avanzado', false, RATES).lines.find((l) => l.key === 'payment')?.monthlyMxn).toBe(500)
    expect(computeT1Cost(INPUTS, 'avanzado', false, RATES).monthlyTotalMxn).toBe(1999)
  })

  test('apps carry through; zero volume costs only the plan', () => {
    expect(computeT1Cost(INPUTS, 'basico', true, RATES, 300).monthlyTotalMxn).toBe(2549)
    expect(computeT1Cost({ volumeMonthly: 0, aovMxn: 500 }, 'avanzado', true, RATES).monthlyTotalMxn).toBe(1499)
  })

  test('the dataset carries exactly the verified T1 figures, each cited to t1.com', () => {
    const ds = dataset as ComparatorDataset
    expect(t1RatesFromDataset(ds)).toEqual(RATES)
    for (const [key, fig] of Object.entries(ds.figures).filter(([k]) => k.startsWith('t1.'))) {
      expect(fig.source, key).toBe('https://t1.com/mx/precios')
      expect(fig.verifiedAt, key).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    expect(lineSourceFigureKey('t1', 'payment', { t1Tier: 'avanzado', t1Pagos: false })).toBe('t1.external.avanzado.pct')
    expect(lineSourceFigureKey('t1', 'payment', { t1Tier: 'basico', t1Pagos: true })).toBe('t1.t1pagos.pct')
  })
})

test.describe('T1 in the URL codec', () => {
  test('round-trips tier + external gateway', () => {
    const state = parseComparadorState({ platform: 't1', tier: 'avanzado', gateway: 'external', volume: '80', aov: '650' }, [])
    expect([state.platform, state.t1Tier, state.t1Pagos, state.volume, state.aov]).toEqual(['t1', 'avanzado', false, 80, 650])
    const again = parseComparadorState(searchParamsToRecord(buildComparadorShareParams(state)), [])
    expect(again).toEqual(state)
  })

  test("T1's free plan is not a tier: tier=gratis falls back to Básico; another platform's tier never bleeds in", () => {
    expect(parseComparadorState({ platform: 't1', tier: 'gratis' }, []).t1Tier).toBe('basico')
    expect(parseComparadorState({ platform: 'shopify', tier: 'avanzado' }, []).t1Tier).toBe('basico')
    expect(parseComparadorState({ platform: 'tiendanube', gateway: 'external' }, []).t1Pagos).toBe(true)
  })
})

test.describe('/comparador?platform=t1 · server HTML', () => {
  test('renders T1 selected with its totals in the initial HTML', async ({ request }) => {
    const res = await request.get('/comparador?platform=t1&tier=basico&volume=100&aov=500', { headers: { Accept: 'text/html' } })
    expect(res.ok()).toBeTruthy()
    const html = await res.text()
    const platformSelect = html.match(/<select[^>]*data-testid="comparador-platform-select"[^>]*>[\s\S]*?<\/select>/)?.[0] ?? ''
    expect(platformSelect).toContain('<option value="t1" selected')
    const tierSelect = html.match(/<select[^>]*data-testid="comparador-t1-tier-select"[^>]*>[\s\S]*?<\/select>/)?.[0] ?? ''
    expect(tierSelect).toContain('<option value="basico" selected')
    expect(tierSelect).not.toContain('value="gratis"')
    expect(html).toContain('data-testid="comparador-t1-free-note"')
    const total = html.match(/data-testid="comparador-monthly-competitor-total"[^>]*>([^<]+)/)?.[1] ?? ''
    const expected = computeT1Cost(INPUTS, 'basico', true, t1RatesFromDataset(dataset as ComparatorDataset)).monthlyTotalMxn
    expect(total).toBe(formatMxn(expected))
  })
})
