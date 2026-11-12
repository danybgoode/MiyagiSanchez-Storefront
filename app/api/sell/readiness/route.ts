import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { DEFAULT_SHAPE, shapeOf } from '@/lib/business-shape'
import { isEnabled } from '@/lib/flags'
import { listingReadiness, ownerShopFacts, type DeliveryMode } from '@/lib/listing-readiness'
import { findKeptDraft } from '@/lib/prompt-to-shop/claim-server'
import { readChooserState, type CobrosSettings } from '@/lib/prompt-to-shop/cobros'
import { fetchGuideShop } from '@/lib/setup-guide-server'
import type { ReadinessView } from '@/lib/readiness-view'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const PUB_KEY = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''
const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0' }

/**
 * GET /api/sell/readiness?listing_type=product&delivery_mode=carrier — the new-listing form's «Antes de publicar»
 * panel (epic listing-readiness S2.1).
 *
 * Readiness comes from the MEDUSA seller's private settings through the ONE rule (`lib/listing-readiness.ts`) — the
 * same facts `POST /api/sell/create` checks, so the panel never promises what the server refuses. The inline fix is
 * the shipped `CobrosChooser`, seeded the way its own page seeds it (`/sell/armar/cobros`).
 *
 * Three states, never two: `no_shop` (first listing — the shop is created by the publish), `unavailable` (we could not
 * read; the form publishes and the server decides), `ok`.
 */
export async function GET(req: NextRequest) {
  const { userId, getToken } = await auth()
  if (!userId) return NextResponse.json({ error: 'No autenticado.' }, { status: 401, headers: NO_STORE })
  const clerkJwt = await getToken()
  if (!clerkJwt) return NextResponse.json({ error: 'No autenticado.' }, { status: 401, headers: NO_STORE })

  const listingType = req.nextUrl.searchParams.get('listing_type') ?? 'product'
  const mode = req.nextUrl.searchParams.get('delivery_mode')
  const deliveryMode: DeliveryMode = mode === 'arranged' || mode === 'carrier' ? mode : null

  try {
    const sellerRes = await fetch(`${MEDUSA_BASE}/store/sellers/me`, {
      headers: { 'Content-Type': 'application/json', 'x-publishable-api-key': PUB_KEY, Authorization: `Bearer ${clerkJwt}` },
      cache: 'no-store',
    })
    if (sellerRes.status === 404) return NextResponse.json({ state: 'no_shop' } satisfies ReadinessView, { headers: NO_STORE })
    if (!sellerRes.ok) return NextResponse.json({ state: 'unavailable' } satisfies ReadinessView, { headers: NO_STORE })
    const { seller } = await sellerRes.json() as { seller: { slug: string; metadata?: Record<string, unknown> | null } }
    const metadata = seller.metadata ?? null
    const readiness = listingReadiness({ listingType, deliveryMode, shop: ownerShopFacts(metadata) })

    const [guideShop, kept, correosAvailable] = await Promise.all([
      fetchGuideShop(userId),
      findKeptDraft(userId, null),
      isEnabled('shipping.correos_enabled'),
    ])
    const settings = ((guideShop?.metadata as { settings?: CobrosSettings } | null)?.settings ?? null)
    const market = typeof metadata?.operating_market === 'string' ? metadata.operating_market : 'mx'

    const view: ReadinessView = {
      state: 'ok',
      readiness,
      chooser: {
        shopSlug: seller.slug,
        market,
        initial: readChooserState(settings),
        correosAvailable,
        shape: kept && kept !== 'unavailable' ? shapeOf(kept.blocks.identity) : DEFAULT_SHAPE,
      },
    }
    return NextResponse.json(view, { headers: NO_STORE })
  } catch {
    return NextResponse.json({ state: 'unavailable' } satisfies ReadinessView, { headers: NO_STORE })
  }
}
