/**
 * POST /api/promoter/report — a field promoter's «Reportar» (merchant-features-surfaced-by-promoter-kit D9).
 *
 * What a merchant asked for, or what broke, lands in `platform_feedback` with author_kind 'promoter' so it is counted
 * in one place (/admin/feedback) instead of dying in WhatsApp. Same gates as the rest of the promoter panel: the
 * `promoter.enabled` flag and a Clerk session bound to a PRM- code. The author comes from that session, never the body.
 */
import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { isEnabled } from '@/lib/flags'
import { getPromoterByClerkId } from '@/lib/promoter'
import { promoterFeedbackRow, validatePromoterReport } from '@/lib/feedback'
import { tg } from '@/lib/telegram'
import { checkRateLimit } from '@/lib/ratelimit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (!(await isEnabled('promoter.enabled'))) return NextResponse.json({ ok: false }, { status: 404 })

  const user = await currentUser().catch(() => null)
  if (!user) return NextResponse.json({ ok: false, error: 'No autorizado' }, { status: 401 })

  const promoter = await getPromoterByClerkId(user.id)
  if (!promoter) return NextResponse.json({ ok: false, error: 'Vincula tu código de promotor primero.' }, { status: 403 })

  // Per promoter, not per IP: one field promoter on shared mobile data must not be blocked by another's reports.
  const rl = await checkRateLimit('relationship', `promoter-report:${promoter.id}`)
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: 'Has enviado muchos reportes en poco tiempo. Intenta de nuevo en unos minutos.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  let body: Record<string, unknown> | null = null
  try { body = await req.json() } catch { /* empty body → validation says why */ }
  const report = validatePromoterReport(body)
  if (!report.ok) return NextResponse.json({ ok: false, error: report.error }, { status: 400 })

  const row = promoterFeedbackRow(promoter, report)
  // `.select()` back: supabase-js reports no error for a write that matched nothing, so success is a row, not "no error".
  const { data, error } = await db.from('platform_feedback').insert(row).select('id')
  if (error || !data?.length) {
    console.error('[promoter/report] insert failed:', error?.message ?? 'no row returned')
    return NextResponse.json({ ok: false, error: 'No se pudo enviar. Intenta de nuevo.' }, { status: 500 })
  }

  // The report is saved: a Telegram rejection must never turn it into an error the promoter retries (duplicate rows).
  try {
    await tg.feedbackFiled(row.author_label, row.author_kind, row.category, null, row.message)
  } catch (err) {
    console.error('[promoter/report] telegram notify failed:', err instanceof Error ? err.message : err)
  }
  return NextResponse.json({ ok: true })
}
