'use client'

import Link from 'next/link'
import type { Dictionary, Locale } from '@/lib/dictionary'
import EventRegistrationPanel, { type EventRegistrationStatus } from './EventRegistrationPanel'

type PublicUi = Dictionary['events']['public']
type Status = EventRegistrationStatus

export default function EventRegistrationClient({
  slug,
  locale,
  ui,
  title,
  description,
  formattedDate,
  venueName,
  venueAddress,
  publicUrl,
  languageHref,
  status,
  registeredCount,
  capacityRemaining,
}: {
  slug: string
  locale: Locale
  ui: PublicUi
  title: string
  description: string | null
  formattedDate: string
  venueName: string
  venueAddress: string | null
  publicUrl: string
  languageHref: string
  status: Status
  registeredCount: number
  capacityRemaining: number | null
}) {
  const shareText = `${title} ${publicUrl}`

  async function copyPublicUrl() {
    try { await navigator.clipboard.writeText(publicUrl) } catch {}
  }

  return (
    <main className="min-h-screen bg-[var(--color-background)]">
      <div className="max-w-5xl mx-auto px-4 py-6 sm:py-10">
        <div className="flex items-center justify-between gap-4 mb-8">
          <Link href="/" className="font-semibold no-underline text-sm">miyagisanchez.com</Link>
          <Link href={languageHref} className="text-sm border border-[var(--color-border)] rounded-lg px-3 py-2 no-underline hover:bg-[var(--color-surface-alt)]">
            {ui.language}
          </Link>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-8 items-start">
          <section>
            <p className="text-xs uppercase tracking-wide text-[var(--color-muted)] font-semibold mb-3">{ui.eventDate}</p>
            <h1 data-testid="event-title" className="text-3xl sm:text-5xl font-bold leading-tight">{title}</h1>
            {description && <p className="text-base text-[var(--color-muted)] leading-7 mt-4">{description}</p>}

            <dl className="mt-7 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="border border-[var(--color-border)] rounded-lg p-4">
                <dt className="text-xs uppercase tracking-wide text-[var(--color-muted)] font-semibold">{ui.eventDate}</dt>
                <dd data-testid="event-date" className="mt-2 font-semibold">{formattedDate}</dd>
              </div>
              <div className="border border-[var(--color-border)] rounded-lg p-4">
                <dt className="text-xs uppercase tracking-wide text-[var(--color-muted)] font-semibold">{ui.venue}</dt>
                <dd data-testid="event-venue" className="mt-2 font-semibold">{venueName}</dd>
                {venueAddress && <dd className="text-sm text-[var(--color-muted)] mt-1">{venueAddress}</dd>}
              </div>
            </dl>

            <div className="mt-6 flex flex-wrap gap-2">
              <a className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm no-underline" href={`https://wa.me/?text=${encodeURIComponent(shareText)}`} target="_blank" rel="noreferrer">{ui.whatsapp}</a>
              <button type="button" onClick={copyPublicUrl} className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm">{ui.copyLink}</button>
            </div>
          </section>

          <EventRegistrationPanel
            slug={slug}
            locale={locale}
            ui={ui}
            status={status}
            registeredCount={registeredCount}
            capacityRemaining={capacityRemaining}
          />
        </div>
      </div>
    </main>
  )
}
