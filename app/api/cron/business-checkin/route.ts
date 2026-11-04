/**
 * GET /api/cron/business-checkin — the monthly «Tu plan» check-in (business-infrastructure S3.4, D12).
 *
 * Called daily by the Oracle VM's systemd timer `miyagi-cron-business-checkin.timer` (root repo,
 * `infra/oci/systemd/`) through `miyagi-cron@business-checkin.service`. Sends at most once per merchant per month, in
 * the month's first week (`checkin.ts`). Protected by the `x-cron-secret` header against `CRON_SECRET`, constant-time;
 * a `?secret=` query is NOT accepted (it would land in access logs). A failed read answers 503, never an empty 200.
 */
import { NextRequest, NextResponse } from 'next/server'
import { runCheckinCron } from '@/lib/business-plan/checkin'
import { checkinDeps } from '@/lib/business-plan/checkin-server'
import { cronSecretMatches } from '@/lib/prompt-to-shop/nudges'
import { purgeAnsweredEmails } from '@/lib/shop-chat/handoff-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const result = await runCheckinCron(
    { authorised: cronSecretMatches(req.headers.get('x-cron-secret'), process.env.CRON_SECRET) },
    checkinDeps(),
  )
  if (result.body.ok) console.info('[business-checkin] run', JSON.stringify(result.body))
  // The same daily run keeps the shop-chat handoff's promise: a buyer's email is gone 90 days after the answer (S5).
  if (result.status !== 401) {
    const purged = await purgeAnsweredEmails()
    console.info('[shop-chat] purge', JSON.stringify({ purged }))
  }
  return NextResponse.json(result.body, { status: result.status })
}
