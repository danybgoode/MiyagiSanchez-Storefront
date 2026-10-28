import { expect, test } from '@playwright/test'
import { handleCreateDraft, parseDraftsBody, type DraftsDeps } from '../lib/prompt-to-shop/handler'
import { generateDraft, type BlockEvent } from '../lib/prompt-to-shop/planner'
import { TONE_HINT, TONES, isTone, wordsPrompt } from '../lib/prompt-to-shop/prompts'

// Prompt-to-shop S2.4 — «Otra versión» with a tone. The tone is a closed enum that reaches ONLY the words prompt,
// outside the merchant's data tags, and does not move the D7 order.

const DEVICE = '0b9e8c1e-3c2a-4d8e-9a51-6f1f2b3c4d5e'
const DRAFT = '7f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607'
const DESCRIPTION = 'Vendo tamales de masa madre en Puebla, por pedido'
const goodText = {
  identity: JSON.stringify({ name: 'Tamales La Abuela', tagline: 'Tamales de masa madre', description: 'Hechos a mano.', accent_color: '#8a3b12', accent_alternates: ['#1f6f5c', '#2f4b8a', '#6b2f6b'], theme_preset: 'terracota' }),
  words: JSON.stringify({ announcement: 'Pedidos con un día de anticipación.', headline: 'Como los de casa', about: 'Somos una familia poblana.' }),
  catalog: JSON.stringify({ products: [1, 2, 3, 4].map((n) => ({ title: `Tamal número ${n}`, price: 30 + n, category: 'otros' })) }),
}

test('tone is an optional closed enum on the body; anything else is a 400-shaped null', () => {
  expect(parseDraftsBody({ draft_id: DRAFT })).toMatchObject({ tone: null })
  for (const tone of TONES) expect(parseDraftsBody({ draft_id: DRAFT, tone })).toMatchObject({ tone })
  expect(parseDraftsBody({ draft_id: DRAFT, tone: 'agresivo' })).toBeNull()
  expect(parseDraftsBody({ draft_id: DRAFT, tone: 7 })).toBeNull()
  expect(isTone('formal')).toBe(true)
  expect(isTone('Formal')).toBe(false)
})

test('the words prompt carries the chosen tone OUTSIDE the data tags, and the default when none is chosen', () => {
  const id = { name: 'Tamales', tagline: 'Masa madre' }
  const plain = wordsPrompt(DESCRIPTION, id)
  expect(plain).toContain('Tono cercano, claro, sin exagerar')
  for (const tone of TONES) {
    const p = wordsPrompt(DESCRIPTION, id, tone)
    expect(p, tone).toContain(TONE_HINT[tone])
    expect(p.indexOf(TONE_HINT[tone]), tone).toBeLessThan(p.indexOf('<descripcion_del_negocio>'))
  }
  expect(wordsPrompt(DESCRIPTION, id, 'formal')).not.toContain('Tono cercano, claro')
})

test('the tone reaches the words call only — not identity, not catalog', async () => {
  const prompts: Record<string, string> = {}
  const events: BlockEvent[] = []
  await generateDraft(DESCRIPTION, {
    callModel: async (req) => { prompts[req.block] = req.body.contents[0].parts[0].text; return { ok: true, text: goodText[req.block] } },
    saveBlock: async () => true,
    emit: (e) => events.push(e),
  }, { tone: 'divertido' })
  expect(prompts.words).toContain(TONE_HINT.divertido)
  expect(prompts.identity).not.toContain(TONE_HINT.divertido)
  expect(prompts.catalog).not.toContain(TONE_HINT.divertido)
  expect(events.map((e) => e.key)).toEqual(['identity', 'words', 'catalog'])
})

test('the handler hands the parsed tone to the model, and a tone changes neither the order nor the spend', async () => {
  const trace: string[] = []
  let wordsPromptText = ''
  const deps: DraftsDeps = {
    verifyTurnstile: async () => { trace.push('turnstile'); return { ok: true } },
    burstAllowed: async () => { trace.push('burst'); return true },
    spend: async () => { trace.push('spend'); return { data: { ok: true, reason: null, versions_used: 2 }, error: null } },
    findOwnedDraft: async () => { trace.push('find'); return { id: DRAFT, description: DESCRIPTION } },
    createDraft: async () => null,
    startVersion: async () => { trace.push('version'); return true },
    saveBlock: async () => true,
    refund: async () => {},
    callModel: async (req) => { if (req.block === 'words') wordsPromptText = req.body.contents[0].parts[0].text; return { ok: true, text: goodText[req.block] } },
    modelConfigured: true,
    newDeviceId: () => DEVICE,
  }
  const result = await handleCreateDraft({ body: { draft_id: DRAFT, tone: 'formal', turnstile_token: 't' }, deviceCookie: DEVICE }, deps)
  if (result.kind !== 'stream') throw new Error('expected a stream')
  await result.run(() => {})
  expect(trace).toEqual(['turnstile', 'burst', 'find', 'spend', 'version'])
  expect(wordsPromptText).toContain(TONE_HINT.formal)
  // An invalid tone is refused at the validate step, before Turnstile even runs.
  const bad = fakesOrder()
  const refused = await handleCreateDraft({ body: { draft_id: DRAFT, tone: 'agresivo', turnstile_token: 't' }, deviceCookie: DEVICE }, bad.deps)
  expect(refused).toMatchObject({ kind: 'refuse', status: 400 })
  expect(bad.trace).toEqual([])
})

function fakesOrder() {
  const trace: string[] = []
  const deps = {
    verifyTurnstile: async () => { trace.push('turnstile'); return { ok: true } },
    burstAllowed: async () => { trace.push('burst'); return true },
  } as unknown as DraftsDeps
  return { deps, trace }
}
