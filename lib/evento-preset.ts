/**
 * lib/evento-preset.ts — «Evento» as ONE wizard choice, free or paid (merchant-panel-gaps S2.1, D5/D6).
 *
 * Pure and next-free (a Playwright `api` spec imports it). «Evento» is a PRESET over
 * `listing_type: 'service'` with the event block and «Lugares disponibles» required — never a new
 * listing_type (that would ripple through every renderer, filter and UCP schema).
 *
 * A PAID Evento is an ordinary service listing whose seats are tracked Medusa inventory (S1.1) and
 * which is bought through checkout. A FREE ($0) Evento reuses the RSVP machinery unchanged: the create
 * route also writes a `marketplace_events` row and stores its slug in the listing's
 * `metadata.rsvp_event_slug`; the PDP then renders the registration form instead of a buy box.
 * Its seats are that row's `capacity` — the number the registration flow already counts against — so
 * the free listing sends NO quantity to Medusa (a tracked count nothing would ever decrement would
 * show «N disponibles» forever).
 */
import { hasEventBlock } from './event-seats'

/** `/sell?tipo=evento` preselects the Evento preset. */
export const EVENTO_TIPO = 'evento'

export function isEventoTipo(value: string | string[] | null | undefined): boolean {
  const v = Array.isArray(value) ? value[0] : value
  return typeof v === 'string' && v.trim().toLowerCase() === EVENTO_TIPO
}

/** Price for an Evento: 0 is allowed (a free event); blank, negative or non-numeric is not. */
export function parseEventoPriceCents(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').replace(/\s/g, '')
  if (cleaned === '') return null
  const num = Number(cleaned)
  if (!Number.isFinite(num) || num < 0) return null
  return Math.round(num * 100)
}

export interface EventoFormInput {
  attrs: Record<string, unknown>
  seatsRaw: string
  priceRaw: string
}

function filled(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

/** Required fields of the Evento preset: date, time, venue, Cupo and a price of $0 or more. */
export function eventoErrors(input: EventoFormInput): Record<string, string> {
  const errs: Record<string, string> = {}
  if (!filled(input.attrs.event_date)) errs.event_date = 'Indica la fecha del evento.'
  if (!filled(input.attrs.event_time)) errs.event_time = 'Indica la hora del evento.'
  if (!filled(input.attrs.venue_name)) errs.venue_name = 'Indica el lugar del evento.'
  const seats = input.seatsRaw.trim()
  if (seats === '' || !/^\d+$/.test(seats)) {
    errs.seats = 'Indica cuántos lugares hay disponibles.'
  } else if (Number.parseInt(seats, 10) < 1) {
    errs.seats = 'Un evento nuevo necesita al menos 1 lugar disponible.'
  }
  if (parseEventoPriceCents(input.priceRaw) === null) {
    errs.price = 'Ingresa el precio, o $0 si es gratis.'
  }
  return errs
}

/**
 * A free Evento, as the create route sees it: a service with the event block and a price of exactly 0.
 * The wizard refuses a $0 price for everything else, so 0 + event block is the unambiguous signature.
 */
export function isFreeEventListing(listing: {
  listing_type?: string | null
  price_cents?: number | null
  attrs?: Record<string, unknown> | null
}): boolean {
  return listing.listing_type === 'service' && listing.price_cents === 0 && hasEventBlock(listing.attrs)
}

/**
 * `event_date` + `event_time` → the instant the RSVP row stores. The wall clock is Mexico City, which has
 * had no daylight-saving time since 2022 (a fixed UTC-6), so the offset is a constant rather than a
 * timezone lookup. Null when either part is missing or malformed.
 */
export function eventStartsAt(attrs: Record<string, unknown> | null | undefined): string | null {
  const date = typeof attrs?.event_date === 'string' ? attrs.event_date.trim() : ''
  const time = typeof attrs?.event_time === 'string' ? attrs.event_time.trim() : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null
  const d = new Date(`${date}T${time}:00-06:00`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export interface RsvpEventDraft {
  title: string
  description: string | null
  starts_at: string
  venue_name: string
  venue_address: string | null
  capacity: number
}

export type RsvpEventDraftResult =
  | { ok: true; draft: RsvpEventDraft }
  | { ok: false; error: string; field: 'event_date' | 'venue_name' | 'quantity' }

/** The `marketplace_events` row for a free Evento (same title, venue and start as the listing). */
export function buildRsvpEventDraft(listing: {
  title: string
  description?: string | null
  quantity?: number | null
  attrs?: Record<string, unknown> | null
}): RsvpEventDraftResult {
  const attrs = listing.attrs ?? {}
  const startsAt = eventStartsAt(attrs)
  if (!startsAt) return { ok: false, field: 'event_date', error: 'Un evento gratis necesita fecha y hora.' }
  const venue = typeof attrs.venue_name === 'string' ? attrs.venue_name.trim() : ''
  if (!venue) return { ok: false, field: 'venue_name', error: 'Un evento gratis necesita el lugar.' }
  const seats = listing.quantity
  // marketplace_events.capacity is CHECK (capacity > 0): a free event with no seat could not be stored.
  if (typeof seats !== 'number' || !Number.isInteger(seats) || seats < 1) {
    return { ok: false, field: 'quantity', error: 'Un evento gratis necesita al menos 1 lugar disponible.' }
  }
  const address = typeof attrs.venue_address === 'string' ? attrs.venue_address.trim() : ''
  return {
    ok: true,
    draft: {
      title: listing.title.trim().slice(0, 100),
      description: listing.description?.trim() || null,
      starts_at: startsAt,
      venue_name: venue,
      venue_address: address || null,
      capacity: Math.min(100000, seats),
    },
  }
}

/** The RSVP slug a listing carries, or null. Reads `metadata.rsvp_event_slug` and nothing else. */
export function rsvpEventSlug(metadata: Record<string, unknown> | null | undefined): string | null {
  const v = metadata?.rsvp_event_slug
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Where «Nuevo evento» sends a merchant (D7). */
export const NEW_EVENT_HREF = '/sell?tipo=evento'
/** Where the roster page sends a merchant who has no events (D7). */
export const EVENTS_EMPTY_REDIRECT = '/shop/manage/catalogo'

/** The price line of a free Evento's PDP (its listing carries a price of 0, which would read «a convenir»). */
export const FREE_EVENT_PRICE_LABEL = 'Gratis'
