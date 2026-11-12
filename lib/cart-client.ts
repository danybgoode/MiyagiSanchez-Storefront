/**
 * Client-safe `startCheckout` — a drop-in replacement for `lib/cart.ts`'s
 * `startCheckout` for use from `'use client'` components. POSTs to
 * `/api/checkout/start` (same origin) instead of importing the Medusa-calling
 * logic directly into the client bundle.
 *
 * Why this file exists: `lib/cart.ts`'s `startCheckout` reads
 * `NEXT_PUBLIC_MEDUSA_STORE_URL`/`NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY` at
 * module scope. Next.js only inlines `NEXT_PUBLIC_*` vars at `next build`
 * time, and the Cloud Run frontend Docker build never receives them as
 * build-args (only as Cloud Run *runtime* env vars) — so any CLIENT bundle
 * that imports `lib/cart.ts` directly bakes in `undefined` permanently,
 * falling back to `http://localhost:9000`. Importing `startCheckout` here
 * only as a TYPE (erased at build) and calling the server-side route instead
 * keeps the real Medusa calls out of the client bundle entirely.
 *
 * IMPORTANT: only import `type`s from `./cart` in this file. A value import
 * would re-bundle `lib/cart.ts`'s module-level consts into the client and
 * reintroduce the exact bug this file exists to avoid.
 */
import type { StartCheckoutParams, StartCheckoutResult } from './cart'
import { CheckoutStartError } from './checkout-error'

export async function startCheckout(params: StartCheckoutParams): Promise<StartCheckoutResult> {
  const res = await fetch('/api/checkout/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new CheckoutStartError(data?.error ?? 'No se pudo iniciar el pago.', data?.code ?? null)
  }
  return data as StartCheckoutResult
}
