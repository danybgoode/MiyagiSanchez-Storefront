/**
 * POST /api/sell/shop/domain/subscribe — used to sell the custom domain on its own.
 *
 * The custom domain and Mercado Libre sync are part of NEGOCIO now (epic 08 · plans-gratis-negocio, D5; Daniel,
 * 2026-11-04: "integrate the add-ons into Negocio"), so neither is sold on its own any more. The route stays and
 * answers 410 Gone — never a silent success — so an old client, a bookmarked page or an agent learns where to go, and
 * no Stripe session is created. Merchants who already paid for the standalone item keep it: entitlement still honours
 * their grant or subscription.
 */
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST() {
  return NextResponse.json(
    { ok: false, error: 'Ahora viene incluido en Negocio. Actívalo desde «Tu suscripción».', code: 'INCLUDED_IN_NEGOCIO', href: '/shop/manage/negocio' },
    { status: 410 },
  )
}
