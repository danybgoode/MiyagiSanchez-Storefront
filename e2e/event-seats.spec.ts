import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SEATS_EDIT_HINT, SEATS_HINT, SEATS_LABEL, SEATS_NEGATIVE_MESSAGE, CAPACITY_EVENT_ONLY_MESSAGE,
  createQuantityForBackend, hasEventBlock, mcpEventFields, mcpUpdateQuantity, seatsForWrite,
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

test.describe('the importer never invents seats (merchant-panel-gaps S1, orchestrator review)', () => {
  test('a service row with an event block is created without a quantity; a product row keeps its stock', async () => {
    const { buildCreateBody } = await import('../lib/seller-product-create')
    const base = { title: 'Taller', category: 'servicios', price: 100 } as unknown as Parameters<typeof buildCreateBody>[0]
    const service = buildCreateBody({ ...base, listing_type: 'service', attrs: { event_date: '2026-12-01', venue_name: 'Foro' } }, [])
    expect(service.quantity).toBeUndefined()
    const product = buildCreateBody({ ...base, listing_type: 'product', quantity: 3 }, [])
    expect(product.quantity).toBe(3)
  })
})

test.describe('seats are refused, never rewritten (codex review #490)', () => {
  test('the seats input keeps what was typed; «-3» and «2.5» are refused by seatsForWrite', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'app/(shell)/sell/AttrsSection.tsx'), 'utf8')
    expect(src).toMatch(/onChange=\{e => setSeats\(e\.target\.value\)\}/)
    for (const raw of ['-3', '2.5']) {
      expect(seatsForWrite({ listingType: 'service', attrs: { event_date: '2026-12-01' }, seatsRaw: raw }).ok).toBe(false)
    }
  })

  test('MCP update_listing: capacity on a product is refused; quantity on an event is refused, not clamped', () => {
    expect(mcpUpdateQuantity({ listingType: 'product', quantity: undefined, capacity: 5 }))
      .toEqual({ ok: false, error: CAPACITY_EVENT_ONLY_MESSAGE })
    // The bug: -3 on an event was clamped to 0 = silently sold out.
    expect(mcpUpdateQuantity({ listingType: 'service', quantity: -3, capacity: undefined }))
      .toEqual({ ok: false, error: SEATS_NEGATIVE_MESSAGE })
    expect(mcpUpdateQuantity({ listingType: 'digital', quantity: 2.5, capacity: undefined }).ok).toBe(false)
    expect(mcpUpdateQuantity({ listingType: 'service', quantity: undefined, capacity: -1 }).ok).toBe(false)
    expect(mcpUpdateQuantity({ listingType: 'service', quantity: 12, capacity: undefined })).toEqual({ ok: true, quantity: 12 })
    expect(mcpUpdateQuantity({ listingType: 'service', quantity: undefined, capacity: 0 })).toEqual({ ok: true, quantity: 0 })
    // Products keep today's clamp.
    expect(mcpUpdateQuantity({ listingType: 'product', quantity: -3, capacity: undefined })).toEqual({ ok: true, quantity: 0 })
    expect(mcpUpdateQuantity({ listingType: 'product', quantity: 4.9, capacity: undefined })).toEqual({ ok: true, quantity: 4 })
  })

  test('MCP update_listing decides from the owner-scoped mirror, not the public cached read', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'app/api/ucp/mcp/route.ts'), 'utf8')
    const block = src.slice(src.indexOf('const q = mcpUpdateQuantity('), src.indexOf('const q = mcpUpdateQuantity(') + 400)
    expect(block).toContain('owned.listing_type')
    expect(src).not.toMatch(/getListing\(productId\)/)
  })

  test('the event block is a STRING date or venue, same as the backend (a number is not an event)', () => {
    expect(hasEventBlock({ event_date: 20261201 })).toBe(false)
    expect(hasEventBlock({ venue_name: 5 })).toBe(false)
    expect(hasEventBlock({ event_date: '2026-12-01' })).toBe(true)
    expect(hasEventBlock({ venue_name: '  ' })).toBe(false)
  })

  test('a refused seat count is shown at the field (create) and blocks the save (edit); edit blank = unchanged', () => {
    const root = join(import.meta.dirname, '..')
    const attrs = readFileSync(join(root, 'app/(shell)/sell/AttrsSection.tsx'), 'utf8')
    const wizard = readFileSync(join(root, 'app/(shell)/sell/SellWizard.tsx'), 'utf8')
    const edit = readFileSync(join(root, 'app/(shell)/sell/edit/[id]/EditForm.tsx'), 'utf8')
    expect(attrs).toContain('data-testid="event-seats-error"')
    expect(wizard).toContain('seatsError={errors.seats}')
    expect(edit).toContain('seatsError={fieldErrors.seats}')
    expect(edit).toMatch(/if \(!seatsCheck\.ok\) errs\.seats = seatsCheck\.error/)
    expect(SEATS_EDIT_HINT).toBe('Déjalo vacío para no cambiarlo; pon 0 para cerrar la venta.')
    expect(edit).toContain('seatsHint={SEATS_EDIT_HINT}')
  })
})
