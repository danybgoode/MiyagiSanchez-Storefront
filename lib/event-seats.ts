/**
 * lib/event-seats.ts — «Lugares disponibles» for event listings (merchant-panel-gaps S1.1).
 *
 * Pure and next-free so the wizard, the edit form, /api/sell/create and the MCP tools all
 * decide ONE way — and so a Playwright `api` spec can import it (CLAUDE.md: a module that
 * imports next/cache cannot be loaded by the runner).
 *
 * The rule mirrors the backend predicate (`isStockableListingType`, apps/backend
 * src/api/store/_utils/inventory.ts): a `service` or `digital` listing that carries the
 * event block (a date or a venue) AND a seat count is tracked inventory. The count is the
 * AVAILABLE number (stocked = available + reserved), so «lowering below tickets sold»
 * cannot happen; only a negative is refused.
 *
 * The storefront must send NO quantity at all for an event without seats. The backend reads
 * "a quantity was provided" as "the merchant set seats" — a defaulted `1` would silently turn
 * every untracked event into a one-seat event.
 */

export const SEATS_LABEL = 'Lugares disponibles'
export const SEATS_HINT = 'Cuántos lugares quedan. Al llenarse, se marca como agotado.'
export const SEATS_NEGATIVE_MESSAGE = 'Los lugares disponibles deben ser un número de 0 o más.'

function filled(v: unknown): boolean {
  return typeof v === 'string' ? v.trim().length > 0 : typeof v === 'number'
}

/** True when the attrs carry the event block (a date or a venue). */
export function hasEventBlock(attrs: Record<string, unknown> | null | undefined): boolean {
  if (!attrs || typeof attrs !== 'object') return false
  return filled(attrs.event_date) || filled(attrs.venue_name)
}

/** The listing types an event can be (D5: a preset over `service`, never a new type). */
export function isEventCapableType(listingType: string | null | undefined): boolean {
  return listingType === 'service' || listingType === 'digital'
}

export type SeatsForWrite =
  | { ok: true; quantity: number | undefined }
  | { ok: false; error: string }

/**
 * What `quantity` to send for a create/edit. `undefined` means "send nothing":
 * not an event, no seats typed, or the event block is empty.
 */
export function seatsForWrite(input: {
  listingType: string | null | undefined
  attrs: Record<string, unknown> | null | undefined
  seatsRaw: string | number | null | undefined
}): SeatsForWrite {
  if (!isEventCapableType(input.listingType) || !hasEventBlock(input.attrs)) {
    return { ok: true, quantity: undefined }
  }
  const raw = typeof input.seatsRaw === 'number' ? String(input.seatsRaw) : (input.seatsRaw ?? '').trim()
  if (raw === '') return { ok: true, quantity: undefined }
  if (!/^\d+$/.test(raw)) return { ok: false, error: SEATS_NEGATIVE_MESSAGE }
  return { ok: true, quantity: Number.parseInt(raw, 10) }
}

/**
 * Server-side counterpart for /api/sell/create: the quantity that goes to Medusa.
 * Products keep today's rule (at least 1, default 1); an event sends its seats or
 * NOTHING; everything else sends nothing (it used to send a dead `1`).
 */
export function createQuantityForBackend(listing: {
  listing_type?: string | null
  quantity?: number | null
  attrs?: Record<string, unknown> | null
}): number | undefined {
  if ((listing.listing_type ?? 'product') === 'product') {
    return Math.max(1, Math.floor(listing.quantity ?? 1))
  }
  if (isEventCapableType(listing.listing_type) && hasEventBlock(listing.attrs)
    && typeof listing.quantity === 'number' && Number.isFinite(listing.quantity) && listing.quantity >= 0) {
    return Math.floor(listing.quantity)
  }
  return undefined
}

export type McpEventFields =
  | { ok: true; attrs: Record<string, string>; quantity: number | undefined }
  | { ok: false; error: string }

function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim().slice(0, max)
  return t.length > 0 ? t : undefined
}

/**
 * The MCP `create_listing` tool's event arguments (event_date, event_time, venue_name,
 * venue_address, capacity) → the `attrs` block and the seat `quantity`. `capacity` is the
 * agent-facing name for «Lugares disponibles»; it needs the event block, same as the wizard.
 */
export function mcpEventFields(args: Record<string, unknown>): McpEventFields {
  const attrs: Record<string, string> = {}
  const date = cleanText(args.event_date, 10)
  if (date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'event_date debe tener el formato AAAA-MM-DD.' }
    attrs.event_date = date
  }
  const time = cleanText(args.event_time, 5)
  if (time !== undefined) {
    if (!/^\d{2}:\d{2}$/.test(time)) return { ok: false, error: 'event_time debe tener el formato HH:MM.' }
    attrs.event_time = time
  }
  const venue = cleanText(args.venue_name, 80)
  if (venue !== undefined) attrs.venue_name = venue
  const address = cleanText(args.venue_address, 160)
  if (address !== undefined) attrs.venue_address = address

  if (args.capacity === undefined || args.capacity === null) return { ok: true, attrs, quantity: undefined }
  if (typeof args.capacity !== 'number' || !Number.isInteger(args.capacity) || args.capacity < 0) {
    return { ok: false, error: SEATS_NEGATIVE_MESSAGE }
  }
  if (!hasEventBlock(attrs)) {
    return { ok: false, error: 'capacity (lugares disponibles) necesita event_date o venue_name.' }
  }
  return { ok: true, attrs, quantity: args.capacity }
}

/** MCP `update_listing.capacity` on a listing that is not an event (codex review #490). */
export const CAPACITY_EVENT_ONLY_MESSAGE =
  '`capacity` es sólo para eventos (un servicio o archivo digital con fecha o recinto). Para el stock de un producto usa `quantity`.'

