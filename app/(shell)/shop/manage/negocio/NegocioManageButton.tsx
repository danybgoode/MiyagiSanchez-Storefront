'use client'

import { useState } from 'react'

/**
 * The monthly subscriber's way out (Daniel, 2026-11-05): opens Stripe's page, where they change the card, see their
 * invoices or cancel. The server finds this owner's own subscription; the request carries nothing.
 */
export default function NegocioManageButton() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function open() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/sell/negocio/manage', { method: 'POST', signal: AbortSignal.timeout(30_000) })
      const json = (await res.json().catch(() => null)) as { ok?: boolean; url?: string; error?: string } | null
      if (res.ok && json?.ok && json.url) {
        window.location.assign(json.url)
        return
      }
      setError(json?.error || 'No pudimos abrir tus pagos. Intenta de nuevo.')
    } catch {
      setError('No pudimos abrir tus pagos. Intenta de nuevo.')
    }
    setBusy(false)
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--s-2)' }}>
      <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>
        Ahí cambias tu tarjeta, ves tus pagos o cancelas. Si cancelas, tu tienda sigue abierta en el Plan Gratis.
      </p>
      <button type="button" className="btn btn-secondary" data-testid="negocio-manage" disabled={busy} onClick={open} style={{ justifySelf: 'start' }}>
        {busy ? 'Un momento…' : 'Ver mis pagos o cancelar'}
      </button>
      {error ? <p role="alert" className="t-small" style={{ color: 'var(--danger)', margin: 0 }}>{error}</p> : null}
    </div>
  )
}
