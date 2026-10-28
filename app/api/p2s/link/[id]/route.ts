import { NextRequest, NextResponse } from 'next/server'
import { sendP2sDraftLink } from '@/lib/email'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { DEVICE_COOKIE } from '@/lib/prompt-to-shop/handler'
import { handleMailLink } from '@/lib/prompt-to-shop/mail-link'
import { readDeps } from '@/lib/prompt-to-shop/read'

/**
 * POST /api/p2s/link/[id] — «Mándame el enlace» (epic prompt-to-shop S3.1).
 *
 * Body `{ email }`. The draft is resolved by its id AND the `p2s_device` cookie (D15) — the same ownership read the
 * canvas page uses — so only the phone that made a draft can mail its links. The decision and its order live in
 * `handleMailLink`.
 *
 * Not under `/api/p2s/drafts/…` on purpose: `e2e/portfolio-no-auto-send.spec.ts` treats every `app/api/<…>/draft*`
 * route as a Merchant Partner message draft that must never reach a transport, and this route legitimately sends
 * email (the shop welcome / the requested link). Its own ownership rule is the device cookie, held in its own specs.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  let body: unknown = null
  try {
    body = await req.json()
  } catch {
    body = null
  }
  const ip = getClientIp(req)
  const result = await handleMailLink(
    { draftId: id, body, deviceCookie: req.cookies.get(DEVICE_COOKIE)?.value },
    {
      allowed: async (deviceId) => {
        const [byIp, byDevice] = await Promise.all([
          checkRateLimit('p2s_mail_link', ip),
          deviceId ? checkRateLimit('p2s_mail_link_device', deviceId) : Promise.resolve({ allowed: true as const }),
        ])
        return byIp.allowed && byDevice.allowed
      },
      findOwned: readDeps.findOwned,
      send: async (mail) => {
        const sent = await sendP2sDraftLink(mail)
        if (!sent.ok) console.error('[p2s] draft link email failed', sent.reason)
        return sent.ok
      },
    },
  )
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'private, no-store' } })
}
