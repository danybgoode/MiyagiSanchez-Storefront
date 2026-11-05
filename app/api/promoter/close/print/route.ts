/**
 * POST /api/promoter/close/print — used to let a promoter sell a printed-ad placement on a merchant's behalf.
 *
 * Retired (Daniel, 2026-11-05: "we are not selling any printed ads whatsoever"). The route stays and answers 410 Gone,
 * never a silent success, so an old client or an agent learns it is gone and no payment is started. Placements already
 * bought keep their flow in /admin/print.
 */
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST() {
  return NextResponse.json({ ok: false, error: 'Ya no vendemos anuncios impresos.', code: 'PRINT_ADS_RETIRED' }, { status: 410 })
}
