'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import type { Scorecard, ScorecardFunnelStage } from '@/lib/scorecard/types'
import type { MetricValue } from '@/lib/scorecard/dictionary'

/**
 * Merchant activation scorecard · Sprint 2, Story 2.1 — the weekly operating
 * view. Thin client over `GET /api/admin/scorecard` (the ONE resolver every
 * scorecard surface shares — decision 2). URL-stable filters (searchParams);
 * every count drills through to its merchant rows via `scorecard.merchants`
 * (the SAME ids the resolver used to compute the count, so the drill-through
 * always "exactly explains" it); definitions/freshness are visible; empty,
 * loading, error and degraded states are visually distinct (SD4 — a
 * `missing`/`stale` metric never renders as if it were a real 0).
 */

const STAGE_LABEL: Record<string, string> = {
  scouted: 'Detectado',
  qualified: 'Calificado',
  permission_granted: 'Permiso otorgado',
  preview_in_preparation: 'Vista previa en preparación',
  preview_delivered: 'Vista previa entregada',
  activation_scheduled: 'Activación agendada',
  claimed: 'Tienda reclamada',
  payments_ready: 'Pagos listos',
  three_products_live: '3+ productos publicados',
  shared_externally: 'Compartido externamente',
  first_inquiry: 'Primera consulta',
  first_sale: 'Primera venta',
  retained_30d: 'Retenido a 30 días',
}

const HEALTH_LABEL: Record<string, string> = { ok: 'OK', stale: 'Desactualizado', missing: 'Sin datos' }
const HEALTH_BADGE: Record<string, string> = { ok: 'badge-success', stale: 'badge-warning', missing: 'badge-neutral' }

function healthBadge(health: string) {
  return <span className={`badge ${HEALTH_BADGE[health] ?? 'badge-neutral'}`}>{HEALTH_LABEL[health] ?? health}</span>
}

function fmtNumber(v: number | null, digits = 0): string {
  if (v === null) return '—'
  return v.toLocaleString('es-MX', { maximumFractionDigits: digits, minimumFractionDigits: 0 })
}

function fmtRatio(v: number | null): string {
  if (v === null) return '—'
  return `${(v * 100).toLocaleString('es-MX', { maximumFractionDigits: 1 })}%`
}

function MetricCard({
  label,
  metric,
  format,
  onDrillThrough,
}: {
  label: string
  metric: MetricValue<number>
  format?: (v: number | null) => string
  onDrillThrough?: () => void
}) {
  const fmt = format ?? ((v: number | null) => fmtNumber(v))
  return (
    <div className="rounded-lg border border-[var(--color-border)] p-4 space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-[var(--color-muted)]">{label}</span>
        {healthBadge(metric.health)}
      </div>
      {onDrillThrough && metric.value !== null && metric.value > 0 ? (
        <button type="button" onClick={onDrillThrough} className="btn btn-ghost text-2xl font-bold" style={{ justifySelf: 'start', paddingInline: 0 }}>
          {fmt(metric.value)}
        </button>
      ) : (
        <div className="text-2xl font-bold">{fmt(metric.value)}</div>
      )}
    </div>
  )
}

function DrillThroughRows({ ids, merchants }: { ids: string[]; merchants: Scorecard['merchants'] }) {
  if (ids.length === 0) {
    return <p className="text-xs text-[var(--color-muted)] py-2">Ningún comercio en esta cuenta.</p>
  }
  return (
    <ul className="text-sm divide-y divide-[var(--color-border)] border border-[var(--color-border)] rounded-md overflow-hidden">
      {ids.map((id) => {
        const m = merchants[id]
        return (
          <li key={id} className="px-3 py-2 flex items-center justify-between gap-2">
            <span>{m?.businessName ?? id}</span>
            {m?.stage && <span className="badge badge-info text-xs">{STAGE_LABEL[m.stage] ?? m.stage}</span>}
          </li>
        )
      })}
    </ul>
  )
}

export default function ActivacionScorecardClient() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [scorecard, setScorecard] = useState<Scorecard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [drillThrough, setDrillThrough] = useState<{ label: string; ids: string[] } | null>(null)

  const [cohort, setCohort] = useState(searchParams.get('cohort') ?? '')
  const [stage, setStage] = useState(searchParams.get('stage') ?? '')
  const [steward, setSteward] = useState(searchParams.get('steward') ?? '')
  const [promoter, setPromoter] = useState(searchParams.get('promoter') ?? '')
  const [dateFrom, setDateFrom] = useState(searchParams.get('date_from') ?? '')
  const [dateTo, setDateTo] = useState(searchParams.get('date_to') ?? '')

  const requestIdRef = useRef(0)

  const query = useMemo(() => {
    const params = new URLSearchParams()
    if (cohort.trim()) params.set('cohort', cohort.trim())
    if (stage) params.set('stage', stage)
    if (steward.trim()) params.set('steward', steward.trim())
    if (promoter.trim()) params.set('promoter', promoter.trim())
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo) params.set('date_to', dateTo)
    return params.toString()
  }, [cohort, stage, steward, promoter, dateFrom, dateTo])

  // Debounce the derived query so typing into a text filter (cohort/steward/
  // promoter) doesn't replace the URL and refetch on EVERY keystroke — both
  // the URL replace and the fetch below key off the debounced value. Seeded
  // to the initial `query` so the first load fires immediately, not after the
  // delay. (PR 307 cross-agent review.)
  const [debouncedQuery, setDebouncedQuery] = useState(query)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300)
    return () => clearTimeout(t)
  }, [query])

  // URL-stable filters: every (settled) filter change replaces the URL so the
  // exact view is shareable/reopenable (Sprint 2 smoke walkthrough step 2).
  useEffect(() => {
    router.replace(debouncedQuery ? `${pathname}?${debouncedQuery}` : pathname, { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery])

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/scorecard${debouncedQuery ? `?${debouncedQuery}` : ''}`)
      const json = await res.json()
      if (requestId !== requestIdRef.current) return
      if (!res.ok || !json.ok) {
        setError(json?.error ?? 'No se pudo cargar la ficha de activación.')
        setScorecard(null)
        return
      }
      setScorecard(json.scorecard as Scorecard)
    } catch {
      if (requestId !== requestIdRef.current) return
      setError('No se pudo cargar la ficha de activación.')
      setScorecard(null)
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [debouncedQuery])

  useEffect(() => {
    // Loading the scorecard is this effect's synchronization job (an external read); `load` owns the setState calls,
    // and a stale response is dropped by the request id above.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const anyDegraded = scorecard
    ? scorecard.freshness.health !== 'ok' ||
      [
        scorecard.summary.cohortEntry,
        scorecard.summary.overdueCount,
        scorecard.summary.missingActionCount,
        scorecard.summary.activationTimeMedianDays,
        scorecard.summary.firstSaleCount,
        scorecard.summary.retained30dCount,
      ].some((m) => m.health !== 'ok') ||
      scorecard.funnel.some((f) => f.count.health !== 'ok')
    : false

  const exportHref = `/api/admin/scorecard/export${query ? `?${query}` : ''}`

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Activación de comercios fundadores</h1>
        <p className="text-sm text-[var(--color-muted)] mt-1">
          Vista semanal: embudo por etapa, tiempo en cada etapa, próximas acciones vencidas o faltantes, y resultados
          comerciales (primera venta, retención). Proyecta hechos ya confiables — no es una segunda bitácora para
          editarlos.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <input type="text" value={cohort} onChange={(e) => setCohort(e.target.value)} placeholder="Cohorte…" className="input w-auto" />
        <select value={stage} onChange={(e) => setStage(e.target.value)} className="input w-auto">
          <option value="">Todas las etapas</option>
          {Object.entries(STAGE_LABEL).map(([s, label]) => (
            <option key={s} value={s}>
              {label}
            </option>
          ))}
        </select>
        <input type="text" value={steward} onChange={(e) => setSteward(e.target.value)} placeholder="ID de Clerk del dueño…" className="input w-auto" />
        <input type="text" value={promoter} onChange={(e) => setPromoter(e.target.value)} placeholder="ID del promotor…" className="input w-auto" />
        <label className="text-xs text-[var(--color-muted)] flex items-center gap-1">
          Desde
          <input type="date" value={dateFrom.slice(0, 10)} onChange={(e) => setDateFrom(e.target.value ? `${e.target.value}T00:00:00.000Z` : '')} className="input w-auto" />
        </label>
        <label className="text-xs text-[var(--color-muted)] flex items-center gap-1">
          Hasta
          <input type="date" value={dateTo.slice(0, 10)} onChange={(e) => setDateTo(e.target.value ? `${e.target.value}T23:59:59.999Z` : '')} className="input w-auto" />
        </label>
        <a href={exportHref} className="btn btn-secondary ml-auto text-sm">
          Exportar CSV
        </a>
      </div>

      {loading && <p className="text-sm text-[var(--color-muted)]">Cargando…</p>}
      {error && <p className="text-sm text-[color:var(--danger)]">{error}</p>}

      {!loading && !error && scorecard && (
        <>
          {anyDegraded && (
            <div className="rounded-md border border-[var(--warning)] bg-[var(--warning-soft)] px-4 py-2 text-sm text-[#7a4e00]">
              Algunos valores están degradados (datos incompletos o desactualizados) — revisa las etiquetas &quot;Sin
              datos&quot;/&quot;Desactualizado&quot; junto a cada métrica antes de decidir con ellas.
            </div>
          )}

          {scorecard.summary.cohortEntry.value === 0 && scorecard.summary.cohortEntry.health === 'ok' && (
            <div className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm text-[var(--color-muted)]">
              Ningún comercio coincide con los filtros — cohorte vacío confirmado (no es un error de carga).
            </div>
          )}

          <div className="flex items-center justify-between text-xs text-[var(--color-muted)]">
            <span>
              Versión del esquema {scorecard.schemaVersion} · generado {new Date(scorecard.generatedAt).toLocaleString('es-MX', { timeZone: scorecard.timezone })} (
              {scorecard.timezone})
            </span>
            <span className="flex items-center gap-2">
              Frescura de Golden Beans: {healthBadge(scorecard.freshness.health)}
              {scorecard.freshness.staleRelationshipIds.length > 0 && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setDrillThrough({ label: 'Comercios con emisión pendiente hacia Golden Beans', ids: scorecard.freshness.staleRelationshipIds })}
                >
                  ver {scorecard.freshness.staleRelationshipIds.length}
                </button>
              )}
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            <MetricCard label="Tamaño del cohorte" metric={scorecard.summary.cohortEntry} />
            <MetricCard
              label="Próxima acción vencida"
              metric={scorecard.summary.overdueCount}
              onDrillThrough={() => setDrillThrough({ label: 'Próxima acción vencida', ids: scorecard.summary.overdueIds })}
            />
            <MetricCard
              label="Sin próxima acción"
              metric={scorecard.summary.missingActionCount}
              onDrillThrough={() => setDrillThrough({ label: 'Sin próxima acción con fecha', ids: scorecard.summary.missingActionIds })}
            />
            <MetricCard label="Tiempo hasta activación (mediana, días)" metric={scorecard.summary.activationTimeMedianDays} />
            <MetricCard label="Tiempo hasta activación (p90, días)" metric={scorecard.summary.activationTimeP90Days} />
            <MetricCard
              label="Con primera venta"
              metric={scorecard.summary.firstSaleCount}
              onDrillThrough={() => setDrillThrough({ label: 'Con primera venta', ids: scorecard.summary.firstSaleIds })}
            />
            <MetricCard label="Tasa de primera venta" metric={scorecard.summary.firstSaleRate} format={fmtRatio} />
            <MetricCard
              label="Retenidos"
              metric={scorecard.summary.retained30dCount}
              onDrillThrough={() => setDrillThrough({ label: 'Retenidos', ids: scorecard.summary.retained30dIds })}
            />
            <MetricCard label="Tasa de retención" metric={scorecard.summary.retained30dRate} format={fmtRatio} />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left border-b border-[var(--color-border)]">
                  <th className="py-2 pr-3">Etapa</th>
                  <th className="py-2 pr-3">Comercios (llegó o superó)</th>
                  <th className="py-2 pr-3">Conversión desde la anterior</th>
                  <th className="py-2 pr-3">Días en la etapa (mediana)</th>
                  <th className="py-2 pr-3">Días en la etapa (p90)</th>
                </tr>
              </thead>
              <tbody>
                {scorecard.funnel.map((row: ScorecardFunnelStage) => (
                  <tr key={row.stage} className="border-b border-[var(--color-border)]">
                    <td className="py-2 pr-3 font-medium">{STAGE_LABEL[row.stage] ?? row.stage}</td>
                    <td className="py-2 pr-3">
                      {row.count.value !== null && row.count.value > 0 ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setDrillThrough({ label: `${STAGE_LABEL[row.stage] ?? row.stage} — llegó o superó`, ids: row.drillThroughIds })}
                        >
                          {fmtNumber(row.count.value)}
                        </button>
                      ) : (
                        fmtNumber(row.count.value)
                      )}{' '}
                      {row.count.health !== 'ok' && healthBadge(row.count.health)}
                    </td>
                    <td className="py-2 pr-3">
                      {fmtRatio(row.conversionFromPrevious.value)} {row.conversionFromPrevious.health !== 'ok' && healthBadge(row.conversionFromPrevious.health)}
                    </td>
                    <td className="py-2 pr-3">
                      {fmtNumber(row.agingMedianDays.value, 1)} {row.agingMedianDays.health !== 'ok' && healthBadge(row.agingMedianDays.health)}
                    </td>
                    <td className="py-2 pr-3">
                      {fmtNumber(row.agingP90Days.value, 1)} {row.agingP90Days.health !== 'ok' && healthBadge(row.agingP90Days.health)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {drillThrough && (
            <div className="rounded-lg border border-[var(--color-border)] p-4 space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-sm">{drillThrough.label}</h2>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDrillThrough(null)}>
                  cerrar
                </button>
              </div>
              <DrillThroughRows ids={drillThrough.ids} merchants={scorecard.merchants} />
            </div>
          )}
        </>
      )}
    </div>
  )
}
