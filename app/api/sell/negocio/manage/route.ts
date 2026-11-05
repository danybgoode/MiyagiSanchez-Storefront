/**
 * POST /api/sell/negocio/manage
 *
 * The signed-in owner opens Stripe's page for their MONTHLY Plan Negocio, where they change the card, see their
 * invoices and cancel (Daniel, 2026-11-05). Returns `{ ok: true, url }` or `{ ok: false, error }`.
 *
 * Auth first: anonymous is always 401. The shop is the caller's own (`readOwnedShop`), and the subscription must carry
 * this shop AND this user in its metadata (`pickNegocioSubscription`), so the body names nothing.
 */
import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { stripe } from '@/lib/stripe'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { readOwnedShop } from '@/lib/plan-server'
import { startNegocioManage, type NegocioSubscriptionLike } from '@/lib/negocio-manage'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Debes iniciar sesión.' }, { status: 401 })

  const rl = await checkRateLimit('checkout', getClientIp(req))
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: 'Demasiados intentos. Espera un momento.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  let shop
  try {
    shop = await readOwnedShop(user.id)
  } catch {
    return NextResponse.json({ ok: false, error: 'No pudimos leer tu tienda. Intenta de nuevo.' }, { status: 503 })
  }
  if (!shop) return NextResponse.json({ ok: false, error: 'Tienda no encontrada.' }, { status: 404 })

  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com'
  const result = await startNegocioManage(
    { shopId: shop.id, sellerClerkId: user.id, returnUrl: `${origin}/shop/manage/negocio` },
    {
      searchSubscriptions: async (query) => {
        const page = await stripe.subscriptions.search({ query, limit: 20 })
        return page.data.map((s): NegocioSubscriptionLike => ({
          id: s.id,
          status: s.status,
          customer: typeof s.customer === 'string' ? s.customer : s.customer?.id ?? null,
          metadata: (s.metadata ?? null) as Record<string, string> | null,
          created: s.created,
        }))
      },
      createPortal: async (customerId, returnUrl) =>
        (await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl })).url,
    },
  )
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status })
  return NextResponse.json({ ok: true, url: result.url })
}
