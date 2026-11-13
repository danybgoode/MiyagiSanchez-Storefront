import { NextRequest, NextResponse } from 'next/server'
import { getClientIp } from '@/lib/ratelimit'
import { auth } from '@clerk/nextjs/server'
import { handlePhotoIntake } from '@/lib/prompt-to-shop/intake-handler'
import { intakeDeps } from '@/lib/prompt-to-shop/intake-server'
import { intakeDevice, intakeResponse, readUpload } from '@/lib/prompt-to-shop/intake-route'

/**
 * POST /api/p2s/intake/photo — start a shop from one photo, signed out (D6).
 * Multipart: `file`, `turnstile_token`, `locale`, `market_hint`. The order and every refusal live in `handlePhotoIntake`.
 * Anonymous by design, like the describe box: the device cookie is the only identity.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const device = intakeDevice(req)
  const upload = await readUpload(req)
  if (!upload) return NextResponse.json({ ok: false, code: 'invalid' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
  const { form, file } = upload
  const outcome = await handlePhotoIntake(
    { file, locale: form.get('locale'), marketHint: form.get('market_hint'), turnstileToken: form.get('turnstile_token'), deviceId: device.deviceId, userId: (await auth()).userId },
    intakeDeps(getClientIp(req)),
  )
  return intakeResponse(outcome, device)
}
