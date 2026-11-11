import 'server-only'

import { randomBytes } from 'crypto'
import { db } from '@/lib/supabase'
import { normalizeLocale, type Locale } from '@/lib/dictionary'
import { SHORTLINK_ORIGIN } from '@/lib/shortlink'
import {
  cleanEmail,
  hashSweepstakesEmail,
  hashVerificationCode,
  isValidEmail,
  makeCode,
  verificationCodeMatches,
} from '@/lib/sweepstakes'
import { sendEventRegistrationConfirmation, sendEventVerificationCode } from '@/lib/email'
import { absoluteTicketQrUrl, ensureFreeRegistrationTicket, ticketFromRegistration } from '@/lib/event-tickets'
import type { MarketplaceEvent, MarketplaceEventRegistration, MarketplaceEventStats } from '@/lib/events-types'

// Ticket QR verification links (absoluteTicketQrUrl below) deliberately stay on
// the platform origin — a door-scan verification surface, not a shareable link
// (out of the mschz-full-coverage US-1.3 scope).
const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com').replace(/\/+$/, '')
const CODE_TTL_MS = 15 * 60 * 1000

export { isValidEmail }
export { eventPublicStatus } from '@/lib/event-status'

// mschz-full-coverage (07, Sprint 1, US-1.3) — the public/shareable event URL is
// now the short branded form (mschz.org/e/…); the passthrough (US-1.1) 301s it
// to the identical /e/<slug> page on the platform origin.
export function publicEventUrl(slug: string, locale?: Locale): string {
  const url = `${SHORTLINK_ORIGIN}/e/${encodeURIComponent(slug)}`
  return locale === 'en' ? `${url}?lang=en` : url
}

export function eventLanguageHref(slug: string, locale: Locale): string {
  return locale === 'en' ? `/e/${encodeURIComponent(slug)}?lang=es` : `/e/${encodeURIComponent(slug)}?lang=en`
}

export function slugifyEvent(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    || `evento-${randomBytes(3).toString('hex')}`
}

export async function uniqueEventSlug(input: string): Promise<string> {
  const base = slugifyEvent(input)
  for (let i = 0; i < 20; i++) {
    const slug = i === 0 ? base : `${base}-${randomBytes(2).toString('hex')}`
    const { data } = await db
      .from('marketplace_events')
      .select('id')
      .eq('slug', slug)
      .maybeSingle()
    if (!data) return slug
  }
  return `${base}-${Date.now().toString(36)}`
}

export async function getEventBySlug(slug: string): Promise<MarketplaceEvent | null> {
  const { data, error } = await db
    .from('marketplace_events')
    .select('*')
    .eq('slug', slug)
    .maybeSingle()
  if (error || !data) return null
  return data as MarketplaceEvent
}

export async function getEventStats(event: Pick<MarketplaceEvent, 'id' | 'capacity'>): Promise<MarketplaceEventStats> {
  const { count } = await db
    .from('marketplace_event_registrations')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', event.id)
    .eq('status', 'registered')
    .not('verified_at', 'is', null)

  const registrations = count ?? 0
  const capacityRemaining = event.capacity == null ? null : Math.max(0, event.capacity - registrations)
  return {
    registrations,
    capacity_remaining: capacityRemaining,
    full: capacityRemaining === 0,
  }
}

export function eventRegistrationIsOpen(event: Pick<MarketplaceEvent, 'status' | 'starts_at'>, now = new Date()): boolean {
  if (event.status !== 'active') return false
  return new Date(event.starts_at).getTime() > now.getTime()
}

export async function createOrRefreshEventVerification(input: {
  event: MarketplaceEvent
  email: string
  locale?: string | null
  codeOverride?: string
  sendEmail?: boolean
}): Promise<{
  alreadyRegistered: boolean
  capacityFull: boolean
  registrationId?: string
  ticket_token?: string | null
  ticket_qr_url?: string | null
}> {
  const email = cleanEmail(input.email)
  const locale = normalizeLocale(input.locale)
  const emailHash = hashSweepstakesEmail(email)

  const { data: existing } = await db
    .from('marketplace_event_registrations')
    .select('*')
    .eq('event_id', input.event.id)
    .eq('email_hash', emailHash)
    .maybeSingle()

  if ((existing as MarketplaceEventRegistration | null)?.status === 'registered') {
    const ticketed = await ensureFreeRegistrationTicket({
      event: input.event,
      registration: existing as MarketplaceEventRegistration,
    })
    const ticket = ticketFromRegistration(ticketed)
    return {
      alreadyRegistered: true,
      capacityFull: false,
      registrationId: ticketed.id,
      ticket_token: ticket?.token ?? null,
      ticket_qr_url: ticket ? absoluteTicketQrUrl(SITE_URL, ticket.token) : null,
    }
  }

  const stats = await getEventStats(input.event)
  if (stats.full) return { alreadyRegistered: false, capacityFull: true }

  const code = input.codeOverride ?? makeCode()
  const now = new Date().toISOString()
  const { data, error } = await db
    .from('marketplace_event_registrations')
    .upsert({
      event_id: input.event.id,
      email,
      email_hash: emailHash,
      locale,
      status: 'pending',
      verification_code_hash: hashVerificationCode(input.event.id, emailHash, code),
      verification_expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
      verification_attempts: 0,
      verification_sent_at: now,
    }, { onConflict: 'event_id,email_hash' })
    .select('id')
    .single()

  if (error || !data) throw new Error(error?.message ?? 'event verification failed')

  if (input.sendEmail !== false) {
    await sendEventVerificationCode({
      to: email,
      code,
      locale,
      eventTitle: input.event.title,
      eventUrl: publicEventUrl(input.event.slug, locale),
    })
  }

  return { alreadyRegistered: false, capacityFull: false, registrationId: data.id as string }
}

export async function verifyEventRegistration(input: {
  event: MarketplaceEvent
  email: string
  code: string
  name: string
  locale?: string | null
  sendConfirmation?: boolean
}): Promise<{
  ok: boolean
  alreadyRegistered?: boolean
  capacityFull?: boolean
  error?: 'invalid_code' | 'capacity_full'
  registration?: MarketplaceEventRegistration
  ticket_token?: string | null
  ticket_qr_url?: string | null
  stats?: MarketplaceEventStats
}> {
  const email = cleanEmail(input.email)
  const locale = normalizeLocale(input.locale)
  const emailHash = hashSweepstakesEmail(email)
  const { data } = await db
    .from('marketplace_event_registrations')
    .select('*')
    .eq('event_id', input.event.id)
    .eq('email_hash', emailHash)
    .maybeSingle()

  const registration = data as MarketplaceEventRegistration | null
  if (!registration) return { ok: false, error: 'invalid_code' }

  if (registration.status === 'registered' && registration.verified_at) {
    const ticketed = await ensureFreeRegistrationTicket({ event: input.event, registration })
    const ticket = ticketFromRegistration(ticketed)
    return {
      ok: true,
      alreadyRegistered: true,
      registration: ticketed,
      ticket_token: ticket?.token ?? null,
      ticket_qr_url: ticket ? absoluteTicketQrUrl(SITE_URL, ticket.token) : null,
      stats: await getEventStats(input.event),
    }
  }

  const expired = !registration.verification_expires_at || new Date(registration.verification_expires_at).getTime() < Date.now()
  const attempts = registration.verification_attempts ?? 0
  const codeHash = registration.verification_code_hash
  const matches = !!codeHash && verificationCodeMatches(input.event.id, emailHash, input.code, codeHash)

  await db
    .from('marketplace_event_registrations')
    .update({ verification_attempts: attempts + 1 })
    .eq('id', registration.id)

  if (expired || attempts >= 5 || !matches) return { ok: false, error: 'invalid_code' }

  const statsBefore = await getEventStats(input.event)
  if (statsBefore.full) return { ok: false, capacityFull: true, error: 'capacity_full' }

  const now = new Date().toISOString()
  const { data: updated, error } = await db
    .from('marketplace_event_registrations')
    .update({
      name: input.name.trim(),
      email,
      locale,
      status: 'registered',
      verified_at: now,
      verification_code_hash: null,
      verification_expires_at: null,
    })
    .eq('id', registration.id)
    .select('*')
    .single()

  if (error || !updated) throw new Error(error?.message ?? 'event registration failed')

  const typed = await ensureFreeRegistrationTicket({
    event: input.event,
    registration: updated as MarketplaceEventRegistration,
    now,
  })
  const ticket = ticketFromRegistration(typed)
  if (input.sendConfirmation !== false) {
    await sendEventRegistrationConfirmation({
      to: email,
      locale,
      eventTitle: input.event.title,
      eventUrl: publicEventUrl(input.event.slug, locale),
      ticketToken: ticket?.token ?? null,
      ticketQrUrl: ticket ? absoluteTicketQrUrl(SITE_URL, ticket.token) : null,
      startsAt: input.event.starts_at,
      venueName: input.event.venue_name,
      venueAddress: input.event.venue_address,
    })
    await db
      .from('marketplace_event_registrations')
      .update({ confirmation_sent_at: new Date().toISOString() })
      .eq('id', typed.id)
  }

  return {
    ok: true,
    registration: typed,
    ticket_token: ticket?.token ?? null,
    ticket_qr_url: ticket ? absoluteTicketQrUrl(SITE_URL, ticket.token) : null,
    stats: await getEventStats(input.event),
  }
}
