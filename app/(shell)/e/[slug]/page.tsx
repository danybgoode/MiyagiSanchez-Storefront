import Link from 'next/link'
import { getDictionary, normalizeLocale, type Locale } from '@/lib/dictionary'
import {
  eventLanguageHref,
  getEventBySlug,
  getEventStats,
  publicEventUrl,
} from '@/lib/events'
import { eventPublicStatus } from '@/lib/event-status'
import EventRegistrationClient from './EventRegistrationClient'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ lang?: string }>
}) {
  const { slug } = await params
  const { lang } = await searchParams
  const locale = normalizeLocale(lang)
  const event = await getEventBySlug(slug)
  if (!event) return { title: { absolute: 'Eventos - Miyagi Sánchez' } }
  const dict = await getDictionary(locale)
  return {
    title: event.title,
    description: event.description ?? dict.events.public.registerTitle,
  }
}

function formatDate(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleString(locale === 'en' ? 'en-US' : 'es-MX', {
    timeZone: 'America/Mexico_City',
    dateStyle: 'full',
    timeStyle: 'short',
  })
}

function StateMessage({ text, locale }: { text: string; locale: Locale }) {
  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-12 bg-[var(--color-background)]">
      <div className="max-w-md w-full border border-[var(--color-border)] rounded-lg p-6 text-center">
        <Link href={`/terminos?lang=${locale}`} className="text-xs text-[var(--color-muted)] no-underline hover:underline">
          miyagisanchez.com
        </Link>
        <h1 className="mt-4 text-xl font-semibold">{text}</h1>
      </div>
    </main>
  )
}

export default async function EventPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ lang?: string }>
}) {
  const [{ slug }, { lang }] = await Promise.all([params, searchParams])
  const locale = normalizeLocale(lang)
  const dict = await getDictionary(locale)
  const ui = dict.events.public
  const event = await getEventBySlug(slug)

  if (!event) return <StateMessage text={ui.notFound} locale={locale} />

  const stats = await getEventStats(event)
  const status = eventPublicStatus(event, stats)

  return (
    <EventRegistrationClient
      slug={event.slug}
      locale={locale}
      ui={ui}
      title={event.title}
      description={event.description}
      formattedDate={formatDate(event.starts_at, locale)}
      venueName={event.venue_name}
      venueAddress={event.venue_address}
      publicUrl={publicEventUrl(event.slug, locale)}
      languageHref={eventLanguageHref(event.slug, locale)}
      status={status}
      registeredCount={stats.registrations}
      capacityRemaining={stats.capacity_remaining}
    />
  )
}
