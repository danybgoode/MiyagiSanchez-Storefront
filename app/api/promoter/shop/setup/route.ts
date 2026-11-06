/**
 * POST /api/promoter/shop/setup — a bound promoter stands up an UNCLAIMED shop
 * for a merchant (epic 08 · S4 · US-11), so the business is live on Miyagi before
 * the owner ever logs in. Reuses the Gem-Claim Loop primitives: mint a real Medusa
 * seller (`clerk_user_id` NULL, idempotent on a `promoter://` source_url) →
 * mirror it into Supabase → record an `enrolled` promoter attribution against the
 * mirror id (which SURVIVES the later claim — the claim only flips clerk_user_id,
 * never the mirror/seller id). The merchant claims it via the WhatsApp link
 * (POST /api/promoter/claim/link). Clerk- + `promoter.enabled`-gated.
 */
import { CATALOG_CATEGORY_KEYS } from '@/lib/catalog-import'
import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { revalidateTag } from 'next/cache'
import { isEnabled } from '@/lib/flags'
import { getPromoterByClerkId, recordAttribution } from '@/lib/promoter'
import { promoterSourceUrl } from '@/lib/promoter-close'
import { ensureUnclaimedShopMirror, type MedusaSellerForMirror } from '@/lib/provisioning'
import { autoGrantPartnerOnClose } from '@/lib/partner-grant-server'
import { ensureShopPreviewReportingCreation, canAnchorPreview } from '@/lib/preview-access'
import { emitPreviewEvent } from '@/lib/preview-lifecycle'
import { readPromoterSetupDescription, readPromoterSetupMarket } from '@/lib/promoter-setup-market'
import { db } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const INTERNAL_SECRET = process.env.MEDUSA_INTERNAL_SECRET ?? ''

type MintedSeller = MedusaSellerForMirror & { source?: string | null; source_url?: string | null }

export async function POST(req: NextRequest) {
  if (!(await isEnabled('promoter.enabled'))) {
    return NextResponse.json({ ok: false }, { status: 404 })
  }

  // Auth gates BEFORE any config/secret check, so an anonymous caller always gets
  // 401 (never a 500 leaking that a prod-only secret is unset on preview).
  const user = await currentUser().catch(() => null)
  if (!user) return NextResponse.json({ ok: false, error: 'No autorizado' }, { status: 401 })

  const promoter = await getPromoterByClerkId(user.id)
  if (!promoter) {
    return NextResponse.json({ ok: false, error: 'Vincula tu código de promotor primero.' }, { status: 403 })
  }

  if (!INTERNAL_SECRET) {
    return NextResponse.json({ ok: false, error: 'Configuración incompleta en el servidor.' }, { status: 500 })
  }

  let body: {
    name?: string
    description?: unknown
    cp?: string
    estado?: string
    municipio?: string
    colonia?: string
    merchant_email?: string
    operating_market?: unknown
    main_category?: unknown
  } = {}
  try { body = await req.json() } catch { /* validated below */ }
  const name = (body.name ?? '').trim()
  if (name.length < 2) {
    return NextResponse.json({ ok: false, error: 'Escribe el nombre del negocio.' }, { status: 400 })
  }

  const operatingMarket = readPromoterSetupMarket(body.operating_market)
  if (operatingMarket === 'invalid') {
    return NextResponse.json({ ok: false, error: 'El mercado operativo debe ser México o Estados Unidos.' }, { status: 400 })
  }
  const description = readPromoterSetupDescription(body.description)
  if (!description.ok) {
    return NextResponse.json({ ok: false, error: 'La descripción debe ser texto de hasta 2,000 caracteres.' }, { status: 400 })
  }

  // Sprint 5 (US-5.2) — structured estado/municipio/colonia (CP-first, from
  // /api/checkout/postal-lookup) replaces the old free-text location field.
  // `location` stays a plain "municipio, estado" string for every existing
  // reader (parseLocation, PDP, search) — same join order `parseLocation`
  // expects (city-like part first, state-like part second). `location_detail`
  // carries the precise fields for Sprint 5's coverage matcher (US-5.3), which
  // treats it as optional (older shops only have the free-text `location`).
  const estado = body.estado?.trim() || null
  const municipio = body.municipio?.trim() || null
  const colonia = body.colonia?.trim() || null
  const cp = body.cp?.trim() || null
  const location = [municipio, estado].filter(Boolean).join(', ') || null
  const locationDetail = (cp || estado || municipio || colonia)
    ? { cp, estado, municipio, colonia }
    : null

  // Sprint 5 (US-5.5) — optional merchant email, so the close-completion
  // receipt has somewhere real to land. Falls back to the promoter's own
  // email (adapted copy) when the promoter didn't capture one.
  const merchantEmailRaw = body.merchant_email?.trim() || null
  const merchantEmail = merchantEmailRaw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(merchantEmailRaw)
    ? merchantEmailRaw
    : null

  // promoter-panel D6: the «Categoría principal» picked in «El negocio» — a catalog key or nothing. An import gives it
  // to every row whose platform category isn't one of ours (D3), so it is stored on the shop.
  const mainCategory = typeof body.main_category === 'string' && (CATALOG_CATEGORY_KEYS as readonly string[]).includes(body.main_category)
    ? body.main_category
    : null

  const metadata = (locationDetail || merchantEmail || mainCategory)
    ? {
        ...(locationDetail ? { location_detail: locationDetail } : {}),
        ...(merchantEmail ? { merchant_email: merchantEmail } : {}),
        ...(mainCategory ? { main_category: mainCategory } : {}),
      }
    : undefined

  // Mint the unclaimed Medusa seller (the storefront's only read model).
  let seller: MintedSeller
  try {
    const res = await fetch(`${MEDUSA_BASE}/internal/sellers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify({
        name,
        location,
        description: description.value,
        source: 'promoter',
        source_url: promoterSourceUrl(promoter.code, name),
        metadata,
        // Omit when unspecified so legacy promoter closes retain the explicit
        // backend MX default. A supplied market was normalized and validated
        // above; it must reach Medusa rather than being inferred from locale.
        ...(operatingMarket ? { operating_market: operatingMarket } : {}),
      }),
    })
    const data = (await res.json().catch(() => ({}))) as { seller?: MintedSeller; message?: string }
    if (!res.ok || !data.seller) {
      throw new Error(`seller create failed (${res.status}): ${data.message ?? 'no data'}`)
    }
    seller = data.seller
  } catch (e) {
    console.error('[promoter/shop/setup] mint failed:', e)
    return NextResponse.json({ ok: false, error: 'No se pudo crear la tienda. Intenta de nuevo.' }, { status: 502 })
  }

  // Mirror (conversations/offers/short links + the attribution seller_id key).
  const mirrorId = await ensureUnclaimedShopMirror(seller).catch((e) => {
    console.error('[promoter/shop/setup] mirror failed:', e)
    return null
  })
  if (!mirrorId) {
    return NextResponse.json({ ok: false, error: 'La tienda se creó pero no se pudo registrar. Avísale al equipo.' }, { status: 502 })
  }

  // Consent-safe previews (S1.1) — anchor the preview HERE, at shop creation, not
  // at the first listing. This is the seam every close variant converges on, so
  // anchoring later would leave a window in which a freshly-minted shop is fully
  // public at /s/<slug> under the merchant's REAL NAME before anyone consented to
  // it being presented at all.
  //
  // This route is NOT "unclaimed by construction", despite appearances: the
  // backend `/internal/sellers` is idempotent on `source_url`, so re-running
  // setup with the same business name returns the EXISTING seller, and
  // `ensureUnclaimedShopMirror` resolves that to the existing mirror row without
  // filtering `clerk_user_id`. If the merchant has since CLAIMED the shop, this
  // path hands back a live claimed shop — anchoring which would 404 a real
  // merchant's storefront. So the anchor goes through the same `canAnchorPreview`
  // gate as every other call site, on freshly-read mirror state.
  //
  // A failure FAILS THE CALL: reporting success would hand the promoter a shop
  // they believe is private while it is in fact publicly visible under the
  // merchant's real name. The shop itself survives (already minted + mirrored)
  // and the promoter can retry; `ensureShopPreview` is idempotent.
  //
  // RESIDUAL RACE (accepted, documented): the mirror row exists before the anchor
  // is written, so a concurrent `/s/<slug>` request in that window renders the
  // shop shell. It runs immediately after the mirror — ahead of the attribution
  // and partner-grant writes — to keep the window as small as possible, but
  // closing it fully needs one transaction across the mirror insert and the
  // anchor, which the Supabase JS client cannot express across these calls.
  // Exposure is a bare shell for a few milliseconds, to someone who already knows
  // an unpublished slug; the products are draft-private structurally regardless.
  if (await isEnabled('promoter.private_preview_enabled')) {
    const { data: mirrorRow, error: mirrorError } = await db
      .from('marketplace_shops')
      .select('clerk_user_id, source_url')
      .eq('id', mirrorId)
      .maybeSingle()

    // A FAILED read is not "not anchorable". Treating it as such would return 200
    // for a shop that is publicly visible under the merchant's real name with no
    // consent record — the precise failure this epic exists to prevent — so an
    // unreadable or missing mirror row fails the call instead.
    if (mirrorError || !mirrorRow) {
      return NextResponse.json(
        { ok: false, error: 'La tienda se creó pero no se pudo verificar su estado. Avísale al equipo antes de compartirla.' },
        { status: 500 },
      )
    }

    const anchorable = canAnchorPreview(
      {
        clerkUserId: (mirrorRow.clerk_user_id as string | null) ?? null,
        sourceUrl: (mirrorRow.source_url as string | null) ?? null,
      },
      promoter.code,
    )

    if (anchorable) {
      const anchored = await ensureShopPreviewReportingCreation(mirrorId, user.id).catch((e) => {
        console.error('[promoter/shop/setup] preview anchor failed:', e)
        return { preview: null, created: false }
      })
      if (!anchored.preview) {
        return NextResponse.json(
          { ok: false, error: 'La tienda se creó pero no se pudo marcar como privada. Inténtalo de nuevo antes de compartirla.' },
          { status: 500 },
        )
      }
      // Lifecycle telemetry (S3.1) — AFTER the canonical anchor write succeeded,
      // and only for a genuinely new anchor. Never fails the close.
      if (anchored.created) {
        await emitPreviewEvent('preview_created', {
          shopId: mirrorId,
          previewId: anchored.preview.id,
          version: anchored.preview.currentVersion,
        })
      }
    }
  }

  // Enroll the attribution now (survives the claim) so the promoter's link is
  // credited even before the close. Idempotent on (promoter, seller, sku).
  await recordAttribution({ promoterId: promoter.id, sellerId: mirrorId, sku: 'custom_domain' })

  // Miyagi Partners · Sprint 2 (US-2.1) — this is the ONE seam every close
  // variant converges on (the shop is created HERE; every /api/promoter/close/*
  // route only operates on a shop that already exists). If this promoter holds
  // a partner MCP credential, auto-grant them manager access to the shop they
  // just stood up. Best-effort; NEVER fails the close — see lib/partner-grant-server.ts.
  await autoGrantPartnerOnClose({ promoterId: promoter.id, shopId: mirrorId })

  revalidateTag('shops', 'default')
  return NextResponse.json({
    ok: true,
    shopId: mirrorId,
    sellerMedusaId: seller.id,
    slug: seller.slug,
    // Sprint 5 (US-5.3) — carried forward so the client can pass it into the
    // print-ad step's coverage matcher with no extra round-trip.
    estado,
    municipio,
    name: seller.name,
  })
}
