import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { isEnabled } from '@/lib/flags'
import { decideSatisfaction } from '@/lib/growth-track'
import { sendGrowthSatisfaction } from '@/lib/growth-engine'

// A merchant's answer to "¿Te ayudó…?" (golden-frijoles satisfied-ask), forwarded as Golden Frijoles' standard rating.
// Same shape as ../track: Clerk-authed (the user id is the session's, never the body's), gated by
// growth.telemetry_enabled, and only an allow-listed feature with a 1–5 score or "dismissed" is accepted
// (lib/growth-track.ts → decideSatisfaction).
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
  if (!decision.forward) {
    if (decision.reason === 'flag_off') return NextResponse.json({ skipped: true }, { status: 200 })
    return NextResponse.json({ error: decision.reason }, { status: 400 })
  }
  // Report what happened: an unconfigured client or a refused send is a 502, never a "forwarded" 202 (Codex, #434).
  // The card does not wait on this (it saves satisfaction_answered either way, so a merchant is never re-asked
  // because telemetry was down), but the server log and any caller can tell a lost rating from a delivered one.
  const forwarded = await sendGrowthSatisfaction(decision.userId, decision.featureId, decision.answer)
  if (!forwarded) {
    console.warn(`[growth/satisfaction] rating for ${decision.featureId} did not reach Golden Frijoles`)
    return NextResponse.json({ skipped: false, forwarded: false }, { status: 502 })
  }
  return NextResponse.json({ skipped: false, forwarded: true }, { status: 202 })
}
