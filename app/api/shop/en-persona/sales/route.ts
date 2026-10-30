/**
 * POST /api/shop/en-persona/sales — «Vender en persona» (in-person-sales S1.3, S2.1, S2.2).
 *
 * Forwards the sale to the backend's `POST /store/sellers/me/in-person-orders` and returns the
 * backend's status and JSON UNCHANGED for cash. The backend owns everything that matters —
 * seller resolution from the Clerk JWT, ownership of every variant, the exactly-once claim, the
 * order itself — so this route only (1) requires a signed-in user, (2) forwards the seller's
 * Clerk JWT and the publishable key, and (3) for card and transfer, makes the claimed cart
 * payable (counter-checkout.ts: start-checkout once, QR url read back, transfer completed).
 *
 * It calls the BACKEND directly, never one of our own Next routes: a server-side `fetch()` to
 * our own authed route loses the Clerk cookie (the 32-days-of-zero-emails learning). It mints
 * nothing: `client_id` is minted by the counter ONCE per sale and re-sent on every retry, which
 * is what makes a retry exactly-once (D4).
 *
 * The body is WHITELISTED rather than spread through, so a browser cannot set backend fields
 * the counter does not own (`offline`, `sold_at` belong to the Sprint 3 queue). A card or
 * transfer sale carries no tendered amount.
 */
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getMySeller } from '@/lib/get-my-seller'
import { backendFetch, buildOrchestrateDeps, CLIENT_ID_RE, readCheckoutMethods } from '@/lib/in-person/counter-backend'
import { makeSalePayable, pickCardProvider, pickTransferSubType } from '@/lib/in-person/counter-checkout'

export const dynamic = 'force-dynamic'

const UNAUTH = { code: 'UNAUTHENTICATED', message: 'Inicia sesión para registrar ventas.' }

export async function POST(req: NextRequest) {
  const { userId, getToken } = await auth()
  if (!userId) return NextResponse.json(UNAUTH, { status: 401 })
  const jwt = await getToken()
  if (!jwt) return NextResponse.json(UNAUTH, { status: 401 })

  let body: Record<string, unknown>
  try {
    const parsed: unknown = await req.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch {
    return NextResponse.json({ code: 'INVALID_BODY', message: 'No pudimos leer la venta. Inténtalo de nuevo.' }, { status: 400 })
  }

  const kind = body.kind
  const isRemote = kind === 'card' || kind === 'transfer'
  const forward = {
    client_id: body.client_id,
    kind,
    lines: body.lines,
    ...(isRemote ? {} : { tendered_cents: body.tendered_cents }),
    buyer_email: body.buyer_email,
  }

  // Card / transfer: learn the shop's providers BEFORE claiming, so a shop that cannot take a
  // card never leaves a claimed cart behind.
  let plan: { sellerId: string; provider: ReturnType<typeof pickCardProvider>; subType: ReturnType<typeof pickTransferSubType> } | null = null
  if (isRemote) {
    const seller = await getMySeller()
    if (!seller) return NextResponse.json({ code: 'SELLER_NOT_FOUND', message: 'No encontramos tu tienda.' }, { status: 404 })
    let methods: Awaited<ReturnType<typeof readCheckoutMethods>>
    try {
      methods = await readCheckoutMethods(seller.slug)
    } catch {
      return NextResponse.json({ code: 'BACKEND_UNREACHABLE', message: 'No hay conexión con la tienda. Toca «Reintentar»: no se cobra doble.' }, { status: 502 })
    }
    const provider = pickCardProvider(methods)
    const subType = pickTransferSubType(methods)
    if (kind === 'card' && !provider) {
      return NextResponse.json({ code: 'NO_CARD_PROVIDER', message: 'Tu tienda no tiene Mercado Pago ni Stripe conectados. Conéctalos en Ajustes para cobrar con tarjeta.' }, { status: 422 })
    }
    if (kind === 'transfer' && !subType) {
      return NextResponse.json({ code: 'SELLER_MANUAL_MISSING', message: 'Configura tu CLABE o DiMo en Ajustes para cobrar por transferencia.' }, { status: 422 })
    }
    plan = { sellerId: seller.id, provider, subType }
  }

  let upstream: Response
  try {
    upstream = await backendFetch('/store/sellers/me/in-person-orders', { method: 'POST', jwt, body: JSON.stringify(forward) })
  } catch (err) {
    console.error('[en-persona/sales] backend unreachable:', err instanceof Error ? err.message : String(err))
    // 502 + a code the counter treats as «retry with the SAME client_id».
    return NextResponse.json(
      { code: 'BACKEND_UNREACHABLE', message: 'No hay conexión con la tienda. Toca «Reintentar»: no se cobra doble.' },
      { status: 502 },
    )
  }

  const text = await upstream.text()
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text)
  } catch {
    return NextResponse.json(
      { code: 'BAD_UPSTREAM', message: 'La tienda respondió algo inesperado. Toca «Reintentar».' },
      { status: upstream.status >= 400 ? upstream.status : 502 },
    )
  }
  if (!upstream.ok || !isRemote || !plan) return NextResponse.json(json, { status: upstream.status })

  const clientId = String(forward.client_id ?? '').toLowerCase()
  if (typeof json.cart_id !== 'string' || !CLIENT_ID_RE.test(clientId)) {
    return NextResponse.json({ code: 'BAD_UPSTREAM', message: 'La tienda respondió algo inesperado. Toca «Reintentar».' }, { status: 502 })
  }
  const result = await makeSalePayable(
    kind as 'card' | 'transfer',
    buildOrchestrateDeps({ jwt, clientId, cartId: json.cart_id, kind: kind as 'card' | 'transfer', sellerId: plan.sellerId, provider: plan.provider, subType: plan.subType }),
  )
  if (!result.ok) return NextResponse.json({ code: result.code, message: result.message }, { status: result.httpStatus })
  const s = result.status
  return NextResponse.json(
    {
      kind,
      state: s.state,
      order_id: s.order_id,
      cart_id: s.cart_id,
      total_cents: s.total_cents,
      checkout_url: s.checkout_url,
      replayed: json.replayed === true,
      manual_payment: result.manual_payment,
    },
    { status: upstream.status },
  )
}
