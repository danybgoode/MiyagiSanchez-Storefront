/**
 * POST /api/shop-chat/<slug> — a buyer asks the shop a question (business-infrastructure S4, D13/D14).
 * The order and every rule live in `lib/shop-chat/handler.ts`; this is the I/O shell.
 *
 * Body: `{ messages: [{role, text}], turnstile_token?, chat_token? }`. JSON only (a cross-site form cannot reach it).
 * Answers `{ answer, answered, chat_token }`; `answered: false` is the widget's cue to offer "leave your question".
 * Not cached: every answer is per conversation.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getClientIp } from '@/lib/ratelimit'
import { handleShopChat } from '@/lib/shop-chat/handler'
import { chatDeps } from '@/lib/shop-chat/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return NextResponse.json({ error: 'JSON only', code: 'invalid' }, { status: 415 })
  }
  const { slug } = await params
  const body = await req.json().catch(() => null)
  const result = await handleShopChat({ slug, body }, chatDeps(getClientIp(req)))
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } })
}
