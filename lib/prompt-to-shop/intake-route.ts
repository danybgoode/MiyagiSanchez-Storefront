/**
 * The three intake routes' shared shell (epic one-front-door-both-markets D6–D8): read the device cookie (minting
 * one, as the describe box's drafts route does, so the photo's allowance and the draft that follows share ONE
 * device), run the handler, answer JSON with `private, no-store`.
 */

import 'server-only'
import { randomUUID } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { DEVICE_COOKIE, DEVICE_COOKIE_MAX_AGE, readDeviceId } from './handler'
import type { IntakeOutcome } from './intake-handler'

export function intakeDevice(req: NextRequest): { deviceId: string; minted: boolean } {
  const existing = readDeviceId(req.cookies.get(DEVICE_COOKIE)?.value)
  return existing ? { deviceId: existing, minted: false } : { deviceId: randomUUID(), minted: true }
}

export function intakeResponse(outcome: IntakeOutcome, device: { deviceId: string; minted: boolean }): NextResponse {
  const res = NextResponse.json(outcome.body, { status: outcome.status, headers: { 'Cache-Control': 'private, no-store' } })
  if (device.minted) {
    res.headers.append('Set-Cookie', `${DEVICE_COOKIE}=${device.deviceId}; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`)
  }
  return res
}

/** One uploaded file from a multipart body, or null. The size cap is the handler's; this only refuses absurd bodies. */
export async function readUpload(req: NextRequest): Promise<{ form: FormData; file: { bytes: Uint8Array; mime: string; name: string } | null } | null> {
  const len = Number(req.headers.get('content-length') ?? '0')
  if (len > 12 * 1024 * 1024) return null
  const form = await req.formData().catch(() => null)
  if (!form) return null
  const f = form.get('file')
  if (!f || typeof f === 'string') return { form, file: null }
  return { form, file: { bytes: new Uint8Array(await f.arrayBuffer()), mime: f.type, name: f.name } }
}
