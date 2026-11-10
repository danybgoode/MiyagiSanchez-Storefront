/**
 * POST /api/sell/shop/subdomain/switch — used to switch a subdomain subscription between monthly and yearly.
 *
 * The subdomain is FREE on every plan (epic 08 · plans-gratis-negocio S2.4, README D11; Daniel, 2026-11-04), so
 * nothing sells it. The route stays and answers 410 Gone — not a silent success — so an old client, a bookmarked page
 * or an agent learns it, and no Stripe session is ever created. Existing subscriptions are ended at period end by
 * `scripts/cancel-subdomain-subscriptions.ts` (decision b).
 */
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST() {
  return NextResponse.json(
    { ok: false, error: 'El subdominio ahora es gratis en todos los planes. No hay nada que pagar.', code: 'SUBDOMAIN_FREE' },
    { status: 410 },
  )
}
