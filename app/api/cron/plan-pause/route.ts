/**
 * GET /api/cron/plan-pause — pause the shops whose free months ended without a plan (epic 08 ·
 * plan-tienda-three-free-months S3.3, README D9).
 *
 *   GET /api/cron/plan-pause             → a DRY RUN: reads and decides, writes NOTHING (no claim, no Backend write),
 *                                          and returns the list of shops it WOULD pause. Run this first, and read it.
 *   GET /api/cron/plan-pause?dry_run=0   → the ONLY live form: pauses them. This is what the timer must call.
 *
 * A dry run is the default (verifier S1b): a bare curl by a person reading the docs must never pause a shop.
 *
 * Authorised like the other VM-timer crons (`business-checkin`): the `x-cron-secret` header against `CRON_SECRET`,
 * constant-time; a `?secret=` query is NOT accepted (it would land in access logs), and a missing secret refuses
 * everyone. The timer `miyagi-cron-plan-pause.timer` is NOT part of this change: Daniel enables it by hand after a
 * dry run he has read (the epic's deploy order, step 4). A failed shop read answers 503, never an empty 200.
 *
 * Every decision is in `lib/plan-pause.ts` (validate → claim → apply); the I/O is `lib/plan-pause-server.ts`.
 */
import { NextRequest, NextResponse } from 'next/server'
import { cronSecretMatches } from '@/lib/prompt-to-shop/nudges'
import { runPlanPause } from '@/lib/plan-pause'
import { planPauseDeps } from '@/lib/plan-pause-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// A pause unlinks a catalog through the Backend (up to 30 s each); a handful of shops must not hit the default.
export const maxDuration = 300

export async function GET(req: NextRequest) {
  if (!cronSecretMatches(req.headers.get('x-cron-secret'), process.env.CRON_SECRET)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  // Live ONLY on an explicit `dry_run=0`. No parameter, or any other value (`dry_run=false`, a typo), is a dry run.
  const dryRun = req.nextUrl.searchParams.get('dry_run') !== '0'
  const result = await runPlanPause(planPauseDeps(), { dryRun })
  console.info('[plan-pause] run', JSON.stringify(result))
  // 409 when the legacy marking has not run (the run refused on purpose); 503 when the shops could not be read.
  return NextResponse.json(result, { status: result.ok ? 200 : result.error === 'legacy_marker_missing' ? 409 : 503 })
}
