/**
 * «1 · El negocio» (promoter-panel S2.1/S2.2, D5/D6/D11): one form for the lead and the shop, choices from the
 * platform's own lists, every word from `promotorPanel` in the locales.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import es from '../locales/es.json' with { type: 'json' }
import en from '../locales/en.json' with { type: 'json' }
import { BUSINESS_SHAPES } from '../lib/business-shape'
import { SELLS_TODAY, mergeCurrentChannels, whatsappForDisplay, whatsappForSave, whatsappIsValid } from '../lib/promoter-panel'
import { PREFERRED_CHANNELS } from '../lib/preferred-channels'

const STEP = readFileSync('app/(shell)/promotor/cerrar/NegocioStep.tsx', 'utf8')
/** `merchant_relationships_qualification_check`, read live 2026-11-05. */
const QUALIFICATION_CHECK = ['unknown', 'strong', 'medium', 'weak', 'disqualified']

test('every dropdown has exactly one label per value the platform accepts, in es and en', () => {
  for (const copy of [es.promotorPanel.negocio, en.promotorPanel.negocio]) {
    expect(Object.keys(copy.shapes).sort()).toEqual([...BUSINESS_SHAPES].sort())
    expect(Object.keys(copy.sellsTodayOptions).sort()).toEqual([...SELLS_TODAY].sort())
    expect(Object.keys(copy.channels).sort()).toEqual([...PREFERRED_CHANNELS].sort())
    expect(Object.keys(copy.interestOptions).sort()).toEqual([...QUALIFICATION_CHECK].sort())
  }
})

test('the closed sets are <select>s built from the platform constants, never typed', () => {
  for (const source of ['BUSINESS_SHAPES.map(', 'CATEGORIES.map(', 'SELLS_TODAY.map(', 'CHANNELS.map(', 'INTEREST.map(']) expect(STEP).toContain(source)
  for (const id of ['panel-shape', 'panel-category', 'panel-sells-today']) {
    const at = STEP.indexOf(`data-testid="${id}"`)
    expect(at).toBeGreaterThan(-1)
    expect(STEP.lastIndexOf('<select', at)).toBeGreaterThan(STEP.lastIndexOf('<input', at))
  }
})

test('«Abrir su tienda» saves the lead, opens the shop, then links them — in that order', () => {
  const open = STEP.slice(STEP.indexOf('async function open('))
  const lead = open.indexOf('await saveLead({ confirmNew })')
  const shop = open.indexOf("fetch('/api/promoter/shop/setup'")
  const link = open.indexOf('saveLead({ shopId: created.shopId, id: leadId })')
  expect(lead).toBeGreaterThan(-1)
  expect(lead).toBeLessThan(shop)
  expect(shop).toBeLessThan(link)
  // The answer to «¿Vende hoy en otra plataforma?» is stored on the lead, and the main category on the shop.
  expect(STEP).toContain('currentChannels: mergeCurrentChannels(otherChannels.current, sellsToday || null)')
  expect(STEP).toContain('main_category: mainCategory || undefined')
})

test('the shop stores a main category only when it is a catalog key', () => {
  const route = readFileSync('app/api/promoter/shop/setup/route.ts', 'utf8')
  expect(route).toContain('(CATALOG_CATEGORY_KEYS as readonly string[]).includes(body.main_category)')
})

test('the panel copy: no «cerrar / cierre», no hand-typed prices, and the component holds no Spanish sentences', () => {
  const words = JSON.stringify(es.promotorPanel)
  expect(words).not.toMatch(/cerrar|cierre|cierra/i)
  expect(words).not.toMatch(/\$\s?\d/)
  // Strings live in the locales (D11): the step's JSX text comes from `t.` / `copy.` keys.
  expect(STEP).not.toMatch(/>\s*[A-ZÁÉÍÓÚ¿][a-záéíóúñ]+ [a-záéíóúñ]+[^<{]*</)
})

// ── #481 review fixes ─────────────────────────────────────────────────────────────────────────────────────────────

test('«Abrir su tienda» links the shop to the lead it JUST created, never the render\'s stale (empty) id', () => {
  const open = STEP.slice(STEP.indexOf('async function open('))
  expect(open).toContain('saveLead({ shopId: created.shopId, id: leadId })')
  const save = STEP.slice(STEP.indexOf('async function saveLead('))
  expect(save).toContain('const id = opts.id !== undefined ? opts.id : relationshipId')
})

test('a non-Mexican WhatsApp is never re-prefixed with +52; a Mexican one shows as its 10 digits', () => {
  expect(whatsappForDisplay('+525512345678')).toBe('5512345678')
  expect(whatsappForDisplay('+13055551234')).toBe('+13055551234')
  expect(whatsappForSave('+1 305 555 1234')).toBe('+1 305 555 1234')
  expect(whatsappForSave('55 1234 5678')).toBe('5512345678')
  expect(whatsappIsValid('55 1234 5678')).toBe(true)
  expect(whatsappIsValid('+13055551234')).toBe(true)
  expect(whatsappIsValid('12345')).toBe(false)
})

test('saving replaces only our «¿Vende hoy en otra plataforma?» value in current_channels; other values stay', () => {
  expect(mergeCurrentChannels(['Facebook Marketplace', 'shopify'], 'tiendanube')).toEqual(['Facebook Marketplace', 'tiendanube'])
  expect(mergeCurrentChannels(['Facebook Marketplace'], null)).toEqual(['Facebook Marketplace'])
  expect(STEP).toContain('mergeCurrentChannels(otherChannels.current, sellsToday || null)')
})

test('the in-person consent shows only when the owner has approved (the only state the route accepts)', () => {
  const preview = readFileSync('app/(shell)/promotor/cerrar/PreviewStep.tsx', 'utf8')
  expect(preview).toContain("relationshipId && status === 'approved' ?")
  expect(preview).not.toMatch(/status !== 'approved' && status !== 'activated'/)
})

test('the US market and the description stay available (a seller market cannot change later, #409)', () => {
  expect(STEP).toContain('operating_market: market')
  expect(STEP).toContain('description: description.trim() || undefined')
})

test("the create route reads each dedupe hit's owner and lets dedupeConflictBody decide what the 409 reveals", () => {
  const route = readFileSync('app/api/promoter/relationship/route.ts', 'utf8')
  expect(route).toContain(".select('id, promoter_id').eq(column, value)")
  expect(route).toContain('dedupeConflictBody(decision, owner, auth.actor.promoterId)')
  expect(route).not.toMatch(/error: 'Ya existe un registro con estos datos\.', relationshipId: decision\.relationshipId/)
})
