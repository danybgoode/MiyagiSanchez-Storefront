'use client'

import { useState } from 'react'
import type { NegocioButton } from '@/lib/negocio-page'

/**
 * The ways to pay on «Tu suscripción», each as a card that says what it is before the button (Daniel, 2026-11-05:
 * "what does each do? if I pay right now what happens?"). Each POSTs the cadence (the only input — the server owns the
 * shop and the price) to the checkout route and sends the browser to the Stripe URL it returns. A failure shows the
 * server's own sentence.
 */
export default function NegocioBuyButtons({ buttons }: { buttons: NegocioButton[] }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function start(cadence: NegocioButton['cadence']) {
    setBusy(cadence)
    setError(null)
    try {
      const res = await fetch('/api/sell/negocio/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cadence }),
        signal: AbortSignal.timeout(30_000),
      })
      const json = (await res.json().catch(() => null)) as { ok?: boolean; url?: string; error?: string } | null
      if (res.ok && json?.ok && json.url) {
        window.location.assign(json.url)
        return
      }
      setError(json?.error || 'No se pudo iniciar el pago. Intenta de nuevo.')
    } catch {
      setError('No se pudo iniciar el pago. Intenta de nuevo.')
    }
    setBusy(null)
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--s-3)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: 'var(--s-3)' }}>
        {buttons.map((b) => (
          <article key={b.cadence} className="card-panel" data-testid={`negocio-option-${b.cadence}`} style={{ padding: 'var(--s-5)', display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
            <h3 className="t-h4" style={{ margin: 0, letterSpacing: 0 }}>{b.title}</h3>
            <ul style={{ margin: 0, paddingLeft: 'var(--s-4)', display: 'grid', gap: 'var(--s-1)', flex: 1 }}>
              {b.lines.map((line) => <li key={line} className="t-small">{line}</li>)}
            </ul>
            <button
              type="button"
              className={b.cadence === 'year' ? 'btn btn-primary' : 'btn btn-secondary'}
              data-testid={`negocio-buy-${b.cadence}`}
              disabled={busy !== null}
              onClick={() => start(b.cadence)}
              style={{ marginTop: 'var(--s-2)' }}
            >
              {busy === b.cadence ? 'Un momento…' : b.label}
            </button>
          </article>
        ))}
      </div>
      {error ? (
        <p role="alert" className="t-small" data-testid="negocio-buy-error" style={{ color: 'var(--danger)', margin: 0 }}>{error}</p>
      ) : null}
    </div>
  )
}
