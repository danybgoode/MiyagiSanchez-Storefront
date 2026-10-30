'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { payFailureKind, type PayChoice } from '@/lib/in-person/payment-link'
import { ATTEMPT_TTL_MS, attemptKey, parseAttempt, resumeDecision, usableAttempt, type PayAttempt } from '@/lib/in-person/pay-attempt'
import type { ManualPayment } from '@/lib/in-person/counter-checkout'

/** Clock read for handlers (kept out of the render path). */
const clock = () => Date.now()

function ManualInstructions({ manual, amount }: { manual: ManualPayment; amount: string }) {
  return (
    <div className="mt-5">
      <h2 className="text-lg font-bold">Haz tu transferencia</h2>
      <p className="text-2xl font-bold mt-1">{amount}</p>
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

/**
 * «Pagar»: asks the server to open a fresh cart for this link, then goes to the provider or shows the
 * transfer data. The last successful start is kept in sessionStorage for this token (31 minutes) so a
 * refresh, a back-out or a held single-use link offers «Continuar con tu pago» instead of starting over.
 */
export default function PayClient({ token, choices, totalCents, currency }: { token: string; choices: PayChoice[]; totalCents: number; currency: string }) {
  const [busy, setBusy] = useState<PayChoice['id'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [manual, setManual] = useState<ManualPayment | null>(null)
  const [kind, setKind] = useState<'closed' | 'busy' | 'retry'>('retry')
  const [attempt, setAttempt] = useState<PayAttempt | null>(null)
  const amount = new Intl.NumberFormat('es-MX', { style: 'currency', currency: currency || 'MXN' }).format(totalCents / 100)

  useEffect(() => {
    queueMicrotask(() => {
      try { setAttempt(parseAttempt(window.sessionStorage.getItem(attemptKey(token)), clock())) } catch { /* no storage: start over */ }
    })
  }, [token])

  // Clear a stored attempt the moment its hold lapses, so «Continuar con tu pago» never
  // outlives it (codex, PR 461 round 3: the offer stayed and the click then did nothing).
  useEffect(() => {
    if (!attempt) return
    const left = attempt.at + ATTEMPT_TTL_MS - clock()
    if (left <= 0) { queueMicrotask(() => setAttempt(null)); return }
    const t = window.setTimeout(() => setAttempt(null), left)
    return () => window.clearTimeout(t)
  }, [attempt])

  function remember(a: PayAttempt) {
    setAttempt(a)
    try { window.sessionStorage.setItem(attemptKey(token), JSON.stringify(a)) } catch { /* ignore */ }
  }

  function resume(a: PayAttempt) {
    // The hold may have lapsed while the page sat open: re-check at the click, else start over.
    // Lapsed between the timer's tick and the click: drop it and SAY so — the method
    // buttons return; never start a payment with a method the buyer did not pick.
    if (!usableAttempt(a, clock())) {
      setAttempt(null)
      setKind('retry')
      setError('Tu intento anterior expiró. Elige cómo pagar.')
      return
    }
    if (a.redirect_url) window.location.assign(a.redirect_url)
    else if (a.manual) setManual(a.manual)
  }

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
      if (res.ok && json?.redirect_url) { remember({ at: clock(), redirect_url: json.redirect_url }); window.location.assign(json.redirect_url); return }
      if (res.ok && json?.manual_payment) { remember({ at: clock(), manual: json.manual_payment }); setManual(json.manual_payment); return }
      setKind(payFailureKind(json?.code))
      setError(json?.message ?? 'No pudimos preparar el pago. Inténtalo de nuevo.')
    } catch {
      setError('Sin conexión. Inténtalo de nuevo.')
    } finally {
      setBusy(null)
    }
  }

  if (manual) return <ManualInstructions manual={manual} amount={amount} />

  if (kind === 'closed' && error) {
    return <p role="alert" className="mt-5 font-medium">{error}</p>
  }

  // `attempt` was already validated for freshness when it was read; the decision re-checks at the instant of render.
  const decision = resumeDecision({ attempt, now: attempt ? attempt.at : 0, failure: kind })

  if (choices.length === 0 && decision !== 'continue') {
    return <p className="mt-5 text-[var(--color-muted)]">Esta tienda todavía no puede recibir pagos por aquí. Pregúntale cómo pagar.</p>
  }

  return (
    <div className="mt-5 flex flex-col gap-2">
      {decision === 'continue' && attempt && (
        <Button variant="primary" size="lg" className="w-full min-h-[52px]" onClick={() => resume(attempt)}>
          Continuar con tu pago
        </Button>
      )}
      {choices.map((c, i) => (
        <Button key={c.id} variant={i === 0 && decision !== 'continue' ? 'primary' : 'secondary'} size="lg" className="w-full min-h-[52px]" loading={busy === c.id} disabled={busy !== null} onClick={() => pay(c.id)}>
          {decision === 'busy_retry' ? `Intentar de nuevo con ${c.label}` : decision === 'continue' ? `Empezar otra vez con ${c.label}` : `Pagar con ${c.label}`}
        </Button>
      ))}
      {error && <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p>}
    </div>
  )
}
