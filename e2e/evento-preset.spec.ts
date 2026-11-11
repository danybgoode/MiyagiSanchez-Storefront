import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EVENTS_EMPTY_REDIRECT, EVENTO_TIPO, FREE_EVENT_PRICE_LABEL, NEW_EVENT_HREF, freeEventPriceLabel,
  buildRsvpEventDraft, eventStartsAt, eventTimeZoneForState, rsvpEventSyncPatch, eventoErrors, isEventoTipo, isFreeEventListing,
  parseEventoPriceCents, rsvpEventSlug, rsvpEventShownOnListing, freeEventPriceRefusal, FREE_EVENT_PRICE_LOCKED_MESSAGE,
} from '../lib/evento-preset'
import { ZERO_TOTAL_CHECKOUT_MESSAGE, zeroTotalDecision } from '../lib/checkout-zero'
import { eventPublicStatus } from '../lib/event-status'
import { createQuantityForBackend, seatsForWrite } from '../lib/event-seats'
import {
  SELLER_NAV, SELLER_NAV_MOBILE_OVERFLOW_GROUPS, SELLER_UNLISTED_SECTIONS, activeSellerNavHref, sellerBreadcrumbTrail,
} from '../lib/seller-nav'

/**
 * merchant-panel-gaps S2.1 — «Evento» is one wizard choice, free or paid (D5-D7).
 * Pure seams + source guards for the wiring that cannot run without Clerk/Supabase/Medusa.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')
const FULL = { event_date: '2026-12-01', event_time: '20:30', venue_name: 'Teatro Pequeño' }

test.describe('evento · wizard preset → payload', () => {
  test('?tipo=evento preselects the preset; anything else does not', () => {
    expect(EVENTO_TIPO).toBe('evento')
    expect(isEventoTipo('evento')).toBe(true)
    expect(isEventoTipo(['Evento'])).toBe(true)
    expect(isEventoTipo('servicio')).toBe(false)
    expect(isEventoTipo(undefined)).toBe(false)
  })

  test('the preset is a service listing — never a new listing_type', () => {
    const wizard = read('app/(shell)/sell/SellWizard.tsx')
    // choosing Evento sets the service type and the preset flag together
    expect(wizard).toMatch(/setEvento\(true\)\s*\n\s*setListingType\('service'\)/)
    const page = read('app/(shell)/sell/page.tsx')
    expect(page).toContain('isEventoTipo(params.tipo)')
    expect(page).toContain('initialEvento=')
  })

  test('price: $0 is allowed for an Evento, blank/negative/junk is not', () => {
    expect(parseEventoPriceCents('0')).toBe(0)
    expect(parseEventoPriceCents('0.00')).toBe(0)
    expect(parseEventoPriceCents('250')).toBe(25000)
    expect(parseEventoPriceCents('1,250.50')).toBe(125050)
    expect(parseEventoPriceCents('')).toBeNull()
    expect(parseEventoPriceCents('-5')).toBeNull()
    expect(parseEventoPriceCents('abc')).toBeNull()
  })

  test('required: date, time, venue, seats and a price', () => {
    expect(eventoErrors({ attrs: FULL, seatsRaw: '40', priceRaw: '150' })).toEqual({})
    expect(eventoErrors({ attrs: FULL, seatsRaw: '5', priceRaw: '0' })).toEqual({})
    const none = eventoErrors({ attrs: {}, seatsRaw: '', priceRaw: '' })
    expect(Object.keys(none).sort()).toEqual(['event_date', 'event_time', 'price', 'seats', 'venue_name'])
    expect(eventoErrors({ attrs: FULL, seatsRaw: '0', priceRaw: '10' }).seats).toMatch(/al menos 1/)
    expect(eventoErrors({ attrs: { ...FULL, event_time: '  ' }, seatsRaw: '3', priceRaw: '10' }).event_time).toBeTruthy()
  })

  test('the payload of a paid Evento carries its seats as quantity (Medusa tracks them, S1.1)', () => {
    const seats = seatsForWrite({ listingType: 'service', attrs: FULL, seatsRaw: '40' })
    expect(seats).toEqual({ ok: true, quantity: 40 })
    expect(createQuantityForBackend({ listing_type: 'service', attrs: FULL, quantity: 40 })).toBe(40)
  })
})

test.describe('evento · a free Evento is also an RSVP event', () => {
  const listing = { title: '  Obra gratis  ', description: 'Una obra', quantity: 25, attrs: { ...FULL, venue_address: 'Calle 1' } }

  test('only service + event block + exactly $0 is free', () => {
    expect(isFreeEventListing({ listing_type: 'service', price_cents: 0, attrs: FULL })).toBe(true)
    expect(isFreeEventListing({ listing_type: 'service', price_cents: 100, attrs: FULL })).toBe(false)
    expect(isFreeEventListing({ listing_type: 'service', price_cents: null, attrs: FULL })).toBe(false)
    expect(isFreeEventListing({ listing_type: 'service', price_cents: 0, attrs: {} })).toBe(false)
    expect(isFreeEventListing({ listing_type: 'product', price_cents: 0, attrs: FULL })).toBe(false)
  })

  test('the RSVP row: capacity = seats, same title, venue and start as the listing', () => {
    const built = buildRsvpEventDraft(listing)
    expect(built).toEqual({
      ok: true,
      draft: {
        title: 'Obra gratis',
        description: 'Una obra',
        starts_at: '2026-12-02T02:30:00.000Z', // 20:30 in Mexico City (UTC-6)
        venue_name: 'Teatro Pequeño',
        venue_address: 'Calle 1',
        capacity: 25,
      },
    })
  })

  test('refused when the row could not be stored: no time, no venue, or fewer than 1 seat (CHECK capacity > 0)', () => {
    expect(buildRsvpEventDraft({ ...listing, attrs: { ...FULL, event_time: '' } })).toMatchObject({ ok: false, field: 'event_date' })
    expect(buildRsvpEventDraft({ ...listing, attrs: { event_date: '2026-12-01', event_time: '20:00' } })).toMatchObject({ ok: false, field: 'venue_name' })
    expect(buildRsvpEventDraft({ ...listing, quantity: 0 })).toMatchObject({ ok: false, field: 'quantity' })
    expect(buildRsvpEventDraft({ ...listing, quantity: null })).toMatchObject({ ok: false, field: 'quantity' })
    expect(eventStartsAt({ event_date: 'mañana', event_time: '20:00' })).toBeNull()
  })

  test('the listing stores the slug; the PDP reads only that key', () => {
    expect(rsvpEventSlug({ rsvp_event_slug: ' obra-gratis ' })).toBe('obra-gratis')
    expect(rsvpEventSlug({ rsvp_event_slug: '' })).toBeNull()
    expect(rsvpEventSlug({ slug: 'x' })).toBeNull()
    expect(rsvpEventSlug(null)).toBeNull()
    expect(FREE_EVENT_PRICE_LABEL).toBe('Gratis')
    expect(freeEventPriceLabel('es')).toBe('Gratis')
    expect(freeEventPriceLabel('en')).toBe('Free')
  })

  test('the create route writes the row BEFORE the product, stores the slug, sends no Medusa seats, and undoes the row on failure', () => {
    const route = read('app/api/sell/create/route.ts')
    const insertAt = route.indexOf(".from('marketplace_events')\n      .insert(")
    const productAt = route.indexOf("medusaFetch('/store/sellers/me/products', clerkJwt, {")
    expect(insertAt).toBeGreaterThan(0)
    expect(insertAt).toBeLessThan(productAt)
    expect(route).toContain('rsvp_event_slug: rsvpEvent.slug')
    expect(route).toContain('quantity: freeEvent ? undefined : createQuantityForBackend(body.listing)')
    expect(route).toMatch(/if \(rsvpEvent\) await db\.from\('marketplace_events'\)\.delete\(\)\.eq\('id', rsvpEvent\.id\)/)
  })

  test('the PDP renders the existing registration panel for a listing with a resolvable slug, replacing the price with Gratis', () => {
    const pdp = read('app/(shell)/l/[id]/ListingRenderer.tsx')
    expect(pdp).toContain('<EventRegistrationPanel')
    expect(pdp).toMatch(/\{rsvpEvent && rsvpStats && \(\s*\n\s*<div data-testid="pdp-rsvp-registration"/)
    expect(pdp).toContain('rsvpEvent ? freeEventPriceLabel(presentation.language)')
    // the page and the PDP share ONE panel and ONE status derivation
    expect(read('app/(shell)/e/[slug]/EventRegistrationClient.tsx')).toContain('<EventRegistrationPanel')
    expect(read('app/(shell)/e/[slug]/page.tsx')).toContain('eventPublicStatus(event, stats)')
  })

  test('event public status: cancelled > full > open/ended', () => {
    const now = new Date('2026-12-01T00:00:00Z')
    const future = { status: 'active' as const, starts_at: '2026-12-05T00:00:00Z' }
    expect(eventPublicStatus(future, { full: false }, now)).toBe('open')
    expect(eventPublicStatus(future, { full: true }, now)).toBe('full')
    expect(eventPublicStatus({ ...future, status: 'cancelled' }, { full: true }, now)).toBe('cancelled')
    expect(eventPublicStatus({ ...future, starts_at: '2026-11-01T00:00:00Z' }, { full: false }, now)).toBe('ended')
  })
})

test.describe('evento · the event start resolves the own-state wall clock', () => {
  const at = (state: string | null | undefined, date = '2026-12-01') =>
    eventStartsAt({ event_date: date, event_time: '20:30' }, state)

  test('Mexico City is the fallback: unknown, blank or unlisted state', () => {
    expect(at(undefined)).toBe('2026-12-02T02:30:00.000Z')
    expect(at(null)).toBe('2026-12-02T02:30:00.000Z')
    expect(at('Jalisco')).toBe('2026-12-02T02:30:00.000Z')
    expect(at('Narnia')).toBe('2026-12-02T02:30:00.000Z')
    expect(eventTimeZoneForState('')).toBe('America/Mexico_City')
  })

  test('Quintana Roo is UTC-5, Sonora UTC-7, Baja California UTC-8 in winter and UTC-7 in summer', () => {
    expect(at('Quintana Roo')).toBe('2026-12-02T01:30:00.000Z')
    expect(at('Sonora')).toBe('2026-12-02T03:30:00.000Z')
    expect(at('Baja California')).toBe('2026-12-02T04:30:00.000Z')
    expect(at('Baja California', '2026-07-01')).toBe('2026-07-02T03:30:00.000Z')
    // Mexico City has no DST: summer is still UTC-6
    expect(at('Ciudad de México', '2026-07-01')).toBe('2026-07-02T02:30:00.000Z')
  })

  test('accents and case do not matter', () => {
    expect(at('QUINTANA ROO')).toBe(at('Quintana Roo'))
    expect(eventTimeZoneForState('Baja California Sur')).toBe('America/Mazatlan')
  })

  test('the RSVP draft carries the state through', () => {
    const r = buildRsvpEventDraft({ title: 'Fiesta', quantity: 5, attrs: FULL, state: 'Quintana Roo' })
    expect(r.ok && r.draft.starts_at).toBe('2026-12-02T01:30:00.000Z')
  })
})

test.describe('evento · editing a free Evento updates its RSVP row (same save)', () => {
  test('the sync patch is title + start + venue + address, never capacity', () => {
    const patch = rsvpEventSyncPatch({ title: ' Nuevo nombre ', attrs: { ...FULL, venue_address: 'Calle 2' }, state: 'Sonora' })
    expect(patch).toEqual({
      title: 'Nuevo nombre', starts_at: '2026-12-02T03:30:00.000Z', venue_name: 'Teatro Pequeño', venue_address: 'Calle 2',
    })
    expect(patch).not.toHaveProperty('capacity')
    expect(rsvpEventSyncPatch({ title: 'X', attrs: { event_date: '2026-12-01' } })).toBeNull()
  })

  test('the PUT route updates the row scoped to the authenticated seller shop, and checks a row came back', () => {
    const route = read('app/api/sell/listing/[id]/route.ts')
    expect(route).toContain('rsvpEventSlug(')
    expect(route).toContain('resolveEventSeller()')
    expect(route).toMatch(/\.from\('marketplace_events'\)\s*\n\s*\.update\(patch\)\s*\n\s*\.eq\('slug', slug\)\s*\n\s*\.eq\('shop_id', context\.shop\.id\)\s*\n\s*\.select\('id'\)/)
    expect(route).toContain('data.length === 0')
    expect(route).toContain('syncFreeEventRow(id, body)')
    // the create route passes the state too, so create and edit agree on the instant
    expect(read('app/api/sell/create/route.ts')).toContain('state: body.listing.state,')
  })
})

test.describe('evento · Eventos leaves the nav, the roster stays', () => {
  test('no rail entry and no «Más» entry points at /shop/manage/eventos', () => {
    const hrefs = SELLER_NAV.flatMap((g) => g.entries.map((e) => e.href))
    expect(hrefs).not.toContain('/shop/manage/eventos')
    expect(SELLER_NAV.flatMap((g) => g.entries.map((e) => e.key))).not.toContain('eventos')
    const overflow = SELLER_NAV_MOBILE_OVERFLOW_GROUPS.flatMap((g) => g.entries.map((e) => e.href))
    expect(overflow).not.toContain('/shop/manage/eventos')
  })

  test('the roster page still resolves: the rail highlights the catalog and the breadcrumb says Eventos', () => {
    expect(SELLER_UNLISTED_SECTIONS.map((s) => s.href)).toContain('/shop/manage/eventos')
    expect(activeSellerNavHref('/shop/manage/eventos')).toBe('/shop/manage/catalogo')
    expect(activeSellerNavHref('/shop/manage/eventos/abc')).toBe('/shop/manage/catalogo')
    expect(sellerBreadcrumbTrail('/shop/manage/eventos/abc', [{ label: 'Obra', href: null }])).toEqual([
      { label: 'Resumen', href: '/shop/manage' },
      { label: 'Eventos', href: '/shop/manage/eventos' },
      { label: 'Obra', href: null },
    ])
  })

  test('redirect + create targets are asserted, not just present', () => {
    expect(NEW_EVENT_HREF).toBe('/sell?tipo=evento')
    expect(EVENTS_EMPTY_REDIRECT).toBe('/shop/manage/catalogo')
    const page = read('app/(shell)/shop/manage/eventos/page.tsx')
    expect(page).toContain('if (initialEvents.length === 0) redirect(EVENTS_EMPTY_REDIRECT)')
    expect(read('app/(shell)/shop/manage/eventos/EventsManager.tsx')).toMatch(/href=\{NEW_EVENT_HREF\}/)
    // the create form is gone: it only renders while editing an existing event
    expect(read('app/(shell)/shop/manage/eventos/EventsManager.tsx')).toContain('{editing && <form onSubmit={save}')
  })

  test('the catalog row of a free Evento links its roster', () => {
    expect(read('app/(shell)/shop/manage/catalogo/CatalogTable.tsx')).toContain('data-testid="event-roster-link"')
    expect(read('app/(shell)/shop/manage/catalogo/page.tsx')).toContain("`/shop/manage/eventos/${row.id}`")
  })
})

test.describe('evento · the event block uses design tokens', () => {
  test('no raw purple utility classes remain in the event block', () => {
    const attrs = read('app/(shell)/sell/AttrsSection.tsx')
    expect(attrs).not.toMatch(/purple-\d/)
    expect(attrs).toContain('border-[var(--info)] bg-[var(--info-soft)]')
  })
})

test.describe('a free Evento edit keeps a complete block (codex review #491)', () => {
  test('the PUT refuses an incomplete date/time/venue BEFORE it writes to Medusa', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'app/api/sell/listing/[id]/route.ts'), 'utf8')
    const put = src.slice(src.indexOf('export async function PUT'))
    const refusal = put.indexOf('await freeEventBlockRefusal(id, body)')
    const firstWrite = put.indexOf('medusaFetch(')
    expect(refusal).toBeGreaterThan(0)
    expect(refusal).toBeLessThan(firstWrite)
  })
})

test.describe('«Gratis» follows the price and the owner, not the link (review #491)', () => {
  const event = { medusa_seller_id: 'sel_A' }
  test('the RSVP panel shows only for a $0 listing whose event is the listing seller\'s own', () => {
    expect(rsvpEventShownOnListing({ price_cents: 0, shop: { id: 'sel_A' } }, event)).toBe(true)
    // A free Evento edited to $150: no «Gratis», no registration form — the buy box takes over.
    expect(rsvpEventShownOnListing({ price_cents: 15000, shop: { id: 'sel_A' } }, event)).toBe(false)
    expect(rsvpEventShownOnListing({ price_cents: null, shop: { id: 'sel_A' } }, event)).toBe(false)
    // Another shop's event slug planted via a direct backend PATCH.
    expect(rsvpEventShownOnListing({ price_cents: 0, shop: { id: 'sel_B' } }, event)).toBe(false)
    expect(rsvpEventShownOnListing({ price_cents: 0, shop: null }, event)).toBe(false)
    expect(rsvpEventShownOnListing({ price_cents: 0, shop: { id: 'sel_A' } }, null)).toBe(false)
  })
  test('the PDP renders the panel through that predicate', () => {
    const src = read('app/(shell)/l/[id]/ListingRenderer.tsx')
    expect(src).toContain('rsvpEventShownOnListing(listing, linkedEvent)')
  })
  test('a price move away from $0 on a free Evento is refused before any write; $0 and non-events pass', () => {
    const meta = { rsvp_event_slug: 'taller-abc' }
    expect(freeEventPriceRefusal(meta, 15000)).toBe(FREE_EVENT_PRICE_LOCKED_MESSAGE)
    expect(freeEventPriceRefusal(meta, null)).toBe(FREE_EVENT_PRICE_LOCKED_MESSAGE)
    expect(freeEventPriceRefusal(meta, 0)).toBeNull()
    expect(freeEventPriceRefusal(meta, undefined)).toBeNull()
    expect(freeEventPriceRefusal({}, 15000)).toBeNull()
    expect(FREE_EVENT_PRICE_LOCKED_MESSAGE).toBe('Este evento es gratis: para cobrar entrada, crea un Evento con precio.')
    const put = read('app/api/sell/listing/[id]/route.ts')
    const body = put.slice(put.indexOf('export async function PUT'))
    expect(body.indexOf('freeEventPriceRefusal(')).toBeGreaterThan(0)
    expect(body.indexOf('freeEventPriceRefusal(')).toBeLessThan(body.indexOf('medusaFetch('))
  })
  test('the edit form locks the price of a free Evento and never writes null over it', () => {
    const edit = read('app/(shell)/sell/edit/[id]/EditForm.tsx')
    expect(edit).toContain('disabled={!!initial.rsvp_event_slug}')
    expect(edit).toMatch(/!initial\.rsvp_event_slug && priceRaw\.trim\(\) !== initialPriceRaw/)
  })
})

test.describe('a crafted /api/checkout/start cannot buy a $0 cart (review #491)', () => {
  test('zeroTotalDecision refuses 0, allows priced and exempt carts, and reports unreadable as unknown', () => {
    expect(zeroTotalDecision({ subtotal: 0, exempt: {} })).toBe('refuse')
    expect(zeroTotalDecision({ subtotal: 15000, exempt: {} })).toBe('allow')
    expect(zeroTotalDecision({ subtotal: undefined, exempt: {} })).toBe('unknown')
    expect(zeroTotalDecision({ subtotal: 0, exempt: { offer: true } })).toBe('allow')
    expect(zeroTotalDecision({ subtotal: 0, exempt: { support: true } })).toBe('allow')
    expect(ZERO_TOTAL_CHECKOUT_MESSAGE).toMatch(/precio/)
  })
  test('startCheckout asks it after the lines are added and BEFORE start-checkout', () => {
    const cart = read('lib/cart.ts')
    const fn = cart.slice(cart.indexOf('export async function startCheckout'))
    const guard = fn.indexOf('zeroTotalDecision(')
    expect(guard).toBeGreaterThan(fn.indexOf('/line-items'))
    expect(guard).toBeLessThan(fn.indexOf('/start-checkout'))
    expect(fn).toContain("if (decision === 'refuse') throw new Error(ZERO_TOTAL_CHECKOUT_MESSAGE)")
  })
})
