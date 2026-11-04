'use client'

import { useState } from 'react'
import type { NegocioButton } from '@/lib/negocio-page'

/**
 * The buy buttons on «Tu suscripción». Each POSTs the cadence (the only input — the server owns the shop and the price)
 * to the checkout route and sends the browser to the Stripe URL it returns. A failure shows the server's own sentence.
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
    <div style={{ display: 'grid', gap: 'var(--s-2)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-3)' }}>
        {buttons.map((b, i) => (
          <button
            key={b.cadence}
            type="button"
            className={i === 0 && buttons.length > 1 ? 'btn btn-secondary' : 'btn btn-primary'}
            data-testid={`negocio-buy-${b.cadence}`}
            disabled={busy !== null}
            onClick={() => start(b.cadence)}
          >
            {busy === b.cadence ? 'Un momento…' : b.label}
          </button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="t-small" data-testid="negocio-buy-error" style={{ color: 'var(--danger)', margin: 0 }}>{error}</p>
      ) : null}
    </div>
  )
}
