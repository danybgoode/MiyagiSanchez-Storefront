import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { isEnabled } from '@/lib/flags'
import { db } from '@/lib/supabase'
import { decideSatisfaction, satisfactionAnswered, withSatisfactionAnswered } from '@/lib/growth-track'
import { sendGrowthSatisfaction } from '@/lib/growth-engine'

// A merchant's answer to "¿Te ayudó la guía?" (golden-frijoles satisfied-ask), forwarded as Golden Frijoles' standard
// rating. Same shape as ../track: Clerk-authed (the user id is the session's, never the body's), gated by
// growth.telemetry_enabled, and only an allow-listed feature with a 1–5 score or "dismissed" is accepted
// (lib/growth-track.ts → decideSatisfaction).
//
// "Asked once" is a SERVER fact here, not a client convention (pr-reviewer + Vibe, #434): the caller's own shop row
// is claimed with `metadata.settings.guide.satisfaction_answered` BEFORE anything is forwarded, by a conditional
// update that only matches while the flag is unset — so a repeat POST, a double tap or a second tab gets 409 and
// sends nothing, and a signed-in user with no shop cannot rate the setup guide at all. The claim is made even with
// telemetry off: it is the merchant's UI state, and without it they would be re-asked on every visit.
export async function POST(req: NextRequest) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const { featureId, answer } = (body ?? {}) as Record<string, unknown>

  const decision = decideSatisfaction(await isEnabled('growth.telemetry_enabled'), {
    userId: user.id,
    featureId,
    answer,
  })
  if (!decision.forward && decision.reason !== 'flag_off') {
    return NextResponse.json({ error: decision.reason }, { status: 400 })
  }

  const { data: shop, error: shopErr } = await db
    .from('marketplace_shops')
    .select('id, metadata')
    .eq('clerk_user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (shopErr) return NextResponse.json({ error: 'shop_lookup_failed' }, { status: 500 })
  if (!shop) return NextResponse.json({ error: 'no_shop' }, { status: 404 })
  if (satisfactionAnswered(shop.metadata)) return NextResponse.json({ error: 'already_answered' }, { status: 409 })

  const { data: claimed, error: claimErr } = await db
    .from('marketplace_shops')
    .update({ metadata: withSatisfactionAnswered(shop.metadata) })
    .eq('id', shop.id)
    .is('metadata->settings->guide->>satisfaction_answered', null)
    .select('id')
  if (claimErr) return NextResponse.json({ error: 'claim_failed' }, { status: 500 })
  if (!claimed || claimed.length === 0) return NextResponse.json({ error: 'already_answered' }, { status: 409 })

  if (!decision.forward) return NextResponse.json({ skipped: true }, { status: 200 })

  // Report what happened: an unconfigured client or a refused send is a 502, never a "forwarded" 202 (Codex, #434).
  const forwarded = await sendGrowthSatisfaction(decision.userId, decision.featureId, decision.answer)
  if (!forwarded) {
    console.warn(`[growth/satisfaction] rating for ${decision.featureId} did not reach Golden Frijoles`)
    return NextResponse.json({ skipped: false, forwarded: false }, { status: 502 })
  }
  return NextResponse.json({ skipped: false, forwarded: true }, { status: 202 })
}
