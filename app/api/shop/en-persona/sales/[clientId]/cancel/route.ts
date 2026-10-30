/**
 * POST /api/shop/en-persona/sales/[clientId]/cancel — «Cancelar» on a waiting card QR or an
 * unconfirmed transfer (in-person-sales S2.1, D9). The backend expires the provider checkout
 * FIRST and answers 502 CANCEL_FAILED if it could not, in which case the QR may still be
 * payable and the counter keeps waiting. Returned unchanged.
 */
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { backendFetch, CLIENT_ID_RE } from '@/lib/in-person/counter-backend'

export const dynamic = 'force-dynamic'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params
  if (!CLIENT_ID_RE.test(clientId)) return NextResponse.json({ code: 'INVALID_CLIENT_ID', message: 'Venta no válida.' }, { status: 400 })
  const { userId, getToken } = await auth()
  const jwt = userId ? await getToken() : null
  if (!jwt) return NextResponse.json({ code: 'UNAUTHENTICATED', message: 'Inicia sesión para cancelar la venta.' }, { status: 401 })
  try {
    const res = await backendFetch(`/store/sellers/me/in-person-orders/${clientId.toLowerCase()}/cancel`, { method: 'POST', jwt, body: '{}' })
    return NextResponse.json(await res.json().catch(() => ({ code: 'BAD_UPSTREAM' })), { status: res.status })
  } catch {
    return NextResponse.json({ code: 'CANCEL_FAILED', message: 'No pudimos cancelar el cobro: el QR todavía podría pagarse. Intenta otra vez.' }, { status: 502 })
  }
}
