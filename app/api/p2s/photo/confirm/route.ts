import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { confirmPhoto } from '@/lib/prompt-to-shop/photo'
import { confirmDeps, photoHosts } from '@/lib/prompt-to-shop/photo-server'
import { PHOTO_COPY } from '@/lib/prompt-to-shop/copy'

/**
 * POST /api/p2s/photo/confirm — one confirmed card → ONE Medusa draft product, one monthly photo (epic S4.2, D4).
 *
 * Body `{ nonce, image_url, card: { title, description, category, price }, replace?: { index, title } }`. The nonce
 * is minted per suggestion by the browser; a repeat with the same nonce (a double tap, a retry) creates nothing new.
 * Order — validate → owner → reserve → spend (fails closed) → create → finish — lives in `confirmPhoto`.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function POST(req: NextRequest) {
  const { userId, getToken } = await auth()
  const clerkJwt = userId ? await getToken() : null
  if (!userId || !clerkJwt) return NextResponse.json({ ok: false, error: PHOTO_COPY.signedOut, code: 'signed_out' }, { status: 401, headers: NO_STORE })
  const body = await req.json().catch(() => null)
  const outcome = await confirmPhoto({ userId, body, hosts: photoHosts() }, confirmDeps(userId, clerkJwt))
  return NextResponse.json(outcome.body, { status: outcome.status, headers: NO_STORE })
}
