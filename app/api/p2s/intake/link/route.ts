import { NextRequest } from 'next/server'
import { getClientIp } from '@/lib/ratelimit'
import { handleLinkIntake } from '@/lib/prompt-to-shop/intake-handler'
import { intakeDeps } from '@/lib/prompt-to-shop/intake-server'
import { intakeDevice, intakeResponse } from '@/lib/prompt-to-shop/intake-route'
import { readCappedBody } from '@/lib/prompt-to-shop/intake'

/**
 * POST /api/p2s/intake/link — start a shop from the merchant's existing store link (D8).
 * JSON `{ url, turnstile_token, locale, market_hint }`. The order and every refusal live in `handleLinkIntake`.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const device = intakeDevice(req)
  // A link request is a few hundred bytes; read at most 16 KB, counting as it streams (Codex security, PR #498).
  const raw = await readCappedBody(req.body, req.headers.get('content-length'), 16 * 1024).catch(() => null)
  let body: Record<string, unknown> | null = null
  try { body = raw ? (JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>) : null } catch { body = null }
  const outcome = await handleLinkIntake(
    { url: body?.url, locale: body?.locale, marketHint: body?.market_hint, turnstileToken: body?.turnstile_token, deviceId: device.deviceId },
    intakeDeps(getClientIp(req)),
  )
  return intakeResponse(outcome, device)
}
