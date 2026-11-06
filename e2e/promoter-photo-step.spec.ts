/**
 * The promoter fills a shop from photos (epic 08 · plans-gratis-negocio S5.1, README D14).
 *
 * The suggestion only FILLS the workspace form; publishing still goes through the existing listing route. So what
 * matters here is the order and the refusals: only the promoter's own upload is fetched (an SSRF door otherwise), the
 * promoter's own daily budget is spent BEFORE any model call and fails closed, and a bad answer becomes "fill it by
 * hand", never an invented card.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { promoterPhotoSubject, suggestFromPhoto, type PromoterPhotoDeps } from '../lib/promoter-photo'

const PROMOTER_USER = 'user_promoter'
const R2 = 'https://pub-0123abcd.r2.dev'
const HOSTS = { r2PublicUrl: R2, supabaseUrl: 'https://abcdefgh.supabase.co' }
const OWN = `${R2}/listing-images/${PROMOTER_USER}/1730000000000-abc.jpg`
const GOOD = JSON.stringify({ title: 'Tamales de rajas', description: 'Docena de tamales.', category: 'hogar', price: 180 })

function world(over: Partial<PromoterPhotoDeps> = {}) {
  const trace: string[] = []
  const deps: PromoterPhotoDeps = {
    hosts: HOSTS,
    burstAllowed: async () => { trace.push('burst'); return true },
    spend: async () => { trace.push('spend'); return { data: 1, error: null } },
    modelConfigured: true,
    fetchImage: async () => { trace.push('fetch'); return { mimeType: 'image/jpeg', base64: 'AAAA' } },
    callModel: async () => { trace.push('model'); return { ok: true, text: GOOD } },
    ...over,
  }
  return { deps, trace }
}

test('only the promoter\'s own upload is fetched — another user\'s or a foreign URL is refused before any spend', async () => {
  for (const url of [`${R2}/listing-images/someone_else/a.jpg`, 'https://evil.example/a.jpg', 'http://169.254.169.254/x', 42]) {
    const w = world()
    const out = await suggestFromPhoto({ promoterClerkId: PROMOTER_USER, imageUrl: url, shopName: 'Tamales' }, w.deps)
    expect(out.status).toBe(400)
    expect(w.trace).toEqual([])
  }
})

test('the order: burst → spend → fetch → model, and a valid card fills the form', async () => {
  const w = world()
  const out = await suggestFromPhoto({ promoterClerkId: PROMOTER_USER, imageUrl: OWN, shopName: 'Tamales' }, w.deps)
  expect(out).toEqual({ status: 200, body: { ok: true, suggestion: { title: 'Tamales de rajas', description: 'Docena de tamales.', category: 'hogar', price: 180 } } })
  expect(w.trace).toEqual(['burst', 'spend', 'fetch', 'model'])
})

test('the daily budget fails CLOSED: at the cap or on an error there is no model call', async () => {
  const capped = world({ spend: async () => ({ data: null, error: null }) })
  expect((await suggestFromPhoto({ promoterClerkId: PROMOTER_USER, imageUrl: OWN, shopName: null }, capped.deps)).status).toBe(429)
  expect(capped.trace).not.toContain('model')
  const broken = world({ spend: async () => ({ data: null, error: { message: 'boom' } }) })
  expect((await suggestFromPhoto({ promoterClerkId: PROMOTER_USER, imageUrl: OWN, shopName: null }, broken.deps)).status).toBe(503)
  expect(broken.trace).not.toContain('model')
})

test('a bad answer is retried once, then "fill it by hand" — never an invented card', async () => {
  let calls = 0
  const w = world({ callModel: async () => { calls += 1; return { ok: true, text: '{"title":""}' } } })
  const out = await suggestFromPhoto({ promoterClerkId: PROMOTER_USER, imageUrl: OWN, shopName: null }, w.deps)
  expect(out.status).toBe(200)
  if (out.status === 200) expect(out.body.suggestion).toBeNull()
  expect(calls).toBe(2)
})

test('every model call spends one unit — the retry included, and an exhausted budget stops the retry', async () => {
  let spends = 0
  let calls = 0
  const bad = async () => { calls += 1; return { ok: true, text: '{"title":""}' } }
  const paid = world({ spend: async () => { spends += 1; return { data: spends, error: null } }, callModel: bad })
  await suggestFromPhoto({ promoterClerkId: PROMOTER_USER, imageUrl: OWN, shopName: null }, paid.deps)
  expect({ spends, calls }).toEqual({ spends: 2, calls: 2 })

  spends = 0
  calls = 0
  const lastUnit = world({ spend: async () => { spends += 1; return { data: spends === 1 ? 60 : null, error: null } }, callModel: bad })
  const out = await suggestFromPhoto({ promoterClerkId: PROMOTER_USER, imageUrl: OWN, shopName: null }, lastUnit.deps)
  expect({ spends, calls }).toEqual({ spends: 2, calls: 1 })
  expect(out.status).toBe(200)
  if (out.status === 200) expect(out.body.suggestion).toBeNull()
})

test('no model credential: "fill it by hand", and nothing is spent', async () => {
  const w = world({ modelConfigured: false })
  const out = await suggestFromPhoto({ promoterClerkId: PROMOTER_USER, imageUrl: OWN, shopName: null }, w.deps)
  expect(out.status).toBe(200)
  expect(w.trace).not.toContain('spend')
})

test('the promoter spends from their own subject, and the route is limited to shops they opened', () => {
  expect(promoterPhotoSubject('p1')).toBe('photo_analysis:promoter:p1')
  const route = readFileSync('app/api/promoter/close/photo/route.ts', 'utf8')
  // The same write rule as adding a product (promoter-panel D1): opened by this promoter and not yet claimed.
  expect(route.indexOf('promoterShopEditAccess(')).toBeGreaterThan(-1)
  expect(route.indexOf('promoterShopEditAccess(')).toBeLessThan(route.indexOf('suggestFromPhoto('))
  // The suggestion only fills the form: publishing is still the existing listing route.
  const ui = readFileSync('app/(shell)/promotor/cerrar/ProductosStep.tsx', 'utf8')
  expect(ui).toContain("fetch('/api/promoter/close/photo'")
})
