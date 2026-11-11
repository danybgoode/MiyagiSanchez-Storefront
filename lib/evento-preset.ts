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

/** Most seats one Evento can hold. Refused above this — never silently capped. */
export const MAX_EVENT_SEATS = 100000
export const EVENT_SEATS_TOO_MANY_MESSAGE = 'Un evento puede tener hasta 100,000 lugares. Indica una cantidad menor.'

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
  } else if (Number.parseInt(seats, 10) > MAX_EVENT_SEATS) {
    errs.seats = EVENT_SEATS_TOO_MANY_MESSAGE
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

/** The zone Mexico City keeps; also the fallback when a state is unknown or unlisted. */
export const DEFAULT_EVENT_TIME_ZONE = 'America/Mexico_City'

/**
 * States whose wall clock is NOT Mexico City's. Everything else (the great majority) keeps
 * America/Mexico_City, so only the exceptions are listed — and as IANA zone NAMES, never offsets: the
 * offsets (and Baja California's daylight-saving rule) come from `Intl`, which knows the tz database.
 * Border municipalities of Chihuahua/Coahuila/Nuevo León/Tamaulipas that follow US DST are a
 * municipality-level exception a state cannot express; they fall back to Mexico City.
 */
const STATE_TIME_ZONES: Record<string, string> = {
  'quintana roo': 'America/Cancun', // UTC-5, no DST
  sonora: 'America/Hermosillo', // UTC-7, no DST
  sinaloa: 'America/Mazatlan', // UTC-7
  nayarit: 'America/Mazatlan', // UTC-7
  'baja california sur': 'America/Mazatlan', // UTC-7
  'baja california': 'America/Tijuana', // UTC-8, US-style DST (UTC-7 in summer)
}

function stateKey(state: string): string {
  return state.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
}

/** The IANA time zone for a Mexican state's display name; Mexico City when unknown, blank or unlisted. */
export function eventTimeZoneForState(state: string | null | undefined): string {
  if (typeof state !== 'string' || !state.trim()) return DEFAULT_EVENT_TIME_ZONE
  return STATE_TIME_ZONES[stateKey(state)] ?? DEFAULT_EVENT_TIME_ZONE
}

/** Offset (ms, east positive) of `timeZone` at the instant `utcMs`, read from Intl. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const n = (t: string) => Number(parts.find(p => p.type === t)?.value)
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'))
  return asUtc - Math.floor(utcMs / 1000) * 1000
}

/**
 * `event_date` + `event_time` → the instant the RSVP row stores. The wall clock is that of the listing's
 * `state` (see `eventTimeZoneForState`), falling back to Mexico City when the state is unknown. Resolved
 * with Intl time-zone math, so daylight-saving zones (Baja California) are right on either side of a
 * change. Null when either part is missing or malformed.
 */
export function eventStartsAt(
  attrs: Record<string, unknown> | null | undefined,
  state?: string | null,
): string | null {
  const date = typeof attrs?.event_date === 'string' ? attrs.event_date.trim() : ''
  const time = typeof attrs?.event_time === 'string' ? attrs.event_time.trim() : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null
  const wall = new Date(`${date}T${time}:00Z`).getTime() // the wall clock read as if it were UTC
  if (Number.isNaN(wall)) return null
  // `Date` rolls an impossible day over (2026-02-31 → 2026-03-03) and an hour like 24:30 into the next
  // day; read the parts back and refuse anything that moved (codex review #491).
  if (new Date(wall).toISOString().slice(0, 16) !== `${date}T${time}`) return null
  const zone = eventTimeZoneForState(state)
  // Two passes: the offset at the guessed instant can differ from the offset at the true one right at a
  // DST change.
  let utc = wall - zoneOffsetMs(wall, zone)
  utc = wall - zoneOffsetMs(utc, zone)
  return new Date(utc).toISOString()
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
  /** The listing's `state` display name — picks the wall-clock time zone. */
  state?: string | null
}): RsvpEventDraftResult {
  const attrs = listing.attrs ?? {}
  const startsAt = eventStartsAt(attrs, listing.state)
  if (!startsAt) return { ok: false, field: 'event_date', error: 'Un evento gratis necesita fecha y hora.' }
  const venue = typeof attrs.venue_name === 'string' ? attrs.venue_name.trim() : ''
  if (!venue) return { ok: false, field: 'venue_name', error: 'Un evento gratis necesita el lugar.' }
  const seats = listing.quantity
  // marketplace_events.capacity is CHECK (capacity > 0): a free event with no seat could not be stored.
  if (typeof seats !== 'number' || !Number.isInteger(seats) || seats < 1) {
    return { ok: false, field: 'quantity', error: 'Un evento gratis necesita al menos 1 lugar disponible.' }
  }
  if (seats > MAX_EVENT_SEATS) return { ok: false, field: 'quantity', error: EVENT_SEATS_TOO_MANY_MESSAGE }
  const address = typeof attrs.venue_address === 'string' ? attrs.venue_address.trim() : ''
  return {
    ok: true,
    draft: {
      title: listing.title.trim().slice(0, 100),
      description: listing.description?.trim() || null,
      starts_at: startsAt,
      venue_name: venue,
      venue_address: address || null,
      capacity: seats,
    },
  }
}

/** The RSVP slug a listing carries, or null. Reads `metadata.rsvp_event_slug` and nothing else. */
export function rsvpEventSlug(metadata: Record<string, unknown> | null | undefined): string | null {
  const v = metadata?.rsvp_event_slug
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/**
 * May the PDP render the RSVP registration (and the «Gratis» label) for this listing + event? ONLY when
 * the listing is really free ($0 — «Gratis» follows the PRICE, never the link: a free Evento edited to
 * $150 must show $150 and its buy box, not a free registration) AND the event belongs to the listing's
 * own seller. `rsvp_event_slug` rides metadata that a seller can PATCH directly on the backend, so the
 * slug alone must never pull another shop's registration form onto this page (review #491, security).
 * `listingSellerId` and `event.medusa_seller_id` are both the Medusa seller id (`listing.shop.id`;
 * the create route writes `medusa_seller_id: sellerId`).
 */
export function rsvpEventShownOnListing(
  listing: { price_cents?: number | null; shop?: { id?: string | null } | null },
  event: { medusa_seller_id?: string | null } | null | undefined,
): boolean {
  if (!event) return false
  if (listing.price_cents !== 0) return false
  const sellerId = listing.shop?.id
  return typeof sellerId === 'string' && sellerId !== '' && event.medusa_seller_id === sellerId
}

export const FREE_EVENT_PRICE_LOCKED_MESSAGE = 'Este evento es gratis: para cobrar entrada, crea un Evento con precio.'

/**
 * A listing that carries an RSVP link is free by construction. Moving its price away from $0 (a number,
 * or null = «precio a consultar») would leave a registration form, a buy button and untracked seats on
 * one page. Returns the refusal message, or null when the write is fine. `undefined` = price untouched.
 */
export function freeEventPriceRefusal(
  metadata: Record<string, unknown> | null | undefined,
  nextPriceCents: number | null | undefined,
): string | null {
  if (nextPriceCents === undefined) return null
  if (!rsvpEventSlug(metadata)) return null
  return nextPriceCents === 0 ? null : FREE_EVENT_PRICE_LOCKED_MESSAGE
}

/**
 * The same rule for a patch-shaped write (catalog bulk rows): a patch that sets `price_cents`
 * (or any per-variant price) away from $0 on a free Evento is refused. A patch with no price key
 * (pause, category, ...) passes.
 */
export function freeEventPatchRefusal(
  metadata: Record<string, unknown> | null | undefined,
  patch: { price_cents?: number | null; variant_prices?: Record<string, number> | null } | null | undefined,
): string | null {
  if (!patch) return null
  // EVERY price field is checked: an early return on `price_cents: 0` let
  // `{ price_cents: 0, variant_prices: { default: 15000 } }` through.
  const base = freeEventPriceRefusal(metadata, patch.price_cents)
  if (base) return base
  const variantPrices = patch.variant_prices
  if (variantPrices && Object.values(variantPrices).some((v) => v !== 0)) {
    return freeEventPriceRefusal(metadata, Number.NaN)
  }
  return null
}

/**
 * What a listing edit changes on its linked RSVP row: title, start, venue and address — never the
 * capacity (seats of a free Evento are edited in the roster) or status. Null when the edit does not
 * describe a complete event (the row is then left as it is rather than half-rewritten).
 */
export function rsvpEventSyncPatch(listing: {
  title: string
  attrs?: Record<string, unknown> | null
  state?: string | null
}): Pick<RsvpEventDraft, 'title' | 'starts_at' | 'venue_name' | 'venue_address'> | null {
  const built = buildRsvpEventDraft({ title: listing.title, attrs: listing.attrs, state: listing.state, quantity: 1 })
  if (!built.ok) return null
  const { title, starts_at, venue_name, venue_address } = built.draft
  return { title, starts_at, venue_name, venue_address }
}

/** Where «Nuevo evento» sends a merchant (D7). */
export const NEW_EVENT_HREF = '/sell?tipo=evento'
/** Where the roster page sends a merchant who has no events (D7). */
export const EVENTS_EMPTY_REDIRECT = '/shop/manage/catalogo'

/** The price line of a free Evento's PDP (its listing carries a price of 0, which would read «a convenir»). */
export const FREE_EVENT_PRICE_LABEL = 'Gratis'
/** The same label in the shopper's language (codex review #491: English shoppers saw «Gratis»). */
export function freeEventPriceLabel(language: string | null | undefined): string {
  return language === 'en' ? 'Free' : FREE_EVENT_PRICE_LABEL
}
