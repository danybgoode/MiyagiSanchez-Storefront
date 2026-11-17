/**
 * GET /api/checkout/options?sellerId=…&listingType=…&isDigital=…
 *
 * Thin proxy to the Medusa backend's /store/sellers/:slug/checkout-options —
 * the single source of truth for which payment + delivery methods a seller
 * offers. All availability logic lives in the backend (Medusa-first).
 *
 * `sellerId` may be a seller id OR slug (the backend resolves either).
 */
import { NextRequest, NextResponse } from 'next/server'
import { isEnabled } from '@/lib/flags'
import { applyPaymentKillSwitches } from '@/lib/checkout-killswitch'
import { DEFAULT_MARKET, isMarketCode } from '@/lib/markets'
import { PROCESS_MARKET_ENV, resolvePublishableKeyForMarket } from '@/lib/market-medusa'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const PUB_KEY     = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const sellerId = searchParams.get('sellerId')
  const listingType = searchParams.get('listingType') ?? 'product'
  const isDigital = searchParams.get('isDigital') ?? 'false'
  // Arranged-only delivery (epic, S1.3) — additive passthrough; the backend
  // ignores it entirely when shipping.arranged_only_enabled is off. Clamped
  // to the known values here too (defense-in-depth — the backend already
  // does the same `=== 'arranged' ? 'arranged' : 'carrier'` clamp).
  const deliveryMode = searchParams.get('deliveryMode') === 'arranged' ? 'arranged' : 'carrier'
  const requestedMarket = searchParams.get('market')
  const market = isMarketCode(requestedMarket) ? requestedMarket : DEFAULT_MARKET

  if (!sellerId) {
    return NextResponse.json({ error: 'sellerId requerido.' }, { status: 400 })
  }

  // A seated Evento takes any rail (coordinated-sales-readiness D5) — a display hint; start-checkout re-derives it.
  const isEvent = searchParams.get('isEvent') === 'true' ? 'true' : 'false'
  const qs = new URLSearchParams({ listing_type: listingType, is_digital: isDigital, delivery_mode: deliveryMode, market, is_event: isEvent })
  const key = resolvePublishableKeyForMarket(market, PROCESS_MARKET_ENV)
  if (key.status !== 'resolved') {
    return NextResponse.json({ error: 'No se pudo resolver el mercado de pago.' }, { status: 503 })
  }

  try {
    const upstream = await fetch(
      `${MEDUSA_BASE}/store/sellers/${encodeURIComponent(sellerId)}/checkout-options?${qs}`,
      { headers: { 'x-publishable-api-key': key.token || PUB_KEY } },
    )
    const data = await upstream.json().catch(() => null)
    if (data == null) {
      return NextResponse.json({ error: 'Respuesta inválida del servidor.' }, { status: upstream.status })
    }
    // Apply platform kill-switches to the success payload. The flag read is
    // fail-open (isEnabled → true if the flag store is unreachable), so Stripe is
    // only ever removed on a deliberate dashboard toggle. Error bodies (no
    // payment_methods array) pass through untouched.
    const stripeEnabled = upstream.ok ? await isEnabled('checkout.stripe_enabled') : true
    const filtered = applyPaymentKillSwitches(data, { stripeEnabled })
    return NextResponse.json(filtered, { status: upstream.status })
  } catch (err) {
    console.error('[checkout/options] backend unreachable:', err)
    return NextResponse.json(
      { error: 'No se pudo cargar las opciones de pago. Intenta en unos momentos.' },
      { status: 502 },
    )
  }
}
