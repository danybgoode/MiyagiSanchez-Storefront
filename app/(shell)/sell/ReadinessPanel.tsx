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
async function fetchReadiness(listingType: string, deliveryMode: string): Promise<ReadinessView | null> {
  try {
    const qs = new URLSearchParams({ listing_type: listingType, delivery_mode: deliveryMode })
    const res = await fetch(`/api/sell/readiness?${qs}`, { cache: 'no-store' })
    return res.ok ? await res.json() as ReadinessView : null
  } catch {
    return null
  }
}

export default function ReadinessPanel({
  listingType,
  deliveryMode,
  refreshKey,
  submitting,
  onPublishAsCatalog,
}: {
  listingType: string
  deliveryMode: 'carrier' | 'arranged'
  refreshKey: number
  submitting: boolean
  onPublishAsCatalog: () => void
}) {
  const [view, setView] = useState<ReadinessView | null>(null)
  const [fixing, setFixing] = useState(false)
  // Bumped after the inline chooser saves, so the checklist re-reads the shop.
  const [savedTick, setSavedTick] = useState(0)

  useEffect(() => {
    // Not a product: nothing to ask (the render below also ignores any earlier answer).
    if (listingType !== 'product') return
    let cancelled = false
    fetchReadiness(listingType, deliveryMode).then((next) => { if (!cancelled) setView(next) })
    return () => { cancelled = true }
  }, [listingType, deliveryMode, refreshKey, savedTick])

  const rows = listingType === 'product' ? readinessChecklist(view) : null
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
