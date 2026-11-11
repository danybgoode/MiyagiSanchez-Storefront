import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SEATS_HINT, SEATS_LABEL, createQuantityForBackend, hasEventBlock, mcpEventFields, seatsForWrite,
} from '../lib/event-seats'
import { clampTicketQuantity, ticketQuantityCap } from '../lib/ticket-quantity'

/**
 * merchant-panel-gaps S1.1 — «Lugares disponibles». Pure seam shared by the wizard, the edit form,
 * /api/sell/create and the MCP tools. The tracked-inventory half (the backend turns this quantity into
 * managed Medusa stock the engine enforces) is proven in the backend's money-path integration suite
 * (integration-tests/http/event-seats.suite.ts); this file proves what the storefront SENDS and what
 * the buyer cap does with the number that comes back.
 */
const EVENT = { event_date: '2026-12-01', venue_name: 'Teatro' }

test.describe('event seats · what the form sends', () => {
  test('copy is the agreed wording', () => {
    expect(SEATS_LABEL).toBe('Lugares disponibles')
    expect(SEATS_HINT).toBe('Cuántos lugares quedan. Al llenarse, se marca como agotado.')
  })

  test('a service with the event block and seats sends that number', () => {
    expect(seatsForWrite({ listingType: 'service', attrs: EVENT, seatsRaw: '40' })).toEqual({ ok: true, quantity: 40 })
    expect(seatsForWrite({ listingType: 'digital', attrs: { venue_name: 'Foro' }, seatsRaw: '0' })).toEqual({ ok: true, quantity: 0 })
  })

  test('no seats typed, no event block, or a non-event type sends NOTHING (never a defaulted 1)', () => {
    expect(seatsForWrite({ listingType: 'service', attrs: EVENT, seatsRaw: '' })).toEqual({ ok: true, quantity: undefined })
    expect(seatsForWrite({ listingType: 'service', attrs: {}, seatsRaw: '40' })).toEqual({ ok: true, quantity: undefined })
    expect(seatsForWrite({ listingType: 'product', attrs: EVENT, seatsRaw: '40' })).toEqual({ ok: true, quantity: undefined })
  })

  test('a negative or fractional count is refused with a plain message', () => {
    for (const bad of ['-3', '2.5', 'abc']) {
      const r = seatsForWrite({ listingType: 'service', attrs: EVENT, seatsRaw: bad })
      expect(r.ok).toBe(false)
    }
  })

  test('hasEventBlock reads a date or a venue only', () => {
    expect(hasEventBlock({ event_date: '2026-12-01' })).toBe(true)
    expect(hasEventBlock({ venue_name: ' Foro ' })).toBe(true)
    expect(hasEventBlock({ venue_name: '  ' })).toBe(false)
    expect(hasEventBlock({ event_time: '20:00' })).toBe(false)
  })
})

test.describe('event seats · /api/sell/create quantity to Medusa', () => {
  test('products keep at-least-1; an event sends its seats; everything else sends nothing', () => {
    expect(createQuantityForBackend({ listing_type: 'product', quantity: 0 })).toBe(1)
    expect(createQuantityForBackend({ listing_type: 'product' })).toBe(1)
    expect(createQuantityForBackend({ listing_type: 'service', attrs: EVENT, quantity: 40 })).toBe(40)
    expect(createQuantityForBackend({ listing_type: 'service', attrs: EVENT, quantity: 0 })).toBe(0)
  })

  test('an untracked event or a plain service sends NO quantity — the backend reads "provided" as "seats set"', () => {
    expect(createQuantityForBackend({ listing_type: 'service', attrs: EVENT })).toBeUndefined()
    expect(createQuantityForBackend({ listing_type: 'service', quantity: 1, attrs: {} })).toBeUndefined()
    expect(createQuantityForBackend({ listing_type: 'rental', quantity: 5, attrs: EVENT })).toBeUndefined()
    expect(createQuantityForBackend({ listing_type: 'service', attrs: EVENT, quantity: -2 })).toBeUndefined()
  })
})

test.describe('event seats · MCP create/update', () => {
  test('capacity becomes the seat quantity with the event block', () => {
    const r = mcpEventFields({ event_date: '2026-12-01', event_time: '20:30', venue_name: 'Teatro', capacity: 12 })
    expect(r).toEqual({ ok: true, attrs: { event_date: '2026-12-01', event_time: '20:30', venue_name: 'Teatro' }, quantity: 12 })
  })
  test('capacity without an event block, or negative, is refused', () => {
    expect(mcpEventFields({ capacity: 5 }).ok).toBe(false)
    expect(mcpEventFields({ venue_name: 'Foro', capacity: -1 }).ok).toBe(false)
    expect(mcpEventFields({ venue_name: 'Foro', capacity: 1.5 }).ok).toBe(false)
    expect(mcpEventFields({ event_date: '01/12/2026' }).ok).toBe(false)
  })
  test('an event without capacity has no quantity (untracked)', () => {
    expect(mcpEventFields({ venue_name: 'Foro' })).toEqual({ ok: true, attrs: { venue_name: 'Foro' }, quantity: undefined })
  })
  test('the tool schemas advertise capacity and the handlers call the seam', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/ucp/mcp/route.ts'), 'utf8')
    expect(src.match(/capacity:\s+\{ type: 'number'/g)?.length).toBe(2) // create_listing + update_listing
    expect(src).toContain('mcpEventFields(args)')
    expect(src).toContain('typeof args.capacity')
  })
})

test.describe('event seats · the number the buyer cap reads', () => {
  test('Cupo 2: the cap is 2, a 3rd ticket clamps down, and sold out floors at 1 (PDP shows Agotado)', () => {
    const sent = createQuantityForBackend({ listing_type: 'service', attrs: EVENT, quantity: 2 })
    expect(sent).toBe(2)
    // Backend turns `sent` into tracked available_quantity (proven in the backend integration suite).
    expect(ticketQuantityCap({ available: sent, enabled: true })).toBe(2)
    expect(clampTicketQuantity(3, { available: sent, enabled: true })).toBe(2)
    expect(ticketQuantityCap({ available: 0, enabled: true })).toBe(1)
  })
})
