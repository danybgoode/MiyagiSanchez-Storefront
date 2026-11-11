'use client'

import { useSellerFormat } from '@/app/components/SellerFormatProvider'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import type { Dictionary } from '@/lib/dictionary'
import type { MarketplaceEvent, MarketplaceEventStats } from '@/lib/events-types'
import { NEW_EVENT_HREF } from '@/lib/evento-preset'

type SellerUi = Dictionary['events']['seller']
type EventWithStats = MarketplaceEvent & { public_url: string; stats: MarketplaceEventStats }

type FormState = {
  id?: string
  title: string
  description: string
  starts_at: string
  venue_name: string
  venue_address: string
  capacity: string
  status: 'active' | 'cancelled'
}

const emptyForm: FormState = {
  title: '',
  description: '',
  starts_at: '',
  venue_name: '',
  venue_address: '',
  capacity: '',
  status: 'active',
}

function toInputDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const offset = d.getTimezoneOffset()
  const local = new Date(d.getTime() - offset * 60000)
  return local.toISOString().slice(0, 16)
}

function fromInputDate(value: string): string | null {
  if (!value) return null
  return new Date(value).toISOString()
}

function formFromEvent(event: EventWithStats): FormState {
  return {
    id: event.id,
    title: event.title,
    description: event.description ?? '',
    starts_at: toInputDate(event.starts_at),
    venue_name: event.venue_name,
    venue_address: event.venue_address ?? '',
    capacity: event.capacity == null ? '' : String(event.capacity),
    status: event.status,
  }
}

export default function EventsManager({
  ui,
  initialEvents,
}: {
  ui: SellerUi
  initialEvents: EventWithStats[]
}) {
  const fmt = useSellerFormat()
  // An event's start time is a WALL CLOCK where the event happens, so the zone
  // follows the shop's market (`MARKETS[…].timezone`) and never the language —
  // America/Mexico_City for an MX shop, exactly the literal that was here.
  const formatDate = (iso: string) =>
    fmt.date(iso, { timeZone: fmt.timeZone, dateStyle: 'medium', timeStyle: 'short' })
  const [events, setEvents] = useState(initialEvents)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const editing = !!form.id
  const selectedEvent = useMemo(
    () => form.id ? events.find(event => event.id === form.id) : null,
    [events, form.id],
  )

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  function payload() {
    return {
      title: form.title,
      description: form.description || null,
      starts_at: fromInputDate(form.starts_at),
      venue_name: form.venue_name,
      venue_address: form.venue_address || null,
      capacity: form.capacity || null,
      status: form.status,
    }
  }

  async function reload() {
    const res = await fetch('/api/sell/events')
    const data = await res.json() as { events?: EventWithStats[] }
    setEvents(data.events ?? [])
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError(null); setMessage(null)
    try {
      const res = await fetch(form.id ? `/api/sell/events/${form.id}` : '/api/sell/events', {
        method: form.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload()),
      })
      const data = await res.json() as { event?: EventWithStats; error?: string }
      if (!res.ok || !data.event) { setError(data.error ?? ui.error); return }
      setMessage(ui.saved)
      setForm(formFromEvent(data.event))
      await reload()
    } catch {
      setError(ui.error)
    } finally {
      setSaving(false)
    }
  }

  async function copyPublic(url: string) {
    await navigator.clipboard.writeText(url)
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold">{ui.title}</h1>
          <p className="text-sm text-[var(--color-muted)] mt-1">{ui.subtitle}</p>
        </div>
        {/* A new event starts in the wizard, like every other listing (merchant-panel-gaps D7). */}
        <Link
          href={NEW_EVENT_HREF}
          data-testid="new-event-link"
          className="px-4 py-2 rounded-[var(--r-md)] bg-[var(--color-accent)] text-white text-sm font-semibold no-underline"
        >
          {ui.newEvent}
        </Link>
      </div>

      {message && <p className="mb-4 text-sm text-green-700">{message}</p>}
      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      <div className={`grid grid-cols-1 gap-6 ${editing ? 'lg:grid-cols-[1fr_0.95fr]' : ''}`}>
        {editing && <form onSubmit={save} className="border border-[var(--color-border)] rounded-[var(--r-md)] p-5">
          <h2 className="font-semibold mb-4">{editing ? ui.edit : ui.newEvent}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block text-sm font-medium sm:col-span-2">
              {ui.titleLabel}
              <input value={form.title} onChange={e => set('title', e.target.value)} className="mt-1 w-full border border-[var(--color-border)] rounded-[var(--r-md)] px-3 py-2 bg-[var(--color-background)]" />
            </label>
            <label className="block text-sm font-medium sm:col-span-2">
              {ui.description}
              <textarea value={form.description} onChange={e => set('description', e.target.value)} rows={4} className="mt-1 w-full border border-[var(--color-border)] rounded-[var(--r-md)] px-3 py-2 bg-[var(--color-background)]" />
            </label>
            <label className="block text-sm font-medium">
              {ui.startsAt}
              <input type="datetime-local" value={form.starts_at} onChange={e => set('starts_at', e.target.value)} className="mt-1 w-full border border-[var(--color-border)] rounded-[var(--r-md)] px-3 py-2 bg-[var(--color-background)]" />
            </label>
            <label className="block text-sm font-medium">
              {ui.capacity}
              <input type="number" min="1" value={form.capacity} onChange={e => set('capacity', e.target.value)} placeholder="120" className="mt-1 w-full border border-[var(--color-border)] rounded-[var(--r-md)] px-3 py-2 bg-[var(--color-background)]" />
              <span className="block text-xs text-[var(--color-muted)] mt-1">{ui.capacityHint}</span>
            </label>
            <label className="block text-sm font-medium">
              {ui.venueName}
              <input value={form.venue_name} onChange={e => set('venue_name', e.target.value)} className="mt-1 w-full border border-[var(--color-border)] rounded-[var(--r-md)] px-3 py-2 bg-[var(--color-background)]" />
            </label>
            <label className="block text-sm font-medium">
              {ui.venueAddress}
              <input value={form.venue_address} onChange={e => set('venue_address', e.target.value)} className="mt-1 w-full border border-[var(--color-border)] rounded-[var(--r-md)] px-3 py-2 bg-[var(--color-background)]" />
            </label>
            {editing && (
              <label className="block text-sm font-medium">
                {ui.statusLabel}
                <select value={form.status} onChange={e => set('status', e.target.value as FormState['status'])} className="mt-1 w-full border border-[var(--color-border)] rounded-[var(--r-md)] px-3 py-2 bg-[var(--color-background)]">
                  <option value="active">{ui.statusActive}</option>
                  <option value="cancelled">{ui.statusCancelled}</option>
                </select>
              </label>
            )}
          </div>
          <button disabled={saving} className="mt-5 bg-[var(--color-accent)] text-white rounded-[var(--r-md)] px-4 py-2 text-sm font-semibold disabled:opacity-50">
            {saving ? ui.saving : ui.save}
          </button>
        </form>}

        <section className="border border-[var(--color-border)] rounded-[var(--r-md)] p-5">
          <h2 className="font-semibold mb-4">{ui.events}</h2>
          {events.length === 0 ? (
            <p className="text-sm text-[var(--color-muted)]">{ui.empty}</p>
          ) : (
            <div className="space-y-3">
              {events.map(event => {
                const selected = selectedEvent?.id === event.id
                return (
                  <div key={event.id} className={`border border-[var(--color-border)] rounded-[var(--r-md)] p-4 ${selected ? 'bg-[var(--color-surface-alt)]' : ''}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="font-semibold truncate">{event.title}</h3>
                        <p className="text-sm text-[var(--color-muted)] mt-1">{formatDate(event.starts_at)} · {event.venue_name}</p>
                      </div>
                      <span className="text-xs rounded-[var(--r-pill)] px-2 py-1 bg-[var(--color-surface-alt)] text-[var(--color-muted)]">
                        {event.status === 'active' ? ui.statusActive : ui.statusCancelled}
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <div className="text-xs text-[var(--color-muted)]">{ui.registrations}</div>
                        <div className="font-semibold">{fmt.number(event.stats.registrations)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-[var(--color-muted)]">{ui.capacityLabel}</div>
                        <div className="font-semibold">{event.capacity == null ? ui.unlimited : fmt.number(event.capacity)}</div>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Link href={`/e/${event.slug}`} target="_blank" className="text-xs px-3 py-2 rounded-[var(--r-md)] border border-[var(--color-border)] no-underline">{ui.viewPublic}</Link>
                      <Link href={`/shop/manage/eventos/${event.id}`} className="text-xs px-3 py-2 rounded-[var(--r-md)] border border-[var(--color-border)] no-underline">{ui.roster}</Link>
                      <button type="button" onClick={() => copyPublic(event.public_url)} className="text-xs px-3 py-2 rounded-[var(--r-md)] border border-[var(--color-border)]">{ui.copyLink}</button>
                      <a href={`/api/sell/events/${event.id}/qr`} className="text-xs px-3 py-2 rounded-[var(--r-md)] border border-[var(--color-border)] no-underline">{ui.downloadQr}</a>
                      <button type="button" onClick={() => { setForm(formFromEvent(event)); setMessage(null); setError(null) }} className="text-xs px-3 py-2 rounded-[var(--r-md)] border border-[var(--color-border)]">{ui.edit}</button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
