/**
 * POST /api/shop-chat/<slug>/message — a buyer leaves the question the shop's chat could not answer
 * (business-infrastructure S5, D17). Rules and order in `lib/shop-chat/handoff.ts`; this is the I/O shell.
 * JSON only. Requires the conversation token the chat issued after its human check.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getClientIp } from '@/lib/ratelimit'
import { handleLeave } from '@/lib/shop-chat/handoff'
import { leaveDeps } from '@/lib/shop-chat/handoff-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return NextResponse.json({ ok: false, message: 'JSON only' }, { status: 415 })
  }
  const { slug } = await params
  const result = await handleLeave({ slug, body: await req.json().catch(() => null) }, leaveDeps(getClientIp(req)))
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } })
}
