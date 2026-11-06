/**
 * lib/promoter-receipt.ts — «El recibo del negocio» (epic 08 · promoter-panel S4.1, D10). Pure: the signed token, the
 * status a merchant reads, and the WhatsApp message, all testable without a database or a network.
 *
 * Why it exists (Daniel, 2026-11-05): a merchant hands the promoter cash and got nothing; the only receipt was an
 * email sent when OUR share settled, days later by transfer, often to the promoter. Now the promoter sends a WhatsApp
 * message the moment they're paid, linking a public receipt page whose status reads live.
 *
 * The token is an HMAC over a small JSON payload, keyed by a key DERIVED for receipts (`receipt:` + the claim secret),
 * so a receipt link can never verify as a claim link or the other way round. It holds no secret data: the shop, the
 * option, the promoter, the amount and the time. It doesn't expire (a receipt is permanent).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { isPackageSku, PACKAGES, type PackageSku } from './promoter-packages'

export type ReceiptPayload = {
  v: 1
  typ: 'receipt'
  shopId: string
  sku: PackageSku
  promoterId: string
  amountCents: number
  issuedAt: string
}

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

function receiptKey(secret: string): Buffer {
  // Domain separation: a key used only for receipts, so a claim token's signature never validates here.
  return createHmac('sha256', secret).update('receipt:v1').digest()
}

export function signReceiptToken(payload: Omit<ReceiptPayload, 'v' | 'typ'>, secret: string): string {
  if (!secret) throw new Error('receipt secret missing')
  const body = b64url(Buffer.from(JSON.stringify({ v: 1, typ: 'receipt', ...payload } satisfies ReceiptPayload)))
  const sig = b64url(createHmac('sha256', receiptKey(secret)).update(body).digest())
  return `${body}.${sig}`
}

/** The payload, or null for anything tampered, malformed or not a receipt. Constant-time signature check. */
export function verifyReceiptToken(token: string, secret: string): ReceiptPayload | null {
  if (!secret || typeof token !== 'string') return null
  const [body, sig, extra] = token.split('.')
  if (!body || !sig || extra !== undefined) return null
  const expected = createHmac('sha256', receiptKey(secret)).update(body).digest()
  const given = fromB64url(sig)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const p = JSON.parse(fromB64url(body).toString('utf8')) as Partial<ReceiptPayload>
    if (p.v !== 1 || p.typ !== 'receipt' || typeof p.shopId !== 'string' || typeof p.promoterId !== 'string') return null
    if (!isPackageSku(p.sku) || typeof p.amountCents !== 'number' || typeof p.issuedAt !== 'string') return null
    return p as ReceiptPayload
  } catch { return null }
}

/**
 * What the merchant reads, in this order (pr-reviewer, #483):
 * 1. The latest transfer for this package is `pending`/`reported` → `pending`: a sale still being confirmed never
 *    borrows an earlier sale's «Activo».
 * 2. Our share never arrived → `problem` when that transfer was rejected (the merchant should write to us), else
 *    `pending`.
 * 3. It arrived: the free setup is `ready`; a Negocio package is `active` while the grant runs, and `ended` once it ran
 *    out — never «Activo hasta» a date already past. A grant with no end date (a permanent one) is `active`.
 */
export type ReceiptStatus =
  | { kind: 'active'; endsAt: string | null }
  | { kind: 'ended'; endsAt: string }
  | { kind: 'ready' }
  | { kind: 'pending' }
  | { kind: 'problem' }

export function receiptStatus(input: {
  sku: PackageSku
  attributionPaid: boolean
  transferStatus: string | null
  negocioEndsAt: string | null
  now: Date
}): ReceiptStatus {
  if (input.transferStatus === 'pending' || input.transferStatus === 'reported') return { kind: 'pending' }
  if (!input.attributionPaid) return input.transferStatus === 'rejected' ? { kind: 'problem' } : { kind: 'pending' }
  if (PACKAGES[input.sku].negocioMonths === 0) return { kind: 'ready' }
  const ends = input.negocioEndsAt ? Date.parse(input.negocioEndsAt) : NaN
  if (input.negocioEndsAt && Number.isFinite(ends) && ends <= input.now.getTime()) return { kind: 'ended', endsAt: input.negocioEndsAt }
  return { kind: 'active', endsAt: input.negocioEndsAt }
}

/**
 * `$2,000 MXN` — one format everywhere a receipt shows an amount (D10). Centavos show only when there are some
 * (`$1,499.50 MXN`): a money receipt never rounds (pr-reviewer, #483 — migration and discounted grosses carry them).
 */
export function formatReceiptAmount(cents: number): string {
  const whole = Math.trunc(cents / 100)
  const centavos = Math.abs(cents % 100)
  return `$${whole.toLocaleString('en-US')}${centavos ? `.${String(centavos).padStart(2, '0')}` : ''} MXN`
}

/** The WhatsApp link the promoter opens, to the owner's number, with the message from the locale. */
export function receiptWhatsappUrl(input: { whatsappE164: string | null; template: string; values: Record<string, string> }): string | null {
  const digits = (input.whatsappE164 ?? '').replace(/\D/g, '')
  if (digits.length < 10) return null
  const text = fillTemplate(input.template, input.values)
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
}

/** Fill `{key}` placeholders from the locale. A value is inserted as given; the page and the email escape it. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), template)
}

/** The receipt's date in Mexico City, as the merchant reads it: «6 de noviembre de 2026». */
export function formatReceiptDate(iso: string, locale: 'es' | 'en' = 'es'): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(locale === 'en' ? 'en-US' : 'es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' })
}
