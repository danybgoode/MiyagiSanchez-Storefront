/**
 * The shop's chat — one buyer question → one answer (business-infrastructure S4, D13/D14). The DECISIONS, with every
 * effect injected so the spec drives the real function and asserts the ORDER:
 *
 *   parse → rate limit → shop (exists · claimed · public) → human check (Turnstile once, then the chat token)
 *         → spend (per shop, then global; fails CLOSED) → knowledge → model → guard → answer
 *
 * Nothing that costs money runs before every refusal has had its chance, and the model never sees another shop's data:
 * the shop comes from the URL's slug, resolved server-side, never from the body.
 */

import {
  buildKnowledge,
  chatRequestBody,
  guardAnswer,
  parseChatBody,
  signChatToken,
  systemPrompt,
  verifyChatToken,
  type ChatProduct,
  type ChatShop,
} from './core'

/** A shop's chat answers this many questions a day; past it the chat says so and offers to leave a message. */
export const CHAT_PER_SHOP_PER_DAY = 200
/** The platform's ceiling across every shop's chat, whatever any one shop does. */
export const CHAT_GLOBAL_PER_DAY = 3000

export const CHAT_COPY = {
  invalid: 'No entendimos tu mensaje. Escríbelo de nuevo, en pocas palabras.',
  notFound: 'Esta tienda no tiene chat.',
  rateLimited: 'Vas muy rápido. Espera un momento y vuelve a preguntar.',
  verify: 'No pudimos verificar que eres una persona. Recarga la página e inténtalo de nuevo.',
  budget: 'La tienda ya respondió muchas preguntas hoy. Déjale tu pregunta y te escribe.',
  unavailable: 'No pudimos responder ahora. Inténtalo de nuevo en un momento.',
  unsure: 'No tengo esa respuesta. Puedes dejarle tu pregunta a la tienda y te escribe.',
} as const

export interface ChatShopRead {
  shop: ChatShop
  products: ChatProduct[]
}

export interface ChatDeps {
  rateAllowed: (slug: string) => Promise<boolean>
  /** null = no such shop, or not one that may chat (unclaimed, preview-private); 'unavailable' = could not read. */
  readShop: (slug: string) => Promise<ChatShopRead | null | 'unavailable'>
  verifyTurnstile: (token: string | null) => Promise<boolean>
  /** `spend_ai_allowance` per subject; true = this question is paid for. Fails closed (an error is false). */
  spend: (subject: string, cap: number) => Promise<boolean>
  callModel: (body: Record<string, unknown>) => Promise<{ ok: boolean; text?: string }>
  secret: string
  now: () => number
  log?: (line: Record<string, unknown>) => void
}

export type ChatResult =
  | { status: 200; body: { answer: string; answered: boolean; chat_token: string } }
  | { status: 400 | 403 | 404 | 429 | 503; body: { error: string; code: keyof typeof CHAT_COPY } }

const refuse = (status: 400 | 403 | 404 | 429 | 503, code: keyof typeof CHAT_COPY): ChatResult => ({ status, body: { error: CHAT_COPY[code], code } })

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/

export async function handleShopChat(input: { slug: string; body: unknown }, deps: ChatDeps): Promise<ChatResult> {
  const slug = input.slug.toLowerCase()
  const body = parseChatBody(input.body)
  if (!SLUG.test(slug) || !body) return refuse(400, 'invalid')

  if (!(await deps.rateAllowed(slug))) return refuse(429, 'rateLimited')

  const read = await deps.readShop(slug)
  if (read === 'unavailable') return refuse(503, 'unavailable')
  if (!read) return refuse(404, 'notFound')

  // Turnstile once per conversation; the signed token (bound to this shop, 30 min) covers the next questions.
  const now = deps.now()
  if (!verifyChatToken(body.chatToken, slug, now, deps.secret)) {
    if (!(await deps.verifyTurnstile(body.turnstileToken))) return refuse(403, 'verify')
  }

  // The shop's own day first (a shop's popularity is not a reason to spend the platform's), then the global ceiling.
  if (!(await deps.spend(`shop_chat:shop:${slug}`, CHAT_PER_SHOP_PER_DAY))) return refuse(429, 'budget')
  if (!(await deps.spend('shop_chat:global', CHAT_GLOBAL_PER_DAY))) return refuse(429, 'budget')

  const knowledge = buildKnowledge(read.shop, read.products)
  const result = await deps.callModel(chatRequestBody(systemPrompt(read.shop.name, knowledge), body.messages))
  const chat_token = signChatToken(slug, now, deps.secret)
  const answer = result.ok ? guardAnswer(result.text, knowledge) : null
  if (!answer) {
    deps.log?.({ event: 'shop_chat_unguarded', slug, ok: result.ok })
    // A refused or failed answer is «no sé», which the widget turns into "leave your question" — never a wrong fact.
    return { status: 200, body: { answer: CHAT_COPY.unsure, answered: false, chat_token } }
  }
  return { status: 200, body: { answer: answer.answer, answered: answer.answered, chat_token } }
}
