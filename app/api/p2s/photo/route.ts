import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { analyzePhoto } from '@/lib/prompt-to-shop/photo'
import { analyzeDeps, photoHosts } from '@/lib/prompt-to-shop/photo-server'
import { PHOTO_COPY } from '@/lib/prompt-to-shop/copy'

/**
 * POST /api/p2s/photo — the merchant's uploaded photo → one product card suggestion (epic prompt-to-shop S4.2).
 *
 * Body `{ image_url }`: a URL `/api/sell/upload` returned for THIS user, on our own storage host (anything else is
 * refused before any fetch). Writes nothing and spends nothing — the monthly photo is spent at confirm
 * (`/api/p2s/photo/confirm`). The order and every refusal live in `analyzePhoto`.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function POST(req: NextRequest) {
  const { userId, getToken } = await auth()
  const clerkJwt = userId ? await getToken() : null
  if (!userId || !clerkJwt) return NextResponse.json({ ok: false, error: PHOTO_COPY.signedOut, code: 'signed_out' }, { status: 401, headers: NO_STORE })
  const body = await req.json().catch(() => null)
  const outcome = await analyzePhoto({ userId, body, hosts: photoHosts() }, analyzeDeps(userId, clerkJwt))
  return NextResponse.json(outcome.body, { status: outcome.status, headers: NO_STORE })
}
