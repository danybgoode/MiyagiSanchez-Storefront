'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { Dictionary, Locale } from '@/lib/dictionary'

type PublicUi = Dictionary['events']['public']
export type EventRegistrationStatus = 'open' | 'cancelled' | 'ended' | 'full'

/**
 * The registration card (name + email + code -> QR ticket) and the seat counters.
 * One component, two homes: the public page /e/[slug] and the PDP of a free Evento
 * (merchant-panel-gaps S2.1, D6) — so a free event registers, verifies and issues its
 * ticket exactly one way, wherever the buyer lands.
 */
export default function EventRegistrationPanel({
  slug,
  locale,
  ui,
  status,
  registeredCount,
  capacityRemaining,
}: {
  slug: string
  locale: Locale
  ui: PublicUi
  status: EventRegistrationStatus
  registeredCount: number
  capacityRemaining: number | null
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [sending, setSending] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState<'registered' | 'already' | null>(null)
  const [ticket, setTicket] = useState<{ token: string | null; qrUrl: string | null }>({ token: null, qrUrl: null })
  const [stats, setStats] = useState({ registeredCount, capacityRemaining })
  const [error, setError] = useState<string | null>(null)

  const disabled = status !== 'open'
  const errorText = error ? ui.errors[error as keyof typeof ui.errors] ?? ui.errors.unavailable : null

  async function sendCode() {
    setError(null)
    if (!email.trim()) { setError('invalid_email'); return }
    setSending(true)
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(slug)}/verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, locale }),
      })
      const data = await res.json() as {
        error?: string
        already_registered?: boolean
        ticket_token?: string | null
        ticket_qr_url?: string | null
      }
      if (!res.ok) { setError(data.error ?? 'unavailable'); return }
      if (data.already_registered) {
        setTicket({ token: data.ticket_token ?? null, qrUrl: data.ticket_qr_url ?? null })
        setSuccess('already')
      } else {
        setCodeSent(true)
      }
    } catch {
      setError('unavailable')
    } finally {
      setSending(false)
    }
  }

  async function submitRegistration(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!name.trim() || !email.trim() || !code.trim()) { setError('missing_fields'); return }
    setSubmitting(true)
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(slug)}/registrations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, code, locale }),
      })
      const data = await res.json() as {
        error?: string
        already_registered?: boolean
        ticket_token?: string | null
        ticket_qr_url?: string | null
        registered_count?: number
        capacity_remaining?: number | null
      }
      if (!res.ok) { setError(data.error ?? 'unavailable'); return }
      setStats({
        registeredCount: data.registered_count ?? stats.registeredCount,
        capacityRemaining: data.capacity_remaining ?? null,
      })
      setTicket({ token: data.ticket_token ?? null, qrUrl: data.ticket_qr_url ?? null })
      setSuccess(data.already_registered ? 'already' : 'registered')
    } catch {
      setError('unavailable')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="border border-[var(--color-border)] rounded-lg p-5 sm:p-6">
      {success ? (
        <div data-testid="event-registration-success">
          <h2 className="text-2xl font-bold">
            {success === 'already' ? ui.alreadyRegisteredTitle : ui.successTitle}
          </h2>
          <p className="text-sm text-[var(--color-muted)] leading-6 mt-3">{ui.successBody}</p>
          {ticket.token && (
            <div className="mt-5 rounded-lg border border-[var(--color-border)] p-4">
              <h3 className="font-semibold">{ui.ticketTitle}</h3>
              <p className="text-sm text-[var(--color-muted)] leading-6 mt-2">{ui.ticketBody}</p>
              {ticket.qrUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={ticket.qrUrl}
                  alt={ui.ticketTitle}
                  className="mt-4 w-40 h-40 border border-[var(--color-border)] rounded-lg"
                />
              )}
              <div className="mt-3 text-xs text-[var(--color-muted)]">{ui.ticketToken}</div>
              <code className="mt-1 block break-all text-sm bg-[var(--color-surface-alt)] rounded-lg px-3 py-2">
                {ticket.token}
              </code>
              {ticket.qrUrl && (
                <a href={ticket.qrUrl} className="mt-3 inline-flex px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm no-underline">
                  {ui.downloadTicketQr}
                </a>
              )}
            </div>
          )}
        </div>
      ) : (
        <form onSubmit={submitRegistration}>
          <h2 className="text-2xl font-bold">{ui.registerTitle}</h2>

          {status !== 'open' && (
            <p data-testid="event-status" className="mt-3 text-sm rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2">
              {status === 'full' ? ui.full : status === 'cancelled' ? ui.cancelled : ui.ended}
            </p>
          )}

          <div className="mt-5 space-y-4">
            <label className="block text-sm font-medium">
              {ui.name}
              <input data-testid="event-name-input" value={name} onChange={(e) => setName(e.target.value)} disabled={disabled} className="mt-1 w-full border border-[var(--color-border)] rounded-lg px-3 py-2 bg-[var(--color-background)]" />
            </label>
            <label className="block text-sm font-medium">
              {ui.email}
              <div className="mt-1 flex gap-2">
                <input data-testid="event-email-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={disabled} className="min-w-0 flex-1 border border-[var(--color-border)] rounded-lg px-3 py-2 bg-[var(--color-background)]" />
                <button data-testid="event-send-code" type="button" onClick={sendCode} disabled={disabled || sending} className="shrink-0 px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm font-semibold disabled:opacity-50">
                  {sending ? ui.sendingCode : ui.sendCode}
                </button>
              </div>
            </label>
            {codeSent && <p data-testid="event-code-sent" className="text-sm text-green-700">{ui.codeSent}</p>}
            <label className="block text-sm font-medium">
              {ui.code}
              <input data-testid="event-code-input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} disabled={disabled} className="mt-1 w-full border border-[var(--color-border)] rounded-lg px-3 py-2 bg-[var(--color-background)] font-mono tracking-wide" />
            </label>
          </div>

          {errorText && <p data-testid="event-error" className="mt-3 text-sm text-red-600">{errorText}</p>}

          <button data-testid="event-register-submit" disabled={disabled || submitting} className="mt-5 w-full bg-[var(--color-accent)] text-white rounded-lg px-4 py-3 text-sm font-semibold disabled:opacity-50">
            {submitting ? ui.submitting : ui.submit}
          </button>
        </form>
      )}

      <div className="mt-6 border-t border-[var(--color-border)] pt-5 grid grid-cols-2 gap-3">
        <div>
          <div className="text-xs text-[var(--color-muted)]">{ui.registeredCount}</div>
          <div data-testid="event-registered-count" className="text-2xl font-bold">{stats.registeredCount.toLocaleString(locale === 'en' ? 'en-US' : 'es-MX')}</div>
        </div>
        {stats.capacityRemaining != null && (
          <div>
            <div className="text-xs text-[var(--color-muted)]">{ui.capacityRemaining}</div>
            <div data-testid="event-capacity-remaining" className="text-2xl font-bold">{stats.capacityRemaining.toLocaleString(locale === 'en' ? 'en-US' : 'es-MX')}</div>
          </div>
        )}
      </div>

      <p className="text-xs text-[var(--color-muted)] mt-5">
        {ui.tosPrefix}{' '}
        <Link href={`/terminos?lang=${locale}`} className="underline">{ui.tosLink}</Link>
      </p>
    </section>
  )
}
