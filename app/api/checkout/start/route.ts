/**
 * POST /api/checkout/start
 *
 * Server-side wrapper around `lib/cart.ts`'s `startCheckout` — the client-side
 * checkout buttons (BuyButton, CheckoutPayButton) call this route instead of
 * importing `startCheckout` directly, via `lib/cart-client.ts`. Running the
 * orchestration here (not in the browser) means its `process.env.MEDUSA_STORE_URL`
 * / publishable-key / region-id reads are live Cloud Run runtime env — safe,
 * unlike a client bundle, which only ever sees whatever `NEXT_PUBLIC_*` value
 * was (or wasn't) present at `next build` time.
 *
 * `startCheckout` itself is untouched — this is a thin proxy, matching the
 * sibling `app/api/checkout/{options,validate-coupon,postal-lookup,shipping-rates}`
 * routes' shape, except it returns the full `StartCheckoutResult` (not a flat
 * passthrough) since callers read both `redirect_url` and `cart_id`.
 */
import { NextRequest, NextResponse } from 'next/server'
import { CheckoutStartError } from '@/lib/checkout-error'
import { auth } from '@clerk/nextjs/server'
import { startCheckout, type StartCheckoutParams } from '@/lib/cart'

export async function POST(req: NextRequest) {
  let body: StartCheckoutParams
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Datos inválidos.' }, { status: 400 })
  }

  // `buyerClerkUserId` decides WHO receives the post-order push/Telegram, so it is
  // taken from the session and the body's value is discarded outright — an
  // overwrite, not a fallback, so a crafted body cannot notify a stranger. Guests
  // resolve to undefined and simply get no push, which is today's behaviour.
  const { userId } = await auth()
  const params: StartCheckoutParams = { ...body, buyerClerkUserId: userId ?? undefined }

  try {
    const result = await startCheckout(params)
    return NextResponse.json(result, { status: 200 })
  } catch (err) {
    // Preserve the thrown message verbatim — callers substring-match it
    // (e.g. BuyButton/CheckoutPayButton both check for 'SELLER_NOT_CONNECTED').
    const message = err instanceof Error ? err.message : 'No se pudo iniciar el pago.'
    console.error('[checkout/start] failed:', err)
    const code = err instanceof CheckoutStartError ? err.code : null
    return NextResponse.json({ error: message, ...(code ? { code } : {}) }, { status: 400 })
  }
}
