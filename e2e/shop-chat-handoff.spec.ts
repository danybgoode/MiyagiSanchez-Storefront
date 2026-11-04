import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { signChatToken } from '../lib/shop-chat/core'
import { EMAIL_RETENTION_DAYS, FAQ_CAP, HANDOFF_COPY, handleLeave, handleReply, parseLeave, purgeCutoff, withFaq, type LeaveDeps, type ReplyDeps } from '../lib/shop-chat/handoff'
import { COMMUNICATION_CATALOG } from '../lib/notifications/catalog'

// business-infrastructure S5 — the handoff that learns (D17).

const SECRET = 's'
const NOW = Date.parse('2026-11-04T12:00:00Z')
const SHOP = { slug: 'tamales-rosa', name: 'Tamales Doña Rosa', sellerId: 'sel_1', ownerClerkUserId: 'user_owner' }
const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const TOKEN = signChatToken('tamales-rosa', NOW, SECRET)
const body = (over: Record<string, unknown> = {}) => ({ email: 'Ana@Ejemplo.mx', question: '¿Hacen factura?', transcript: [{ role: 'user', text: '¿Hacen factura?' }, { role: 'assistant', text: 'No sé.' }], chat_token: TOKEN, ...over })

function leaveFakes(over: Partial<LeaveDeps> = {}) {
  const trace: string[] = []
  const deps: LeaveDeps = {
    rateAllowed: async () => { trace.push('rate'); return true },
    readShop: async (slug) => { trace.push(`shop:${slug}`); return slug === 'tamales-rosa' ? SHOP : null },
    store: async (row) => { trace.push(`store:${row.email}`); return 'thread-1' },
    notifyOwner: async (shop) => { trace.push(`notify:${shop.ownerClerkUserId}`) },
    secret: SECRET,
    now: () => NOW,
    ...over,
  }
  return { deps, trace }
}

test('leave: an email and a question, the transcript capped; anything else is refused whole', () => {
  expect(parseLeave(body())).toMatchObject({ email: 'ana@ejemplo.mx', question: '¿Hacen factura?' })
  expect(parseLeave(body({ email: 'not-an-email' }))).toBeNull()
  expect(parseLeave(body({ question: '' }))).toBeNull()
  expect(parseLeave(body({ question: 'x'.repeat(601) }))).toBeNull()
  expect(parseLeave(body({ transcript: Array.from({ length: 30 }, () => ({ role: 'user', text: 'hola' })) }))?.transcript).toHaveLength(12)
})

test('leave: rate → shop → the conversation token → store → alert the OWNER (resolved from the shop, never the body)', async () => {
  const { deps, trace } = leaveFakes()
  const r = await handleLeave({ slug: 'tamales-rosa', body: body({ owner: 'attacker' }) }, deps)
  expect(r).toMatchObject({ status: 200, body: { ok: true, message: HANDOFF_COPY.sent } })
  expect(trace).toEqual(['rate', 'shop:tamales-rosa', 'store:ana@ejemplo.mx', 'notify:user_owner'])
})

test('leave: no conversation (no token, another shop\'s, expired) stores nothing; a failed alert still keeps the question', async () => {
  for (const chat_token of [null, signChatToken('velas-luz', NOW, SECRET), signChatToken('tamales-rosa', NOW - 31 * 60 * 1000, SECRET)]) {
    const { deps, trace } = leaveFakes()
    const r = await handleLeave({ slug: 'tamales-rosa', body: body({ chat_token }) }, deps)
    expect(r.status).toBe(403)
    expect(trace.some((t) => t.startsWith('store:'))).toBe(false)
  }
  const unclaimed = leaveFakes()
  expect((await handleLeave({ slug: 'otra', body: body() }, unclaimed.deps)).status).toBe(404)
  const storeDown = leaveFakes({ store: async () => null })
  expect((await handleLeave({ slug: 'tamales-rosa', body: body() }, storeDown.deps)).status).toBe(503)
  const alertDown = leaveFakes({ notifyOwner: async () => { throw new Error('smtp') } })
  expect((await handleLeave({ slug: 'tamales-rosa', body: body() }, alertDown.deps)).status).toBe(200)
})

const THREAD = '7f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607'
function replyFakes(over: Partial<ReplyDeps> = {}) {
  const trace: string[] = []
  let claimed = false
  const deps: ReplyDeps = {
    claim: async (id, owner) => {
      trace.push(`claim:${owner}`)
      if (owner !== 'user_owner' || claimed) return null
      claimed = true
      return { id, question: '¿Hacen factura?', buyerEmail: 'ana@ejemplo.mx', shopSlug: 'tamales-rosa', shopName: 'Tamales Doña Rosa' }
    },
    emailBuyer: async () => { trace.push('email'); return true },
    readFaq: async () => { trace.push('readFaq'); return { items: [{ question: '¿Dónde están?', answer: 'Coyoacán.' }] } },
    writeFaq: async (items) => { trace.push(`writeFaq:${items.length}`); return true },
    ...over,
  }
  return { deps, trace }
}

test('reply: claim (by id AND owner) → email the buyer → add to the FAQ; a double tap answers and emails ONCE', async () => {
  const { deps, trace } = replyFakes()
  const first = await handleReply({ threadId: THREAD, ownerClerkUserId: 'user_owner', body: { reply: 'Sí, facturamos.', save_faq: true } }, deps)
  expect(first).toMatchObject({ status: 200, body: { ok: true, emailed: true, faq: 'added' } })
  const second = await handleReply({ threadId: THREAD, ownerClerkUserId: 'user_owner', body: { reply: 'Sí, facturamos.', save_faq: true } }, deps)
  expect(second.status).toBe(409)
  expect(trace).toEqual(['claim:user_owner', 'email', 'readFaq', 'writeFaq:2', 'claim:user_owner'])
})

test('reply: another merchant cannot answer it; a bad body never claims', async () => {
  const other = replyFakes()
  expect((await handleReply({ threadId: THREAD, ownerClerkUserId: 'user_other', body: { reply: 'x' } }, other.deps)).status).toBe(409)
  expect(other.trace).toEqual(['claim:user_other'])
  const bad = replyFakes()
  expect((await handleReply({ threadId: THREAD, ownerClerkUserId: 'user_owner', body: { reply: '' } }, bad.deps)).status).toBe(400)
  expect(bad.trace).toEqual([])
})

test('the FAQ: appended, a same question replaced, refused at the platform\'s cap; the reply still goes out', async () => {
  expect(withFaq(null, '¿Facturan?', 'Sí.')).toEqual({ items: [{ question: '¿Facturan?', answer: 'Sí.' }] })
  expect(withFaq({ items: [{ question: '¿Facturan?', answer: 'No.' }] }, '¿facturan? ', 'Sí.')).toEqual({ items: [{ question: '¿Facturan?', answer: 'Sí.' }] })
  const full = { items: Array.from({ length: FAQ_CAP }, (_, i) => ({ question: `q${i}`, answer: 'a' })) }
  expect(withFaq(full, 'nueva', 'r')).toEqual({ full: true })
  const { deps, trace } = replyFakes({ readFaq: async () => full })
  const r = await handleReply({ threadId: THREAD, ownerClerkUserId: 'user_owner', body: { reply: 'Sí.', save_faq: true } }, deps)
  expect(r).toMatchObject({ status: 200, body: { faq: 'full' } })
  expect(trace).toContain('email')
  expect(trace.some((t) => t.startsWith('writeFaq'))).toBe(false)
})

test('privacy: emails purged 90 days after the answer; the table is service-role only; the reply route uses the caller\'s session', () => {
  expect(EMAIL_RETENTION_DAYS).toBe(90)
  expect(purgeCutoff(new Date('2026-11-04T00:00:00Z'))).toBe('2026-08-06T00:00:00.000Z')
  const sql = src('supabase/migrations/20261104010000_shop_chat_threads.sql')
  expect(sql).toMatch(/REVOKE ALL ON public\.shop_chat_threads FROM PUBLIC, anon, authenticated/)
  expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/)
  const server = src('lib/shop-chat/handoff-server.ts')
  expect(server).toMatch(/\.eq\('owner_clerk_user_id', ownerClerkUserId\)\s*\.eq\('status', 'open'\)/)
  expect(server).toContain("if (read.shop.clerk_user_id !== owner.clerkUserId) return 'unavailable'")
  const route = src('app/api/shop/questions/[id]/reply/route.ts')
  expect(route).toContain('ownerClerkUserId: userId')
  expect(src('app/api/cron/business-checkin/route.ts')).toContain('await purgeAnsweredEmails()')
  expect(COMMUNICATION_CATALOG.map((e) => e.key)).toEqual(expect.arrayContaining(['mensajes.shop_question', 'mensajes.shop_answer']))
  // the widget offers the handoff only after a «no sé», inside a verified conversation
  expect(src('components/shop-chat/ShopChat.tsx')).toContain("const offerLeave = verified && last?.role === 'assistant' && last.answered === false")
})
