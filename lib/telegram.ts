/**
 * Telegram messaging.
 *
 * Two audiences share one bot (TELEGRAM_BOT_TOKEN):
 *   • admin — Daniel's private chat (TELEGRAM_CHAT_ID); every `tg.*` helper below.
 *   • sellers — their own linked chat (Granular Notifications epic, Sprint 2);
 *     the dispatch seam passes an explicit chat_id to `tgSend`.
 *
 * All sends are fire-and-forget — never throw, never block the request path.
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN   — bot token from @BotFather (required for any send)
 *   TELEGRAM_CHAT_ID     — admin's personal chat ID (default target for tgSend)
 */

import { newShopPingText } from './shop-notify'
import { logNotification } from './notifications/log'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID

// ── Core send ──────────────────────────────────────────────────────────────────

/**
 * Resolve the effective chat id: an explicit (non-empty) `chatId` wins; otherwise
 * fall back to `adminDefault`. Pure + side-effect-free so it is unit-testable
 * without the network. Returns undefined when neither is available (→ no send).
 */
export function resolveChatId(
  chatId: string | undefined | null,
  adminDefault: string | undefined = CHAT_ID,
): string | undefined {
  return chatId && chatId.length > 0 ? chatId : adminDefault || undefined
}

/**
 * Send a Telegram message. `chatId` defaults to the admin chat, so every existing
 * `tg.*` admin call (which omits it) is byte-for-byte unchanged. The seller
 * channel passes an explicit linked chat_id.
 */
/**
 * Is the Telegram transport actually CONFIGURED to reach a target right now?
 *
 * Additive, pure, and deliberately NOT a change to `tgSend`'s signature (it is
 * `Promise<void>` and fire-and-forget by design — 13 admin call sites depend on
 * that, and observability must never throw into a request path).
 *
 * It exists because "fire-and-forget" and "report whether delivery is possible"
 * are different questions, and a caller that must record a DELIVERY OUTCOME
 * cannot answer the second one from `tgSend` alone: an unset `TELEGRAM_BOT_TOKEN`
 * makes it return silently, indistinguishable from a successful send. The
 * portfolio reminder rail (merchant-partner-lifecycle S2.2) needs the difference
 * — a reminder nobody could receive must be recorded as failed, not reported as
 * sent (fresh-reviewer finding 2, PR 310).
 *
 * NOTE what this does and does not tell you: it answers "could we even try?",
 * never "did it arrive". A configured transport can still fail at the network or
 * get a non-2xx, and `tgSend` swallows both.
 */
export function tgConfigured(chatId?: string | null): boolean {
  return Boolean(BOT_TOKEN) && Boolean(resolveChatId(chatId))
}

export async function tgSend(chatId: string | undefined | null, text: string): Promise<void> {
  const target = resolveChatId(chatId)
  // The skip stays silent to the CALLER (Telegram is observability, never the
  // critical path) but is no longer silent to the ledger: "no bot token" and "no
  // linked chat" are the two ways a Telegram notification quietly does not happen.
  if (!BOT_TOKEN || !target) {
    logNotification({
      channel: 'telegram',
      outcome: 'skipped',
      recipient: target ?? null,
      subject: firstLine(text),
      reason: !BOT_TOKEN ? 'unconfigured' : 'no_recipient',
    })
    return
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    target,
        text,
        parse_mode: 'HTML',
      }),
      signal: AbortSignal.timeout(5000),  // 5s timeout — never block request path
    })
    // `tgSend` deliberately does not inspect the response for its RETURN value (see
    // tgSendWithResult below for why), but the ledger records what the API said —
    // otherwise a 401 bad-token looks identical to a delivered message forever.
    logNotification({
      channel: 'telegram',
      outcome: res.ok ? 'sent' : 'failed',
      recipient: target,
      subject: firstLine(text),
      reason: res.ok ? null : `http_${res.status}`,
    })
  } catch (e) {
    // Intentionally swallowed for the caller — Telegram is observability, not
    // critical path — but recorded, so it is not swallowed for the audit.
    logNotification({
      channel: 'telegram',
      outcome: 'failed',
      recipient: target,
      subject: firstLine(text),
      reason: 'network',
      context: { detail: e instanceof Error ? e.message : String(e) },
    })
  }
}

/** The ledger stores a label, not a whole HTML message body. */
function firstLine(text: string): string {
  return text.replace(/<[^>]*>/g, '').split('\n')[0].slice(0, 200)
}

/**
 * `tgSend`, but it REPORTS whether Telegram actually accepted the message.
 *
 * `tgSend` is `Promise<void>`: it swallows exceptions AND never inspects the
 * response, so a non-2xx (bad token, chat not found, rate limit) is
 * indistinguishable from a successful send. That is correct for the 13 admin
 * observability call sites — telemetry must never throw into a request path — and
 * wrong for any caller that has to persist a delivery outcome.
 *
 * Added for the portfolio reminder rail (cross-agent review round 2, PR 310):
 * recording `channels: ['telegram']` when the API returned 401 is a false
 * operational claim, and the whole point of that rail's `last_error` column is that
 * a silently-dead reminder is the failure mode it exists to prevent.
 *
 * Never throws either — it returns `false` instead. `tgSend` is left byte-identical.
 */
export async function tgSendWithResult(chatId: string | undefined | null, text: string): Promise<boolean> {
  const target = resolveChatId(chatId)
  if (!BOT_TOKEN || !target) return false
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: target, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Admin notification — sends to TELEGRAM_CHAT_ID. Thin wrapper over `tgSend`. */
export async function tgNotify(text: string): Promise<void> {
  return tgSend(undefined, text)
}

// ── Bot identity (for building deep links) ──────────────────────────────────────

let _botUsername: string | null = null

/**
 * Resolve the bot's @username via getMe, cached for the process lifetime — used
 * to build `t.me/<username>?start=<token>` deep links. Returns null if the bot
 * token is unset or the call fails (the caller surfaces a friendly error).
 */
export async function getBotUsername(): Promise<string | null> {
  if (_botUsername) return _botUsername
  if (!BOT_TOKEN) return null
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`, {
      signal: AbortSignal.timeout(5000),
    })
    const data = await res.json()
    const username: unknown = data?.result?.username
    if (typeof username === 'string' && username.length > 0) {
      _botUsername = username
      return username
    }
  } catch {
    // fall through → null
  }
  return null
}

// ── Typed event helpers ────────────────────────────────────────────────────────

export const tg = {
  /** New seller account claimed (shop went from pending → active) */
  newShop(shopName: string, location: string | null, slug: string) {
    return tgNotify(newShopPingText(shopName, location, slug))
  },

  /** New listing published by a claimed seller */
  newListing(title: string, priceFmt: string, shopName: string, listingId: string) {
    return tgNotify(`📦 <b>Nuevo anuncio</b>\n${esc(title)} — <b>${esc(priceFmt)}</b>\nVendedor: ${esc(shopName)}\nmiyagisanchez.com/mx/l/${esc(listingId)}`)
  },

  /** Sale completed via Stripe */
  salePaid(amount: string, title: string, buyerEmail: string, method: 'stripe' | 'mercadopago') {
    const icon = method === 'stripe' ? '💳' : '🟦'
    return tgNotify(`${icon} <b>Venta completada</b>\n<b>${esc(amount)}</b> — ${esc(title)}\nComprador: ${esc(buyerEmail)}`)
  },

  /** New subscription started */
  newSubscription(amount: string, interval: string, listingTitle: string, buyerEmail: string) {
    return tgNotify(`🔔 <b>Nueva suscripción</b>\n${esc(listingTitle)}\n<b>${esc(amount)}/${esc(interval)}</b> · ${esc(buyerEmail)}`)
  },

  /** Offer made on a listing */
  offerMade(offerAmount: string, listPrice: string, title: string, buyerEmail: string) {
    return tgNotify(`🤝 <b>Nueva oferta</b>\n${esc(title)}\n${esc(offerAmount)} (precio: ${esc(listPrice)}) · ${esc(buyerEmail)}`)
  },

  /** Offer accepted by seller */
  offerAccepted(amount: string, title: string) {
    return tgNotify(`✅ <b>Oferta aceptada</b>\n${esc(title)} · ${esc(amount)}`)
  },

  /** New user signed up (Clerk webhook) */
  newUser(email: string, name: string) {
    return tgNotify(`👤 <b>Nuevo usuario</b>\n${esc(name)} · ${esc(email)}`)
  },

  /** UCP webhook delivery failed all retries */
  webhookFailed(shopName: string, orderId: string, url: string) {
    return tgNotify(`⚠️ <b>Webhook fallido</b>\n${esc(shopName)} · Orden ${esc(orderId)}\nURL: <code>${esc(url)}</code>`)
  },

  /** Listing cleanup cron completed */
  cleanupRun(expired: number, deleted: number, stagingCleaned: number) {
    if (expired === 0 && deleted === 0 && stagingCleaned === 0) return Promise.resolve()
    return tgNotify(`🧹 <b>Limpieza de listings</b>\nExpirados: ${expired} · Eliminados: ${deleted} · Staging: ${stagingCleaned}`)
  },

  /** Generic admin alert */
  alert(message: string) {
    return tgNotify(`🚨 <b>Admin alert</b>\n${esc(message)}`)
  },

  /** New self-serve promoter application submitted (epic 08 · promoter-funnel-v2 S2). */
  promoterApplicationSubmitted(name: string, city: string | null, adminUrl: string) {
    return tgNotify(`📝 <b>Nueva solicitud de promotor</b>\n${esc(name)}${city ? ` · ${esc(city)}` : ''}\n${esc(adminUrl)}`)
  },

  /** New Tiendas Fundadoras application submitted (epic 08 · tiendas-fundadoras-acquisition
   *  S2). Carries only the business name + a coarse location — the full PII record lives in
   *  the canonical relationship, this is just the "someone applied, go look" ping. */
  foundingApplicationSubmitted(businessName: string, location: string | null, adminUrl: string) {
    return tgNotify(`🌱 <b>Nueva solicitud fundadora</b>\n${esc(businessName)}${location ? ` · ${esc(location)}` : ''}\n${esc(adminUrl)}`)
  },

  /** send_feedback MCP tool filed a report (miyagi-partners-mcp S3). */
  feedbackFiled(authorLabel: string, authorKind: string, category: string, toolName: string | null, message: string) {
    const title = authorKind === 'promoter' ? 'Reporte de promotor' : 'Feedback de agente'
    return tgNotify(
      `🗣️ <b>${title}</b>\n${esc(authorLabel)} (${esc(authorKind)}) · ${esc(category)}` +
      (toolName ? ` · herramienta: <code>${esc(toolName)}</code>` : '') +
      `\n${esc(message)}`,
    )
  },

  /** A migration's parity report is "very custom" (untrustworthy pull) — no price
   *  was offered; route to Daniel with the report (epic 03 · platform-migrations
   *  S2 · US-2.3). Links the report instead of attaching a file (this codebase
   *  never attaches files to Telegram — see lib/promoter-close-notify.ts). */
  migrationVeryCustom(shopId: string, listingCount: number, reportUrl: string) {
    return tgNotify(
      `🔍 <b>Migración "muy personalizada" — revisar a mano</b>\n` +
      `Tienda: ${esc(shopId)}\nProductos detectados: ${esc(listingCount)}\n${esc(reportUrl)}`,
    )
  },
}

// ── HTML escape ────────────────────────────────────────────────────────────────

function esc(s: string | number): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** HTML-escape an interpolated value for a `parse_mode: 'HTML'` Telegram body. */
export const escapeHtml = esc
