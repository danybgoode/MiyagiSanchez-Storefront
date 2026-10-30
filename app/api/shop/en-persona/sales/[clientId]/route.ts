/**
 * GET /api/shop/en-persona/sales/[clientId] — the counter polls this every 3 s while a buyer
 * pays a card QR or until a transfer is confirmed (in-person-sales S2.1, D9). The answer is the
 * backend's, read from Medusa and scoped to the signed-in seller; the browser's own idea of
 * "paid" is never consulted. Backend called directly, never one of our own routes.
 */
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { backendFetch, CLIENT_ID_RE } from '@/lib/in-person/counter-backend'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params
  if (!CLIENT_ID_RE.test(clientId)) return NextResponse.json({ code: 'INVALID_CLIENT_ID', message: 'Venta no válida.' }, { status: 400 })
  const { userId, getToken } = await auth()
  const jwt = userId ? await getToken() : null
  if (!jwt) return NextResponse.json({ code: 'UNAUTHENTICATED', message: 'Inicia sesión para ver la venta.' }, { status: 401 })
  try {
    const res = await backendFetch(`/store/sellers/me/in-person-orders/${clientId.toLowerCase()}`, { jwt })
    return NextResponse.json(await res.json().catch(() => ({ code: 'BAD_UPSTREAM' })), { status: res.status })
  } catch {
    return NextResponse.json({ code: 'BACKEND_UNREACHABLE', message: 'Sin conexión con la tienda.' }, { status: 502 })
  }
}
