/**
 * Centralized email — Miniflux-style templates.
 * Text-first. No decorative elements. Every line earns its place.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { logNotification } from '@/lib/notifications/log'
import { Resend } from 'resend'
import { CONTACT_EMAIL } from '@/lib/contact'
import { getDictionary, type Locale } from '@/lib/dictionary'
import { ticketQrPath, type EventTicket } from '@/lib/event-ticket-state'
import { buildMerchantCloseReceipt, type CloseReceiptItem } from '@/lib/promoter-close-receipt'
import { isRenderableArtworkUrl, isImageLikeArtworkUrl } from '@/lib/personalization'
import { formatRentalBookingLines, type RentalBookingLike } from '@/lib/rental-booking'
import {
  resolveFoundingOperatorInvitationOutcome,
  type FoundingOperatorInvitationOutcome,
} from '@/lib/founding-operator-invitation-outcome'

const FROM = 'Miyagi Sánchez <noreply@miyagisanchez.com>'

/**
 * Where a reply actually goes.
 *
 * Every email this platform has ever sent came from `noreply@` with no Reply-To, so
 * a seller who answered one — the most natural thing to do when something is wrong —
 * was writing into a void, and we never knew they had tried. Set at the single
 * transport, so all 63 senders inherit it and none can forget.
 */
// Imported, never restated. The same address is now shown on the site itself
// (footer, 404, /acerca, /terminos), and two copies of a support address
// eventually become two addresses — the wrong half of that pair being a
// channel nobody reads. `lib/contact.ts` is the single source.
const REPLY_TO = CONTACT_EMAIL
const SITE = 'https://miyagisanchez.com'

// ── Resend client (lazy) ──────────────────────────────────────────────────────

let _resend: Resend | null = null
function resend(): Resend {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY
    if (!key) throw new Error('Missing RESEND_API_KEY')
    _resend = new Resend(key)
  }
  return _resend
}

// ── Seller email lookup via Clerk Management API ──────────────────────────────

/**
 * Why a seller could not be emailed.
 *
 * `no_email_on_account` (the account genuinely carries no address) and
 * `lookup_failed` (Clerk was unreachable, rate-limited, or the id is unknown to
 * THIS instance) are different facts with different fixes, and the bare
 * `catch { return null }` this replaces collapsed them. That collapse is not
 * cosmetic: the admin broadcast preview shows an operator who cannot be reached and
 * why, and reporting "sin correo" over a transient outage would send them chasing
 * fourteen merchants about an account problem none of them have.
 */
export type SellerEmailLookup =
  | { email: string; reason?: undefined }
  | { email: null; reason: 'no_email_on_account' | 'lookup_failed'; detail?: string }

export async function getSellerEmailResult(clerkUserId: string): Promise<SellerEmailLookup> {
  try {
    const { clerkClient } = await import('@clerk/nextjs/server')
    const client = await clerkClient()
    const user = await client.users.getUser(clerkUserId)
    const email = user.emailAddresses[0]?.emailAddress
    return email ? { email } : { email: null, reason: 'no_email_on_account' }
  } catch (e) {
    // Said out loud. Every seller notification in the product resolves its recipient
    // through here, so a silent failure here is a silent failure everywhere.
    // SDK errors can contain request headers; only log a bounded error type.
    const name = e instanceof Error ? e.name : ''
    const errorType = /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? name : 'unknown'
    console.error('[getSellerEmail] Clerk lookup failed for', clerkUserId, errorType)
    return { email: null, reason: 'lookup_failed', detail: errorType }
  }
}

/** The long-standing shape, kept for the callers that only need the address. */
export async function getSellerEmail(clerkUserId: string): Promise<string | null> {
  return (await getSellerEmailResult(clerkUserId)).email
}

// ── Base template ─────────────────────────────────────────────────────────────
//
// Aesthetic: Miniflux / Hacker News / Pinboard
//   – no hero, no logo image, no gradient
//   – wordmark as plain text link, thin green rule beneath
//   – data laid out in key/value rows
//   – one CTA, sharp-ish corners, accent green
//   – footer is 2 lines of plain text

/** Brand shown in the email wordmark + footer. Defaults to the platform; an
 *  own-channel order brands to the seller's custom domain instead. */
type Brand = { url: string; label: string }
const DEFAULT_BRAND: Brand = { url: SITE, label: 'miyagisanchez.com' }

type EmailLanguage = 'es' | 'en'

function html(subject: string, body: string, brand: Brand = DEFAULT_BRAND, language: EmailLanguage = 'es'): string {
  // The contact address is named in the footer AND set as Reply-To, so it works
  // whether someone hits reply or copies the address out.
  const contact = `<a href="mailto:${REPLY_TO}" style="color:#1d6f42;text-decoration:none">${REPLY_TO}</a>`
  const footer = language === 'en'
    ? `This email was sent because of activity on your account. Questions? Write to ${contact}.<br>
    <a href="${brand.url}" style="color:#1d6f42;text-decoration:none">${esc(brand.label)}</a>`
    : `Este correo fue enviado por actividad en tu cuenta. ¿Dudas? Escríbenos a ${contact}.<br>
    <a href="${brand.url}" style="color:#1d6f42;text-decoration:none">${esc(brand.label)}</a> · sin comisiones, sin intermediarios.`
  return `<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f9f9f7">
<div style="max-width:500px;margin:0 auto;padding:36px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.65;color:#1a1a18">

  <!-- Wordmark -->
  <div style="padding-bottom:14px;margin-bottom:24px;border-bottom:2px solid #1d6f42">
    <a href="${brand.url}" style="text-decoration:none;color:#1a1a18;font-weight:700;font-size:14px;letter-spacing:-0.2px">${esc(brand.label)}</a>
  </div>

  ${body}

  <!-- Footer -->
  <div style="margin-top:36px;padding-top:14px;border-top:1px solid #e2e2de;font-size:12px;color:#6b6b67;line-height:1.5">
    ${footer}
  </div>

</div>
</body>
</html>`
}

/** Build the email brand from an optional own-channel store domain. */
function brandFor(storeDomain?: string | null): Brand {
  return storeDomain ? { url: `https://${storeDomain}`, label: storeDomain } : DEFAULT_BRAND
}

// ── Template building blocks ──────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function h1(text: string): string {
  return `<h1 style="margin:0 0 18px;font-size:17px;font-weight:700;color:#1a1a18;letter-spacing:-0.2px">${esc(text)}</h1>`
}

function p(text: string): string {
  return `<p style="margin:0 0 14px;color:#1a1a18">${text}</p>`
}

/** Key/value table — listing context, amounts, buyer info */
function table(rows: [string, string][]): string {
  return `<table style="width:100%;border-collapse:collapse;margin:0 0 20px;font-size:13px">
    ${rows.map(([k, v]) => `
    <tr>
      <td style="padding:5px 12px 5px 0;color:#6b6b67;white-space:nowrap;vertical-align:top;width:130px">${esc(k)}</td>
      <td style="padding:5px 0;color:#1a1a18;font-weight:500">${v}</td>
    </tr>`).join('')}
  </table>`
}

/** Big money amount with optional sub-label */
function amount(money: string, label: string, accent = false): string {
  return `<div style="margin:0 0 20px;padding:14px 16px;background:#f0f0ec;border-left:3px solid ${accent ? '#1d6f42' : '#e2e2de'}">
    <div style="font-size:22px;font-weight:700;color:${accent ? '#1d6f42' : '#1a1a18'};letter-spacing:-0.5px">${esc(money)}</div>
    <div style="font-size:12px;color:#6b6b67;margin-top:3px">${esc(label)}</div>
  </div>`
}

/** Buyer message / seller counter note — italicised blockquote */
function quote(text: string): string {
  return `<div style="margin:0 0 18px;padding:10px 14px;border-left:3px solid #e2e2de;color:#6b6b67;font-style:italic;font-size:13px">&ldquo;${esc(text)}&rdquo;</div>`
}

/** Buyer personalization — shown in order emails so both sides have the spec. */
export type EmailPersonalization = Array<{ title?: string; fields: Array<{ label?: string; value?: string; type?: string }> }>

function personalizationBlock(blocks?: EmailPersonalization | null): string {
  const clean = (blocks ?? []).filter(b => (b.fields ?? []).some(f => (f.value ?? '').trim()))
  if (!clean.length) return ''
  const multi = clean.length > 1
  const sections = clean.map(b => {
    const rows = (b.fields ?? [])
      .filter(f => (f.value ?? '').trim())
      .map(f => {
        const value = f.value ?? ''
        // Only ever render a `file` value as a link/thumbnail when it looks
        // like a real URL our own upload route produced — never trust an
        // unchecked string into an `<a href>`/`<img src>` inside an email
        // (order-item metadata is technically buyer/API-writable via some
        // paths). See `isRenderableArtworkUrl` for what "looks like" means
        // and its documented residual risk.
        if (f.type === 'file' && isRenderableArtworkUrl(value)) {
          const href = esc(value)
          const thumb = isImageLikeArtworkUrl(value)
            ? `<br/><img src="${href}" alt="${esc(f.label ?? 'Arte')}" style="max-width:120px;border-radius:6px;margin-top:4px;display:block">`
            : ''
          return `<div style="margin:2px 0"><span style="color:#6b6b67">${esc(f.label ?? '')}:</span> <a href="${href}" style="color:#1d6f42;font-weight:600">Descargar original</a>${thumb}</div>`
        }
        return `<div style="margin:2px 0"><span style="color:#6b6b67">${esc(f.label ?? '')}:</span> <span style="font-weight:600;color:#1a1a18">${esc(value)}</span></div>`
      })
      .join('')
    const head = multi && b.title ? `<div style="font-weight:600;margin:0 0 3px;color:#1a1a18">${esc(b.title)}</div>` : ''
    return `<div style="margin:0 0 8px">${head}${rows}</div>`
  }).join('')
  return `<div style="margin:0 0 20px;padding:12px 14px;background:#f0f0ec;border-left:3px solid #1d6f42;font-size:13px">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:#1d6f42;margin:0 0 6px">Personalización</div>
    ${sections}
  </div>`
}

function eventTicketBlock(tickets?: EventTicket[] | null): string {
  const clean = (tickets ?? []).filter(ticket => ticket.token)
  if (!clean.length) return ''
  const rows = clean.map((ticket, index) => `
    <div style="margin:0 0 10px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:#1d6f42;margin:0 0 4px">Boleto ${index + 1}</div>
      <code style="display:block;word-break:break-all;background:#ffffff;border:1px solid #e2e2de;border-radius:4px;padding:8px">${esc(ticket.token)}</code>
      <div style="margin-top:8px"><a href="${SITE}${ticketQrPath(ticket.token)}" style="color:#1d6f42;text-decoration:none;font-weight:600">Descargar QR →</a></div>
    </div>
  `).join('')
  return `<div style="margin:0 0 20px;padding:12px 14px;background:#f0f0ec;border-left:3px solid #1d6f42;font-size:13px">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:#1d6f42;margin:0 0 6px">Boleto de entrada</div>
    <div style="margin:0 0 8px;color:#6b6b67">El QR contiene este token único. Preséntalo en la puerta.</div>
    ${rows}
  </div>`
}

/** Rental booking — dates + itemized deposit (epic 02 · rental-backend-line-item-pricing,
 *  S2.3). `rb` absent (a non-rental order) renders nothing, matching the
 *  personalization/event-ticket block contract. */
function rentalBookingBlock(rb?: RentalBookingLike | null, currency = 'MXN'): string {
  if (!rb) return ''
  const lines = formatRentalBookingLines(rb, currency)
  return `<div style="margin:0 0 20px;padding:12px 14px;background:#f0f0ec;border-left:3px solid #1d6f42;font-size:13px">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:#1d6f42;margin:0 0 6px">Reserva de renta</div>
    <div style="font-weight:600;color:#1a1a18;margin:0 0 4px">${esc(lines.dates)}</div>
    <div style="color:#6b6b67;margin:0 0 2px">${esc(lines.breakdown)}</div>
    ${lines.deposit ? `<div style="color:#6b6b67">${esc(lines.deposit)}</div>` : ''}
    <div style="font-weight:700;color:#1a1a18;margin-top:6px">Total: ${esc(lines.total)}</div>
  </div>`
}

/** Inline notice (warning or neutral) */
function notice(text: string, type: 'warn' | 'info' = 'info'): string {
  const bg    = type === 'warn' ? '#fffbeb' : '#f0f0ec'
  const left  = type === 'warn' ? '#f59e0b' : '#1d6f42'
  const color = type === 'warn' ? '#92400e' : '#1a1a18'
  return `<div style="margin:0 0 18px;padding:10px 14px;background:${bg};border-left:3px solid ${left};font-size:13px;color:${color}">${text}</div>`
}

/** Single CTA button */
function cta(label: string, href: string): string {
  return `<div style="margin:22px 0">
    <a href="${href}" style="display:inline-block;background:#1d6f42;color:#ffffff;text-decoration:none;padding:10px 20px;font-size:13px;font-weight:600;border-radius:4px">${esc(label)} →</a>
  </div>`
}

function divider(): string {
  return `<div style="border-top:1px solid #e2e2de;margin:20px 0"></div>`
}

// ── Send helper ───────────────────────────────────────────────────────────────
// Returns the Resend email ID, or null when skipped/failed.
// Pass `scheduledAt` to defer delivery; Resend requires at least 15 min in future.

const RESEND_MIN_SCHEDULE_MS = 16 * 60 * 1000 // 16 min buffer

/**
 * Why this is a discriminated result and `send` below is not
 * (marketplace-communications · D4).
 *
 * `send` returns `string | null`, and `null` meant three completely different
 * things: the API key is unset, Resend rejected the message, or a scheduled send
 * landed inside Resend's 16-minute window. On a rail the product owner asked to make
 * bulletproof, "I could not check", "it did not send" and "there was nothing to
 * send" are different facts — collapsing them is the confident falsehood
 * `LEARNINGS.md` keeps recording.
 *
 * Rather than churn 62 call sites that legitimately ignore the value,
 * `sendWithResult` carries the honest answer and `send` stays the thin adapter the
 * fire-and-forget senders already use. The sample sender in
 * `/admin/comunicaciones` uses the honest one, because reporting "sent" for an
 * unconfigured key is precisely what would make that surface untrustworthy.
 */
/**
 * Sample-send marking (marketplace-communications · D6).
 *
 * `/admin/comunicaciones` sends a real template with fixture data so the product
 * owner can see exactly what a merchant receives. Those messages MUST be
 * unmistakable: an operator who finds one in an inbox six months from now must not
 * read it as a real order notification.
 *
 * The marking has to reach 62 senders that each build their own subject, and the
 * alternatives were both bad — threading a parameter through every signature, or a
 * module-level mutable flag that two concurrent requests would trample. AsyncLocal-
 * Storage is request-scoped by construction, so a sample send cannot mark a real
 * notification happening at the same moment on another request.
 */
const sampleContext = new AsyncLocalStorage<{ key: string }>()

/** Run `fn` with every email it sends marked as a sample. */
export function runAsSampleSend<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return sampleContext.run({ key }, fn)
}

const SAMPLE_SUBJECT_PREFIX = '[PRUEBA] '

function sampleBanner(key: string): string {
  return `<div style="margin:0 0 18px;padding:10px 14px;background:#fffbeb;border-left:3px solid #f59e0b;font-size:13px;color:#92400e">
    <strong>Correo de prueba.</strong> Se envió desde <code>/admin/comunicaciones</code> con datos de muestra
    para revisar cómo se ve esta plantilla. No corresponde a ningún pedido, oferta ni pago real.<br>
    <span style="color:#a16207">Plantilla: <code>${esc(key)}</code></span>
  </div>`
}

export type EmailSendResult =
  | { ok: true; id: string | null }
  | { ok: false; reason: 'unconfigured' | 'rejected' | 'too_soon'; detail?: string }

export async function sendWithResult(
  to: string,
  subject: string,
  body: string,
  scheduledAt?: Date,
  brand?: Brand,
  language: EmailLanguage = 'es',
  idempotencyKey?: string,
): Promise<EmailSendResult> {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY not set — skipping:', subject, '→', to)
    logNotification({ channel: 'email', outcome: 'skipped', recipient: to, subject, reason: 'unconfigured' })
    return { ok: false, reason: 'unconfigured' }
  }
  if (scheduledAt && scheduledAt.getTime() - Date.now() < RESEND_MIN_SCHEDULE_MS) {
    // Too close to fire — skip rather than error (the window already passed).
    console.warn('[email] scheduled send too soon, skipping:', subject)
    logNotification({ channel: 'email', outcome: 'skipped', recipient: to, subject, reason: 'too_soon' })
    return { ok: false, reason: 'too_soon' }
  }
  // Marking happens HERE, at the single transport, so no sender can forget it and a
  // new sender inherits it for free.
  const sample = sampleContext.getStore()
  const finalSubject = sample ? `${SAMPLE_SUBJECT_PREFIX}${subject}` : subject
  const finalBody = sample ? `${sampleBanner(sample.key)}${body}` : body

  try {
    const result = await resend().emails.send({
      from: FROM,
      replyTo: REPLY_TO,
      to,
      subject: finalSubject,
      html: html(finalSubject, finalBody, brand, language),
      ...(scheduledAt ? { scheduledAt: scheduledAt.toISOString() } : {}),
    }, idempotencyKey && !sample ? { idempotencyKey } : undefined)
    // Resend reports rejected sends in its result object; it does not always
    // throw. A claim request must never say "link sent" when the provider said no.
    if (result.error) throw new Error(result.error.message)
    // Resend can accept without echoing an id. That is still a send, so `id` is
    // nullable INSIDE the ok branch rather than collapsing back into a failure.
    logNotification({
      channel: 'email',
      outcome: 'sent',
      recipient: to,
      subject: finalSubject,
      providerId: result.data?.id ?? null,
      context: sample ? { sample_key: sample.key } : null,
    })
    return { ok: true, id: result.data?.id ?? null }
  } catch (err) {
    // Provider errors may echo request headers or payloads; do not persist them.
    const name = err instanceof Error ? err.name : ''
    const errorType = /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? name : 'unknown'
    console.error('[email] send failed:', subject, '→', to, errorType)
    logNotification({
      channel: 'email',
      outcome: 'failed',
      recipient: to,
      subject: finalSubject,
      reason: 'rejected',
      context: { error_type: errorType },
    })
    return { ok: false, reason: 'rejected', detail: errorType }
  }
}

/** The fire-and-forget adapter every existing sender uses. Unchanged contract. */
async function send(
  to: string,
  subject: string,
  body: string,
  scheduledAt?: Date,
  brand?: Brand,
  language: EmailLanguage = 'es',
  idempotencyKey?: string,
): Promise<string | null> {
  const result = await sendWithResult(to, subject, body, scheduledAt, brand, language, idempotencyKey)
  return result.ok ? result.id : null
}

/** The email request establishes possession of an inbox, not business ownership. */
export async function sendShopClaimLink(ctx: { to: string; shopName: string; claimUrl: string; market: 'mx' | 'us' }): Promise<EmailSendResult> {
  const name = esc(ctx.shopName)
  if (ctx.market === 'us') return sendWithResult(ctx.to, `Claim ${ctx.shopName} on Miyagi Sánchez`, [
    h1(`Claim ${name}`),
    p('You asked to claim this shop. Open the link, then create an account or sign in with any email or Google account. The link expires in 24 hours.'),
    cta('Claim my shop', ctx.claimUrl),
    p('If you did not request this, you can ignore this message.'),
  ].join(''), undefined, undefined, 'en')
  return sendWithResult(ctx.to, `Reclama ${ctx.shopName} en Miyagi Sánchez`, [
    h1(`Reclama ${name}`),
    p('Solicitaste reclamar esta tienda. Abre el enlace y crea una cuenta o inicia sesión con el correo o la cuenta de Google que prefieras. El enlace vence en 24 horas.'),
    cta('Reclamar mi tienda', ctx.claimUrl),
    p('Si no solicitaste este enlace, puedes ignorar este mensaje.'),
  ].join(''))
}

/** Notify the account that now owns the shop, once Medusa confirms a new transfer. */
export async function sendShopClaimedWelcome(ctx: { to: string; shopName: string; shopSlug: string; market: 'mx' | 'us'; sellerId: string }): Promise<void> {
  const shopUrl = `${SITE}/${ctx.market}/s/${encodeURIComponent(ctx.shopSlug)}`
  if (ctx.market === 'us') {
    await send(ctx.to, `${ctx.shopName} is now linked to your account`, [
      h1('Your shop is ready'),
      p(`We linked <strong>${esc(ctx.shopName)}</strong> to your Miyagi Sánchez account.`),
      cta('Manage my shop', `${SITE}/shop/manage`),
      p(`Public shop: <a href="${shopUrl}">${esc(shopUrl)}</a>`),
    ].join(''), undefined, undefined, 'en')
    return
  }
  await send(ctx.to, `Tu tienda ${ctx.shopName} ya está en tu cuenta`, [
    h1(`${ctx.shopName} ya es tuya en Miyagi Sánchez`),
    p(`Vinculamos <strong>${esc(ctx.shopName)}</strong> a tu cuenta.`),
    cta('Administrar mi tienda', `${SITE}/shop/manage`),
    p(`Tu tienda pública: <a href="${shopUrl}">${esc(shopUrl)}</a>`),
  ].join(''), undefined, undefined, 'es', `shop-claimed/${ctx.sellerId}`)
}

/** First-party shop creation, distinct from taking ownership of a public listing. */
export async function sendShopCreatedWelcome(ctx: {
  to: string; shopName: string; shopSlug: string; market: 'mx' | 'us'; sellerId: string
}): Promise<EmailSendResult> {
  const shopUrl = `${SITE}/${ctx.market}/s/${encodeURIComponent(ctx.shopSlug)}`
  if (ctx.market === 'us') {
    return sendWithResult(ctx.to, `Your shop ${ctx.shopName} is ready on Miyagi Sánchez`, [
      h1(`${ctx.shopName}, your shop is ready`),
      p('Here is what you can do now:'),
      p('• Your AI agents can help manage your shop end to end: set it up, publish products, respond to offers, and review orders.<br>• Other agents can discover your products and show them to shoppers.<br>• Add listings for your products or services.<br>• Set up payments and delivery in your shop dashboard.<br>• Manage orders, offers, and messages in one place.<br>• Share your shop link with customers.'),
      cta('Set up my shop', `${SITE}/shop/manage`),
      p(`Your shop: <a href="${shopUrl}">${esc(shopUrl)}</a>`),
      p('Opening a basic shop is free. Reply to this email if you need a hand.'),
    ].join(''), undefined, undefined, 'en', `shop-created/${ctx.sellerId}`)
  }
  return sendWithResult(ctx.to, `Tu tienda ${ctx.shopName} ya está en Miyagi Sánchez`, [
    h1(`${ctx.shopName}, tu tienda ya está lista`),
    p('Esto es lo que puedes hacer ahora:'),
    p('• Tus agentes de IA pueden ayudarte a gestionar tu tienda de principio a fin: configurarla, publicar productos, responder ofertas y revisar pedidos.<br>• Otros agentes pueden descubrir tus productos y mostrárselos a quienes buscan comprar.<br>• Agregar anuncios de tus productos o servicios.<br>• Configurar pagos y entregas desde tu panel.<br>• Administrar pedidos, ofertas y mensajes en un solo lugar.<br>• Compartir el enlace de tu tienda con tus clientes.'),
    cta('Preparar mi tienda', `${SITE}/shop/manage`),
    p(`Tu tienda: <a href="${shopUrl}">${esc(shopUrl)}</a>`),
    p('Abrir una tienda básica es gratis. Si necesitas ayuda, responde a este correo.'),
  ].join(''), undefined, undefined, 'es', `shop-created/${ctx.sellerId}`)
}

/**
 * Prompt-to-shop «Mándame el enlace» (S3.1): a merchant's unfinished shop, mailed to themselves. es-MX only (the
 * flow is). The owner link opens the canvas only on the phone that made it, so the email says that plainly instead
 * of promising a link that will look broken on a laptop; the view-only link works anywhere.
 */
export async function sendP2sDraftLink(ctx: { to: string; shopName: string; draftId: string; sharePath: string }): Promise<EmailSendResult> {
  const ownerUrl = `${SITE}/p2s/${encodeURIComponent(ctx.draftId)}`
  const shareUrl = `${SITE}${ctx.sharePath}`
  return sendWithResult(ctx.to, `Tu tienda ${ctx.shopName} te espera en Miyagi Sánchez`, [
    h1(`${ctx.shopName} te espera`),
    p('Ábrela en el teléfono donde la armaste: ahí puedes quedártela con un toque.'),
    cta('Volver a mi tienda', ownerUrl),
    p(`Para enseñársela a alguien, comparte esta vista previa (solo se puede ver): <a href="${shareUrl}">${esc(shareUrl)}</a>`),
    p('Las tiendas en armado se guardan unos días. Si no pediste este correo, puedes ignorarlo.'),
  ].join(''))
}

/** General account welcome. Shop-specific language belongs to the claim receipt. */
export async function sendAccountWelcome(ctx: { to: string; clerkUserId: string }): Promise<EmailSendResult> {
  return sendWithResult(ctx.to, 'Bienvenido a Miyagi Sánchez / Welcome', [
    h1('Bienvenido a Miyagi Sánchez'),
    p('Tu cuenta ya está lista. Puedes explorar tiendas y productos, guardar lo que te interese y hablar con quienes venden cuando encuentres algo para ti.'),
    p('Si tienes un negocio, también puedes crear una tienda o reclamar una ficha pública disponible desde su página. Tener una tienda básica es gratis.'),
    divider(),
    h1('Welcome to Miyagi Sánchez'),
    p('Your account is ready. Explore shops and products, save what interests you, and contact sellers when you find something you like.'),
    p('If you run a business, you can also create a shop or claim an available public listing from its page. A basic shop is free.'),
    cta('Explorar / Explore', SITE),
    p('¿Dudas? Responde a este correo. Questions? Just reply.'),
  ].join(''), undefined, undefined, 'es', `account-welcome/${ctx.clerkUserId}`)
}

// ── Cancel a scheduled email by Resend ID ─────────────────────────────────────

export async function cancelScheduledEmail(emailId: string): Promise<void> {
  if (!process.env.RESEND_API_KEY) return
  try {
    await resend().emails.cancel(emailId)
  } catch (err) {
    console.error('[email] cancel failed:', emailId, err)
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// OFFER EMAILS
// ════════════════════════════════════════════════════════════════════════════════

export interface OfferEmailCtx {
  listingTitle: string
  listingId: string
  listingUrl: string
  askingPrice: string
  offerAmount: string
  offerPct: number   // e.g. 83 = 83% of asking
  buyerName: string
  buyerEmail: string
  buyerMessage?: string | null
  currency: string
  offerId: string
  expiresAt: string  // ISO
  conversationUrl?: string | null
}

// ── 1. Buyer: confirmation of offer submitted ─────────────────────────────────
export async function sendOfferConfirmed(ctx: OfferEmailCtx): Promise<void> {
  const subject = `Oferta enviada — ${ctx.listingTitle}`
  const body = [
    h1('Tu oferta fue enviada'),
    table([
      ['Anuncio',   `<a href="${ctx.listingUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.listingTitle)}</a>`],
      ['Precio lista', ctx.askingPrice],
    ]),
    amount(ctx.offerAmount, `Tu oferta · ${ctx.offerPct}% del precio`),
    p('El vendedor tiene <strong>48 horas</strong> para responder. Recibirás un correo cuando lo haga.'),
    cta('Ver conversación', ctx.conversationUrl ?? ctx.listingUrl),
    notice('Si el vendedor no responde en 48 horas, tu oferta expirará automáticamente y podrás intentarlo de nuevo.'),
  ].join('')
  await send(ctx.buyerEmail, subject, body)
}

// ── Referral: reward earned ───────────────────────────────────────────────────
export async function sendReferralReward(to: string, code: string, amountLabel: string): Promise<void> {
  const subject = `¡Ganaste ${amountLabel} de crédito! 🎁`
  const body = [
    h1('Tu invitado hizo su primera compra'),
    p('Como agradecimiento, te regalamos crédito para tu próximo anuncio en la edición impresa.'),
    amount(amountLabel, `Cupón ${esc(code)}`, true),
    p(`Ingresa el código <strong>${esc(code)}</strong> al pagar tu anuncio impreso.`),
    cta('Crear un anuncio', `${SITE}/account/print-ads`),
    notice('El crédito tiene vigencia limitada — úsalo pronto.'),
  ].join('')
  await send(to, subject, body)
}

// ── Sweepstakes: email verification ─────────────────────────────────────────
export async function sendSweepstakesVerificationCode(ctx: {
  to: string
  code: string
  locale: Locale
  campaignTitle: string
  campaignUrl: string
}): Promise<void> {
  const ui = (await getDictionary(ctx.locale)).sweepstakes.email
  const body = [
    h1(ui.verificationTitle),
    p(ui.verificationIntro),
    amount(ctx.code, ui.verificationCode, true),
    table([[ui.campaign, `<a href="${ctx.campaignUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.campaignTitle)}</a>`]]),
    notice(ui.verificationExpiry),
  ].join('')
  await send(ctx.to, ui.verificationSubject, body)
}

// ── Sweepstakes: winner notification ────────────────────────────────────────
export async function sendSweepstakesWinner(ctx: {
  to: string
  locale: Locale
  campaignTitle: string
  campaignUrl: string
}): Promise<void> {
  const ui = (await getDictionary(ctx.locale)).sweepstakes.email
  const body = [
    h1(ui.winnerTitle),
    p(ui.winnerIntro),
    table([[ui.campaign, `<a href="${ctx.campaignUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.campaignTitle)}</a>`]]),
    cta(ui.claimPrize, ctx.campaignUrl),
  ].join('')
  await send(ctx.to, `${ui.winnerSubject} — ${ctx.campaignTitle}`, body)
}

// ── Sweepstakes: consolation broadcast ──────────────────────────────────────
export async function sendSweepstakesConsolation(ctx: {
  to: string
  locale: Locale
  campaignTitle: string
  campaignUrl: string
  message: string
  couponCode?: string | null
}): Promise<void> {
  const ui = (await getDictionary(ctx.locale)).sweepstakes.email
  const body = [
    h1(ui.consolationTitle),
    p(ui.consolationIntro),
    quote(ctx.message),
    ctx.couponCode ? amount(ctx.couponCode, ui.coupon, true) : '',
    table([[ui.campaign, `<a href="${ctx.campaignUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.campaignTitle)}</a>`]]),
    cta(ui.claimPrize, ctx.campaignUrl),
  ].join('')
  await send(ctx.to, `${ui.consolationSubject} — ${ctx.campaignTitle}`, body)
}

// ── Bookshop launchpad: writer submission emails (es-MX only) ───────────────
// The launchpad is not on the bilingual allow-list (AGENTS rule #5) — es-MX
// literal copy, same shape as the print-ad editorial emails.

/** Writer: the 6-char code that verifies their email before a manuscript lands. */
export async function sendLaunchpadVerificationCode(ctx: {
  to: string
  code: string
  shopName: string
}): Promise<void> {
  const body = [
    h1('Confirma tu correo'),
    p(`Estás por enviar tu manuscrito a ${esc(ctx.shopName)}. Ingresa este código para confirmar que este correo es tuyo:`),
    amount(ctx.code, 'Tu código', true),
    notice('El código vence en 15 minutos. Si no intentaste enviar un manuscrito, ignora este mensaje.'),
  ].join('')
  await send(ctx.to, `Tu código para enviar tu manuscrito — ${ctx.shopName}`, body)
}

/** Writer: a curation-state change on their submission (Story 1.2). es-MX. */
export async function sendLaunchpadStatusEmail(ctx: {
  to: string
  authorName: string
  title: string
  shopName: string
  status: 'submitted' | 'in_review' | 'approved' | 'rejected' | 'changes_requested'
  note?: string | null
}): Promise<void> {
  const work = esc(ctx.title)
  const shop = esc(ctx.shopName)

  const COPY: Record<typeof ctx.status, { subject: string; title: string; intro: string } | null> = {
    submitted: null, // no email on re-entry to submitted (the writer just acted)
    in_review: {
      subject: `📖 ${ctx.shopName} está leyendo tu manuscrito`,
      title: 'Tu manuscrito está en revisión',
      intro: `${shop} recibió «${work}» y ya lo está leyendo. Te avisaremos en cuanto haya novedades.`,
    },
    approved: {
      subject: `✅ ¡Aceptaron tu manuscrito! — ${ctx.title}`,
      title: '¡Tu manuscrito fue aceptado!',
      intro: `${shop} aceptó «${work}». Muy pronto lo publicarán como libro digital y te enviaremos el enlace.`,
    },
    changes_requested: {
      subject: `✏️ Tu manuscrito necesita ajustes — ${ctx.title}`,
      title: 'La librería te pide algunos ajustes',
      intro: `${shop} revisó «${work}» y hay algo que ajustar antes de continuar. Cuando lo tengas listo, vuelve a enviarlo desde la página de convocatoria.`,
    },
    rejected: {
      subject: `Sobre tu manuscrito — ${ctx.title}`,
      title: 'Gracias por enviar tu obra',
      intro: `${shop} revisó «${work}» y en esta ocasión no seguirá adelante con su publicación. Agradecemos que la hayas compartido y te deseamos mucho éxito.`,
    },
  }

  const copy = COPY[ctx.status]
  if (!copy) return

  const body = [
    h1(copy.title),
    p(`Hola ${esc(ctx.authorName)},`),
    p(copy.intro),
    ...(ctx.note ? [quote(ctx.note)] : []),
  ].join('')
  await send(ctx.to, copy.subject, body)
}

/** Writer: their work is now live for sale (Story 1.3), with the public URL. */
export async function sendLaunchpadPublishedEmail(ctx: {
  to: string
  authorName: string
  title: string
  shopName: string
  url: string
}): Promise<void> {
  const body = [
    h1('¡Tu obra ya está publicada! 🎉'),
    p(`Hola ${esc(ctx.authorName)},`),
    p(`${esc(ctx.shopName)} publicó «${esc(ctx.title)}». Ya está disponible para lectores y se entrega automáticamente al comprarla.`),
    cta('Ver tu obra publicada', ctx.url),
  ].join('')
  await send(ctx.to, `📚 Ya está publicado: ${ctx.title}`, body)
}

// ── Bookshop launchpad: voting-campaign emails (Sprint 3, es-MX only) ────────

/** Voter: the 6-char code that verifies their email before a vote is recorded. */
export async function sendLaunchpadCampaignVoteCode(ctx: {
  to: string
  code: string
  campaignTitle: string
}): Promise<void> {
  const body = [
    h1('Confirma tu voto'),
    p(`Estás por votar en «${esc(ctx.campaignTitle)}». Ingresa este código para confirmar que este correo es tuyo:`),
    amount(ctx.code, 'Tu código', true),
    notice('El código vence en 15 minutos. Si no intentaste votar, ignora este mensaje.'),
  ].join('')
  await send(ctx.to, `Tu código para votar — ${ctx.campaignTitle}`, body)
}

/**
 * Merchant: the one-time code to APPROVE a private shop preview
 * (founding-merchant-consent-previews S4). Same shape as the vote-code mail — a
 * 6-char code, 15-min expiry — but the copy makes clear what approving does
 * (publishes the shop as shown) and what the code proves (that this contact is
 * theirs), not a legal signature.
 */
export async function sendPreviewApprovalCode(ctx: {
  to: string
  code: string
  shopName: string
}): Promise<void> {
  const body = [
    h1('Confirma que apruebas tu tienda'),
    p(`Estás por aprobar la publicación de «${esc(ctx.shopName)}» tal como la revisaste. Ingresa este código para confirmar que este correo es tuyo:`),
    amount(ctx.code, 'Tu código', true),
    notice('El código vence en 15 minutos. Al aprobar, la tienda se publica tal como la viste. Si no pediste aprobar nada, ignora este mensaje.'),
  ].join('')
  await send(ctx.to, `Tu código para aprobar — ${ctx.shopName}`, body)
}

/** Voter: threshold reached → the product-scoped coupon they unlocked (Story 3.3). */
export async function sendLaunchpadCampaignCouponEmail(ctx: {
  to: string
  campaignTitle: string
  couponCode: string
  percent: number
  productUrl: string
  expiresAt: string | null
}): Promise<void> {
  const expiry = ctx.expiresAt
    ? new Date(ctx.expiresAt).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'long' })
    : null
  const body = [
    h1('¡Se alcanzó la meta! 🎉'),
    p(`Gracias a votos como el tuyo, «${esc(ctx.campaignTitle)}» llegó a su meta. Desbloqueaste un ${ctx.percent}% de descuento en la impresión del libro:`),
    amount(ctx.couponCode, 'Tu cupón', true),
    ...(expiry ? [notice(`Válido hasta el ${expiry}. Aplica solo a este libro.`)] : [notice('Aplica solo a este libro.')]),
    cta('Imprimir el libro con tu descuento', ctx.productUrl),
  ].join('')
  await send(ctx.to, `🎁 Desbloqueaste ${ctx.percent}% en «${ctx.campaignTitle}»`, body)
}

/** Writer/seller: the campaign closed — met (coupon minted) or unmet (honest). */
export async function sendLaunchpadCampaignResultEmail(ctx: {
  to: string
  campaignTitle: string
  met: boolean
  voteCount: number
  threshold: number
  couponCode?: string | null
}): Promise<void> {
  const body = ctx.met
    ? [
        h1('Tu campaña alcanzó la meta 🎉'),
        p(`«${esc(ctx.campaignTitle)}» cerró con ${ctx.voteCount}/${ctx.threshold} votos. Se generó el cupón de impresión y se avisó a quienes votaron.`),
        ...(ctx.couponCode ? [amount(ctx.couponCode, 'Cupón generado', true)] : []),
      ].join('')
    : [
        h1('Tu campaña cerró sin alcanzar la meta'),
        p(`«${esc(ctx.campaignTitle)}» cerró con ${ctx.voteCount}/${ctx.threshold} votos. No se generó ningún cupón. Gracias por convocar a tu comunidad — puedes crear una nueva campaña cuando quieras.`),
      ].join('')
  await send(ctx.to, ctx.met ? `🎉 Meta alcanzada: ${ctx.campaignTitle}` : `Campaña cerrada: ${ctx.campaignTitle}`, body)
}

/** Voter: the campaign closed WITHOUT reaching the threshold — honest, no coupon. */
export async function sendLaunchpadCampaignVoterUnmet(ctx: {
  to: string
  campaignTitle: string
}): Promise<void> {
  const body = [
    h1('La campaña cerró'),
    p(`«${esc(ctx.campaignTitle)}» no alcanzó la meta de votos, así que en esta ocasión no se generó el cupón de impresión. ¡Gracias por participar y por apoyar a los autores!`),
  ].join('')
  await send(ctx.to, `Sobre «${ctx.campaignTitle}»`, body)
}

// ── Events: email verification + RSVP confirmation ──────────────────────────
function formatEventEmailDate(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleString(locale === 'en' ? 'en-US' : 'es-MX', {
    timeZone: 'America/Mexico_City',
    dateStyle: 'full',
    timeStyle: 'short',
  })
}

export async function sendEventVerificationCode(ctx: {
  to: string
  code: string
  locale: Locale
  eventTitle: string
  eventUrl: string
}): Promise<void> {
  const ui = (await getDictionary(ctx.locale)).events.email
  const body = [
    h1(ui.verificationTitle),
    p(ui.verificationIntro),
    amount(ctx.code, ui.verificationCode, true),
    table([[ui.event, `<a href="${ctx.eventUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.eventTitle)}</a>`]]),
    notice(ui.verificationExpiry),
  ].join('')
  await send(ctx.to, ui.verificationSubject, body)
}

export async function sendEventRegistrationConfirmation(ctx: {
  to: string
  locale: Locale
  eventTitle: string
  eventUrl: string
  ticketToken?: string | null
  ticketQrUrl?: string | null
  startsAt: string
  venueName: string
  venueAddress?: string | null
}): Promise<void> {
  const ui = (await getDictionary(ctx.locale)).events.email
  const venue = ctx.venueAddress ? `${esc(ctx.venueName)}<br>${esc(ctx.venueAddress)}` : esc(ctx.venueName)
  const body = [
    h1(ui.confirmationTitle),
    p(ui.confirmationIntro),
    table([
      [ui.event, `<a href="${ctx.eventUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.eventTitle)}</a>`],
      [ui.date, esc(formatEventEmailDate(ctx.startsAt, ctx.locale))],
      [ui.venue, venue],
      ...(ctx.ticketToken ? [[ui.ticketToken, `<code>${esc(ctx.ticketToken)}</code>`] as [string, string]] : []),
    ]),
    ctx.ticketQrUrl ? cta(ui.downloadTicketQr, ctx.ticketQrUrl) : '',
    cta(ui.viewEvent, ctx.eventUrl),
  ].join('')
  await send(ctx.to, `${ui.confirmationSubject} — ${ctx.eventTitle}`, body)
}

// ── 2. Seller: new offer alert ────────────────────────────────────────────────
export async function sendNewOfferToSeller(ctx: OfferEmailCtx & { sellerEmail: string }): Promise<void> {
  const subject = `Nueva oferta de ${ctx.buyerName} — ${ctx.listingTitle}`
  const body = [
    h1('Nueva oferta recibida'),
    table([
      ['Anuncio',   `<a href="${ctx.listingUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.listingTitle)}</a>`],
      ['Precio lista', ctx.askingPrice],
    ]),
    amount(ctx.offerAmount, `Oferta de ${ctx.buyerName} · ${ctx.offerPct}% del precio`, true),
    ctx.buyerMessage ? quote(ctx.buyerMessage) : '',
    table([
      ['Comprador', ctx.buyerName],
      ['Expira',    new Date(ctx.expiresAt).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'medium', timeStyle: 'short' })],
    ]),
    notice('Los compradores que esperan más de 2 horas compran en otro lugar. <strong>Responde rápido.</strong>', 'warn'),
    cta('Ver y responder', ctx.conversationUrl ?? `${SITE}/shop/manage/offers`),
  ].join('')
  await send(ctx.sellerEmail, subject, body)
}

// ── 3. Buyer: offer accepted — payment link ───────────────────────────────────
export async function sendOfferAccepted(ctx: OfferEmailCtx & {
  checkoutUrl?: string | null
  checkoutExpiresAt?: string | null
  sellerPhone?: string | null
}): Promise<void> {
  const subject = `✓ Tu oferta fue aceptada — ${ctx.listingTitle}`
  const expiryStr = ctx.checkoutExpiresAt
    ? new Date(ctx.checkoutExpiresAt).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'medium', timeStyle: 'short' })
    : null

  const body = [
    h1(`¡Tu oferta fue aceptada!`),
    table([['Anuncio', `<a href="${ctx.listingUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.listingTitle)}</a>`]]),
    amount(ctx.offerAmount, `Precio acordado (${100 - ctx.offerPct}% de descuento)`, true),
    ctx.checkoutUrl
      ? [
          p('Completa el pago desde la conversación para confirmar la compra. El vendedor recibirá el pago directamente.'),
          cta('Comprar ahora', ctx.checkoutUrl),
          expiryStr ? notice(`El trato expira el <strong>${expiryStr}</strong>. Después de esa fecha queda cancelado.`, 'warn') : '',
        ].join('')
      : [
          p('El vendedor se pondrá en contacto para coordinar el pago y la entrega.'),
          ctx.sellerPhone ? p(`WhatsApp del vendedor: <strong>${ctx.sellerPhone}</strong>`) : '',
          cta('Ver conversación', ctx.conversationUrl ?? ctx.listingUrl),
        ].join(''),
  ].join('')
  await send(ctx.buyerEmail, subject, body)
}

// ── 4. Buyer: offer declined ──────────────────────────────────────────────────
export async function sendOfferDeclined(ctx: Pick<OfferEmailCtx,
  'listingTitle' | 'listingUrl' | 'askingPrice' | 'offerAmount' | 'buyerEmail' | 'buyerName'>
): Promise<void> {
  const subject = `Tu oferta no fue aceptada — ${ctx.listingTitle}`
  const body = [
    h1('El vendedor no pudo aceptar tu oferta'),
    table([
      ['Anuncio',    `<a href="${ctx.listingUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.listingTitle)}</a>`],
      ['Tu oferta',  ctx.offerAmount],
      ['Precio lista', ctx.askingPrice],
    ]),
    p('El artículo sigue disponible. Puedes hacer una nueva oferta o comprarlo al precio de lista.'),
    cta('Ver anuncio', ctx.listingUrl),
  ].join('')
  await send(ctx.buyerEmail, subject, body)
}

// ── 5. Buyer: seller countered ────────────────────────────────────────────────
export async function sendOfferCountered(ctx: OfferEmailCtx & {
  counterAmount: string
  counterPct: number
  counterMessage?: string | null
  counterExpiresAt: string
}): Promise<void> {
  const subject = `El vendedor contraoferta — ${ctx.listingTitle}`
  const expiryStr = new Date(ctx.counterExpiresAt).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'medium', timeStyle: 'short' })
  const body = [
    h1('El vendedor hace una contraoferta'),
    table([['Anuncio', `<a href="${ctx.listingUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.listingTitle)}</a>`]]),
    amount(ctx.counterAmount, `Contraoferta del vendedor · ${ctx.counterPct}% del precio`),
    table([
      ['Tu oferta',    ctx.offerAmount],
      ['Precio lista', ctx.askingPrice],
    ]),
    ctx.counterMessage ? quote(ctx.counterMessage) : '',
    notice(`Tienes hasta el <strong>${expiryStr}</strong> para aceptar o rechazar.`, 'warn'),
    cta('Ver contraoferta', ctx.conversationUrl ?? ctx.listingUrl),
  ].join('')
  await send(ctx.buyerEmail, subject, body)
}

// ── 6. Seller: counter accepted ───────────────────────────────────────────────
export async function sendCounterAccepted(ctx: {
  sellerEmail: string
  listingTitle: string
  listingUrl: string
  counterAmount: string
  buyerName: string
  buyerEmail: string
  conversationUrl?: string | null
}): Promise<void> {
  const subject = `✓ Contraoferta aceptada — ${ctx.listingTitle}`
  const body = [
    h1('El comprador aceptó tu contraoferta'),
    table([['Anuncio', `<a href="${ctx.listingUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.listingTitle)}</a>`]]),
    amount(ctx.counterAmount, 'Precio acordado', true),
    table([
      ['Comprador', ctx.buyerName],
    ]),
    p('El comprador ya puede completar el pago desde la conversación. Te notificaremos cuando lo haga.'),
    cta('Ver conversación', ctx.conversationUrl ?? `${SITE}/shop/manage/offers`),
  ].join('')
  await send(ctx.sellerEmail, subject, body)
}

// ── 7. Seller: offer withdrawn ───────────────────────────────────────────────
//
// There is deliberately no `sendCounterDeclined` here. It existed, unwired, for a
// buyer action the product does not have: `buyer-respond` accepts exactly
// `accept-counter` and `withdraw`, so a buyer who does not want the counteroffer
// withdraws. Sending "El comprador rechazó tu contraoferta" for a withdrawal would
// describe an action nobody took, so the template was removed rather than wired to
// the nearest available trigger.
export async function sendOfferWithdrawn(ctx: {
  sellerEmail: string
  listingTitle: string
  listingUrl: string
  offerAmount: string
  buyerName: string
}): Promise<void> {
  const subject = `Oferta retirada — ${ctx.listingTitle}`
  const body = [
    h1('El comprador retiró su oferta'),
    table([
      ['Anuncio',  `<a href="${ctx.listingUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.listingTitle)}</a>`],
      ['Oferta',   ctx.offerAmount],
      ['Comprador', ctx.buyerName],
    ]),
    p('No se requiere ninguna acción. El anuncio sigue activo.'),
  ].join('')
  await send(ctx.sellerEmail, subject, body)
}

// ════════════════════════════════════════════════════════════════════════════════
// REMINDER EMAILS (cron-triggered)
// ════════════════════════════════════════════════════════════════════════════════

// ── Seller: 24h nudge ─────────────────────────────────────────────────────────
// Pass `scheduledAt` to defer delivery (returns Resend email ID for cancellation).
export async function sendSellerOfferReminder(ctx: {
  sellerEmail: string
  listingTitle: string
  listingUrl: string
  offerAmount: string
  offerPct: number
  buyerName: string
  expiresAt: string
}, scheduledAt?: Date): Promise<string | null> {
  const expiryStr = new Date(ctx.expiresAt).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'medium', timeStyle: 'short' })
  const subject = `Tienes una oferta sin responder — ${ctx.listingTitle}`
  const body = [
    h1('Una oferta espera tu respuesta'),
    table([['Anuncio', `<a href="${ctx.listingUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.listingTitle)}</a>`]]),
    amount(ctx.offerAmount, `Oferta de ${ctx.buyerName} · ${ctx.offerPct}% del precio`),
    table([['Expira', expiryStr]]),
    notice('Cuanto más tardes en responder, más probable es que el comprador pierda el interés.', 'warn'),
    cta('Responder ahora', `${SITE}/shop/manage/offers`),
  ].join('')
  return send(ctx.sellerEmail, subject, body, scheduledAt)
}

// ── Seller: expiry warning (4h left) ─────────────────────────────────────────
export async function sendSellerExpiryWarning(ctx: {
  sellerEmail: string
  listingTitle: string
  listingUrl: string
  offerAmount: string
  offerPct: number
  buyerName: string
  expiresAt: string
}, scheduledAt?: Date): Promise<string | null> {
  const subject = `Última oportunidad — oferta por expirar · ${ctx.listingTitle}`
  const body = [
    h1('Una oferta expira en menos de 4 horas'),
    table([['Anuncio', `<a href="${ctx.listingUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.listingTitle)}</a>`]]),
    amount(ctx.offerAmount, `Oferta de ${ctx.buyerName} · ${ctx.offerPct}% del precio`),
    notice('Si no respondes antes de que expire, el comprador podrá hacer una nueva oferta o comprar en otro lugar.', 'warn'),
    cta('Responder ahora', `${SITE}/shop/manage/offers`),
  ].join('')
  return send(ctx.sellerEmail, subject, body, scheduledAt)
}

// ── Buyer: counter expiry warning (4h left) ──────────────────────────────────
export async function sendBuyerCounterExpiryWarning(ctx: {
  buyerEmail: string
  listingTitle: string
  listingUrl: string
  counterAmount: string
  expiresAt: string
  conversationUrl?: string | null
}, scheduledAt?: Date): Promise<string | null> {
  const subject = `La contraoferta expira en 4 horas — ${ctx.listingTitle}`
  const expiryStr = new Date(ctx.expiresAt).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'medium', timeStyle: 'short' })
  const body = [
    h1('La contraoferta del vendedor expira pronto'),
    table([
      ['Anuncio',      `<a href="${ctx.listingUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.listingTitle)}</a>`],
      ['Contraoferta', ctx.counterAmount],
      ['Expira',       expiryStr],
    ]),
    notice('Si no respondes antes de esa hora, perderás la oportunidad de comprar al precio acordado.', 'warn'),
    cta('Ver contraoferta', ctx.conversationUrl ?? ctx.listingUrl),
  ].join('')
  return send(ctx.buyerEmail, subject, body, scheduledAt)
}

// ── Buyer: payment link expiry warning (4h left) ─────────────────────────────
export async function sendBuyerPaymentExpiryWarning(ctx: {
  buyerEmail: string
  listingTitle: string
  checkoutUrl: string
  agreedAmount: string
  expiresAt: string
}, scheduledAt?: Date): Promise<string | null> {
  const subject = `Tu enlace de pago expira en 4 horas — ${ctx.listingTitle}`
  const expiryStr = new Date(ctx.expiresAt).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'medium', timeStyle: 'short' })
  const body = [
    h1('Completa tu pago antes de que expire'),
    table([
      ['Anuncio', `<strong>${esc(ctx.listingTitle)}</strong>`],
      ['Acordado', ctx.agreedAmount],
      ['Expira',   expiryStr],
    ]),
    notice('Si no pagas antes de esa hora, el trato quedará cancelado y el vendedor podrá vender a otro comprador.', 'warn'),
    cta('Completar pago ahora', ctx.checkoutUrl),
  ].join('')
  return send(ctx.buyerEmail, subject, body, scheduledAt)
}

// ════════════════════════════════════════════════════════════════════════════════
// PURCHASE EMAILS
// ════════════════════════════════════════════════════════════════════════════════

export async function sendSaleCompletedToSeller(ctx: {
  sellerEmail: string
  listingTitle: string
  listingUrl: string
  amountPaid: string
  buyerName: string | null
  buyerEmail: string | null
  isDigital: boolean
}): Promise<void> {
  const subject = `✓ Venta completada — ${ctx.listingTitle}`
  const body = [
    h1('Recibiste un pago'),
    table([['Anuncio', `<a href="${ctx.listingUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.listingTitle)}</a>`]]),
    amount(ctx.amountPaid, 'Monto recibido', true),
    table([
      ...(ctx.buyerName  ? [['Comprador', ctx.buyerName]  as [string, string]] : []),
    ]),
    ctx.isDigital
      ? p('El archivo fue enviado al comprador automáticamente.')
      : p('El comprador ha sido notificado. Coordina la entrega directamente.'),
    divider(),
    p('<span style="font-size:12px;color:#6b6b67">El pago aparecerá en tu cuenta Stripe en 2–7 días hábiles.</span>'),
    cta('Ver panel', `${SITE}/shop/manage`),
  ].join('')
  await send(ctx.sellerEmail, subject, body)
}

export async function sendOrderConfirmedToBuyer(ctx: {
  buyerEmail: string
  buyerName: string | null
  listingTitle: string
  listingUrl: string
  amountPaid: string
  shopName: string
  isDigital: boolean
  digitalDownloadUrl?: string | null
  digitalExpiresAt?: string | null
  personalization?: EmailPersonalization | null
  eventTickets?: EventTicket[] | null
  /** Own-channel order → brand the email to the seller's custom domain. */
  storeDomain?: string | null
}): Promise<void> {
  const subject = ctx.isDigital ? `Tu descarga está lista — ${ctx.listingTitle}` : `Compra confirmada — ${ctx.listingTitle}`
  const greeting = ctx.buyerName ? `¡Gracias, ${ctx.buyerName}!` : '¡Gracias por tu compra!'
  const expiryStr = ctx.digitalExpiresAt
    ? new Date(ctx.digitalExpiresAt).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'medium', timeStyle: 'short' })
    : null

  const body = [
    h1(greeting),
    table([
      ['Anuncio',   `<a href="${ctx.listingUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.listingTitle)}</a>`],
      ['Vendedor',  ctx.shopName],
      ['Pagado',    ctx.amountPaid],
    ]),
    personalizationBlock(ctx.personalization),
    eventTicketBlock(ctx.eventTickets),
    ctx.isDigital && ctx.digitalDownloadUrl
      ? [
          p('Tu archivo está listo para descargar.'),
          cta('Descargar ahora', ctx.digitalDownloadUrl),
          expiryStr ? notice(`El enlace expira el ${expiryStr}.`) : '',
        ].join('')
      : [
          p('Tu pago fue procesado. El vendedor está preparando tu pedido. Te avisaremos cuando se envíe.'),
          cta('Ver estado del pedido', `${SITE}/account/orders`),
        ].join(''),
  ].join('')
  await send(ctx.buyerEmail, subject, body, undefined, brandFor(ctx.storeDomain))
}

// ════════════════════════════════════════════════════════════════════════════════
// ORDER / SHIPPING EMAILS
// ════════════════════════════════════════════════════════════════════════════════

// ── Seller: new physical order alert ─────────────────────────────────────────

export async function sendNewOrderToSeller(ctx: {
  sellerEmail: string
  listingTitle: string
  listingUrl: string
  amountPaid: string
  buyerName: string | null
  buyerEmail: string | null
  shippingAddress: Record<string, string> | null
  orderId: string
  orderUrl: string
  personalization?: EmailPersonalization | null
}): Promise<void> {
  const subject = `📦 Nuevo pedido — ${ctx.listingTitle}`
  const addrStr = ctx.shippingAddress
    ? [ctx.shippingAddress.line1, ctx.shippingAddress.line2, ctx.shippingAddress.city, ctx.shippingAddress.state, ctx.shippingAddress.postal_code]
        .filter(Boolean).join(', ')
    : null

  const body = [
    h1('Recibiste un pedido'),
    table([['Producto', `<a href="${ctx.listingUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.listingTitle)}</a>`]]),
    amount(ctx.amountPaid, 'Monto recibido (en camino a tu cuenta)', true),
    table([
      ...(ctx.buyerName  ? [['Comprador', ctx.buyerName]  as [string, string]] : []),
      ...(addrStr ? [['Dirección',  addrStr]              as [string, string]] : []),
    ]),
    personalizationBlock(ctx.personalization),
    notice('Envía en menos de 3 días hábiles para mantener una buena reputación. Los compradores que esperan más de 72 h cancelan con más frecuencia.', 'warn'),
    cta('Gestionar pedido', ctx.orderUrl),
  ].join('')
  await send(ctx.sellerEmail, subject, body)
}

// ── Seller: Mercado Libre order event (ml-orders-native S2 · US-5) ────────────
//
// One lean template for all four ML-order lifecycle events (new / shipped /
// delivered / cancelled) rather than four near-duplicates — copy is fully
// data-driven off `subject`/`headline`/`note`, which the caller (the backend's
// notify bridge) selects per event kind.

export async function sendMlOrderEventToSeller(ctx: {
  sellerEmail: string
  subject: string
  headline: string
  note: string
  orderUrl: string
}): Promise<void> {
  const body = [h1(ctx.headline), p(ctx.note), cta('Ver pedido', ctx.orderUrl)].join('')
  await send(ctx.sellerEmail, ctx.subject, body)
}

// ── Seller: buyer reported a manual payment ("Ya hice el pago") ───────────────
//
// The money-path keystone (Granular Notifications S3.1). Fires when a buyer taps
// "Ya hice el pago" on a manual (SPEI/cash/DiMo) order — the durable
// `buyer_reported_paid` event (#3b). The seller still confirms receipt to capture;
// this just gets them to verify fast. Copy uses #3b's "en verificación" vocabulary.

export async function sendBuyerReportedPaymentToSeller(ctx: {
  sellerEmail: string
  listingTitle: string
  buyerEmail: string | null
  orderUrl: string
}): Promise<void> {
  const subject = `💸 El comprador avisó que pagó — ${ctx.listingTitle}`
  const body = [
    h1('El comprador avisó que pagó'),
    table([
      ['Producto', `<a href="${ctx.orderUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.listingTitle)}</a>`],
      ...(ctx.buyerEmail ? [['Comprador', esc(ctx.buyerEmail)] as [string, string]] : []),
    ]),
    p('El comprador marcó este pedido como pagado. Verifica que el depósito llegó a tu cuenta antes de confirmar el pago y preparar el envío.'),
    notice('Hasta que confirmes el pago, el pedido sigue como “Pago reportado — en verificación”.', 'warn'),
    cta('Verificar y confirmar', ctx.orderUrl),
  ].join('')
  await send(ctx.sellerEmail, subject, body)
}

/**
 * A message arrived in a conversation.
 *
 * This had no email at all until 2026-08-15: starting a conversation sent nothing
 * whatsoever, and a reply sent web push only. Push is a no-op for anyone without a
 * subscription — which is most sellers — so a buyer pressing "Preguntar" reached the
 * seller through NO channel, and the only surface that would have shown it
 * (`/messages`) was itself broken. One shape for both directions: the recipient is
 * whoever did not send it.
 */
export async function sendConversationMessage(ctx: {
  to: string
  /** What the recipient is to the sender: a buyer messages the seller and vice versa. */
  recipientRole: 'buyer' | 'seller'
  listingTitle: string
  messageText: string
  conversationUrl: string
}): Promise<void> {
  const who = ctx.recipientRole === 'seller' ? 'Un comprador' : 'El vendedor'
  const subject = `💬 ${who} te escribió — ${ctx.listingTitle}`
  const body = [
    h1(`${who} te escribió`),
    table([
      ['Anuncio', `<a href="${ctx.conversationUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.listingTitle)}</a>`],
      ['Mensaje', esc(ctx.messageText)],
    ]),
    p('Responde desde tu bandeja de mensajes para no perder la venta.'),
    cta('Ver conversación', ctx.conversationUrl),
  ].join('')
  await send(ctx.to, subject, body)
}

/**
 * An operational broadcast from the platform team (admin → sellers or buyers).
 *
 * Uses the SAME `html()` shell as all 62 other senders — wordmark, green rule,
 * footer — so a message from the team is visibly the same product as a message
 * about an order. There is no second design here on purpose.
 *
 * Paragraphs arrive as plain text and are escaped by `p()`. The composer never
 * accepts markup: an outage notice written under pressure must not be able to
 * inject HTML into a message going to everyone.
 */
export async function sendPlatformBroadcast(ctx: {
  to: string
  headline: string
  paragraphs: string[]
  ctaLabel?: string | null
  ctaUrl?: string | null
  subject: string
}): Promise<void> {
  const body = [
    h1(ctx.headline),
    ...ctx.paragraphs.map((text) => p(text)),
    ctx.ctaLabel && ctx.ctaUrl ? cta(ctx.ctaLabel, ctx.ctaUrl) : '',
  ].join('')
  await send(ctx.to, ctx.subject, body)
}

// ── Buyer: order shipped notification ─────────────────────────────────────────

/**
 * Correos de México Impresos (shipping-provider-expansion S3) ships through this
 * same manual-carrier email — ordinary mail has NO tracking, so the generic
 * "puedes rastrear tu envío" promise below is false for it. Keyed on the raw
 * carrier id ('correos_mx', matching the checkout rate + the manual-ship form).
 */
const CORREOS_CARRIER_ID = 'correos_mx'

export async function sendOrderShipped(ctx: {
  buyerEmail: string
  buyerName: string | null
  listingTitle: string
  orderUrl: string
  carrier: string
  trackingNumber: string | null
  estimatedDelivery: string | null
  shopName: string
}): Promise<void> {
  const isCorreos = ctx.carrier === CORREOS_CARRIER_ID
  const carrierDisplay = isCorreos ? 'Correos de México' : ctx.carrier
  const subject = `🚚 Tu pedido está en camino — ${ctx.listingTitle}`
  const greeting = ctx.buyerName ? `¡${ctx.buyerName}, tu pedido ya viene!` : '¡Tu pedido está en camino!'
  const deliveryStr = ctx.estimatedDelivery
    ? new Date(ctx.estimatedDelivery).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', timeZone: 'America/Mexico_City' })
    : null

  const body = [
    h1(greeting),
    table([
      ['Producto', esc(ctx.listingTitle)],
      ['Vendedor', ctx.shopName],
      ['Paquetería', esc(carrierDisplay)],
      ...(ctx.trackingNumber ? [['Número de guía', `<span style="font-family:monospace">${esc(ctx.trackingNumber)}</span>`] as [string, string]] : []),
      ...(deliveryStr ? [['Entrega estimada', deliveryStr] as [string, string]] : []),
    ]),
    isCorreos
      ? p('Se envió por correo ordinario (Correos de México, categoría Impresos) — económico pero sin número de rastreo. Llega en 4 a 10 días hábiles.')
      : p('Recibirás tu paquete pronto. Puedes rastrear el estado de tu envío en tu historial de compras.'),
    cta('Ver estado del pedido', ctx.orderUrl),
    isCorreos
      ? notice('Si no recibes tu paquete después de 10 días hábiles, contacta al vendedor desde tu historial de compras — este envío no tiene rastreo en línea.')
      : notice('Si no recibes tu paquete en la fecha estimada, contacta al vendedor desde tu historial de compras.'),
  ].join('')
  await send(ctx.buyerEmail, subject, body)
}

// ── Buyer: order delivered — request review ───────────────────────────────────

export async function sendOrderDelivered(ctx: {
  buyerEmail: string
  buyerName: string | null
  listingTitle: string
  orderUrl: string
  shopName: string
}): Promise<void> {
  const subject = `¡Tu pedido fue entregado! — ${ctx.listingTitle}`
  const greeting = ctx.buyerName ? `¡${ctx.buyerName}, esperamos que lo disfrutes!` : '¡Tu pedido fue entregado!'

  const body = [
    h1(greeting),
    table([
      ['Producto', esc(ctx.listingTitle)],
      ['Vendedor', ctx.shopName],
    ]),
    p('Tu pedido fue marcado como entregado. Si tienes algún problema con tu compra, contáctanos desde el detalle del pedido.'),
    cta('Ver pedido', ctx.orderUrl),
    notice('¿Todo bien? Confirmar la entrega le ayuda al vendedor a recibir su pago completo.'),
  ].join('')
  await send(ctx.buyerEmail, subject, body)
}

// ════════════════════════════════════════════════════════════════════════════════
// RETURN REQUEST EMAILS

const REASON_LABELS: Record<string, string> = {
  not_as_described: 'No coincide con la descripción',
  damaged:          'Artículo dañado',
  wrong_item:       'Artículo incorrecto',
  changed_mind:     'Cambié de opinión',
  other:            'Otro motivo',
}

// ── Seller: new return request ────────────────────────────────────────────────

export async function sendReturnRequestToSeller(ctx: {
  sellerEmail: string
  shopName: string
  buyerName: string | null
  buyerEmail: string
  listingTitle: string
  reason: string
  description: string | null
  orderUrl: string
}): Promise<void> {
  const subject = `↩ Solicitud de devolución — ${ctx.listingTitle}`

  const body = [
    h1('Un comprador solicitó una devolución'),
    table([
      ['Producto',  esc(ctx.listingTitle)],
      ['Motivo',    esc(REASON_LABELS[ctx.reason] ?? ctx.reason)],
      ...(ctx.buyerName  ? [['Comprador', esc(ctx.buyerName)]  as [string, string]] : []),
    ]),
    ctx.description ? quote(ctx.description) : '',
    notice('Tienes 3 días hábiles para responder. Si no hay respuesta, el comprador puede escalar el caso.', 'warn'),
    cta('Gestionar solicitud', ctx.orderUrl),
  ].join('')
  await send(ctx.sellerEmail, subject, body)
}

// ── Buyer: return request received ───────────────────────────────────────────

export async function sendReturnRequestConfirmedToBuyer(ctx: {
  buyerEmail: string
  buyerName: string | null
  listingTitle: string
  shopName: string
  orderUrl: string
}): Promise<void> {
  const subject = `Tu solicitud de devolución fue enviada — ${ctx.listingTitle}`
  const greeting = ctx.buyerName ? `${ctx.buyerName}, recibimos tu solicitud.` : 'Recibimos tu solicitud de devolución.'

  const body = [
    h1(greeting),
    table([
      ['Producto', esc(ctx.listingTitle)],
      ['Tienda',   esc(ctx.shopName)],
    ]),
    p('El vendedor tiene 3 días hábiles para responder. Te notificaremos cuando tome una decisión.'),
    cta('Ver estado de la solicitud', ctx.orderUrl),
    notice('Si no recibes respuesta en 3 días hábiles, contáctanos y lo resolveremos juntos.'),
  ].join('')
  await send(ctx.buyerEmail, subject, body)
}

// ── Buyer: return request accepted ───────────────────────────────────────────

export async function sendReturnAcceptedToBuyer(ctx: {
  buyerEmail: string
  buyerName: string | null
  listingTitle: string
  shopName: string
  refundAmount: string
  isPartial: boolean
  sellerNote: string | null
  orderUrl: string
}): Promise<void> {
  const subject = ctx.isPartial
    ? `Reembolso parcial procesado — ${ctx.listingTitle}`
    : `✓ Devolución aceptada — ${ctx.listingTitle}`
  const greeting = ctx.isPartial
    ? 'El vendedor aprobó un reembolso parcial.'
    : '¡Tu devolución fue aceptada!'

  const body = [
    h1(greeting),
    table([
      ['Producto',  esc(ctx.listingTitle)],
      ['Vendedor',  esc(ctx.shopName)],
      ['Reembolso', esc(ctx.refundAmount)],
    ]),
    ctx.sellerNote ? [p('Nota del vendedor:'), quote(ctx.sellerNote)].join('') : '',
    p('El reembolso aparecerá en tu cuenta en 5–10 días hábiles dependiendo de tu banco.'),
    cta('Ver detalle del pedido', ctx.orderUrl),
  ].join('')
  await send(ctx.buyerEmail, subject, body)
}

// ── Buyer: off-platform (SPEI/cash) refund transfer sent ─────────────────────
// The seller marked the transfer as sent. Honest copy — the money was sent by the
// seller off-platform (not a card refund), so the buyer must confirm receipt to
// close the refund (lib/refund-state.ts → confirmado). Delivery & Manual-Money S1.

export async function sendRefundTransferSentToBuyer(ctx: {
  buyerEmail: string
  buyerName: string | null
  listingTitle: string
  shopName: string
  refundAmount: string | null
  sellerNote: string | null
  orderUrl: string
}): Promise<void> {
  const subject = `El vendedor envió tu reembolso — ${ctx.listingTitle}`

  const body = [
    h1('El vendedor envió tu reembolso 💸'),
    table([
      ['Producto',  esc(ctx.listingTitle)],
      ['Vendedor',  esc(ctx.shopName)],
      ...(ctx.refundAmount ? [['Reembolso', esc(ctx.refundAmount)] as [string, string]] : []),
    ]),
    ctx.sellerNote ? [p('Nota del vendedor:'), quote(ctx.sellerNote)].join('') : '',
    p('Revisa tu cuenta. Cuando confirmes que recibiste el reembolso, márcalo como recibido para cerrar la devolución.'),
    cta('Confirmar que recibí el reembolso', ctx.orderUrl),
  ].join('')
  await send(ctx.buyerEmail, subject, body)
}

// ── Buyer: return request declined ───────────────────────────────────────────

export async function sendReturnDeclinedToBuyer(ctx: {
  buyerEmail: string
  buyerName: string | null
  listingTitle: string
  shopName: string
  sellerNote: string | null
  orderUrl: string
}): Promise<void> {
  const subject = `Tu solicitud de devolución fue rechazada — ${ctx.listingTitle}`

  const body = [
    h1('El vendedor rechazó tu solicitud de devoluci��n.'),
    table([
      ['Producto', esc(ctx.listingTitle)],
      ['Vendedor', esc(ctx.shopName)],
    ]),
    ctx.sellerNote ? [p('Motivo del vendedor:'), quote(ctx.sellerNote)].join('') : '',
    p('Si crees que esta decisión es incorrecta, puedes contactar al vendedor directamente para llegar a un acuerdo.'),
    cta('Ver detalle del pedido', ctx.orderUrl),
    notice('¿No quedó resuelto? Contáctanos y revisaremos el caso.', 'warn'),
  ].join('')
  await send(ctx.buyerEmail, subject, body)
}

// ════════════════════════════════════════════════════════════════════════════════
// MANUAL DELIVERY EMAILS (coordinated & local pickup)
// ══════════��═════════════════════════════���═══════════════════════════════════════

// ── Coordinated delivery — Buyer ─────────────────────────────────────────────

export async function sendCoordinatedOrderToBuyer(ctx: {
  buyerEmail: string
  buyerName: string | null
  listingTitle: string
  listingUrl: string
  amountPaid: string
  shopName: string
  sellerPhone?: string | null
  sellerWhatsapp?: string | null
  orderUrl: string
  personalization?: EmailPersonalization | null
  eventTickets?: EventTicket[] | null
  /** Own-channel order → brand the email to the seller's custom domain. */
  storeDomain?: string | null
  /** Rental line-item pricing (epic 02) — dates + itemized deposit, when set. */
  rentalBooking?: RentalBookingLike | null
  currency?: string
}): Promise<void> {
  const greeting = ctx.buyerName ? `¡Gracias, ${ctx.buyerName}!` : '¡Gracias por tu compra!'
  const subject = `Compra confirmada — coordina la entrega con ${ctx.shopName}`

  const whatsappUrl = ctx.sellerWhatsapp
    ? `https://wa.me/${ctx.sellerWhatsapp.replace(/\D/g, '').replace(/^(?!52)/, '52')}?text=${encodeURIComponent(`Hola, acabo de comprar "${ctx.listingTitle}" en Miyagi Sánchez y quiero coordinar la entrega.`)}`
    : null

  const body = [
    h1(greeting),
    p('Tu pago fue procesado. El vendedor acordará contigo cómo y cuándo recibirás tu pedido — espera su mensaje o contáctalo directamente.'),
    table([
      ['Producto',  `<a href="${ctx.listingUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.listingTitle)}</a>`],
      ['Vendedor',  esc(ctx.shopName)],
      ['Pagado',    esc(ctx.amountPaid)],
      ['Entrega',   'Por coordinar con el vendedor'],
      ...(ctx.sellerPhone ? [['Teléfono vendedor', esc(ctx.sellerPhone)] as [string, string]] : []),
    ]),
    personalizationBlock(ctx.personalization),
    eventTicketBlock(ctx.eventTickets),
    rentalBookingBlock(ctx.rentalBooking, ctx.currency),
    notice('El vendedor tiene hasta <strong>24 horas</strong> para contactarte. Guarda este correo como comprobante de tu compra.', 'info'),
    whatsappUrl
      ? cta('Contactar por WhatsApp', whatsappUrl)
      : cta('Ver estado del pedido', ctx.orderUrl),
    p(`Si en 24 horas no has tenido noticias, ve al <a href="${ctx.orderUrl}" style="color:#1d6f42">detalle de tu pedido</a> para escribirle al vendedor.`),
  ].join('')
  await send(ctx.buyerEmail, subject, body, undefined, brandFor(ctx.storeDomain))
}

// ── Coordinated delivery — Seller ───────��────────────────────────────────────

export async function sendCoordinatedOrderToSeller(ctx: {
  sellerEmail: string
  listingTitle: string
  listingUrl: string
  amountPaid: string
  buyerName: string | null
  buyerEmail: string | null
  shopName: string
  orderId: string
  orderUrl: string
  personalization?: EmailPersonalization | null
  /** Rental line-item pricing (epic 02) — dates + itemized deposit, when set. */
  rentalBooking?: RentalBookingLike | null
  currency?: string
}): Promise<void> {
  const subject = `📦 Nuevo pedido — acuerda la entrega con el comprador`

  const body = [
    h1('Tienes un nuevo pedido de entrega acordada'),
    table([
      ['Producto',   `<a href="${ctx.listingUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.listingTitle)}</a>`],
      ...(ctx.buyerName  ? [['Comprador', esc(ctx.buyerName)]  as [string, string]] : []),
      ...(ctx.buyerEmail ? [['Email', `<a href="mailto:${esc(ctx.buyerEmail)}" style="color:#1d6f42;text-decoration:none">${esc(ctx.buyerEmail)}</a>`] as [string, string]] : []),
    ]),
    personalizationBlock(ctx.personalization),
    rentalBookingBlock(ctx.rentalBooking, ctx.currency),
    amount(ctx.amountPaid, 'Monto recibido (en camino a tu cuenta)', true),
    notice('El comprador eligió <strong>entrega acordada</strong>. Tienes <strong>24 horas</strong> para contactarlo y definir cómo y cuándo le entregas el artículo.', 'warn'),
    cta('Gestionar pedido', ctx.orderUrl),
    divider(),
    p('<strong>¿Qué hacer?</strong><br>1. Contacta al comprador por correo o mensaje.<br>2. Acuerda el método de entrega (envío propio, paquetería, en mano).<br>3. Una vez entregado, marca el pedido como entregado desde tu panel.'),
  ].join('')
  await send(ctx.sellerEmail, subject, body)
}

// ── Local pickup — Buyer ─────────────────────────────────────────────────────

export async function sendPickupOrderToBuyer(ctx: {
  buyerEmail: string
  buyerName: string | null
  listingTitle: string
  listingUrl: string
  amountPaid: string
  shopName: string
  pickupAddress?: string | null
  pickupInstructions?: string | null
  sellerPhone?: string | null
  sellerWhatsapp?: string | null
  orderUrl: string
  personalization?: EmailPersonalization | null
  eventTickets?: EventTicket[] | null
  /** Own-channel order → brand the email to the seller's custom domain. */
  storeDomain?: string | null
}): Promise<void> {
  const greeting = ctx.buyerName ? `¡Gracias, ${ctx.buyerName}!` : '¡Gracias por tu compra!'
  const subject = `Compra confirmada — recoge tu pedido en ${ctx.shopName}`

  const whatsappUrl = ctx.sellerWhatsapp
    ? `https://wa.me/${ctx.sellerWhatsapp.replace(/\D/g, '').replace(/^(?!52)/, '52')}?text=${encodeURIComponent(`Hola, compré "${ctx.listingTitle}" en Miyagi Sánchez y quiero coordinar la recolección.`)}`
    : null

  const body = [
    h1(greeting),
    p('Tu pago fue procesado. Este vendedor ofrece recolección en mano. El vendedor te confirmará el lugar y horario disponible.'),
    table([
      ['Producto',        `<a href="${ctx.listingUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.listingTitle)}</a>`],
      ['Vendedor',        esc(ctx.shopName)],
      ['Pagado',          esc(ctx.amountPaid)],
      ['Entrega',         'Recolección en mano'],
      ...(ctx.pickupAddress      ? [['Ubicación',    esc(ctx.pickupAddress)]      as [string, string]] : []),
      ...(ctx.pickupInstructions ? [['Instrucciones', esc(ctx.pickupInstructions)] as [string, string]] : []),
      ...(ctx.sellerPhone        ? [['Teléfono',     esc(ctx.sellerPhone)]        as [string, string]] : []),
    ]),
    personalizationBlock(ctx.personalization),
    eventTicketBlock(ctx.eventTickets),
    notice('El vendedor confirmará el horario. Guarda este correo como comprobante de pago.', 'info'),
    whatsappUrl
      ? cta('Coordinar por WhatsApp', whatsappUrl)
      : cta('Ver estado del pedido', ctx.orderUrl),
  ].join('')
  await send(ctx.buyerEmail, subject, body, undefined, brandFor(ctx.storeDomain))
}

// ── Local pickup — Seller ────────────────────────────────────────────────────

export async function sendPickupOrderToSeller(ctx: {
  sellerEmail: string
  listingTitle: string
  listingUrl: string
  amountPaid: string
  buyerName: string | null
  buyerEmail: string | null
  shopName: string
  orderUrl: string
  personalization?: EmailPersonalization | null
}): Promise<void> {
  const subject = `📦 Nuevo pedido — el comprador recogerá en mano`

  const body = [
    h1('Tienes un nuevo pedido de recolección'),
    table([
      ['Producto',   `<a href="${ctx.listingUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.listingTitle)}</a>`],
      ...(ctx.buyerName  ? [['Comprador', esc(ctx.buyerName)]  as [string, string]] : []),
      ...(ctx.buyerEmail ? [['Email', `<a href="mailto:${esc(ctx.buyerEmail)}" style="color:#1d6f42;text-decoration:none">${esc(ctx.buyerEmail)}</a>`] as [string, string]] : []),
    ]),
    personalizationBlock(ctx.personalization),
    amount(ctx.amountPaid, 'Monto recibido (en camino a tu cuenta)', true),
    notice('El comprador <strong>recogerá el artículo en mano</strong>. Contáctalo para confirmar el horario y lugar de recolección.', 'warn'),
    cta('Gestionar pedido', ctx.orderUrl),
    divider(),
    p('<strong>¿Qué hacer?</strong><br>1. Contáctalo para confirmar horario de recolección.<br>2. Ten el artículo listo el día acordado.<br>3. Una vez entregado en mano, marca el pedido como entregado desde tu panel.'),
  ].join('')
  await send(ctx.sellerEmail, subject, body)
}

// ── Manual ("Pago directo") — pending payment ─────────────────────────────────

export type ManualPaymentSnapshot = {
  spei?: { clabe: string; bank_name?: string | null; account_holder?: string | null } | null
  dimo?: { phone: string } | null
  cash?: { note?: string | null } | null
}

/** Renders the seller's configured manual methods as email table rows. */
function manualInstructionRows(mp: ManualPaymentSnapshot): [string, string][] {
  const rows: [string, string][] = []
  if (mp.spei?.clabe) {
    const extra = [mp.spei.bank_name ? `Banco: ${esc(mp.spei.bank_name)}` : '', mp.spei.account_holder ? `Titular: ${esc(mp.spei.account_holder)}` : '']
      .filter(Boolean).join(' · ')
    rows.push(['SPEI', `CLABE <strong style="font-family:monospace">${esc(mp.spei.clabe)}</strong>${extra ? `<br><span style="color:#666">${extra}</span>` : ''}`])
  }
  if (mp.dimo?.phone) {
    rows.push(['DiMo', `Transfiere al teléfono <strong style="font-family:monospace">${esc(mp.dimo.phone)}</strong>`])
  }
  if (mp.cash) {
    rows.push(['Efectivo al recoger', esc(mp.cash.note || 'Paga en efectivo cuando recojas tu pedido.')])
  }
  return rows
}

export async function sendManualOrderToBuyer(ctx: {
  buyerEmail: string
  buyerName: string | null
  listingTitle: string
  listingUrl: string
  amountToPay: string
  shopName: string
  manualPayment: ManualPaymentSnapshot
  orderUrl: string
  personalization?: EmailPersonalization | null
  /** Rental line-item pricing (epic 02) — dates + itemized deposit, when set. */
  rentalBooking?: RentalBookingLike | null
  currency?: string
}): Promise<void> {
  const greeting = ctx.buyerName ? `¡Gracias, ${ctx.buyerName}!` : '¡Gracias por tu compra!'
  const subject = `Pedido registrado — completa tu pago en ${ctx.shopName}`
  const rows = manualInstructionRows(ctx.manualPayment)

  const body = [
    h1(greeting),
    p('Tu pedido quedó <strong>reservado</strong>. Para completarlo, realiza tu pago con cualquiera de las opciones que acepta el vendedor:'),
    table([
      ['Producto', `<a href="${ctx.listingUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.listingTitle)}</a>`],
      ['Vendedor', esc(ctx.shopName)],
      ['Monto a pagar', esc(ctx.amountToPay)],
      ...rows,
    ]),
    personalizationBlock(ctx.personalization),
    rentalBookingBlock(ctx.rentalBooking, ctx.currency),
    notice('Una vez que el vendedor reciba tu pago, lo confirmará y procesará tu pedido. Guarda este correo.', 'info'),
    cta('Ver mi pedido', ctx.orderUrl),
  ].join('')
  await send(ctx.buyerEmail, subject, body)
}

export async function sendManualOrderToSeller(ctx: {
  sellerEmail: string
  listingTitle: string
  listingUrl: string
  amount: string
  buyerName: string | null
  buyerEmail: string | null
  shopName: string
  orderUrl: string
  personalization?: EmailPersonalization | null
  /** Rental line-item pricing (epic 02) — dates + itemized deposit, when set. */
  rentalBooking?: RentalBookingLike | null
  currency?: string
}): Promise<void> {
  const subject = `📦 Nuevo pedido — pago directo pendiente`
  const body = [
    h1('Tienes un nuevo pedido'),
    table([
      ['Producto', `<a href="${ctx.listingUrl}" style="color:#1d6f42;text-decoration:none">${esc(ctx.listingTitle)}</a>`],
      ...(ctx.buyerName  ? [['Comprador', esc(ctx.buyerName)]  as [string, string]] : []),
      ...(ctx.buyerEmail ? [['Email', `<a href="mailto:${esc(ctx.buyerEmail)}" style="color:#1d6f42;text-decoration:none">${esc(ctx.buyerEmail)}</a>`] as [string, string]] : []),
    ]),
    personalizationBlock(ctx.personalization),
    rentalBookingBlock(ctx.rentalBooking, ctx.currency),
    amount(ctx.amount, 'Monto del pedido', true),
    notice('El comprador pagará por <strong>pago directo</strong> (SPEI / DiMo / efectivo). Cuando recibas el pago, márcalo como confirmado en tu panel para procesar el pedido.', 'warn'),
    cta('Gestionar pedido', ctx.orderUrl),
  ].join('')
  await send(ctx.sellerEmail, subject, body)
}

// ════════════════════════════════════════════════════════════════════════════════
// PRINT EDITION EMAILS — "Sal en la edición impresa"
// ════════════════════════════════════════════════════════════════════════════════

function formatPrintDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' })
}

/** Buyer (advertiser): receipt + what to expect after paying for a print placement. */
export async function sendPrintAdReceivedToBuyer(ctx: {
  buyerEmail: string
  buyerName?: string | null
  editionTitle: string
  providerName: string
  tierLabel: string
  amountPaid: string
  submissionDeadline?: string | null
  distributionDate?: string | null
  manageUrl: string
}): Promise<void> {
  const subject = `🗞️ Recibimos tu anuncio — ${ctx.editionTitle}`
  const deadline = formatPrintDate(ctx.submissionDeadline)
  const distrib = formatPrintDate(ctx.distributionDate)
  const body = [
    h1('¡Tu lugar en la edición impresa está apartado!'),
    p('Gracias. Recibimos los elementos de tu anuncio y nuestro equipo lo diseñará con la estética México 86 antes de imprimir.'),
    table([
      ['Edición', esc(ctx.editionTitle)],
      ['Imprenta', esc(ctx.providerName)],
      ['Tamaño', esc(ctx.tierLabel)],
      ...(deadline ? [['Cierre de edición', esc(deadline)] as [string, string]] : []),
      ...(distrib ? [['Distribución', esc(distrib)] as [string, string]] : []),
    ]),
    amount(ctx.amountPaid, 'Pago recibido', true),
    notice('Próximos pasos: <strong>Miyagi diseña tu anuncio</strong> → te compartimos una vista previa → se imprime y distribuye. Si necesitamos algo más, te escribimos.'),
    cta('Ver mis anuncios', ctx.manageUrl),
  ].join('')
  await send(ctx.buyerEmail, subject, body)
}

/** Miyagi (admin): a new paid placement landed in the editorial queue. */
export async function sendPrintAdReceivedToMiyagi(ctx: {
  adminEmail: string
  editionTitle: string
  tierLabel: string
  sellerName: string
  buyerEmail: string | null
  amountPaid: string
  ctaUrl: string | null
  photosCount: number
  adminUrl: string
}): Promise<void> {
  const subject = `🗞️ Nuevo anuncio pagado — ${ctx.editionTitle} (${ctx.tierLabel})`
  const body = [
    h1('Nuevo anuncio para la edición impresa'),
    table([
      ['Edición', esc(ctx.editionTitle)],
      ['Tamaño', esc(ctx.tierLabel)],
      ['Anunciante', esc(ctx.sellerName)],
      ...(ctx.buyerEmail ? [['Email', `<a href="mailto:${esc(ctx.buyerEmail)}" style="color:#1d6f42;text-decoration:none">${esc(ctx.buyerEmail)}</a>`] as [string, string]] : []),
      ['Fotos', String(ctx.photosCount)],
      ...(ctx.ctaUrl ? [['Enlace QR', `<a href="${esc(ctx.ctaUrl)}" style="color:#1d6f42;text-decoration:none">${esc(ctx.ctaUrl)}</a>`] as [string, string]] : []),
    ]),
    amount(ctx.amountPaid, 'Pagado', true),
    cta('Abrir cola editorial', ctx.adminUrl),
  ].join('')
  await send(ctx.adminEmail, subject, body)
}

interface PrintManualMethods {
  spei?: { clabe?: string | null; bank_name?: string | null; account_holder?: string | null } | null
  dimo?: { phone?: string | null } | null
  cash?: { note?: string | null } | null
}

/** Buyer: manual (SPEI/DiMo/cash) payment is pending — here's how to pay. */
export async function sendPrintAdPaymentPending(ctx: {
  buyerEmail: string
  buyerName?: string | null
  editionTitle: string
  tierLabel: string
  amountDue: string
  manual: PrintManualMethods
  submissionDeadline?: string | null
  manageUrl: string
}): Promise<void> {
  const subject = `🗞️ Aparta tu anuncio — falta el pago (${ctx.editionTitle})`
  const deadline = formatPrintDate(ctx.submissionDeadline)
  const rows: [string, string][] = [
    ['Edición', esc(ctx.editionTitle)],
    ['Tamaño', esc(ctx.tierLabel)],
    ...(deadline ? [['Pagar antes de', esc(deadline)] as [string, string]] : []),
  ]
  if (ctx.manual.spei?.clabe) {
    rows.push(['CLABE (SPEI)', `<strong>${esc(ctx.manual.spei.clabe)}</strong>`])
    if (ctx.manual.spei.bank_name) rows.push(['Banco', esc(ctx.manual.spei.bank_name)])
    if (ctx.manual.spei.account_holder) rows.push(['Titular', esc(ctx.manual.spei.account_holder)])
  }
  if (ctx.manual.dimo?.phone) rows.push(['DiMo (teléfono)', `<strong>${esc(ctx.manual.dimo.phone)}</strong>`])
  if (ctx.manual.cash?.note) rows.push(['Efectivo', esc(ctx.manual.cash.note)])

  const body = [
    h1('Tu lugar está apartado — falta el pago'),
    p('Reservamos tu espacio en la edición. Para confirmar tu anuncio, realiza el pago con los datos de abajo. En cuanto lo recibamos, lo verás reflejado y empezamos el diseño.'),
    amount(ctx.amountDue, 'Monto a pagar', true),
    table(rows),
    notice('Cuando hagas la transferencia, entra a "Mis anuncios" y toca <strong>"Ya hice el pago"</strong> para avisarnos y agilizar la confirmación.'),
    cta('Ver instrucciones y estado', ctx.manageUrl),
  ].join('')
  await send(ctx.buyerEmail, subject, body)
}

/** Buyer: ad approved by the editor — it's going in the edition. */
export async function sendPrintAdApproved(ctx: {
  buyerEmail: string
  buyerName?: string | null
  editionTitle: string
  tierLabel: string
  distributionDate?: string | null
  manageUrl: string
}): Promise<void> {
  const subject = `✅ Tu anuncio fue aprobado — ${ctx.editionTitle}`
  const distrib = formatPrintDate(ctx.distributionDate)
  const body = [
    h1('¡Tu anuncio quedó aprobado!'),
    p('Nuestro equipo revisó tu anuncio y lo incluiremos en la edición impresa. Ya puedes ver cómo quedará desde "Mis anuncios".'),
    table([
      ['Edición', esc(ctx.editionTitle)],
      ['Tamaño', esc(ctx.tierLabel)],
      ...(distrib ? [['Distribución', esc(distrib)] as [string, string]] : []),
    ]),
    cta('Ver mi anuncio', ctx.manageUrl),
  ].join('')
  await send(ctx.buyerEmail, subject, body)
}

/** Buyer: ad needs changes / was rejected — what to fix. */
export async function sendPrintAdRejected(ctx: {
  buyerEmail: string
  buyerName?: string | null
  editionTitle: string
  tierLabel: string
  reason?: string | null
  manageUrl: string
}): Promise<void> {
  const subject = `✏️ Tu anuncio necesita ajustes — ${ctx.editionTitle}`
  const body = [
    h1('Necesitamos algunos ajustes'),
    p('Revisamos tu anuncio y hay algo que ajustar antes de imprimirlo. Edítalo desde "Mis anuncios" y vuelve a enviarlo.'),
    ...(ctx.reason ? [quote(ctx.reason)] : []),
    table([
      ['Edición', esc(ctx.editionTitle)],
      ['Tamaño', esc(ctx.tierLabel)],
    ]),
    cta('Editar mi anuncio', ctx.manageUrl),
  ].join('')
  await send(ctx.buyerEmail, subject, body)
}

/** Admin: a buyer reports they've sent a manual payment — verify + confirm. */
export async function sendPrintPaymentReportedToMiyagi(ctx: {
  adminEmail: string
  editionTitle: string
  tierLabel: string
  buyerEmail: string | null
  amount?: string | null
  adminUrl: string
}): Promise<void> {
  const subject = `💸 Pago reportado — ${ctx.editionTitle} (${ctx.tierLabel})`
  const body = [
    h1('Un anunciante reporta su pago'),
    p('Verifica que el pago haya llegado y confírmalo en la cola editorial para liberar el diseño.'),
    table([
      ['Edición', esc(ctx.editionTitle)],
      ['Tamaño', esc(ctx.tierLabel)],
      ...(ctx.buyerEmail ? [['Anunciante', `<a href="mailto:${esc(ctx.buyerEmail)}" style="color:#1d6f42;text-decoration:none">${esc(ctx.buyerEmail)}</a>`] as [string, string]] : []),
      ...(ctx.amount ? [['Monto', esc(ctx.amount)] as [string, string]] : []),
    ]),
    cta('Confirmar en la cola editorial', ctx.adminUrl),
  ].join('')
  await send(ctx.adminEmail, subject, body)
}

/** Buyer: acknowledgement that we received their payment notice. */
export async function sendPrintPaymentReportedToBuyer(ctx: {
  buyerEmail: string
  buyerName?: string | null
  editionTitle: string
  manageUrl: string
}): Promise<void> {
  const subject = `Recibimos tu aviso de pago — ${ctx.editionTitle}`
  const body = [
    h1('¡Gracias! Recibimos tu aviso'),
    p('Estamos verificando tu pago. En cuanto lo confirmemos, empezamos a diseñar tu anuncio y te avisamos. Normalmente toma poco tiempo.'),
    cta('Ver el estado de mi anuncio', ctx.manageUrl),
  ].join('')
  await send(ctx.buyerEmail, subject, body)
}

/** Submitter: confirmation that their community/social post was received. */
export async function sendPrintSocialReceived(ctx: {
  toEmail: string
  caption: string
  mineUrl: string
}): Promise<void> {
  const subject = '📣 Recibimos tu aporte para la edición impresa'
  const body = [
    h1('¡Gracias por compartir con tu colonia!'),
    p('Recibimos tu aporte. Nuestro equipo lo revisará y podría aparecer en la próxima edición impresa.'),
    quote(ctx.caption),
    cta('Ver mis aportes', ctx.mineUrl),
  ].join('')
  await send(ctx.toEmail, subject, body)
}

// ════════════════════════════════════════════════════════════════════════════════
// AGENT CONFIG ALERTS (Sprint 4 US-4)
// ════════════════════════════════════════════════════════════════════════════════

const AGENT_BLOCK_LABELS: Record<string, string> = {
  profile:        'Perfil y marca',
  shipping:       'Envíos y entrega',
  offers:         'Negociación y ofertas',
  notifications:  'Notificaciones',
  orders:         'Gestión de pedidos',
  returns_policy: 'Devoluciones',
  scheduling:     'Enlaces de agenda',
}

/** Security alert: a seller's MCP agent changed a sensitive config block. */
export async function sendAgentConfigAlert(ctx: {
  to: string
  shopName: string
  blocks: string[]
  sensitive: string[]
}): Promise<void> {
  const subject = `Tu agente cambió la configuración de ${ctx.shopName}`
  const label = (k: string) => AGENT_BLOCK_LABELS[k] ?? k
  const body = [
    h1('Un agente modificó tu tienda'),
    p(`Tu agente de IA aplicó cambios en la configuración de <strong>${esc(ctx.shopName)}</strong> a través de MCP.`),
    table(ctx.blocks.map((b) => [label(b), ctx.sensitive.includes(b) ? 'Modificado · sensible' : 'Modificado'])),
    notice('Si no reconoces este cambio, revisa y revoca el token de tu agente en Configuración → Agentes e integraciones.', 'warn'),
    cta('Revisar configuración', `${SITE}/shop/manage/settings/agentes`),
  ].join('')
  await send(ctx.to, subject, body)
}

// ════════════════════════════════════════════════════════════════════════════════
// PROMOTER APPLICATIONS (epic 08 · promoter-funnel-v2 · Sprint 2)
// ════════════════════════════════════════════════════════════════════════════════

/** Admin (Daniel): a new self-serve promoter application landed. */
export async function sendPromoterApplicationReceivedToAdmin(ctx: {
  adminEmail: string
  name: string
  email: string
  whatsapp: string
  city: string | null
  motivation: string | null
  adminUrl: string
}): Promise<void> {
  const subject = `📝 Nueva solicitud de promotor — ${ctx.name}`
  const body = [
    h1('Nueva solicitud de promotor'),
    table([
      ['Nombre', esc(ctx.name)],
      ['Email', `<a href="mailto:${esc(ctx.email)}" style="color:#1d6f42;text-decoration:none">${esc(ctx.email)}</a>`],
      ['WhatsApp', esc(ctx.whatsapp)],
      ...(ctx.city ? [['Ciudad/zona', esc(ctx.city)] as [string, string]] : []),
    ]),
    ctx.motivation ? quote(ctx.motivation) : '',
    cta('Revisar solicitudes', ctx.adminUrl),
  ].join('')
  await send(ctx.adminEmail, subject, body)
}

/** Privacy-minimal operator alert: qualification stays in the Clerk-admin queue. */
export async function sendFoundingOperatorApplicationReceivedToAdmin(ctx: {
  adminEmail: string
  adminUrl: string
}): Promise<void> {
  const ui = (await getDictionary('es')).partnersRecruiting.email
  const subject = ui.adminApplicationSubject
  const body = [
    h1(ui.adminApplicationHeading),
    p(ui.adminApplicationBody),
    cta(ui.adminApplicationCta, ctx.adminUrl),
  ].join('')
  await send(ctx.adminEmail, subject, body, undefined, undefined, 'es')
}

/** Applicant: approved — here's your PRM- code + how to finish signup. */
export async function sendPromoterApplicationApproved(ctx: {
  to: string
  name: string
  code: string
  bindUrl: string
}): Promise<void> {
  const subject = '✅ Ya eres promotor — aquí está tu código'
  const body = [
    h1(`¡Felicidades, ${esc(ctx.name)}!`),
    p('Tu solicitud para ser promotor de Miyagi Sánchez fue aprobada. Este es tu código personal:'),
    amount(ctx.code, 'Tu código de promotor', true),
    p('Para empezar a cerrar ventas:'),
    table([
      ['1', 'Crea tu cuenta en miyagisanchez.com (o inicia sesión si ya tienes una)'],
      ['2', 'Entra a tu panel de promotor y captura tu código'],
      ['3', 'Abre tu primera tienda y cobra en persona'],
    ]),
    cta('Ingresar mi código', ctx.bindUrl),
    notice('Guarda este correo — tu código es tuyo y personal, no lo compartas.'),
  ].join('')
  await send(ctx.to, subject, body)
}

/** Applicant: rejected — polite es-MX close. */
export async function sendPromoterApplicationRejected(ctx: {
  to: string
  name: string
}): Promise<void> {
  const subject = 'Tu solicitud de promotor'
  const body = [
    h1(`Gracias por tu interés, ${esc(ctx.name)}`),
    p('Revisamos tu solicitud para ser promotor de Miyagi Sánchez y, por ahora, no podemos avanzar con ella.'),
    p('Puedes volver a aplicar más adelante si tu situación cambia. Gracias por el interés en el proyecto.'),
  ].join('')
  await send(ctx.to, subject, body)
}

export async function sendFoundingOperatorApplicationRejected(ctx: {
  to: string
  name: string
  locale?: Locale
}): Promise<void> {
  // Intake locale is deliberately not persisted with the qualification dossier,
  // so an unspecified locale sends both dictionaries instead of guessing.
  const locales: Locale[] = ctx.locale ? [ctx.locale] : ['en', 'es']
  const messages = await Promise.all(locales.map(async (locale) => (await getDictionary(locale)).partnersRecruiting.email))
  const subject = messages.map((ui) => ui.rejectionSubject).join(' / ')
  const body = messages.flatMap((ui) => [
    h1(ui.rejectionHeading.replace('{name}', ctx.name)),
    p(ui.rejectionBody),
    p(ui.rejectionBoundary),
  ]).join('')
  await send(ctx.to, subject, body, undefined, undefined, ctx.locale ?? 'en')
}

export type { FoundingOperatorInvitationOutcome } from '@/lib/founding-operator-invitation-outcome'

type FoundingOperatorInvitationDeps = {
  sendEmail: (to: string, subject: string, body: string) => Promise<string | null>
}

/**
 * The only outcome-bearing email helper. Existing Promise<void> callers stay
 * untouched. A non-empty Resend acceptance id is the sole success signal;
 * missing config, null ids, exceptions and ambiguous network results are all
 * recoverable `unconfirmed` outcomes—not mailbox-delivery claims.
 */
export async function sendFoundingOperatorActivationInvitationWithOutcome(
  ctx: { to: string; name: string; activationUrl: string; expiresAt: string; locale?: Locale },
  deps?: FoundingOperatorInvitationDeps,
): Promise<FoundingOperatorInvitationOutcome> {
  const locale = ctx.locale ?? 'en'
  const ui = (await getDictionary(locale)).partnersRecruiting.email
  const subject = ui.subject
  const expiry = new Date(ctx.expiresAt).toLocaleString(locale === 'es' ? 'es-MX' : 'en-US', {
    timeZone: locale === 'es' ? 'America/Mexico_City' : 'America/New_York', dateStyle: 'medium', timeStyle: 'short',
  })
  const body = [
    h1(ui.heading.replace('{name}', ctx.name)),
    p(ui.approved),
    p(ui.boundary),
    table([
      [ui.programKey, ui.programValue],
      [ui.expiresKey, expiry],
    ]),
    cta(ui.cta, ctx.activationUrl),
    notice(ui.notice),
  ].join('')
  return resolveFoundingOperatorInvitationOutcome(() => deps
    ? deps.sendEmail(ctx.to, subject, body)
    : send(ctx.to, subject, body, undefined, undefined, locale))
}

// ════════════════════════════════════════════════════════════════════════════════
// PROMOTER NET-REMITTANCE TRANSFERS (epic 08 · promoter-funnel-v2 · Sprint 4)
// ════════════════════════════════════════════════════════════════════════════════

/** Promoter: your reported transfer was approved — the benefit is already live. */
export async function sendPromoterTransferApproved(ctx: {
  to: string
  skuLabel: string
  owedMxn: string
}): Promise<void> {
  const subject = `✅ Transferencia aprobada — ${ctx.skuLabel} activado`
  const body = [
    h1('Transferencia aprobada'),
    p(`Confirmamos tu transferencia de ${esc(ctx.owedMxn)}. El beneficio ya está activo en la tienda del comerciante:`),
    amount(ctx.skuLabel, 'Producto activado', true),
  ].join('')
  await send(ctx.to, subject, body)
}

/** Promoter: your reported transfer was rejected — an es-MX reason + retry note. */
export async function sendPromoterTransferRejected(ctx: {
  to: string
  skuLabel: string
  reason: string | null
}): Promise<void> {
  const subject = 'Tu transferencia no pudo confirmarse'
  const body = [
    h1('Transferencia rechazada'),
    p(`No pudimos confirmar tu transferencia para ${esc(ctx.skuLabel)}.`),
    ctx.reason ? quote(ctx.reason) : '',
    p('Puedes intentar de nuevo desde el flujo de cierre.'),
  ].join('')
  await send(ctx.to, subject, body)
}

/**
 * Promoter Funnel v2 · Sprint 5 (US-5.5) — the branded merchant receipt after a
 * promoter close: what they bought, what they paid, what happens next, plus
 * the claim-link recap. Fired from every close-completion path (see
 * lib/promoter-close-receipt.ts's header comment for the six call sites) —
 * one email per completed SKU close, not batched per promoter visit.
 */
export async function sendMerchantCloseReceipt(ctx: {
  to: string
  shopName: string
  items: CloseReceiptItem[]
  claimUrl: string
  toMerchantDirectly: boolean
}): Promise<void> {
  const { subject, intro, items, claimUrl } = buildMerchantCloseReceipt(ctx)
  const notes = items.map((i) => i.note).filter((n): n is string => !!n)
  const body = [
    h1('Tu recibo de Miyagi Sánchez'),
    p(intro),
    table(items.map((i) => [i.label, i.amountMxn ?? 'GRATIS'] as [string, string])),
    ...(notes.length ? [notice(notes.join('<br>'))] : []),
    cta('Reclamar mi tienda', claimUrl),
  ].join('')
  await send(ctx.to, subject, body)
}
