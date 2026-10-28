import { NextResponse } from 'next/server'
import QRCode from 'qrcode'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { shopQrPlan } from '@/lib/share-link'

/**
 * GET /api/sell/shop/qr — a PNG QR code for the current seller's own shop (prompt-to-shop S5.2, the shares after
 * «Publicar»).
 *
 * Seller-scoped exactly like its sibling `/api/sell/shop/story-image`: the shop is read from the caller's Clerk
 * session, never from a slug param. The code points at the shop's short branded link (`mschz.org/<slug>`, which the
 * short-link host 301s to the shop page) — the same short form the launchpad and sweepstakes QR codes print.
 */

export const dynamic = 'force-dynamic'

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'No autenticado.' }, { status: 401 })

  const { data: shop } = await db
    .from('marketplace_shops')
    .select('slug')
    .eq('clerk_user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  // Validated before it reaches the QR or a header: a slug outside the shop-slug charset is not encoded at all.
  const plan = shopQrPlan(shop?.slug)
  if (!plan) return NextResponse.json({ error: 'Tienda no encontrada.' }, { status: 404 })

  const png = await QRCode.toBuffer(plan.url, {
    errorCorrectionLevel: 'H', type: 'png', margin: 2, scale: 10,
    color: { dark: '#000000ff', light: '#ffffffff' },
  })

  return new NextResponse(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="${plan.filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
