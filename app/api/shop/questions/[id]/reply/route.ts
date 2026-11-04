/**
 * POST /api/shop/questions/<id>/reply — the shop owner answers a buyer's question (business-infrastructure S5, D17).
 * The owner is the caller's own Clerk session; the thread is claimed by id AND owner (`handoff.ts` → `handleReply`).
 */
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { handleReply } from '@/lib/shop-chat/handoff'
import { replyDeps } from '@/lib/shop-chat/handoff-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return NextResponse.json({ ok: false, message: 'JSON only' }, { status: 415 })
  }
  const { userId, getToken } = await auth()
  if (!userId) return NextResponse.json({ ok: false, message: 'Inicia sesión.' }, { status: 401 })
  const { id } = await params
  const result = await handleReply(
    { threadId: id, ownerClerkUserId: userId, body: await req.json().catch(() => null) },
    replyDeps({ clerkUserId: userId, clerkJwt: await getToken() }),
  )
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } })
}
