import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { freeEventPriceBlock } from '@/lib/seller-products'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const PUB_KEY = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

/**
 * POST /api/sell/profit/apply-price — proxies the one-click Apply write
 * (Sprint 2 · US-5) to the backend, which owns ownership verification, the
 * Miyagi price write, the conditional ML push, and the activity log. This
 * route only authenticates the seller and forwards the backend's honest
 * partial-state response verbatim (miyagi: ok|failed, ml: ok|failed|skipped).
 */
export async function POST(req: NextRequest) {
  const { userId, getToken } = await auth()
  if (!userId) return NextResponse.json({ error: 'No autenticado.' }, { status: 401 })

  let body: {
    product_id?: string
    variant_id?: string
    new_price_cents?: number
    target_margin_pct?: number
  }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Datos inválidos.' }, { status: 400 }) }

  if (!body.product_id || !body.variant_id || !Number.isInteger(body.new_price_cents) || (body.new_price_cents ?? 0) <= 0) {
    return NextResponse.json({ error: 'Faltan datos para aplicar el precio.' }, { status: 422 })
  }

  const clerkJwt = await getToken()
  if (!clerkJwt) return NextResponse.json({ error: 'Error de autenticación.' }, { status: 401 })

  // A free Evento stays free: refuse before the backend writes the price.
  const priceRefusal = await freeEventPriceBlock(body.product_id, body.new_price_cents as number)
  if (priceRefusal) return NextResponse.json({ error: priceRefusal, field: 'price' }, { status: 422 })

  const res = await fetch(`${MEDUSA_BASE}/store/sellers/me/profit/apply-price`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-publishable-api-key': PUB_KEY,
      Authorization: `Bearer ${clerkJwt}`,
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  })

  const d = await res.json().catch(() => ({}))
  if (res.status === 403) return NextResponse.json({ error: 'No tienes permiso para modificar este anuncio.' }, { status: 403 })
  if (res.status === 404) return NextResponse.json({ error: 'No disponible.' }, { status: 404 })
  if (res.status === 422) return NextResponse.json({ error: d.message ?? 'Datos inválidos.' }, { status: 422 })
  if (!res.ok) return NextResponse.json({ error: d.message ?? 'Error al aplicar el precio.' }, { status: 500 })

  // Success from the backend's point of view means the MIYAGI write landed —
  // ML may still report 'failed'/'skipped' inside `d`; forward it as-is so
  // the UI can render the honest partial state.
  return NextResponse.json(d)
}
