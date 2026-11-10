/**
 * POST /api/promoter/close/listing — a bound promoter adds a real listing
 * (title, price, category, photos) to a merchant's shop during the in-person
 * close (epic 08 · promoter-funnel-v2 S5 · US-5.1), so the shop looks real —
 * populated at /s/[slug] and in search — before the promoter ever walks out.
 *
 * Can't reuse POST /api/sell/create — that route resolves the seller via the
 * CALLER's own Clerk session (/store/sellers/me), which fails for an unclaimed
 * shop (clerk_user_id: null). Instead calls createSellerProductViaInternal
 * directly, the same primitive the MCP create_listing tool already uses.
 *
 * Publish status: by default (flag OFF) this ALWAYS force-publishes — unlike a
 * self-serve listing it never runs listingActivationBlock's delivery/payment gate.
 * That gate exists to stop a live listing no buyer could check out on, but an
 * unclaimed shop's checkout is already fully blocked by isShopClaimed() regardless
 * of publish status, so the gate would be redundant here and would only hide the
 * listing from /s/[slug], defeating the story's point.
 *
 * Consent-safe preview (founding-merchant-consent-previews S1.1): when
 * `promoter.private_preview_enabled` is ON, this instead creates the product as a
 * native Medusa `status:'draft'` product — structurally excluded from every public
 * /store/* read seam (search, PDP, seller products, sitemap, agent, embed) — and
 * ensures a per-shop preview anchor. Nothing is public until the merchant approves
 * and the promoter activates (Sprint 2).
 *
 * Flag OFF preserves the force-publish path exactly for any shop that was NEVER
 * anchored — which is the rollback for the feature as a whole. It is NOT a
 * per-shop undo: a shop that already carries a non-activated anchor stays private
 * regardless of the flag, because a flag flip is not merchant consent. Un-hiding
 * one shop is a deliberate act (activate the approved snapshot in Sprint 2, or
 * delete its `merchant_previews` row).
 */
import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { isEnabled } from '@/lib/flags'
import { getPromoterByClerkId } from '@/lib/promoter'
import { resolveTargetShop } from '@/lib/promoter-server'
import { promoterShopEditAccess } from '@/lib/promoter-shop-access'
import { shopEditRefusal } from '@/lib/promoter-close'
import { CATALOG_CATEGORY_KEYS } from '@/lib/catalog-import'
import { normalizePromoterListingContract, optionalTrimmedText } from '@/lib/promoter-listing-contract'
import { afterPromoterProductsAdded, createPromoterProduct, resolvePromoterListingStatus } from '@/lib/promoter-listing-server'

export const dynamic = 'force-dynamic'

interface Body {
  shopId?: string
  slug?: string
  title?: string
  /** Backwards-compatible Mexico field. Prefer price + currency for new callers. */
  price_mxn?: number
  price?: number
  currency?: 'MXN' | 'USD'
  description?: string
  quantity?: number
  source_url?: string
  source_platform?: string
  category?: string
  condition?: string
  images?: Array<{ url: string; alt?: string }>
}

export async function POST(req: NextRequest) {
  if (!(await isEnabled('promoter.enabled'))) {
    return NextResponse.json({ ok: false }, { status: 404 })
  }

  const user = await currentUser().catch(() => null)
  if (!user) return NextResponse.json({ ok: false, error: 'No autorizado' }, { status: 401 })

  const rl = await checkRateLimit('checkout', getClientIp(req))
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: 'Demasiados intentos. Espera un momento.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  const promoter = await getPromoterByClerkId(user.id)
  if (!promoter) {
    return NextResponse.json({ ok: false, error: 'Vincula tu código de promotor primero.' }, { status: 403 })
  }

  let body: Body = {}
  try {
    const parsed: unknown = await req.json()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Body
  } catch { /* validated below */ }

  const title = (body.title ?? '').trim()
  if (title.length < 3) {
    return NextResponse.json({ ok: false, error: 'Escribe un título para el anuncio (mínimo 3 caracteres).' }, { status: 400 })
  }
  const category = (body.category ?? '').trim()
  if (!CATALOG_CATEGORY_KEYS.includes(category as (typeof CATALOG_CATEGORY_KEYS)[number])) {
    return NextResponse.json({ ok: false, error: 'Elige una categoría válida.' }, { status: 400 })
  }

  const shop = await resolveTargetShop({ shopId: body.shopId, slug: body.slug })
  if (!shop) return NextResponse.json({ ok: false, error: 'Tienda no encontrada.' }, { status: 404 })
  // Only a shop this promoter opened (or holds a relationship for) that nobody has claimed (promoter-panel D1). Before
  // this, any promoter account could add a product to any merchant's live shop (pr-reviewer, #475).
  const refusal = shopEditRefusal(await promoterShopEditAccess({ promoter, shop }))
  if (refusal) return NextResponse.json({ ok: false, error: refusal.error }, { status: refusal.status })

  // Private (a preview draft the merchant approves) or published — the same rule for typed and imported products
  // (lib/promoter-listing-server.ts, moved here unchanged from this route).
  const status = await resolvePromoterListingStatus({ shop, promoterCode: promoter.code, clerkUserId: user.id })
  if (!status.ok) return NextResponse.json({ ok: false, error: status.error }, { status: status.status })
  const { privatePreview } = status

  const { currency, priceCents, quantity } = normalizePromoterListingContract(body)
  const created = await createPromoterProduct(shop, privatePreview, {
    title,
    description: optionalTrimmedText(body.description),
    category,
    priceCents,
    currency,
    quantity,
    condition: body.condition?.trim() || null,
    images: Array.isArray(body.images) ? body.images.slice(0, 6) : [],
    // Provenance stays accepted from API callers; the panel no longer sends it (promoter-panel D7).
    sourceUrl: optionalTrimmedText(body.source_url),
    sourcePlatform: optionalTrimmedText(body.source_platform),
  })
  if (!created.ok) return NextResponse.json({ ok: false, error: created.error }, { status: 502 })

  await afterPromoterProductsAdded(shop.id, privatePreview)
  return NextResponse.json({ ok: true, productId: created.productId, private: privatePreview })
}
