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
import { isLikelyShopSlug } from '../route-shape'
import { PLAN_ALLOWANCES } from '../plan-allowances'

/** A shop's chat answers this many questions a day; past it the chat says so and offers to leave a message. */
export const CHAT_PER_SHOP_PER_DAY = 200
/** The platform's ceiling across every shop's chat, whatever any one shop does. */
export const CHAT_GLOBAL_PER_DAY = 3000
/**
 * Agents (`ask_shop`, no human check) spend from their OWN subjects: a script could otherwise exhaust a shop's — or
 * every shop's — chat for the day and take the widget down for real buyers (PR #469 review). Lower caps, same shape.
 */
export const AGENT_PER_SHOP_PER_DAY = 50
export const AGENT_GLOBAL_PER_DAY = 500
/** When a shop's plan cannot be read, its monthly chat allowance is Gratis's — the lower one. */
const GRATIS_CHAT_MONTHLY = PLAN_ALLOWANCES.gratis.chatAnswersPerMonth

export const CHAT_COPY = {
  invalid: 'No entendimos tu mensaje. Escríbelo de nuevo, en pocas palabras.',
  notFound: 'Esta tienda no tiene chat.',
  rateLimited: 'Vas muy rápido. Espera un momento y vuelve a preguntar.',
  verify: 'No pudimos verificar que eres una persona. Recarga la página e inténtalo de nuevo.',
  // Neutral: a budget refusal adds no answer to the thread, so the leave form never follows it (PR #470 review).
  budget: 'La tienda ya respondió muchas preguntas hoy. Vuelve a intentarlo mañana.',
  unavailable: 'No pudimos responder ahora. Inténtalo de nuevo en un momento.',
  // The shop's plan allowance for the month is used up (plans-gratis-negocio D8). Sent as an UNANSWERED answer, so
  // the widget offers «Déjale tu pregunta a la tienda» — the buyer is never left with an error.
  allowance: 'Esta tienda ya respondió muchas preguntas este mes. Déjale la tuya y te responde por correo.',
  // S5 ships the handoff, so «no sé» can now offer it: the widget shows the form under this answer.
  unsure: 'No tengo esa respuesta en la información de la tienda. Puedes dejarle tu pregunta y te escribe.',
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
  /**
   * The shop's monthly answers for its plan (`lib/plan-allowances.ts`), or null when the plan could not be read —
   * then Gratis's allowance applies (fail closed). Omitted (a test, an older caller): no monthly allowance.
   */
  monthlyCap?: (slug: string) => Promise<number | null>
  /** Spend one answer from the shop's MONTHLY allowance (`spend_ai_allowance`, kind `chat_month`). Fails closed. */
  spendMonth?: (subject: string, cap: number) => Promise<boolean>
  callModel: (body: Record<string, unknown>) => Promise<{ ok: boolean; text?: string }>
  secret: string
  now: () => number
  /** Who is asking: a person in the widget (default) or an agent through MCP — they spend from separate subjects. */
  audience?: 'web' | 'agent'
  log?: (line: Record<string, unknown>) => void
}

export type ChatResult =
  | { status: 200; body: { answer: string; answered: boolean; chat_token: string } }
  | { status: 400 | 403 | 404 | 429 | 503; body: { error: string; code: keyof typeof CHAT_COPY } }

const refuse = (status: 400 | 403 | 404 | 429 | 503, code: keyof typeof CHAT_COPY): ChatResult => ({ status, body: { error: CHAT_COPY[code], code } })

export async function handleShopChat(input: { slug: string; body: unknown }, deps: ChatDeps): Promise<ChatResult> {
  const slug = input.slug.toLowerCase()
  const body = parseChatBody(input.body)
  // The platform's own slug rule (up to 80 characters), not a second, shorter one (PR #469 review).
  if (!isLikelyShopSlug(slug) || !body) return refuse(400, 'invalid')

  if (!(await deps.rateAllowed(slug))) return refuse(429, 'rateLimited')

  const read = await deps.readShop(slug)
  if (read === 'unavailable') return refuse(503, 'unavailable')
  if (!read) return refuse(404, 'notFound')

  // Turnstile once per conversation; the signed token (bound to this shop, 30 min) covers the next questions.
  const now = deps.now()
  const hasToken = verifyChatToken(body.chatToken, slug, now, deps.secret)
  if (!hasToken) {
    if (!(await deps.verifyTurnstile(body.turnstileToken))) return refuse(403, 'verify')
  }

  // The shop's own day first (a shop's popularity is not a reason to spend the platform's), then the global ceiling.
  const agent = deps.audience === 'agent'
  const shopSubject = agent ? `shop_chat:agent:shop:${slug}` : `shop_chat:shop:${slug}`
  const globalSubject = agent ? 'shop_chat:agent:global' : 'shop_chat:global'
  if (!(await deps.spend(shopSubject, agent ? AGENT_PER_SHOP_PER_DAY : CHAT_PER_SHOP_PER_DAY))) return refuse(429, 'budget')
  if (!(await deps.spend(globalSubject, agent ? AGENT_GLOBAL_PER_DAY : CHAT_GLOBAL_PER_DAY))) return refuse(429, 'budget')

  // Then the plan's monthly allowance (D8) — after the daily checks, so a daily refusal never uses up a monthly answer
  // (Codex, #472). Over it, the buyer is offered the leave-a-question form, not an error. A model failure after this
  // still counts: that call cost money too.
  // Widget and agents spend from ONE monthly subject: the allowance is the shop's, whoever asks.
  if (deps.monthlyCap && deps.spendMonth) {
    const cap = (await deps.monthlyCap(slug)) ?? GRATIS_CHAT_MONTHLY
    if (!(await deps.spendMonth(`shop_chat:month:shop:${slug}`, cap))) {
      const chat_token = hasToken && body.chatToken ? body.chatToken : signChatToken(slug, now, deps.secret)
      deps.log?.({ event: 'shop_chat_allowance', slug, cap })
      return { status: 200, body: { answer: CHAT_COPY.allowance, answered: false, chat_token } }
    }
  }

  const knowledge = buildKnowledge(read.shop, read.products)
  const result = await deps.callModel(chatRequestBody(systemPrompt(read.shop.name, knowledge), body.messages))
  // The token does NOT slide: one human check buys one 30-minute conversation, never an endless pass (PR #469 review).
  const chat_token = hasToken && body.chatToken ? body.chatToken : signChatToken(slug, now, deps.secret)
  const answer = result.ok ? guardAnswer(result.text, knowledge) : null
  if (!answer) {
    deps.log?.({ event: 'shop_chat_unguarded', slug, ok: result.ok })
    // A refused or failed answer is «no sé», which the widget turns into "leave your question" — never a wrong fact.
    return { status: 200, body: { answer: CHAT_COPY.unsure, answered: false, chat_token } }
  }
  return { status: 200, body: { answer: answer.answer, answered: answer.answered, chat_token } }
}
