import { NextRequest } from 'next/server'
import { getClientIp } from '@/lib/ratelimit'
import { handleLinkIntake } from '@/lib/prompt-to-shop/intake-handler'
import { intakeDeps } from '@/lib/prompt-to-shop/intake-server'
import { intakeDevice, intakeResponse } from '@/lib/prompt-to-shop/intake-route'

/**
 * POST /api/p2s/intake/link — start a shop from the merchant's existing store link (D8).
 * JSON `{ url, turnstile_token, locale, market_hint }`. The order and every refusal live in `handleLinkIntake`.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const device = intakeDevice(req)
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const outcome = await handleLinkIntake(
    { url: body?.url, locale: body?.locale, marketHint: body?.market_hint, turnstileToken: body?.turnstile_token, deviceId: device.deviceId },
    intakeDeps(getClientIp(req)),
  )
  return intakeResponse(outcome, device)
}
