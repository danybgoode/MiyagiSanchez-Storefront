/**
 * GET /api/promoter/rate-card — used to serve the printed-ad rate card PDF to promoters.
 *
 * Retired with the printed ad (Daniel, 2026-11-05). 410 Gone, so a saved link learns it is gone; the promoter's prices
 * are on the quick guide (/mx/vende/promotor/sell-sheet).
 */
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ ok: false, error: 'Ya no vendemos anuncios impresos.', code: 'PRINT_ADS_RETIRED', href: '/mx/vende/promotor/sell-sheet' }, { status: 410 })
}
