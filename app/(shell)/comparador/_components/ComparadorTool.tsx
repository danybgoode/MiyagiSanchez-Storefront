'use client'

import { useMemo, useState } from 'react'
import {
  computeShopifyCost,
  computeMercadoLibreCost,
  computeWooCommerceCost,
  computeTiendanubeCost,
  computeT1Cost,
  computeMiyagiCost,
  computeSelectedAppsMonthlyMxn,
  applyLineOverrides,
  formatMxn,
  type ShopifyRates,
  type MercadoLibreRates,
  type WooCommerceRates,
  type TiendanubeRates,
  type T1Rates,
  type MiyagiRates,
  type ShopifyTier,
  type MlBand,
  type MlPublicationType,
  type WooCommerceHostingTier,
  type TiendanubeTier,
  type T1Tier,
  type PremiumAppOption,
  type StackedCost,
} from '@/lib/cost-comparator'
import { lineSourceHint, lineSourceFigureKey, type ComparatorDataset } from '@/lib/cost-comparator-dataset'
import {
  buildComparatorReportMarkdown,
  type ComparatorReportSource,
  type ComparatorReportLineOverride,
} from '@/lib/cost-comparator-report'
import { buildSmalldocsUrl } from '@/lib/smalldocs'
import {
  buildComparadorShareParams,
  type CompetitorPlatform,
  type ComparadorMiyagiSkus,
} from '@/lib/cost-comparator-url'
import type { ShopAnalyzerResult } from '@/lib/shop-url-analyzer'
import { pushAnalyticsEvent } from '@/lib/analytics-events'

export type { CompetitorPlatform }

/** Natural es-MX pluralization for a count + noun pair — "1 producto" /
 *  "2 productos", never the `producto(s)` shorthand (review catch, S3). */
function pluralEs(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

const PLATFORM_LABELS: Record<CompetitorPlatform, string> = {
  shopify: 'Shopify',
  mercadolibre: 'Mercado Libre',
  woocommerce: 'WooCommerce',
  tiendanube: 'Tiendanube',
  t1: 'T1',
}

// "Basic" / "Grow" / "Advanced" are Shopify's own plan brand names (unchanged
// even on Shopify's own es-MX pricing page) — they stay as-is per AGENTS rule 5
// ("brand names stay as-is"), presented as "Plan <Nombre>" so they read as a
// proper-noun plan name rather than a stray English word.
const SHOPIFY_TIER_LABELS: Record<ShopifyTier, string> = {
  basico: 'Plan Basic (~$19 USD/mes)',
  crecimiento: 'Plan Grow (~$52 USD/mes)',
  avanzado: 'Plan Advanced (~$399 USD/mes)',
}

const ML_BAND_LABELS: Record<MlBand, string> = {
  baja: 'Comisión baja (ej. electrónica)',
  media: 'Comisión media (ej. hogar)',
  alta: 'Comisión alta (ej. ropa, joyería)',
}

const WOO_TIER_LABELS: Record<WooCommerceHostingTier, string> = {
  entrada: 'Alojamiento de entrada (~$19 USD/mes)',
  crecimiento: 'Alojamiento de crecimiento (~$28 USD/mes)',
}

const TN_TIER_LABELS: Record<TiendanubeTier, string> = {
  gratis: 'Gratis',
  basico: 'Básico ($149 MXN/mes)',
  tiendanube: 'Tiendanube ($374 MXN/mes)',
  avanzado: 'Avanzado ($999 MXN/mes)',
}

// T1's free plan has no online store (pricing-page A1) — only the two plans that can sell.
const T1_TIER_LABELS: Record<T1Tier, string> = {
  basico: 'Básico ($399 MXN/mes)',
  avanzado: 'Avanzado ($1,499 MXN/mes)',
}

// US-2.2 — the SAME shape lib/cost-comparator-url.ts's ComparadorState codec
// builds/parses, so the page's SSR prefill and this component's "Copiar enlace"
// share button can never drift on which fields exist.
export interface ComparadorInitial {
  platform: CompetitorPlatform
  shopifyTier: ShopifyTier
  mlBand: MlBand
  mlPublicationType: MlPublicationType
  wooTier: WooCommerceHostingTier
  tnTier: TiendanubeTier
  tnOwnGateway: boolean
  t1Tier: T1Tier
  t1Pagos: boolean
  volume: number
  aov: number
  selectedAppIds: string[]
  miyagiSkus: ComparadorMiyagiSkus
  lineOverrides: Record<string, number>
}

export interface ComparadorRates {
  shopify: ShopifyRates
  mercadolibre: MercadoLibreRates
  woocommerce: WooCommerceRates
  tiendanube: TiendanubeRates
  t1: T1Rates
  miyagi: MiyagiRates
}

interface ComparadorToolProps {
  rates: ComparadorRates
  apps: PremiumAppOption[]
  fx: number
  initial: ComparadorInitial
  dataset: ComparatorDataset
}

function EditableLine({
  testId,
  label,
  value,
  original,
  sourceHint,
  onChange,
}: {
  testId: string
  label: string
  value: number
  original: number
  sourceHint: string
  onChange: (next: number) => void
}) {
  const overridden = Math.round(value * 100) !== Math.round(original * 100)
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s-3)', padding: '6px 0' }}>
      <span
        className="t-small"
        title={sourceHint}
        data-testid={`${testId}-source`}
        style={{ color: 'var(--fg-muted)', flex: '1 1 auto', minWidth: 0, cursor: 'help', textDecoration: 'underline dotted', textUnderlineOffset: 3 }}
      >
        {label}
        <i className="iconoir-info-circle" aria-hidden="true" style={{ marginLeft: 4, fontSize: 12, color: 'var(--fg-subtle)', verticalAlign: 'middle' }} />
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 }}>
        <input
          type="number"
          step="0.01"
          className="input"
          data-testid={testId}
          title={sourceHint}
          value={value}
          onChange={(e) => {
            const next = e.target.valueAsNumber
            onChange(Number.isFinite(next) ? next : 0)
          }}
          style={{ width: 110, textAlign: 'right', padding: '4px 8px', fontSize: 13 }}
        />
        {overridden ? (
          <span className="t-caption" style={{ color: 'var(--fg-subtle)', marginTop: 2 }}>
            Original: {formatMxn(original)}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function StackedBar({
  testId,
  label,
  stackResult,
  maxTotal,
  color,
}: {
  testId: string
  label: string
  stackResult: StackedCost
  maxTotal: number
  color: string
}) {
  const widthPct = maxTotal > 0 ? Math.min(100, (stackResult.monthlyTotalMxn / maxTotal) * 100) : 0
  return (
    <div style={{ marginBottom: 'var(--s-3)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span className="t-small" style={{ fontWeight: 600, color: 'var(--fg)' }}>{label}</span>
        <span className="t-small" data-testid={testId} style={{ fontWeight: 700, color: 'var(--accent)' }}>
          {formatMxn(stackResult.monthlyTotalMxn)}/mes
        </span>
      </div>
      <div style={{ display: 'flex', height: 22, borderRadius: 'var(--r-md)', overflow: 'hidden', background: 'var(--bg-sunk)', width: '100%' }}>
        <div style={{ width: `${widthPct}%`, background: color, minWidth: stackResult.monthlyTotalMxn > 0 ? 4 : 0, transition: 'width 120ms ease' }} />
      </div>
    </div>
  )
}

export default function ComparadorTool({ rates, apps, fx, initial, dataset }: ComparadorToolProps) {
  const [platform, setPlatform] = useState<CompetitorPlatform>(initial.platform)
  const [shopifyTier, setShopifyTier] = useState<ShopifyTier>(initial.shopifyTier)
  const [mlBand, setMlBand] = useState<MlBand>(initial.mlBand)
  const [mlPublicationType, setMlPublicationType] = useState<MlPublicationType>(initial.mlPublicationType)
  const [wooTier, setWooTier] = useState<WooCommerceHostingTier>(initial.wooTier)
  const [tnTier, setTnTier] = useState<TiendanubeTier>(initial.tnTier)
  const [tnOwnGateway, setTnOwnGateway] = useState(initial.tnOwnGateway)
  const [t1Tier, setT1Tier] = useState<T1Tier>(initial.t1Tier)
  const [t1Pagos, setT1Pagos] = useState(initial.t1Pagos)
  const [volume, setVolume] = useState(initial.volume)
  const [aov, setAov] = useState(initial.aov)
  const [selectedAppIds, setSelectedAppIds] = useState<string[]>(initial.selectedAppIds)
  const [miyagiSkus, setMiyagiSkus] = useState<ComparadorMiyagiSkus>(initial.miyagiSkus)
  const [lineOverrides, setLineOverrides] = useState<Record<string, number>>(initial.lineOverrides)
  const [interacted, setInteracted] = useState(false)
  const [shareStatus, setShareStatus] = useState<'idle' | 'copied' | 'error'>('idle')
  const [exportStatus, setExportStatus] = useState<'idle' | 'building' | 'error'>('idle')
  // Set only when the synchronous popup got blocked anyway — an inline fallback
  // link instead of a silent no-op (second-opinion review, PR 278).
  const [exportFallbackUrl, setExportFallbackUrl] = useState<string | null>(null)

  // US-3.1 — shop-URL analyzer state. Entirely additive/optional: failure at
  // any point just leaves `analyzerStatus` at 'error' and every manual control
  // above/below keeps working untouched (the "degrades gracefully to manual
  // entry" acceptance — there's no separate "manual mode," manual entry is
  // simply always available).
  const [analyzerUrl, setAnalyzerUrl] = useState('')
  const [analyzerStatus, setAnalyzerStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [analyzerError, setAnalyzerError] = useState<string | null>(null)
  const [analyzerResult, setAnalyzerResult] = useState<ShopAnalyzerResult | null>(null)

  // `nextPlatform` lets the platform-change handler pass the value it's ABOUT to
  // set — `setPlatform` is async (queued), so reading the `platform` closure
  // variable at call time would still read the PREVIOUS value for that one
  // interaction and misattribute the "first calculation" event to it.
  const markInteracted = (nextPlatform?: CompetitorPlatform) => {
    if (interacted) return
    setInteracted(true)
    pushAnalyticsEvent('comparador_calculated', { platform: nextPlatform ?? platform }, { dedupeKey: 'comparador_calculated' })
  }

  const inputs = { volumeMonthly: Math.max(0, volume), aovMxn: Math.max(0, aov) }

  const appsMonthlyMxn = useMemo(
    () => computeSelectedAppsMonthlyMxn(apps, selectedAppIds, fx),
    [apps, selectedAppIds, fx],
  )

  // Current tier/band key — used to namespace line overrides so switching tiers
  // doesn't silently carry a stale hand-edited number into a different tier's row.
  const tierKey = useMemo(() => {
    switch (platform) {
      case 'shopify': return shopifyTier
      case 'mercadolibre': return `${mlBand}-${mlPublicationType}`
      case 'woocommerce': return wooTier
      case 'tiendanube': return `${tnTier}-${tnOwnGateway ? 'own' : 'ext'}`
      case 't1': return `${t1Tier}-${t1Pagos ? 'own' : 'ext'}`
    }
  }, [platform, shopifyTier, mlBand, mlPublicationType, wooTier, tnTier, tnOwnGateway, t1Tier, t1Pagos])

  const baseCompetitorStack = useMemo<StackedCost>(() => {
    switch (platform) {
      case 'shopify':
        return computeShopifyCost(inputs, shopifyTier, rates.shopify, appsMonthlyMxn)
      case 'mercadolibre':
        return computeMercadoLibreCost(inputs, mlBand, mlPublicationType, rates.mercadolibre, appsMonthlyMxn)
      case 'woocommerce':
        return computeWooCommerceCost(inputs, wooTier, rates.woocommerce, appsMonthlyMxn)
      case 'tiendanube':
        return computeTiendanubeCost(inputs, tnTier, tnOwnGateway, rates.tiendanube, appsMonthlyMxn)
      case 't1':
        return computeT1Cost(inputs, t1Tier, t1Pagos, rates.t1, appsMonthlyMxn)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, inputs.volumeMonthly, inputs.aovMxn, shopifyTier, mlBand, mlPublicationType, wooTier, tnTier, tnOwnGateway, t1Tier, t1Pagos, appsMonthlyMxn, rates])

  const baseMiyagiStack = useMemo<StackedCost>(
    () => computeMiyagiCost(inputs, miyagiSkus, rates.miyagi),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inputs.volumeMonthly, inputs.aovMxn, miyagiSkus, rates.miyagi],
  )

  const competitorOverrideKey = (lineKey: string) => `${platform}:${tierKey}:${lineKey}`
  const miyagiOverrideKey = (lineKey: string) => `miyagi:${lineKey}`

  const competitorStack = useMemo(() => {
    const scoped: Record<string, number> = {}
    for (const line of baseCompetitorStack.lines) {
      const k = competitorOverrideKey(line.key)
      if (lineOverrides[k] !== undefined) scoped[line.key] = lineOverrides[k]
    }
    return applyLineOverrides(baseCompetitorStack, scoped)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseCompetitorStack, lineOverrides, platform, tierKey])

  const miyagiStack = useMemo(() => {
    const scoped: Record<string, number> = {}
    for (const line of baseMiyagiStack.lines) {
      const k = miyagiOverrideKey(line.key)
      if (lineOverrides[k] !== undefined) scoped[line.key] = lineOverrides[k]
    }
    return applyLineOverrides(baseMiyagiStack, scoped)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseMiyagiStack, lineOverrides])

  const maxMonthly = Math.max(competitorStack.monthlyTotalMxn, miyagiStack.monthlyTotalMxn, 1)
  const maxAnnual = Math.max(competitorStack.annualTotalMxn, miyagiStack.annualTotalMxn, 1)

  // The tier/band selections currently in effect — feeds lineSourceHint() so each
  // editable line's hover tooltip cites the figure that actually backs it right now
  // (e.g. Shopify's "payment" line cites the Basic-tier rate while Basic is picked,
  // the Advanced-tier rate once Advanced is picked).
  const sourceCtx = { shopifyTier, mlBand, mlPublicationType, wooTier, tnTier, tnOwnGateway, t1Tier, t1Pagos }

  // US-2.2 — "Copiar enlace": serializes the FULL current state (platform, its
  // own tier/band/type/hosting/gateway, volume, AOV, selected apps, Miyagi SKUs,
  // AND any hand-edited line overrides) through the same codec page.tsx's SSR
  // prefill parses, so the copied link restores EXACTLY what's on screen right
  // now — matching the "comparación exacta" claim in the caption below.
  const handleCopyLink = async () => {
    const params = buildComparadorShareParams({
      platform, shopifyTier, mlBand, mlPublicationType, wooTier, tnTier, tnOwnGateway, t1Tier, t1Pagos,
      volume, aov, selectedAppIds, miyagiSkus, lineOverrides,
    })
    const url = `${window.location.origin}/comparador?${params.toString()}`
    try {
      await navigator.clipboard.writeText(url)
      setShareStatus('copied')
      pushAnalyticsEvent('comparador_share_link', { platform })
      window.setTimeout(() => setShareStatus('idle'), 2500)
    } catch {
      setShareStatus('error')
    }
  }

  // US-3.1 — paste a shop URL, detect the platform, prefill the calculator.
  // Never throws: any non-2xx response or network error just surfaces
  // `analyzerError` and leaves the rest of the tool exactly as it was.
  const handleAnalyze = async () => {
    const target = analyzerUrl.trim()
    if (!target) return
    setAnalyzerStatus('loading')
    setAnalyzerError(null)
    try {
      const res = await fetch('/api/comparador/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: target }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data) {
        setAnalyzerStatus('error')
        setAnalyzerError(
          typeof data?.error === 'string' ? data.error : 'No pudimos analizar esa tienda. Llena los datos a mano abajo.',
        )
        return
      }
      const result = data as ShopAnalyzerResult
      setAnalyzerResult(result)
      setAnalyzerStatus('success')
      if (result.platform) {
        setPlatform(result.platform)
        markInteracted(result.platform)
      }
      pushAnalyticsEvent('comparador_url_analyzed', { platform: result.platform ?? 'unknown' })
    } catch {
      setAnalyzerStatus('error')
      setAnalyzerError('No pudimos analizar esa tienda. Llena los datos a mano abajo.')
    }
  }

  // Every sourced figure currently backing either stack, deduped by dataset key —
  // feeds the report's "Fuentes" section (US-2.1) exactly like the per-line hover
  // tooltip does, just collected instead of shown one at a time.
  //
  // HONESTY GUARANTEE (codex blocking finding, PR 278) — a line the visitor
  // hand-edited (US-1.3 inline override) is EXCLUDED from `reportSources`: the
  // dataset's citation verified the ORIGINAL figure, not the edited one, so citing
  // it here would misattribute a user-typed number as sourced/verified. Instead it
  // goes into `competitorOverrides`/`miyagiOverrides`, which the report annotates
  // inline as "editado por el usuario" (see lib/cost-comparator-report.ts).
  const isLineOverridden = (current: number, original: number) => Math.round(current * 100) !== Math.round(original * 100)

  const { reportSources, competitorOverrides, miyagiOverrides } = useMemo(() => {
    const sourceKeys = new Set<string>()
    const compOverrides: Record<string, ComparatorReportLineOverride> = {}
    const miyagiOv: Record<string, ComparatorReportLineOverride> = {}

    for (const line of competitorStack.lines) {
      const baseLine = baseCompetitorStack.lines.find((l) => l.key === line.key)
      const k = lineSourceFigureKey(platform, line.key, sourceCtx)
      if (baseLine && isLineOverridden(line.monthlyMxn, baseLine.monthlyMxn)) {
        const figure = k ? dataset.figures[k] : undefined
        compOverrides[line.key] = { originalMxn: baseLine.monthlyMxn, source: figure?.source, verifiedAt: figure?.verifiedAt }
      } else if (k) {
        sourceKeys.add(k)
      }
    }
    for (const line of miyagiStack.lines) {
      const baseLine = baseMiyagiStack.lines.find((l) => l.key === line.key)
      const k = lineSourceFigureKey('miyagi', line.key, {})
      if (baseLine && isLineOverridden(line.monthlyMxn, baseLine.monthlyMxn)) {
        const figure = k ? dataset.figures[k] : undefined
        miyagiOv[line.key] = { originalMxn: baseLine.monthlyMxn, source: figure?.source, verifiedAt: figure?.verifiedAt }
      } else if (k) {
        sourceKeys.add(k)
      }
    }

    const sources = Array.from(sourceKeys)
      .map((k) => dataset.figures[k])
      .filter((f): f is NonNullable<typeof f> => Boolean(f))
      .map((f) => ({ label: f.label, source: f.source, verifiedAt: f.verifiedAt }))

    return { reportSources: sources as ComparatorReportSource[], competitorOverrides: compOverrides, miyagiOverrides: miyagiOv }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [competitorStack, miyagiStack, baseCompetitorStack, baseMiyagiStack, platform, dataset])

  const platformDisplayLabel = (() => {
    switch (platform) {
      case 'shopify': return `Shopify (${SHOPIFY_TIER_LABELS[shopifyTier]})`
      case 'mercadolibre': return `Mercado Libre (${ML_BAND_LABELS[mlBand]}, ${mlPublicationType === 'clasica' ? 'Clásica' : 'Premium'})`
      case 'woocommerce': return `WooCommerce (${WOO_TIER_LABELS[wooTier]})`
      case 'tiendanube': return `Tiendanube (${TN_TIER_LABELS[tnTier]}${tnOwnGateway ? '' : ', pasarela externa'})`
      case 't1': return `T1 (${T1_TIER_LABELS[t1Tier]}${t1Pagos ? '' : ', pasarela externa'})`
    }
  })()

  // US-2.1 — "Exportar reporte": builds the styled es-MX markdown from what's on
  // screen right now, then hands it to lib/smalldocs.ts (client-only compress +
  // base64url into the URL hash) and opens smalldocs.org in a new tab. Nothing
  // here ever leaves the browser except the smalldocs.org navigation itself.
  //
  // POPUP HARDENING (second-opinion review, PR 278) — `window.open` after an
  // `await` loses the click's transient user-activation in Safari/strict popup
  // blockers, so a naive `await ...; window.open(url)` can silently no-op. Instead
  // we open a BLANK tab synchronously (inside the click handler, before any
  // `await` — still within the activation window) and only set its `location`
  // once the URL is ready. Deliberately no `noopener` here: we need to keep the
  // handle to navigate it later; we sever `opener` ourselves right after — best
  // of both (no lingering back-reference from smalldocs.org, still navigable).
  // If even the synchronous open comes back null (an aggressive blocker), we
  // fall back to an inline "Ábrelo aquí" link instead of a silent failure.
  const handleExportReport = async () => {
    setExportStatus('building')
    setExportFallbackUrl(null)
    const popup = window.open('', '_blank')
    try {
      const markdown = buildComparatorReportMarkdown({
        platformLabel: platformDisplayLabel,
        volumeMonthly: inputs.volumeMonthly,
        aovMxn: inputs.aovMxn,
        competitorStack,
        miyagiStack,
        datasetVerifiedAt: dataset.generatedAt,
        sources: reportSources,
        competitorOverrides,
        miyagiOverrides,
      })
      const url = await buildSmalldocsUrl(markdown)
      pushAnalyticsEvent('comparador_export', { platform })
      if (popup) {
        popup.location.href = url
        try { popup.opener = null } catch { /* not all browsers allow this; harmless if blocked */ }
        setExportStatus('idle')
      } else {
        // Popup was blocked even with the synchronous open — never fail silently.
        setExportFallbackUrl(url)
        setExportStatus('idle')
      }
    } catch {
      popup?.close()
      setExportStatus('error')
    }
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--s-6)' }}>
      {/* US-3.1 — shop-URL analyzer: paste a URL, detect platform + rough
          catalog, prefill the calculator below. Optional — manual entry always
          works regardless of what happens here. */}
      <div className="card-panel" style={{ padding: 'var(--s-5)', display: 'grid', gap: 'var(--s-3)' }}>
        <p className="t-small" style={{ fontWeight: 600 }}>Analiza tu tienda</p>
        <p className="t-caption" style={{ color: 'var(--fg-muted)' }}>
          Pega la URL de tu tienda actual y detectamos la plataforma y un estimado de tu catálogo — es opcional,
          siempre puedes llenar los datos a mano abajo.
        </p>
        <div style={{ display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
          <input
            type="url"
            inputMode="url"
            placeholder="https://mitienda.com"
            className="input"
            data-testid="comparador-analyzer-url-input"
            value={analyzerUrl}
            onChange={(e) => setAnalyzerUrl(e.target.value)}
            style={{ flex: '1 1 220px' }}
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            data-testid="comparador-analyzer-submit"
            disabled={analyzerStatus === 'loading' || !analyzerUrl.trim()}
            onClick={handleAnalyze}
          >
            <i className="iconoir-search" aria-hidden style={{ fontSize: 14 }} />
            {analyzerStatus === 'loading' ? 'Analizando…' : 'Analizar'}
          </button>
        </div>
        {analyzerStatus === 'error' && analyzerError && (
          <p className="t-caption" data-testid="comparador-analyzer-error" style={{ color: 'var(--danger)' }}>
            {analyzerError}
          </p>
        )}
        {analyzerStatus === 'success' && analyzerResult && (
          <div data-testid="comparador-analyzer-result" style={{ display: 'grid', gap: 'var(--s-2)' }}>
            <p className="t-caption" style={{ color: 'var(--fg-muted)' }}>
              {analyzerResult.platform
                ? `Detectamos ${PLATFORM_LABELS[analyzerResult.platform]} — prellenamos la plataforma abajo.`
                : 'No pudimos identificar la plataforma automáticamente — elige la tuya abajo.'}
            </p>
            <p className="t-caption" style={{ color: 'var(--fg-muted)' }}>
              Catálogo aproximado (solo para contexto — no calculamos tu volumen de ventas a partir de
              esto): {pluralEs(analyzerResult.inventory.catalogCount, 'producto', 'productos')} y{' '}
              {pluralEs(analyzerResult.inventory.sectionCount, 'sección', 'secciones')}.
              {analyzerResult.truncated ? ' (solo pudimos leer una parte de la página)' : ''}{' '}
              Ajusta tu volumen mensual y ticket promedio abajo con tus propios números.
            </p>
            {analyzerResult.parity ? (
              <div style={{ display: 'grid', gap: 4 }}>
                {analyzerResult.parity.veryCustom && analyzerResult.parity.veryCustomReason && (
                  <p className="t-caption" style={{ color: 'var(--warning)' }}>{analyzerResult.parity.veryCustomReason}</p>
                )}
                {analyzerResult.parity.sections.map((s) => (
                  <p
                    key={s.key}
                    className="t-caption"
                    data-testid={`comparador-analyzer-parity-${s.key}`}
                    style={{ color: 'var(--fg-muted)' }}
                  >
                    <strong>{s.label}:</strong>{' '}
                    {s.verdict === 'mapped' ? 'Igual' : s.verdict === 'partial' ? 'Parcial' : 'Sin equivalente'} — {s.note}
                  </p>
                ))}
              </div>
            ) : (
              analyzerResult.platform && (
                <p className="t-caption" style={{ color: 'var(--fg-muted)' }}>
                  Aún no tenemos un reporte de esfuerzo de migración detallado para esta plataforma — sigue ajustando
                  la comparación abajo.
                </p>
              )
            )}
          </div>
        )}
      </div>

      {/* Platform + tier pickers */}
      <div className="card-panel" style={{ padding: 'var(--s-5)', display: 'grid', gap: 'var(--s-4)' }}>
        <label style={{ display: 'grid', gap: 'var(--s-1)' }}>
          <span className="t-small" style={{ color: 'var(--fg-muted)' }}>Plataforma con la que comparas</span>
          <select
            className="input"
            data-testid="comparador-platform-select"
            value={platform}
            onChange={(e) => {
              const next = e.target.value as CompetitorPlatform
              setPlatform(next)
              markInteracted(next)
            }}
          >
            {(Object.keys(PLATFORM_LABELS) as CompetitorPlatform[]).map((p) => (
              <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>
            ))}
          </select>
        </label>

        {platform === 'shopify' && (
          <label style={{ display: 'grid', gap: 'var(--s-1)' }}>
            <span className="t-small" style={{ color: 'var(--fg-muted)' }}>Plan de Shopify</span>
            <select className="input" data-testid="comparador-shopify-tier-select" value={shopifyTier} onChange={(e) => { setShopifyTier(e.target.value as ShopifyTier); markInteracted() }}>
              {(Object.keys(SHOPIFY_TIER_LABELS) as ShopifyTier[]).map((t) => (
                <option key={t} value={t}>{SHOPIFY_TIER_LABELS[t]}</option>
              ))}
            </select>
          </label>
        )}

        {platform === 'mercadolibre' && (
          <>
            <label style={{ display: 'grid', gap: 'var(--s-1)' }}>
              <span className="t-small" style={{ color: 'var(--fg-muted)' }}>Categoría (banda de comisión)</span>
              <select className="input" data-testid="comparador-ml-band-select" value={mlBand} onChange={(e) => { setMlBand(e.target.value as MlBand); markInteracted() }}>
                {(Object.keys(ML_BAND_LABELS) as MlBand[]).map((b) => (
                  <option key={b} value={b}>{ML_BAND_LABELS[b]}</option>
                ))}
              </select>
            </label>
            <label style={{ display: 'grid', gap: 'var(--s-1)' }}>
              <span className="t-small" style={{ color: 'var(--fg-muted)' }}>Tipo de publicación</span>
              <select className="input" data-testid="comparador-ml-type-select" value={mlPublicationType} onChange={(e) => { setMlPublicationType(e.target.value as MlPublicationType); markInteracted() }}>
                <option value="clasica">Clásica</option>
                <option value="premium">Premium</option>
              </select>
            </label>
          </>
        )}

        {platform === 'woocommerce' && (
          <label style={{ display: 'grid', gap: 'var(--s-1)' }}>
            <span className="t-small" style={{ color: 'var(--fg-muted)' }}>Alojamiento</span>
            <select className="input" data-testid="comparador-woo-tier-select" value={wooTier} onChange={(e) => { setWooTier(e.target.value as WooCommerceHostingTier); markInteracted() }}>
              {(Object.keys(WOO_TIER_LABELS) as WooCommerceHostingTier[]).map((t) => (
                <option key={t} value={t}>{WOO_TIER_LABELS[t]}</option>
              ))}
            </select>
          </label>
        )}

        {platform === 'tiendanube' && (
          <>
            <label style={{ display: 'grid', gap: 'var(--s-1)' }}>
              <span className="t-small" style={{ color: 'var(--fg-muted)' }}>Plan de Tiendanube</span>
              <select className="input" data-testid="comparador-tn-tier-select" value={tnTier} onChange={(e) => { setTnTier(e.target.value as TiendanubeTier); markInteracted() }}>
                {(Object.keys(TN_TIER_LABELS) as TiendanubeTier[]).map((t) => (
                  <option key={t} value={t}>{TN_TIER_LABELS[t]}</option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
              <input type="checkbox" checked={tnOwnGateway} onChange={(e) => { setTnOwnGateway(e.target.checked); markInteracted() }} data-testid="comparador-tn-gateway-toggle" />
              <span className="t-small" style={{ color: 'var(--fg-muted)' }}>Usar Pago Nube (si no, pasarela externa)</span>
            </label>
          </>
        )}

        {platform === 't1' && (
          <>
            <label style={{ display: 'grid', gap: 'var(--s-1)' }}>
              <span className="t-small" style={{ color: 'var(--fg-muted)' }}>Plan de T1</span>
              <select className="input" data-testid="comparador-t1-tier-select" value={t1Tier} onChange={(e) => { setT1Tier(e.target.value as T1Tier); markInteracted() }}>
                {(Object.keys(T1_TIER_LABELS) as T1Tier[]).map((t) => (
                  <option key={t} value={t}>{T1_TIER_LABELS[t]}</option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
              <input type="checkbox" checked={t1Pagos} onChange={(e) => { setT1Pagos(e.target.checked); markInteracted() }} data-testid="comparador-t1-gateway-toggle" />
              <span className="t-small" style={{ color: 'var(--fg-muted)' }}>Usar T1pagos (si no, pasarela externa)</span>
            </label>
            <p className="t-caption" data-testid="comparador-t1-free-note" style={{ color: 'var(--fg-muted)', margin: 0 }}>
              El plan gratuito de T1 no incluye tienda en línea ni cobros propios, por eso no aparece aquí.
            </p>
          </>
        )}
      </div>

      {/* Volume + AOV */}
      <div className="card-panel" style={{ padding: 'var(--s-5)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))', gap: 'var(--s-4)' }}>
        <label style={{ display: 'grid', gap: 'var(--s-1)' }}>
          <span className="t-small" style={{ color: 'var(--fg-muted)' }}>Ventas al mes</span>
          <input
            type="number"
            min={0}
            className="input"
            data-testid="comparador-volume-input"
            value={volume}
            onChange={(e) => { const n = e.target.valueAsNumber; setVolume(Number.isFinite(n) ? n : 0); markInteracted() }}
          />
        </label>
        <label style={{ display: 'grid', gap: 'var(--s-1)' }}>
          <span className="t-small" style={{ color: 'var(--fg-muted)' }}>Ticket promedio (MXN)</span>
          <input
            type="number"
            min={0}
            className="input"
            data-testid="comparador-aov-input"
            value={aov}
            onChange={(e) => { const n = e.target.valueAsNumber; setAov(Number.isFinite(n) ? n : 0); markInteracted() }}
          />
        </label>
      </div>

      {/* Premium apps */}
      <div className="card-panel" style={{ padding: 'var(--s-5)' }}>
        <p className="t-small" style={{ fontWeight: 600, marginBottom: 'var(--s-3)' }}>Apps premium que ya pagas</p>
        <div style={{ display: 'grid', gap: 'var(--s-3)' }}>
          {apps.map((app) => (
            <label key={app.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s-3)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', minWidth: 0 }}>
                <input
                  type="checkbox"
                  data-testid={`comparador-app-${app.id}`}
                  checked={selectedAppIds.includes(app.id)}
                  onChange={(e) => {
                    setSelectedAppIds((prev) => (e.target.checked ? [...prev, app.id] : prev.filter((id) => id !== app.id)))
                    markInteracted()
                  }}
                />
                <span className="t-small" style={{ color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{app.label}</span>
              </span>
              <span className="t-caption" style={{ color: 'var(--fg-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                ~{formatMxn(app.monthlyUsd * fx)}/mes ·{' '}
                {app.miyagiIncluded ? (
                  <span className="badge badge-verified" style={{ fontSize: 10 }}>Incluido en Miyagi</span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* Miyagi SKU toggles */}
      <div className="card-panel" style={{ padding: 'var(--s-5)' }}>
        <p className="t-small" style={{ fontWeight: 600, marginBottom: 'var(--s-3)' }}>Extras opcionales de Miyagi</p>
        <div style={{ display: 'grid', gap: 'var(--s-3)' }}>
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s-3)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
              <input type="checkbox" data-testid="comparador-miyagi-subdomain" checked={miyagiSkus.subdomain} onChange={(e) => { setMiyagiSkus((s) => ({ ...s, subdomain: e.target.checked })); markInteracted() }} />
              <span className="t-small">Subdominio propio</span>
            </span>
            <span className="t-caption" style={{ color: 'var(--fg-muted)' }}>{formatMxn(rates.miyagi.subdomainMonthlyMxn)}/mes</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s-3)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
              <input type="checkbox" data-testid="comparador-miyagi-domain" checked={miyagiSkus.customDomain} onChange={(e) => { setMiyagiSkus((s) => ({ ...s, customDomain: e.target.checked })); markInteracted() }} />
              <span className="t-small">Dominio propio</span>
            </span>
            <span className="t-caption" style={{ color: 'var(--fg-muted)' }}>{formatMxn(rates.miyagi.customDomainMonthlyMxn)}/mes</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s-3)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
              <input type="checkbox" data-testid="comparador-miyagi-mlsync" checked={miyagiSkus.mlSync} onChange={(e) => { setMiyagiSkus((s) => ({ ...s, mlSync: e.target.checked })); markInteracted() }} />
              <span className="t-small">Sincronización con Mercado Libre</span>
            </span>
            <span className="t-caption" style={{ color: 'var(--fg-muted)' }}>{formatMxn(rates.miyagi.mlSyncMonthlyMxn)}/mes</span>
          </label>
        </div>
      </div>

      {/* Stacked bars */}
      <div className="card-panel" style={{ padding: 'var(--s-5)' }}>
        <p className="t-small" style={{ fontWeight: 600, marginBottom: 'var(--s-3)' }}>Costo mensual</p>
        <StackedBar testId="comparador-monthly-competitor-total" label={PLATFORM_LABELS[platform]} stackResult={competitorStack} maxTotal={maxMonthly} color="var(--fg-subtle)" />
        <StackedBar testId="comparador-monthly-miyagi-total" label="Miyagi Sánchez" stackResult={miyagiStack} maxTotal={maxMonthly} color="var(--accent)" />

        <p className="t-small" style={{ fontWeight: 600, margin: 'var(--s-5) 0 var(--s-3)' }}>Costo anual</p>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span className="t-small" style={{ color: 'var(--fg)' }}>{PLATFORM_LABELS[platform]}</span>
          <span className="t-small" data-testid="comparador-annual-competitor-total" style={{ fontWeight: 700 }}>{formatMxn(competitorStack.annualTotalMxn)}/año</span>
        </div>
        <div style={{ display: 'flex', height: 18, borderRadius: 'var(--r-md)', overflow: 'hidden', background: 'var(--bg-sunk)', marginBottom: 'var(--s-3)' }}>
          <div style={{ width: `${Math.min(100, (competitorStack.annualTotalMxn / maxAnnual) * 100)}%`, background: 'var(--fg-subtle)' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span className="t-small" style={{ color: 'var(--fg)' }}>Miyagi Sánchez</span>
          <span className="t-small" data-testid="comparador-annual-miyagi-total" style={{ fontWeight: 700, color: 'var(--accent)' }}>{formatMxn(miyagiStack.annualTotalMxn)}/año</span>
        </div>
        <div style={{ display: 'flex', height: 18, borderRadius: 'var(--r-md)', overflow: 'hidden', background: 'var(--bg-sunk)' }}>
          <div style={{ width: `${Math.min(100, (miyagiStack.annualTotalMxn / maxAnnual) * 100)}%`, background: 'var(--accent)' }} />
        </div>
      </div>

      {/* Editable line items — every figure inline-editable, sourced original as hint */}
      <div className="card-panel" style={{ padding: 'var(--s-5)' }}>
        <p className="t-small" style={{ fontWeight: 600, marginBottom: 'var(--s-2)' }}>{PLATFORM_LABELS[platform]} — detalle</p>
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {competitorStack.lines.map((line, i) => (
            <EditableLine
              key={line.key}
              testId={`comparador-line-${platform}-${line.key}`}
              label={line.label}
              value={line.monthlyMxn}
              original={baseCompetitorStack.lines[i]?.monthlyMxn ?? line.monthlyMxn}
              sourceHint={lineSourceHint(dataset, platform, line.key, sourceCtx)}
              onChange={(next) => {
                setLineOverrides((prev) => ({ ...prev, [competitorOverrideKey(line.key)]: next }))
                markInteracted()
              }}
            />
          ))}
        </div>
        <p className="t-small" style={{ fontWeight: 600, margin: 'var(--s-5) 0 var(--s-2)' }}>Miyagi Sánchez — detalle</p>
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {miyagiStack.lines.map((line, i) => (
            <EditableLine
              key={line.key}
              testId={`comparador-line-miyagi-${line.key}`}
              label={line.label}
              value={line.monthlyMxn}
              original={baseMiyagiStack.lines[i]?.monthlyMxn ?? line.monthlyMxn}
              sourceHint={lineSourceHint(dataset, 'miyagi', line.key, {})}
              onChange={(next) => {
                setLineOverrides((prev) => ({ ...prev, [miyagiOverrideKey(line.key)]: next }))
                markInteracted()
              }}
            />
          ))}
        </div>
      </div>

      {/* Compartir / Exportar — US-2.1 (smalldocs report) + US-2.2 (prefill link) */}
      <div className="card-panel" style={{ padding: 'var(--s-5)', display: 'grid', gap: 'var(--s-3)' }}>
        <p className="t-small" style={{ fontWeight: 600 }}>Comparte o guarda esta comparación</p>
        <div style={{ display: 'flex', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="comparador-export-button"
            disabled={exportStatus === 'building'}
            onClick={handleExportReport}
          >
            <i className="iconoir-page" aria-hidden style={{ fontSize: 14 }} />
            {exportStatus === 'building' ? 'Generando…' : 'Exportar reporte'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            data-testid="comparador-share-link-button"
            onClick={handleCopyLink}
          >
            <i className="iconoir-link" aria-hidden style={{ fontSize: 14 }} />
            {shareStatus === 'copied' ? '¡Enlace copiado!' : 'Copiar enlace'}
          </button>
        </div>
        {exportFallbackUrl && (
          <p className="t-caption" style={{ color: 'var(--fg-muted)' }}>
            Tu navegador bloqueó la ventana emergente —{' '}
            <a href={exportFallbackUrl} target="_blank" rel="noopener noreferrer" data-testid="comparador-export-fallback-link">
              ábrelo aquí
            </a>.
          </p>
        )}
        {exportStatus === 'error' && (
          <p className="t-caption" style={{ color: 'var(--danger)' }}>
            No se pudo generar el reporte. Intenta de nuevo.
          </p>
        )}
        {shareStatus === 'error' && (
          <p className="t-caption" style={{ color: 'var(--danger)' }}>
            No se pudo copiar el enlace. Copia la URL de la barra de direcciones.
          </p>
        )}
        <p className="t-caption" style={{ color: 'var(--fg-muted)' }}>
          «Exportar reporte» abre un reporte es-MX en smalldocs.org (nunca toca nuestro servidor: el
          documento viaja comprimido en la URL). «Copiar enlace» copia esta comparación exacta para
          compartirla — útil para un promotor durante una visita.
        </p>
      </div>
    </div>
  )
}
