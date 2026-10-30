/**
 * POST /api/shop/cobros/links/[id]/cancel — cancel one of the signed-in seller's payment links
 * (in-person-sales S4.3). Pass-through to the backend, which scopes it to the seller.
 */
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { backendFetch } from '@/lib/in-person/counter-backend'

export const dynamic = 'force-dynamic'
const ID = /^[A-Za-z0-9_-]{1,64}$/

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!ID.test(id)) return NextResponse.json({ code: 'LINK_NOT_FOUND', message: 'No encontramos ese cobro.' }, { status: 404 })
  const { userId, getToken } = await auth()
  const jwt = userId ? await getToken() : null
  if (!jwt) return NextResponse.json({ code: 'UNAUTHENTICATED', message: 'Inicia sesión para cancelar el cobro.' }, { status: 401 })
  try {
    const res = await backendFetch(`/store/sellers/me/payment-links/${id}/cancel`, { method: 'POST', jwt, body: '{}' })
    return NextResponse.json(await res.json().catch(() => ({ code: 'BAD_UPSTREAM' })), { status: res.status })
  } catch {
    return NextResponse.json({ code: 'BACKEND_UNREACHABLE', message: 'No hay conexión con la tienda. Inténtalo de nuevo.' }, { status: 502 })
  }
}
