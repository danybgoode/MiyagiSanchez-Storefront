/**
 * POST /api/promoter/attribute  — record an enrollment against a promoter.
 *
 * Called when an enrolling seller applies a promoter code at a paid-SKU checkout
 * (Sprint 1 — the code-applied/enrollment event; no order exists yet). Reads the
 * code from the body or the `promo` cookie (set by middleware from the share link),
 * resolves the promoter + the seller's shop, writes one idempotent attribution row,
 * then always clears the cookie. Sprint 2's real charge fills in amount + cadence.
 *
 * Gated by `promoter.enabled` (default off) — 404 when the program is hidden.
 */
import { isPackageSku, isShareSku } from '@/lib/promoter-packages'
import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { currentUser } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { isEnabled } from '@/lib/flags'
import { getPromoterByCode, recordAttribution, isPromoterSku } from '@/lib/promoter'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (!(await isEnabled('promoter.enabled'))) {
    return NextResponse.json({ ok: false }, { status: 404 })
  }

  const user = await currentUser().catch(() => null)
  if (!user) return NextResponse.json({ ok: false, error: 'No autorizado' }, { status: 401 })

  let body: { code?: string; sku?: string } = {}
  try { body = await req.json() } catch { /* allow cookie-only enrollment */ }

  const cookieStore = await cookies()
  const code = (body.code ?? cookieStore.get('promo')?.value ?? '').trim()
  const sku = body.sku ?? 'custom_domain'

  // Nothing actionable (no code / unknown code / no shop / transient error) → leave
  // the 30-day promo cookie intact so a valid code survives for a later retry. Only
  // a FRESH successful enrollment burns it (one enrollment per share link).
  // Packages and the shares after the sale (renewals, the upgrade) are recorded only by the server when money arrives;
  // a seller must not be able to pre-create one (it would move a renewal or upgrade window) — pr-reviewer #474.
  if (!code || !isPromoterSku(sku) || isPackageSku(sku) || isShareSku(sku)) return NextResponse.json({ ok: true, attributed: false })

  const promoter = await getPromoterByCode(code)
  if (!promoter) return NextResponse.json({ ok: true, attributed: false })

  // The enrolling seller's own shop is the attribution target.
  const { data: shop } = await db
    .from('marketplace_shops')
    .select('id')
    .eq('clerk_user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  const result = shop?.id
    ? await recordAttribution({ promoterId: promoter.id, sellerId: shop.id, sku })
    : 'skipped'

  const res = NextResponse.json({ ok: true, attributed: result === 'recorded' })
  if (result === 'recorded') res.cookies.set('promo', '', { maxAge: 0, path: '/' })
  return res
}
