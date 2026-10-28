/**
 * GET /api/cron/p2s-nudges — the day 1/3/7 reminders to finish a kept shop (epic prompt-to-shop S5.4).
 *
 * Called daily by the Oracle VM's systemd timer `miyagi-cron-p2s-nudges.timer` (root repo,
 * `infra/oci/systemd/`), through `miyagi-cron@p2s-nudges.service`. Protected by the `x-cron-secret` header
 * against `CRON_SECRET` — the same rule every cron route here uses (`order-autoconfirm`).
 *
 * The order (authorise → read → decide → claim → send) and every rule live in `lib/prompt-to-shop/nudges.ts`.
 * A failed read answers 503, never an empty 200: the timer's log must show a run that could not look, not a run that
 * found nobody.
 */
import { NextRequest, NextResponse } from 'next/server'
import { runNudgeCron } from '@/lib/prompt-to-shop/nudges'
import { nudgeCronDeps } from '@/lib/prompt-to-shop/nudges-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const result = await runNudgeCron(
    {
      secretHeader: req.headers.get('x-cron-secret'),
      secretQuery: req.nextUrl.searchParams.get('secret'),
      cronSecret: process.env.CRON_SECRET,
    },
    nudgeCronDeps(),
  )
  if (result.body.ok) console.info('[p2s] nudges run', JSON.stringify(result.body))
  return NextResponse.json(result.body, { status: result.status })
}
