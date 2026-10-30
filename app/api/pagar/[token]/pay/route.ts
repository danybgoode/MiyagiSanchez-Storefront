/**
 * POST /api/pagar/[token]/pay — «Pagar» on a payment link (in-person-sales S4.2, D15). Public.
 * Body: { choice: 'mercadopago' | 'stripe' | 'manual' }. The shop, the lines and the price all come
 * from the BACKEND's link; the only thing the browser decides is which of the shop's own methods to
 * use, and that is re-checked against the shop's checkout-options here.
 */
import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { isLinkToken, payChoices, payScreen } from '@/lib/in-person/payment-link'
import { runPayFlow } from '@/lib/in-person/payment-link-flow'
import { pickTransferSubType } from '@/lib/in-person/counter-checkout'
import { readCheckoutMethods } from '@/lib/in-person/counter-backend'
import { buildPayFlowDeps, getPublicLink } from '@/lib/in-person/payment-link-backend'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!isLinkToken(token)) return NextResponse.json({ code: 'LINK_NOT_FOUND', message: 'No encontramos este cobro.' }, { status: 404, headers: NO_STORE })

  const rl = await checkRateLimit('checkout', getClientIp(req))
  if (!rl.allowed) return NextResponse.json({ code: 'RATE_LIMITED', message: 'Demasiados intentos. Espera un momento.' }, { status: 429, headers: { ...NO_STORE, 'Retry-After': String(rl.retryAfter) } })

  let choice: unknown
  try { choice = ((await req.json()) as { choice?: unknown }).choice } catch { choice = null }

  const link = await getPublicLink(token)
  const pl = link.body.payment_link as { state?: string; shop?: { slug?: string } } | undefined
  const screen = payScreen({ httpStatus: link.status, state: pl?.state, code: link.body.code })
  if (screen.screen !== 'ready') {
    return NextResponse.json({ code: screen.screen.toUpperCase(), message: screen.message }, { status: screen.screen === 'unavailable' ? 502 : 409, headers: NO_STORE })
  }
  const slug = pl?.shop?.slug
  if (!slug) return NextResponse.json({ code: 'LINK_UNAVAILABLE', message: 'No pudimos abrir este cobro.' }, { status: 502, headers: NO_STORE })

  let methods: Awaited<ReturnType<typeof readCheckoutMethods>>
  try { methods = await readCheckoutMethods(slug) } catch {
    return NextResponse.json({ code: 'BACKEND_UNREACHABLE', message: 'No hay conexión con la tienda. Inténtalo de nuevo.' }, { status: 502, headers: NO_STORE })
  }
  const offered = payChoices(methods)
  const picked = offered.find((c) => c.id === choice)
  if (!picked) return NextResponse.json({ code: 'METHOD_NOT_OFFERED', message: 'Esta tienda no acepta ese método.' }, { status: 422, headers: NO_STORE })

  const result = await runPayFlow(picked.id, buildPayFlowDeps(token, picked.id, pickTransferSubType(methods)))
  if (!result.ok) return NextResponse.json({ code: result.code, message: result.message }, { status: result.status, headers: NO_STORE })
  return NextResponse.json(result.kind === 'redirect' ? { redirect_url: result.url } : { manual_payment: result.manual }, { headers: NO_STORE })
}
