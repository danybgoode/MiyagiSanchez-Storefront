/**
 * POST /api/shop/en-persona/sales — «Vender en persona» (in-person-sales S1.3).
 *
 * A thin pass-through to the backend's `POST /store/sellers/me/in-person-orders`
 * (S1.2). The backend owns everything that matters — seller resolution from the Clerk JWT,
 * ownership of every variant, the exactly-once claim, the order itself — so this route
 * only (1) requires a signed-in user, (2) forwards the seller's Clerk JWT and the
 * publishable key, and (3) returns the backend's status and JSON UNCHANGED, so the counter
 * can show the backend's Spanish `message` and branch on its `code`.
 *
 * It calls the BACKEND directly, never one of our own Next routes: a server-side `fetch()`
 * to our own authed route loses the Clerk cookie (the 32-days-of-zero-emails learning).
 * It mints nothing: `client_id` is minted by the counter ONCE per sale and re-sent on
 * every retry, which is what makes a retry exactly-once (D4).
 *
 * The body is WHITELISTED rather than spread through, so a browser cannot set backend
 * fields the counter does not own (`offline`, `sold_at` belong to the Sprint 3 queue).
 */
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'

export const dynamic = 'force-dynamic'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const PUB_KEY = process.env.MEDUSA_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

/** A sale slower than this is treated as «unknown» and retried with the same client_id (exactly-once, D4). */
const BACKEND_TIMEOUT_MS = 25_000

export async function POST(req: NextRequest) {
  const { userId, getToken } = await auth()
  if (!userId) {
    return NextResponse.json({ code: 'UNAUTHENTICATED', message: 'Inicia sesión para registrar ventas.' }, { status: 401 })
  }
  const jwt = await getToken()
  if (!jwt) {
    return NextResponse.json({ code: 'UNAUTHENTICATED', message: 'Inicia sesión para registrar ventas.' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    const parsed: unknown = await req.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch {
    return NextResponse.json({ code: 'INVALID_BODY', message: 'No pudimos leer la venta. Inténtalo de nuevo.' }, { status: 400 })
  }

  const forward = {
    client_id: body.client_id,
    kind: body.kind,
    lines: body.lines,
    tendered_cents: body.tendered_cents,
    buyer_email: body.buyer_email,
  }

  let upstream: Response
  try {
    upstream = await fetch(`${MEDUSA_BASE}/store/sellers/me/in-person-orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-publishable-api-key': PUB_KEY,
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify(forward),
      cache: 'no-store',
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    })
  } catch (err) {
    console.error('[en-persona/sales] backend unreachable:', err instanceof Error ? err.message : String(err))
    // 502 + a code the counter treats as «retry with the SAME client_id».
    return NextResponse.json(
      { code: 'BACKEND_UNREACHABLE', message: 'No hay conexión con la tienda. Toca «Reintentar»: no se cobra doble.' },
      { status: 502 },
    )
  }

  const text = await upstream.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = { code: 'BAD_UPSTREAM', message: 'La tienda respondió algo inesperado. Toca «Reintentar».' }
    return NextResponse.json(json, { status: upstream.status >= 400 ? upstream.status : 502 })
  }
  return NextResponse.json(json, { status: upstream.status })
}
