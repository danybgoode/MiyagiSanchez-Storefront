/**
 * The handoff (business-infrastructure S5, D17): a question the shop's chat could not answer goes to the merchant, the
 * merchant's reply goes to the buyer by email, and — one tap — becomes a frequent question the chat answers next time.
 *
 * Leave:  parse → rate limit → shop (claimed, public; from the URL) → a valid conversation token (proof the buyer
 *         passed the human check in THIS shop's chat) → store → alert the owner.
 * Reply:  parse → claim (open → answered, by id AND owner, read back) → email the buyer → (optional) add to the FAQ.
 *         validate → claim → apply: a double tap answers once and emails once (team memory: a read is not a claim).
 *
 * Pure: every effect is injected; the spec drives the real functions and asserts the order.
 */

import { CHAT_LIMITS, verifyChatToken, type ChatTurn } from './core'

/** The FAQ the platform keeps (`settings-import` caps `content.faq.items` at 12, question ≤ 140, answer ≤ 600). */
export const FAQ_CAP = 12
/** A buyer's email is kept until 90 days after the answer — long enough for a follow-up, then gone. */
export const EMAIL_RETENTION_DAYS = 90

export const HANDOFF_COPY = {
  invalid: 'Revisa tu correo y tu pregunta.',
  notFound: 'Esta tienda no recibe preguntas por aquí.',
  rateLimited: 'Vas muy rápido. Espera un momento.',
  verify: 'Tu conversación expiró. Vuelve a abrir el chat y pregunta otra vez.',
  unavailable: 'No pudimos enviar tu pregunta ahora. Inténtalo de nuevo en un momento.',
  sent: 'Listo: la tienda recibió tu pregunta y te escribe a tu correo.',
  replyInvalid: 'Escribe una respuesta de hasta 600 caracteres.',
  replyGone: 'Esta pregunta ya fue respondida o no es de tu tienda.',
  replyDone: 'Respuesta enviada.',
  faqAdded: 'También quedó en tus preguntas frecuentes: el chat ya la responde.',
  faqFull: 'Tus preguntas frecuentes ya tienen 12. Quita una en Configuración › Páginas para agregar esta.',
  faqFailed: 'La respuesta se envió, pero no pudimos agregarla a tus preguntas frecuentes. Agrégala en Configuración › Páginas.',
} as const

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,24}$/i

export interface LeaveRequest {
  email: string
  question: string
  transcript: ChatTurn[]
  chatToken: string | null
}

export function parseLeave(body: unknown): LeaveRequest | null {
  if (!isObj(body) || typeof body.email !== 'string' || typeof body.question !== 'string') return null
  const email = body.email.trim().toLowerCase()
  const question = clean(body.question)
  if (!EMAIL.test(email) || email.length > 254 || !question || question.length > CHAT_LIMITS.maxMessageChars) return null
  const transcript: ChatTurn[] = []
  for (const t of Array.isArray(body.transcript) ? body.transcript.slice(-CHAT_LIMITS.maxMessages) : []) {
    if (!isObj(t) || (t.role !== 'user' && t.role !== 'assistant') || typeof t.text !== 'string') continue
    const text = clean(t.text).slice(0, CHAT_LIMITS.maxAnswerChars)
    if (text) transcript.push({ role: t.role, text })
  }
  return { email, question, transcript, chatToken: typeof body.chat_token === 'string' ? body.chat_token : null }
}

export interface HandoffShop {
  slug: string
  name: string
  sellerId: string
  ownerClerkUserId: string
}

export interface LeaveDeps {
  rateAllowed: (slug: string) => Promise<boolean>
  readShop: (slug: string) => Promise<HandoffShop | null | 'unavailable'>
  /** Insert one thread; the id, or null when the write did not land. */
  store: (row: { shop: HandoffShop; question: string; transcript: ChatTurn[]; email: string }) => Promise<string | null>
  /** Alert the owner on their channels. Best effort: the question is stored either way. */
  notifyOwner: (shop: HandoffShop, threadId: string, question: string) => Promise<void>
  secret: string
  now: () => number
}

export type HandoffResult = { status: 200 | 400 | 403 | 404 | 409 | 429 | 503; body: { ok: boolean; message: string; [k: string]: unknown } }

const fail = (status: HandoffResult['status'], message: string): HandoffResult => ({ status, body: { ok: false, message } })

export async function handleLeave(input: { slug: string; body: unknown }, deps: LeaveDeps): Promise<HandoffResult> {
  const slug = input.slug.toLowerCase()
  const req = parseLeave(input.body)
  if (!req || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return fail(400, HANDOFF_COPY.invalid)
  if (!(await deps.rateAllowed(slug))) return fail(429, HANDOFF_COPY.rateLimited)
  const shop = await deps.readShop(slug)
  if (shop === 'unavailable') return fail(503, HANDOFF_COPY.unavailable)
  if (!shop) return fail(404, HANDOFF_COPY.notFound)
  // Only from inside a real conversation with THIS shop: the token was minted after the human check.
  if (!verifyChatToken(req.chatToken, slug, deps.now(), deps.secret)) return fail(403, HANDOFF_COPY.verify)
  const id = await deps.store({ shop, question: req.question, transcript: req.transcript, email: req.email })
  if (!id) return fail(503, HANDOFF_COPY.unavailable)
  await deps.notifyOwner(shop, id, req.question).catch(() => {})
  return { status: 200, body: { ok: true, message: HANDOFF_COPY.sent } }
}

// ── The merchant's reply ──────────────────────────────────────────────────────────────────────────────────────────

export interface ReplyRequest { reply: string; saveFaq: boolean }

export function parseReply(body: unknown): ReplyRequest | null {
  if (!isObj(body) || typeof body.reply !== 'string') return null
  const reply = clean(body.reply)
  if (!reply || reply.length > CHAT_LIMITS.maxMessageChars) return null
  return { reply, saveFaq: body.save_faq === true }
}

export interface ClaimedThread {
  id: string
  question: string
  buyerEmail: string | null
  shopSlug: string
  shopName: string
}

export type FaqItem = { question: string; answer: string }

/** The FAQ after adding one answer: appended (a same question is replaced), or `full` at the platform's cap. */
export function withFaq(existing: unknown, question: string, answer: string): { items: FaqItem[] } | { full: true } {
  const items: FaqItem[] = (isObj(existing) && Array.isArray(existing.items) ? existing.items : [])
    .filter((it): it is FaqItem => isObj(it) && typeof it.question === 'string' && typeof it.answer === 'string')
    .map((it) => ({ question: it.question, answer: it.answer }))
  const q = question.slice(0, 140)
  const at = items.findIndex((it) => it.question.trim().toLowerCase() === q.trim().toLowerCase())
  if (at >= 0) return { items: items.map((it, i) => (i === at ? { question: it.question, answer } : it)) }
  if (items.length >= FAQ_CAP) return { full: true }
  return { items: [...items, { question: q, answer }] }
}

export interface ReplyDeps {
  /** Conditional `open → answered` by id AND owner, `.select()` back. null = not open, or not this owner's. */
  claim: (threadId: string, ownerClerkUserId: string, reply: string) => Promise<ClaimedThread | null | 'unavailable'>
  emailBuyer: (thread: ClaimedThread, reply: string) => Promise<boolean>
  readFaq: () => Promise<unknown | 'unavailable'>
  writeFaq: (items: FaqItem[]) => Promise<boolean>
}

export async function handleReply(input: { threadId: string; ownerClerkUserId: string; body: unknown }, deps: ReplyDeps): Promise<HandoffResult> {
  const req = parseReply(input.body)
  if (!req || !/^[0-9a-f-]{36}$/i.test(input.threadId)) return fail(400, HANDOFF_COPY.replyInvalid)
  const thread = await deps.claim(input.threadId, input.ownerClerkUserId, req.reply)
  if (thread === 'unavailable') return fail(503, HANDOFF_COPY.unavailable)
  if (!thread) return fail(409, HANDOFF_COPY.replyGone)
  const emailed = thread.buyerEmail ? await deps.emailBuyer(thread, req.reply).catch(() => false) : false
  let faq: 'added' | 'full' | 'failed' | 'skipped' = 'skipped'
  if (req.saveFaq) {
    const current = await deps.readFaq().catch(() => 'unavailable' as const)
    if (current === 'unavailable') faq = 'failed'
    else {
      const next = withFaq(current, thread.question, req.reply)
      faq = 'full' in next ? 'full' : (await deps.writeFaq(next.items).catch(() => false)) ? 'added' : 'failed'
    }
  }
  const message = [HANDOFF_COPY.replyDone, faq === 'added' ? HANDOFF_COPY.faqAdded : faq === 'full' ? HANDOFF_COPY.faqFull : faq === 'failed' ? HANDOFF_COPY.faqFailed : null]
    .filter(Boolean)
    .join(' ')
  return { status: 200, body: { ok: true, message, emailed, faq } }
}

/** Threads answered before this instant have their buyer email nulled. */
export function purgeCutoff(now: Date): string {
  return new Date(now.getTime() - EMAIL_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
}
