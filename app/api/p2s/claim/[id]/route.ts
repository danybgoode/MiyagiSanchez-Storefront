import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { claimAndApply, type ClaimOutcome } from '@/lib/prompt-to-shop/claim'
import { claimDeps } from '@/lib/prompt-to-shop/claim-server'
import { DEVICE_COOKIE } from '@/lib/prompt-to-shop/handler'
import { readCappedBody } from '@/lib/prompt-to-shop/intake'

/**
 * POST /api/p2s/claim/[id] — keep a draft: claim it, then make it the signed-in user's shop (epic S3.2, D16).
 *
 * Called by the browser from `/sell/armar` (a route handler, not the page render, because the apply busts the shop
 * cache and `revalidateTag` is not allowed during a render). The draft is identified by the path id; ownership is
 * the `p2s_device` cookie and the Clerk session, and nothing in a query string, header or body stands in for either.
 * The whole decision — and its order — lives in `claimAndApply`.
 *
 * Not under `/api/p2s/drafts/…` on purpose: `e2e/portfolio-no-auto-send.spec.ts` treats every `app/api/<…>/draft*`
 * route as a Merchant Partner message draft that must never reach a transport, and this route legitimately sends
 * email (the shop welcome / the requested link). Its own ownership rule is the device cookie, held in its own specs.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STATUS: Record<ClaimOutcome['kind'], number> = {
  kept: 200,
  other_phone: 404,
  has_shop: 409,
  incomplete: 409,
  signed_out: 401,
  market_required: 400,
  retry: 503,
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { userId, getToken } = await auth()
  const clerkJwt = userId ? await getToken() : null
  if (!userId || !clerkJwt) {
    return NextResponse.json({ kind: 'signed_out' } satisfies ClaimOutcome, { status: STATUS.signed_out, headers: { 'Cache-Control': 'private, no-store' } })
  }
  // D13 — the merchant's chosen market rides in a tiny JSON body, read only after the session is known and capped
  // while it streams (Codex security, PR #499); anything unreadable is "no choice", never a guess.
  const raw = await readCappedBody(req.body, req.headers.get('content-length'), 2048).catch(() => null)
  let body: { market?: unknown; locale?: unknown } | null = null
  try { body = raw ? JSON.parse(new TextDecoder().decode(raw)) : null } catch { body = null }
  const outcome: ClaimOutcome = await claimAndApply(
        { draftId: id, deviceCookie: req.cookies.get(DEVICE_COOKIE)?.value, userId, market: body?.market, locale: body?.locale },
        claimDeps(userId, clerkJwt),
      )
  return NextResponse.json(outcome, { status: STATUS[outcome.kind], headers: { 'Cache-Control': 'private, no-store' } })
}
