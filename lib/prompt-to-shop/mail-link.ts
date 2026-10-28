/**
 * Prompt-to-shop — «Mándame el enlace» (epic S3.1).
 *
 * The merchant who is not ready to sign up gets their shop's links by email. Two links, because they are different
 * powers (D15): the owner link (`/p2s/<id>`) opens the canvas — and «Quedármela» — only on the phone that made the
 * draft, since ownership is that phone's cookie; the view-only link works anywhere and changes nothing. The email
 * says so in plain words, so a merchant who opens it on a laptop is not surprised.
 *
 * Order: validate (pure) → rate limit → resolve ownership by id + device cookie → send. A malformed address, a spent
 * limit or a draft this phone does not own sends nothing. The limit may fail open (it is a burst guard on an email
 * that only reaches an address the requester typed, about a shop that Turnstile already gated); ownership may not.
 *
 * Pure: the limiter, the draft read and the sender are injected.
 */

import { normalizedClaimEmail } from '../claim-invitation'
import { resolveOwnerPage, shareHrefFor, type ReadDeps } from './access'
import { MAIL_LINK_COPY } from './copy'
import { readDeviceId } from './handler'

export interface MailLinkDeps {
  /** Burst limits: per IP, and per device when there is one (null = no valid device cookie). */
  allowed: (deviceId: string | null) => Promise<boolean>
  findOwned: ReadDeps['findOwned']
  send: (ctx: { to: string; shopName: string; draftId: string; sharePath: string }) => Promise<boolean>
}

export type MailLinkResult = { status: number; body: { ok: true; message: string } | { ok: false; error: keyof typeof MAIL_LINK_COPY; message: string } }

const refuse = (status: number, error: Exclude<keyof typeof MAIL_LINK_COPY, 'sent'>): MailLinkResult => ({
  status,
  body: { ok: false, error, message: MAIL_LINK_COPY[error] },
})

export async function handleMailLink(
  input: { draftId: string; body: unknown; deviceCookie: string | null | undefined },
  deps: MailLinkDeps,
): Promise<MailLinkResult> {
  const raw = input.body && typeof input.body === 'object' ? (input.body as Record<string, unknown>).email : undefined
  const to = normalizedClaimEmail(raw)
  if (!to) return refuse(400, 'invalid')

  if (!(await deps.allowed(readDeviceId(input.deviceCookie)))) return refuse(429, 'limited')

  const owned = await resolveOwnerPage({ id: input.draftId, deviceCookie: input.deviceCookie }, deps)
  if (owned.kind === 'gone') return refuse(404, 'gone')

  const sent = await deps.send({
    to,
    shopName: owned.blocks.identity?.name ?? 'Tu tienda',
    draftId: owned.access.draftId,
    sharePath: shareHrefFor(owned),
  })
  if (!sent) return refuse(503, 'failed')
  return { status: 200, body: { ok: true, message: MAIL_LINK_COPY.sent } }
}
