'use client'

import { useState } from 'react'
import type { Dictionary } from '@/lib/dictionary'

/**
 * «Reportar» — a promoter sends what a merchant asked for, or what broke, in under a minute
 * (merchant-features-surfaced-by-promoter-kit D9). Not tied to a shop: a request can come at any time.
 */
export default function ReportStep({ copy }: { copy: Dictionary['promotorPanel'] }) {
  const t = copy.report
  const [category, setCategory] = useState<'feature' | 'bug'>('feature')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function send() {
    if (message.trim().length < 5) { setError(t.tooShort); return }
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/promoter/report', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, message }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) { setError(t.error); return }
      setDone(true); setMessage('')
    } catch { setError(copy.errors.network) }
    finally { setBusy(false) }
  }

  return (
    <section className="card-panel grid gap-3" style={{ padding: 'var(--s-5)' }} data-testid="promoter-report" aria-labelledby="promoter-report-title">
      <header className="grid gap-1">
        <h2 id="promoter-report-title" className="t-h3" style={{ margin: 0, letterSpacing: 0 }}>{t.title}</h2>
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{t.lead}</p>
      </header>
      {done ? (
        <p className="t-small" role="status" style={{ margin: 0, fontWeight: 600 }} data-testid="promoter-report-done">{t.done}</p>
      ) : null}
      <fieldset className="grid gap-2" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="block text-sm font-medium">{t.kind}</legend>
        <div className="flex flex-wrap gap-4">
          {(['feature', 'bug'] as const).map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input type="radio" name="report-kind" checked={category === k} onChange={() => { setCategory(k); setDone(false) }} />
              {t[k]}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block text-sm font-medium">{t.message}
        <textarea
          value={message}
          onChange={(e) => { setMessage(e.target.value); setDone(false) }}
          placeholder={t.placeholder}
          rows={3}
          maxLength={2000}
          className="mt-1 w-full rounded-lg border border-[var(--color-border)] px-3 py-2"
        />
      </label>
      {error && <p className="t-small" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p>}
      <button type="button" className="btn btn-secondary" onClick={send} disabled={busy || !message.trim()}>
        {busy ? t.busy : t.button}
      </button>
    </section>
  )
}
