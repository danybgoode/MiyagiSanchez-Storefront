'use client'
import { useEffect, useState } from 'react'
import CobrosChooser from '@/app/(shell)/p2s/_components/CobrosChooser'
import { READINESS_COPY } from '@/lib/listing-readiness'
import { readinessChecklist, type ReadinessView } from '@/lib/readiness-view'

/**
 * «Antes de publicar» — the new-listing form's readiness panel (epic listing-readiness S2.1).
 *
 * For a product, it asks the server (`GET /api/sell/readiness`, the same rule `POST /api/sell/create` enforces)
 * whether a buyer could pay for it online. If not, it says what is missing, opens the shipped `CobrosChooser` in place
 * («Activar cobros aquí»), and offers «Publicar como catálogo» as a deliberate choice. Renders nothing when the
 * listing sells online or when it cannot tell — the server still decides at publish, and a LISTING_NOT_READY answer
 * bumps `refreshKey` to re-open this panel.
 */
async function fetchReadiness(listingType: string, deliveryMode: string, priced: boolean, isEvent: boolean): Promise<ReadinessView | null> {
  try {
    const qs = new URLSearchParams({
      listing_type: listingType, delivery_mode: deliveryMode, priced: String(priced), is_event: String(isEvent),
    })
    const res = await fetch(`/api/sell/readiness?${qs}`, { cache: 'no-store' })
    return res.ok ? await res.json() as ReadinessView : null
  } catch {
    return null
  }
}

const GATED_TYPES: ReadonlySet<string> = new Set(['product', 'service', 'rental'])

export default function ReadinessPanel({
  listingType,
  deliveryMode,
  refreshKey,
  submitting,
  onPublishAsCatalog,
  priced = false,
  isEvent = false,
}: {
  listingType: string
  deliveryMode: 'carrier' | 'arranged'
  /** A positive price (a service/rental without one is contact-only and never gated). */
  priced?: boolean
  /** A seated Evento (any rail pays a ticket). */
  isEvent?: boolean
  refreshKey: number
  submitting: boolean
  onPublishAsCatalog: () => void
}) {
  const [view, setView] = useState<ReadinessView | null>(null)
  const [fixing, setFixing] = useState(false)
  // Bumped after the inline chooser saves, so the checklist re-reads the shop.
  const [savedTick, setSavedTick] = useState(0)

  useEffect(() => {
    // Only types the rule can gate (coordinated-sales-readiness added services and rentals).
    if (!GATED_TYPES.has(listingType)) return
    let cancelled = false
    fetchReadiness(listingType, deliveryMode, priced, isEvent).then((next) => { if (!cancelled) setView(next) })
    return () => { cancelled = true }
  }, [listingType, deliveryMode, priced, isEvent, refreshKey, savedTick])

  const rows = GATED_TYPES.has(listingType) ? readinessChecklist(view) : null
  if (!rows || !view || view.state !== 'ok') return null

  return (
    <section className="card-panel grid gap-3" style={{ padding: 'var(--s-4)' }} aria-label={READINESS_COPY.panelTitle} data-testid="readiness-panel">
      <div className="grid gap-1">
        <h2 className="t-small" style={{ margin: 0, fontWeight: 700 }}>{READINESS_COPY.panelTitle}</h2>
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{READINESS_COPY.notReadyTitle}</p>
      </div>
      <ul className="grid gap-1" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {rows.map((row) => (
          <li key={row.key} className="t-small flex items-center gap-2" data-testid={`readiness-${row.key}`} data-done={row.done}>
            <i className={row.done ? 'iconoir-check-circle' : 'iconoir-xmark-circle'} aria-hidden="true"
              style={{ color: row.done ? 'var(--success)' : 'var(--danger)' }} />
            {row.done ? READINESS_COPY.ready[row.key] : READINESS_COPY.missing[row.missing ?? row.key]}
          </li>
        ))}
      </ul>
      {fixing ? (
        <CobrosChooser
          shopSlug={view.chooser.shopSlug}
          market={view.chooser.market}
          initial={view.chooser.initial}
          correosAvailable={view.chooser.correosAvailable}
          shape={view.chooser.shape}
          draftId={null}
          onSaved={() => setSavedTick((n) => n + 1)}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!fixing ? (
          <button type="button" className="btn btn-secondary" onClick={() => setFixing(true)} data-testid="readiness-fix">
            {READINESS_COPY.fixPayments}
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost" onClick={onPublishAsCatalog} disabled={submitting} data-testid="readiness-catalog">
          {READINESS_COPY.publishAsCatalog}
        </button>
      </div>
      <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{READINESS_COPY.catalogHint}</p>
    </section>
  )
}
