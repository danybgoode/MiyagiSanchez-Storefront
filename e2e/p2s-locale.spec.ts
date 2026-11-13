import { expect, test } from '@playwright/test'
import { builderCopy, nudgeCopy } from '../lib/prompt-to-shop/copy-en'
import { ARMAR_COPY, COBROS_COPY, OWNER_COPY, KEEP_COPY, NUDGE_COPY } from '../lib/prompt-to-shop/copy'
import { draftView, EXAMPLE_TAG, EXAMPLE_TAG_EN, formatSuggestedPrice } from '../lib/prompt-to-shop/view'

// one-front-door-both-markets S2.1 — the builder's own UI copy follows the draft's locale (D11). Pure: no server.
// The English bundles are `satisfies`-checked by tsc; this spec is the runtime twin, so a key that tsc cannot see
// (a JSON-ish cast, a stale build) still fails here, and it compares the NESTED shape, function-valued keys included.

type Shape = string | Shape[] | { [k: string]: Shape }

/** Every key path of a value; a function is a leaf named «fn», an array contributes its length and each element. */
function shapeOf(v: unknown): Shape {
  if (typeof v === 'function') return 'fn'
  if (Array.isArray(v)) return [String(v.length), ...v.map(shapeOf)]
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x)]))
  return typeof v
}

test('every English bundle has exactly the Spanish keys, nested and function-valued included', () => {
  const es = builderCopy('es')
  const en = builderCopy('en')
  expect(Object.keys(en).sort()).toEqual(Object.keys(es).sort())
  expect(Object.keys(es).length).toBeGreaterThanOrEqual(15)
  for (const bundle of Object.keys(es) as Array<keyof typeof es>) {
    const a = shapeOf(es[bundle])
    const b = shapeOf(en[bundle])
    // Compare shapes with free-text leaves collapsed: array LENGTH is part of the shape, string contents are not.
    expect(JSON.stringify(b), `bundle ${bundle}`).toBe(JSON.stringify(a))
  }
  // The nudge emails' bundles, too.
  expect(JSON.stringify(shapeOf(nudgeCopy('en')))).toBe(JSON.stringify(shapeOf(nudgeCopy('es'))))
})

test('builderCopy(es) is the exact Spanish; builderCopy(en) is English', () => {
  expect(builderCopy('es').ARMAR).toBe(ARMAR_COPY)
  expect(builderCopy('es').COBROS).toBe(COBROS_COPY)
  expect(builderCopy('es').OWNER.anotherVersion).toBe(OWNER_COPY.anotherVersion)
  expect(builderCopy('es').KEEP.keep).toBe('Quedármela')
  expect(builderCopy('en').KEEP.keep).toBe('Keep it')
  expect(builderCopy('en').SHAPING.title).toBe("We're building your shop")
  expect(builderCopy('en').NARRATION.map((n) => n.label)).toEqual(['Name', 'Colors', 'Text', 'Sample products', 'Your numbers'])
  expect(builderCopy('en').NARRATION.map((n) => n.key)).toEqual(builderCopy('es').NARRATION.map((n) => n.key))
  expect(builderCopy('en').COBROS.speiName).toBe('Bank transfer')
  expect(builderCopy('en').COBROS.mpName).toBe('Mercado Pago')
  expect(builderCopy('en').PUBLISH.whatsapp).toBe('WhatsApp')
  expect(builderCopy('en').SEED.title(2)).toBe('Your 2 products are ready to upload')
  expect(builderCopy('en').SHAPE_LABELS.products).toBe('Products')
  expect(builderCopy('es').SHAPE_LABELS.products).toBe('Productos')
  expect(nudgeCopy('en').NUDGE.cta).not.toBe(NUDGE_COPY.cta)
  expect(nudgeCopy('es').NUDGE).toBe(NUDGE_COPY)
})

test('a locale other than en falls back to Spanish', () => {
  for (const odd of ['fr', '', 'EN', null, undefined, 42]) {
    expect(builderCopy(odd as never).KEEP).toBe(KEEP_COPY)
  }
})

test('no English string is left as the Spanish one (a copied-over line would pass the shape check)', () => {
  const es = builderCopy('es')
  const en = builderCopy('en')
  const same: string[] = []
  const walk = (a: unknown, b: unknown, path: string) => {
    if (typeof a === 'string' && typeof b === 'string') { if (a === b) same.push(path); return }
    if (a && b && typeof a === 'object' && typeof b === 'object') for (const k of Object.keys(a)) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`)
  }
  walk(es, en, '')

  // Identifiers (block keys, tone values) and cognates (Color, Formal, Digital) match by nature.
  const allowed = /^\.(COBROS\.mpName|PUBLISH\.whatsapp|OWNER\.accentLabel|OWNER\.tones\.1\.label|SHAPE_LABELS\.digital|NARRATION\.\d\.key|OWNER\.tones\.\d\.value)$/
  expect(same.filter((p) => !allowed.test(p))).toEqual([])
})

test('draftView: English tags examples «EXAMPLE» and formats prices as US English; Spanish is unchanged', () => {
  const draft = {
    identity: null, words: null,
    catalog: [{ title: 'Sourdough loaf', description: 'Fresh', price: 1850, currency: 'USD', illustration: 'bread' }],
    block_status: {},
  } as unknown as Parameters<typeof draftView>[1]
  const en = draftView('x', draft, 'en')
  expect(en.cards?.[0].tag).toBe(EXAMPLE_TAG_EN)
  expect(EXAMPLE_TAG_EN).toBe('EXAMPLE')
  expect(en.cards?.[0].priceLabel).toBe('$1,850')
  const es = draftView('x', draft)
  expect(es.cards?.[0].tag).toBe(EXAMPLE_TAG)
  expect(EXAMPLE_TAG).toBe('EJEMPLO')
  expect(draftView('x', draft, 'es').cards?.[0].tag).toBe('EJEMPLO')
  expect(draftView('x', draft, 'fr' as never).cards?.[0].tag).toBe('EJEMPLO')
  // The two locales really format differently: a USD amount reads «US$» in es-MX and «$» in en-US.
  expect(formatSuggestedPrice(25, 'USD', 'en')).toBe('$25')
  expect(formatSuggestedPrice(25, 'USD')).not.toBe('$25')
  expect(formatSuggestedPrice(25, 'USD', 'en')).not.toBe(formatSuggestedPrice(25, 'USD', 'es'))
})

// Codex, PR #499 — a US shop's «pagos» reminder says Stripe in both languages, never Mercado Pago or CLABE.
test('the payments reminder follows the market: Stripe for a US shop, Mercado Pago/CLABE for a Mexican one', () => {
  for (const locale of ['es', 'en'] as const) {
    expect(nudgeCopy(locale, 'us').STEP.pagos.lead).toMatch(/Stripe/)
    expect(nudgeCopy(locale, 'us').STEP.pagos.lead).not.toMatch(/Mercado Pago|CLABE|bank account/i)
    expect(nudgeCopy(locale, 'mx').STEP.pagos.lead).toMatch(/Mercado Pago/)
    expect(nudgeCopy(locale, null).STEP.pagos).toEqual(nudgeCopy(locale, 'mx').STEP.pagos)
  }
})

// Follow-up: the client's own failure messages, and the server's Spanish refusals, read in the screen's language.
import { englishFor } from '../lib/prompt-to-shop/copy-en'
import { claimDraft, publishShop, setClientLocale } from '../lib/prompt-to-shop/client'
import { PHOTO_COPY, PUBLISH_COPY } from '../lib/prompt-to-shop/copy'

test('a Spanish builder message from the server has its English twin; anything else is unchanged', () => {
  expect(englishFor(PHOTO_COPY.noShop)).toBe(builderCopy('en').PHOTO.noShop)
  expect(englishFor(PUBLISH_COPY.failed)).toBe(builderCopy('en').PUBLISH.failed)
  expect(englishFor('Mensaje del backend sin gemelo')).toBe('Mensaje del backend sin gemelo')
})

test('an English screen shows English fallbacks and translated server refusals; Spanish stays Spanish', async () => {
  const dead = { fetch: async () => { throw new Error('offline') } } as never
  const refusing = { fetch: async () => new Response(JSON.stringify({ ok: false, message: PUBLISH_COPY.failed }), { status: 500 }) } as never
  try {
    setClientLocale('en')
    expect(await claimDraft('7f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607', dead)).toEqual({ kind: 'retry', message: builderCopy('en').ARMAR.failed })
    expect(await publishShop(refusing)).toMatchObject({ ok: false, message: builderCopy('en').PUBLISH.failed })
    setClientLocale('es')
    expect(await claimDraft('7f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607', dead)).toEqual({ kind: 'retry', message: builderCopy('es').ARMAR.failed })
  } finally {
    setClientLocale('es')
  }
})
