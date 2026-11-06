/**
 * lib/promoter-listing-server.ts — how a promoter's product lands in a shop they opened (promoter-panel D2/D3).
 *
 * Three steps every promoter write shares — a typed product (`/api/promoter/close/listing`), a Shopify import and a
 * file import — so an imported product is private or published by exactly the same rule as a typed one:
 *   1. `resolvePromoterListingStatus` decides private (preview draft) vs published, and anchors the preview first.
 *   2. `createPromoterProduct` creates the product through the internal seller path and mirrors it.
 *   3. `afterPromoterProductsAdded` marks a stale merchant approval and revalidates — once per batch, not per row.
 *
 * Moved out of the listing route unchanged (promoter-panel S1); its comments carry the original reasons.
 */
import 'server-only'
import { revalidateTag } from 'next/cache'
import { isEnabled } from '@/lib/flags'
import { createSellerProductViaInternal } from '@/lib/seller-products'
import { syncSupabaseListingMirror } from '@/lib/provisioning'
import {
  ensureShopPreviewReportingCreation,
  getPreviewByShop,
  canAnchorPreview,
  shopMustStayPrivate,
  shopHasPublicListings,
} from '@/lib/preview-access'
import { invalidateIfMaterialChange } from '@/lib/preview-consent'
import { emitPreviewEvent } from '@/lib/preview-lifecycle'
import type { TargetShop } from '@/lib/promoter-server'

export type ListingStatusResult = { ok: true; privatePreview: boolean } | { ok: false; status: number; error: string }

/**
 * Private (a preview draft the merchant approves) or published. The ANCHOR is authoritative, ahead of the flag and of
 * who is calling: a shop already awaiting its merchant's consent never receives a published product — not during a
 * flag-store outage (the flag falls open to `false`), and not because a different promoter is calling.
 */
export async function resolvePromoterListingStatus(input: {
  shop: TargetShop
  promoterCode: string
  clerkUserId: string
}): Promise<ListingStatusResult> {
  const { shop } = input
  const alreadyPrivate = await shopMustStayPrivate(shop.id)
  let privatePreview =
    alreadyPrivate ||
    ((await isEnabled('promoter.private_preview_enabled')) && canAnchorPreview(shop, input.promoterCode))

  // Only the shop's own promoter may CREATE the anchor; creating one also requires that the shop isn't ALREADY publicly
  // trading — anchoring a shop with live listings would hide a working storefront (locked decision #4 of the consent
  // epic: existing public/unclaimed shops are audited, not mutated).
  if (privatePreview && !alreadyPrivate && (await shopHasPublicListings(shop.id))) {
    privatePreview = false
  } else if (privatePreview && !alreadyPrivate) {
    // Anchor BEFORE creating the product, so a failed anchor costs nothing; creating the product first would leave an
    // untracked draft that a retry duplicates.
    const anchored = await ensureShopPreviewReportingCreation(shop.id, input.clerkUserId)
    if (!anchored.preview) {
      return { ok: false, status: 500, error: 'No se pudo preparar la vista previa privada. Inténtalo de nuevo.' }
    }
    if (anchored.created) {
      await emitPreviewEvent('preview_created', {
        shopId: shop.id,
        previewId: anchored.preview.id,
        version: anchored.preview.currentVersion,
      })
    }
    // An ALREADY-ACTIVATED shop is public and out of the consent flow — a hidden draft would strand a product nobody
    // can see. Fall back to the ordinary publish path.
    if (anchored.preview.status === 'activated') privatePreview = false
  }
  return { ok: true, privatePreview }
}

export type PromoterProductInput = {
  title: string
  description: string | null
  category: string
  priceCents: number | null
  currency: string
  quantity: number | null
  condition?: string | null
  images: Array<{ url: string; alt?: string }>
  /** Where an IMPORTED product came from (its real source); a typed product sends none (promoter-panel D7). */
  sourceUrl?: string | null
  sourcePlatform?: string | null
}

/** Create one product in the promoter's shop through the internal seller path, and mirror it. */
export async function createPromoterProduct(
  shop: TargetShop,
  privatePreview: boolean,
  p: PromoterProductInput,
): Promise<{ ok: true; productId: string } | { ok: false; error: string }> {
  const locationDetail = (shop.metadata.location_detail ?? null) as { estado?: string | null; municipio?: string | null } | null
  const provenance = {
    ...(p.sourceUrl ? { source_url: p.sourceUrl } : {}),
    ...(p.sourcePlatform ? { source_platform: p.sourcePlatform } : {}),
  }
  const result = await createSellerProductViaInternal(shop.slug, {
    title: p.title,
    description: p.description,
    category: p.category,
    price_cents: p.priceCents,
    currency: p.currency,
    condition: p.condition ?? null,
    listing_type: 'product',
    state: locationDetail?.estado ?? null,
    municipio: locationDetail?.municipio ?? null,
    quantity: p.quantity,
    metadata: { ...provenance, acquisition: { motion: 'claim_shop_preview' } },
    // Private draft while the merchant's consent is pending, published otherwise; never gated by listingActivationBlock.
    status: privatePreview ? 'draft' : 'published',
    images: p.images,
  })
  if (!result.ok || !result.product_id) return { ok: false, error: result.error ?? 'No se pudo crear el anuncio.' }
  await syncSupabaseListingMirror(shop.id, {
    id: result.product_id,
    title: p.title,
    description: p.description,
    category: p.category,
    price_cents: p.priceCents,
    currency: p.currency,
    condition: p.condition ?? null,
    listing_type: 'product',
    state: locationDetail?.estado ?? null,
    municipio: locationDetail?.municipio ?? null,
    images: p.images,
    status: privatePreview ? 'draft' : 'active',
    ...provenance,
  })
  return { ok: true, productId: result.product_id }
}

/**
 * After products were added: a current merchant approval no longer matches what would be published (adding a product
 * is a MATERIAL change), so it is invalidated and the preview returns to review. Best-effort — the products already
 * exist. Called once per request, however many products it added.
 */
export async function afterPromoterProductsAdded(shopId: string, privatePreview: boolean): Promise<void> {
  if (privatePreview) {
    const pv = await getPreviewByShop(shopId)
    if (pv) {
      const outcome = await invalidateIfMaterialChange(pv).catch(() => ({ invalidated: false, reasons: [] }))
      if (outcome.invalidated) {
        await emitPreviewEvent('preview_invalidated', { shopId, previewId: pv.id, version: pv.currentVersion })
      }
    }
  }
  revalidateTag('listings', 'default')
  revalidateTag('shops', 'default')
}
