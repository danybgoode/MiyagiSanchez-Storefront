import { NextRequest, NextResponse } from 'next/server'
import { getClientIp } from '@/lib/ratelimit'
import { DEVICE_COOKIE, DEVICE_COOKIE_MAX_AGE, handleCreateDraft, sseFrame, type DraftsResult } from '@/lib/prompt-to-shop/handler'
import { draftsDeps } from '@/lib/prompt-to-shop/server'

/**
 * POST /api/p2s/drafts — prompt-to-shop's public describe box (epic prompt-to-shop S1.3, D7/D11/D12).
 *
 * Body `{ description, turnstile_token }` makes a new draft; `{ draft_id, turnstile_token[, description] }` makes
 * another version of one this device owns. Accepted → `text/event-stream`: three `block` events, then `done`. Refused
 * → plain JSON with a friendly es-MX `error`, and no model call was made (the order lives in `handleCreateDraft`).
 *
 * Anonymous by design: no Clerk session, no Medusa write. The device cookie is the only identity.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PRIVATE = 'private, no-store'

function withDeviceCookie(res: NextResponse | Response, result: DraftsResult) {
  if (!result.mintedDevice) return res
  const cookie = `${DEVICE_COOKIE}=${result.deviceId}; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`
  res.headers.append('Set-Cookie', cookie)
  return res
}

export async function POST(req: NextRequest) {
  let body: unknown = null
  try {
    body = await req.json()
  } catch {
    body = null
  }

  const result = await handleCreateDraft(
    { body, deviceCookie: req.cookies.get(DEVICE_COOKIE)?.value },
    draftsDeps(getClientIp(req)),
  )

  if (result.kind === 'refuse') {
    const res = NextResponse.json({ error: result.message, code: result.error }, { status: result.status, headers: { 'Cache-Control': PRIVATE } })
    return withDeviceCookie(res, result)
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await result.run((event, data) => controller.enqueue(encoder.encode(sseFrame(event, data))))
      controller.close()
    },
  })
  const res = new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': PRIVATE,
      // Caddy and any proxy in front must pass each frame through as it is written.
      'X-Accel-Buffering': 'no',
      'X-P2S-Draft': result.draftId,
    },
  })
  return withDeviceCookie(res, result)
}
