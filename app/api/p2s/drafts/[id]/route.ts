import { NextRequest, NextResponse } from 'next/server'
import { handleEditDraft } from '@/lib/prompt-to-shop/edit'
import { DEVICE_COOKIE } from '@/lib/prompt-to-shop/handler'
import { editDeps } from '@/lib/prompt-to-shop/server'

/**
 * PATCH /api/p2s/drafts/[id] — the canvas's autosave (epic prompt-to-shop S2.4, D15).
 *
 * Body `{ name?, accent_color? }`. The draft is resolved by its id AND the `p2s_device` cookie and nothing else: no
 * query parameter, header or body key can stand in for the cookie, and a view-only link's token is not an
 * ownership proof anywhere in this app. The cookie is SameSite=Lax, so a cross-site page cannot make a browser send
 * it on this PATCH.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  let body: unknown = null
  try {
    body = await req.json()
  } catch {
    body = null
  }
  const result = await handleEditDraft(
    { draftId: id, body, deviceCookie: req.cookies.get(DEVICE_COOKIE)?.value },
    editDeps(),
  )
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'private, no-store' } })
}
