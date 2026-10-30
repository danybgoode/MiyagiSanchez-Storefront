/**
 * GET/POST /api/shop/cobros/links — «Cobrar con un link» (in-person-sales S4.3). Clerk-authenticated
 * pass-through to the BACKEND's seller routes, which validate (the MCP tools hit the same core) and
 * scope the links to the signed-in seller. Status and JSON are returned unchanged.
 */
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { backendFetch } from '@/lib/in-person/counter-backend'

export const dynamic = 'force-dynamic'
const UNAUTH = { code: 'UNAUTHENTICATED', message: 'Inicia sesión para cobrar con un link.' }

async function relay(path: string, init: { method: 'GET' | 'POST'; body?: string }) {
  const { userId, getToken } = await auth()
  const jwt = userId ? await getToken() : null
  if (!jwt) return NextResponse.json(UNAUTH, { status: 401 })
  try {
    const res = await backendFetch(path, { ...init, jwt })
    return NextResponse.json(await res.json().catch(() => ({ code: 'BAD_UPSTREAM', message: 'La tienda respondió algo inesperado.' })), { status: res.status })
  } catch {
    return NextResponse.json({ code: 'BACKEND_UNREACHABLE', message: 'No hay conexión con la tienda. Inténtalo de nuevo.' }, { status: 502 })
  }
}

export async function GET() {
  return relay('/store/sellers/me/payment-links', { method: 'GET' })
}

export async function POST(req: NextRequest) {
  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ code: 'INVALID_BODY', message: 'Falta el cobro.' }, { status: 400 }) }
  return relay('/store/sellers/me/payment-links', { method: 'POST', body: JSON.stringify(body) })
}
