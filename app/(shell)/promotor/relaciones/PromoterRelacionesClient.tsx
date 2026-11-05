'use client'

import { useEffect, useState } from 'react'
import RelationshipHistoryPanel, { STAGE_LABEL } from '@/app/components/RelationshipHistoryPanel'

/**
 * Founding merchant activation operations · Sprint 2 (Story 2.3) — the
 * promoter operating pipeline. Thin screen over `GET /api/promoter/relationships`;
 * each row expands into `RelationshipHistoryPanel` for history + write actions.
 */

type EnrichedRelationship = {
  id: string
  businessName: string
  contactName: string | null
  estado: string | null
  municipio: string | null
  stage: string
  stageEnteredAt: string
  ageInStageDays: number
  nextAction: { id: string; dueAt: string | null } | null
  missingAction: boolean
  overdue: boolean
  blocker: boolean
  consentState: string
}

const CONSENT_LABEL: Record<string, string> = {
  sin_vista_previa: 'Sin vista previa',
  vista_previa_draft: 'Vista previa en borrador',
  vista_previa_approved: 'Vista previa aprobada',
  vista_previa_changes_requested: 'Cambios solicitados',
  vista_previa_invalidated: 'Vista previa invalidada',
  vista_previa_activated: 'Vista previa activada',
}

export default function PromoterRelacionesClient() {
  const [rows, setRows] = useState<EnrichedRelationship[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/promoter/relationships')
      const json = await res.json()
      if (!res.ok || !json.ok) {
        setError('No se pudo cargar tu cartera de comercios.')
        return
      }
      setRows(json.relationships ?? [])
    } catch {
      setError('No se pudo cargar tu cartera de comercios.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Mis comercios</h1>
        <p className="text-sm text-[var(--color-muted)] mt-1">
          Tus comercios fundadores: etapa, antigüedad en la etapa, próxima acción, consentimiento y bloqueos.
        </p>
      </div>

      {loading && <p className="text-sm text-[var(--color-muted)]">Cargando…</p>}
      {error && <p className="text-sm text-[color:var(--danger)]">{error}</p>}

      {!loading && !error && rows.length === 0 && (
        <p className="text-sm text-[var(--color-muted)] py-8 text-center">
          Todavía no tienes comercios registrados. Captúralos desde{' '}
          <a href="/promotor/cerrar" className="underline">Abrir una tienda</a>.
        </p>
      )}

      <div className="space-y-2">
        {rows.map((r) => {
          const open = r.id === expandedId
          return (
            <div key={r.id} className="rounded-lg border border-[var(--color-border)] overflow-hidden">
              <button
                type="button"
                onClick={() => setExpandedId(open ? null : r.id)}
                className="w-full text-left px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1 hover:bg-[var(--color-surface-alt)]"
                aria-expanded={open}
              >
                <span className="font-medium">{r.businessName}</span>
                <span className="text-xs text-[var(--color-muted)]">
                  {[r.municipio, r.estado].filter(Boolean).join(', ')}
                </span>
                <span className="ml-auto flex flex-wrap items-center gap-2 text-xs">
                  <span className="badge badge-info">{STAGE_LABEL[r.stage] ?? r.stage}</span>
                  <span className="text-[var(--color-muted)]">{r.ageInStageDays}d en etapa</span>
                  {r.missingAction ? (
                    <span className="badge badge-warning">
                      <i className="iconoir-warning-triangle" aria-hidden /> Sin próxima acción
                    </span>
                  ) : (
                    <span className={`badge ${r.overdue ? 'badge-danger' : 'badge-success'}`}>
                      {r.overdue ? 'Acción vencida' : 'Con próxima acción'}
                    </span>
                  )}
                  {r.blocker && (
                    <span className="badge badge-danger">
                      <i className="iconoir-warning-triangle" aria-hidden /> Bloqueo
                    </span>
                  )}
                  <span className="badge badge-neutral">{CONSENT_LABEL[r.consentState] ?? r.consentState}</span>
                </span>
              </button>

              {open && (
                <div className="border-t border-[var(--color-border)] px-4 py-4 bg-[var(--color-surface-alt)]">
                  <RelationshipHistoryPanel relationshipId={r.id} onChanged={load} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
