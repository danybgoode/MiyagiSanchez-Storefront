'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { payFailureKind, type PayChoice } from '@/lib/in-person/payment-link'
import type { ManualPayment } from '@/lib/in-person/counter-checkout'

/** «Pagar»: asks the server to open a fresh cart for this link, then goes to the provider or shows the transfer data. */
export default function PayClient({ token, choices }: { token: string; choices: PayChoice[] }) {
  const [busy, setBusy] = useState<PayChoice['id'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [manual, setManual] = useState<ManualPayment | null>(null)
  const [kind, setKind] = useState<'closed' | 'busy' | 'retry'>('retry')

  async function pay(choice: PayChoice['id']) {
    if (busy) return
    setBusy(choice)
    setError(null)
    try {
      const res = await fetch(`/api/pagar/${token}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice }),
        signal: AbortSignal.timeout(40_000),
      })
      const json = (await res.json().catch(() => null)) as { redirect_url?: string; manual_payment?: ManualPayment; message?: string; code?: string } | null
      if (res.ok && json?.redirect_url) { window.location.assign(json.redirect_url); return }
      if (res.ok && json?.manual_payment) { setManual(json.manual_payment); return }
      setKind(payFailureKind(json?.code))
      setError(json?.message ?? 'No pudimos preparar el pago. Inténtalo de nuevo.')
    } catch {
      setError('Sin conexión. Inténtalo de nuevo.')
    } finally {
      setBusy(null)
    }
  }

  if (manual) {
    return (
      <div className="mt-5">
        <h2 className="text-lg font-bold">Haz tu transferencia</h2>
        {manual.spei && (
          <div className="mt-3 rounded-[var(--r-md)] border border-[var(--color-border)] bg-[var(--color-surface-alt)] p-3">
            <div className="text-sm text-[var(--color-muted)]">CLABE</div>
            <div className="text-xl font-bold tracking-wide break-all">{manual.spei.clabe}</div>
            {manual.spei.bank_name && <div className="text-sm mt-1">{manual.spei.bank_name}</div>}
            {manual.spei.account_holder && <div className="text-sm">{manual.spei.account_holder}</div>}
          </div>
        )}
        {manual.dimo && (
          <div className="mt-3 rounded-[var(--r-md)] border border-[var(--color-border)] bg-[var(--color-surface-alt)] p-3">
            <div className="text-sm text-[var(--color-muted)]">DiMo</div>
            <div className="text-xl font-bold">{manual.dimo.phone}</div>
          </div>
        )}
        <p className="text-sm text-[var(--color-muted)] mt-3">La tienda confirmará tu pago cuando le llegue la transferencia.</p>
      </div>
    )
  }

  if (kind === 'closed' && error) {
    return <p role="alert" className="mt-5 font-medium">{error}</p>
  }

  if (choices.length === 0) {
    return <p className="mt-5 text-[var(--color-muted)]">Esta tienda todavía no puede recibir pagos por aquí. Pregúntale cómo pagar.</p>
  }

  return (
    <div className="mt-5 flex flex-col gap-2">
      {choices.map((c, i) => (
        <Button key={c.id} variant={i === 0 ? 'primary' : 'secondary'} size="lg" className="w-full min-h-[52px]" loading={busy === c.id} disabled={busy !== null} onClick={() => pay(c.id)}>
          {kind === 'busy' ? `Intentar de nuevo con ${c.label}` : `Pagar con ${c.label}`}
        </Button>
      ))}
      {error && <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p>}
    </div>
  )
}
