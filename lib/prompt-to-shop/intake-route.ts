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
import { readCappedBody } from './intake'

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

/** The whole multipart body a signed-out intake may send: an 8 MB photo or a 5 MB file, plus the form's own bytes. */
const UPLOAD_BODY_MAX = 9 * 1024 * 1024

/**
 * One uploaded file from a multipart body, or null. The body is read through `readCappedBody`, counting AS IT READS
 * (Codex, PR #498): `req.formData()` alone buffers whatever a stranger sends — a missing or understated
 * `Content-Length` is no limit. The handler then applies the per-kind cap.
 */
export async function readUpload(req: NextRequest): Promise<{ form: FormData; file: { bytes: Uint8Array; mime: string; name: string } | null } | null> {
  const bytes = await readCappedBody(req.body, req.headers.get('content-length'), UPLOAD_BODY_MAX).catch(() => null)
  if (!bytes) return null
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes)
  const form = await new Response(copy.buffer, { headers: { 'content-type': req.headers.get('content-type') ?? '' } }).formData().catch(() => null)
  if (!form) return null
  const f = form.get('file')
  if (!f || typeof f === 'string') return { form, file: null }
  return { form, file: { bytes: new Uint8Array(await f.arrayBuffer()), mime: f.type, name: f.name } }
}
