/**
 * lib/supply-import.ts
 *
 * The shared per-item import core extracted from app/api/supply/import so two
 * callers can reuse it without duplicating the create + mirror + status loop:
 *   - the ADMIN supply console (scrape → unclaimed seller, source_url dedupe), and
 *   - the SELLER Mercado Libre import (epic 03 · mercadolibre-sync S2 → the
 *     CONNECTED seller, linkage-aware dedupe, records the S1 product↔ML-item link).
 *
 * The two differ only in (a) how a row resolves to a Medusa seller, (b) how a
 * duplicate is detected, and (c) what runs after a product is created — so those
 * are injected as hooks; the create/mirror/status machinery stays identical.
 *
 * server-only (holds MEDUSA_INTERNAL_SECRET). next-free on purpose — callers own
 * cache revalidation + batch bookkeeping.
 */
import 'server-only'
import { db } from '@/lib/supabase'
import { supplyItemToProductBody, type SupplyItem } from '@/lib/supply'
import { syncSupabaseListingMirror } from '@/lib/provisioning'
import { ingestImageUrls } from '@/lib/image-ingest'
import { describeMedusaNetworkFailure, getMedusaInternalBaseUrl } from './medusa-internal'
import { screenText, type ScreenVerdict } from './prompt-to-shop/screen'
import { PROHIBITED_IMPORT_MESSAGE, prohibitedItemIds } from './supply-screen'
import { screenDeps } from './prompt-to-shop/screen-server'

const MEDUSA_BASE = getMedusaInternalBaseUrl()
const INTERNAL_SECRET = process.env.MEDUSA_INTERNAL_SECRET ?? ''

async function internalFetch(path: string, body: unknown) {
  try {
    return await fetch(`${MEDUSA_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new Error(describeMedusaNetworkFailure(`Listing create (${path})`, MEDUSA_BASE, error))
  }
}

/** Where a staged row's listing should be created. */
export type ResolvedImportSeller = { sellerSlug: string; mirrorId: string | null }

export type ImportHooks = {
  targetStatus: string
  /** Resolve the item to a Medusa seller slug (+ Supabase mirror id for the listing mirror). */
  resolveSeller: (item: SupplyItem) => Promise<ResolvedImportSeller>
  /**
   * Decide whether the item is already imported (skip create). Defaults to the
   * admin behaviour: a marketplace_listings row already exists for the source_url.
   */
  checkDuplicate?: (item: SupplyItem) => Promise<{ duplicate: boolean; existingListingId?: string | null }>
  /** Runs after a product is created (e.g. record the ML linkage). Non-fatal: a throw fails the item. */
  afterCreate?: (productId: string, item: SupplyItem, sellerSlug: string) => Promise<void>
  /** The prohibited-goods screen (D1 of one-front-door-both-markets). Defaults to Jev; injected by specs. */
  screen?: (text: string) => Promise<ScreenVerdict>
}


export type ImportCounts = { imported: number; duplicate: number; failed: number }

/** Default dedupe: an existing listing with the same source_url (admin scrape path). */
async function defaultCheckDuplicate(item: SupplyItem) {
  if (!item.source_url) return { duplicate: false as const }
  const { data } = await db
    .from('marketplace_listings')
    .select('id')
    .eq('source_url', item.source_url)
    .maybeSingle()
  return { duplicate: !!data, existingListingId: data?.id ?? null }
}

/**
 * Import the approved items: per item, dedupe → resolve seller → create the
 * Medusa product → mirror → afterCreate hook, writing each item's status. Returns
 * the running counts. Does NOT touch the batch row or revalidate caches — the
 * caller owns those.
 */
export async function importApprovedItems(items: SupplyItem[], hooks: ImportHooks): Promise<ImportCounts> {
  const checkDuplicate = hooks.checkDuplicate ?? defaultCheckDuplicate
  let imported = 0
  let duplicate = 0
  let failed = 0
  const prohibited = await prohibitedItemIds(items, hooks.screen ?? ((text) => screenText(text, screenDeps())))

  for (const item of items) {
    try {
      if (prohibited.has(item.id)) throw new Error(PROHIBITED_IMPORT_MESSAGE)
      if (!item.listing_title || item.listing_title.trim().length < 5) throw new Error('Missing listing title')
      if (!item.source_url) throw new Error('Missing original source URL')
      if (!item.category) throw new Error('Missing category')

      const dup = await checkDuplicate(item)
      if (dup.duplicate) {
        duplicate++
        await db.from('supply_items').update({
          status: 'duplicate',
          error_message: 'Already imported',
          imported_listing_id: dup.existingListingId ?? null,
          imported_at: new Date().toISOString(),
        }).eq('id', item.id)
        continue
      }

      const { sellerSlug, mirrorId } = await hooks.resolveSeller(item)

      // ── Copy hotlinked images into R2 (hyper-performant-website S1.3) ─────
      // Same ingestImageUrls() the bulk/MCP catalog-import paths already use
      // (lib/image-ingest.ts) — this was the one product-creation path that
      // hadn't been wired up yet, so a scraped listing (e.g. the 369 KiB
      // teatrounam.com.mx image the PageSpeed audit flagged) shipped with a
      // permanent third-party hotlink. Best-effort: a failed image keeps its
      // original URL rather than failing the whole import; ingest.failed > 0
      // is logged so a bad batch is visible without blocking it.
      const imageUrls = (item.images ?? []).map((img) => img.url).filter(Boolean)
      const ingest = imageUrls.length > 0
        ? await ingestImageUrls(item.batch_id, imageUrls, item.listing_title ?? sellerSlug)
        : { images: [] as Array<{ url: string; alt?: string }>, ingested: 0, failed: 0 }
      if (ingest.failed > 0) {
        console.error(`[supply-import] ${ingest.failed}/${imageUrls.length} image(s) failed to ingest to R2 for item ${item.id}, kept original hotlink(s)`)
      }
      const itemForCreate: SupplyItem = { ...item, images: ingest.images.length > 0 ? ingest.images : item.images }

      // ── Create the REAL listing: a Medusa product linked to the seller ────
      const productBody = supplyItemToProductBody(itemForCreate, sellerSlug, hooks.targetStatus)
      const productRes = await internalFetch('/internal/seller-products', productBody)
      const productData = await productRes.json().catch(() => ({})) as { product_id?: string; message?: string }
      if (!productRes.ok || !productData.product_id) {
        throw new Error(`Listing create failed (${productRes.status}): ${productData.message ?? 'no data'}`)
      }

      // ── Mirror the listing (short-code mint + conversations/offers) ───────
      let mirrorListingId: string | null = null
      if (mirrorId) {
        mirrorListingId = await syncSupabaseListingMirror(mirrorId, {
          id: productData.product_id,
          title: productBody.title,
          description: productBody.description,
          price_cents: productBody.price_cents,
          currency: productBody.currency,
          condition: productBody.condition,
          listing_type: productBody.listing_type,
          category: productBody.category,
          state: productBody.state,
          municipio: productBody.municipio,
          location: productBody.location,
          images: productBody.images,
          tags: productBody.tags,
          status: hooks.targetStatus,
          metadata: productBody.metadata,
          source: 'scraped',
          source_platform: item.source_platform,
          source_url: item.source_url,
        }).catch((e) => {
          console.error('[supply-import] listing mirror failed (non-fatal):', e)
          return null
        }) ?? null
      }

      if (hooks.afterCreate) await hooks.afterCreate(productData.product_id, item, sellerSlug)

      imported++
      await db.from('supply_items').update({
        status: 'imported',
        imported_shop_id: mirrorId,
        imported_listing_id: mirrorListingId,
        imported_at: new Date().toISOString(),
        error_message: null,
      }).eq('id', item.id)
    } catch (err) {
      failed++
      await db.from('supply_items').update({
        status: 'failed',
        error_message: err instanceof Error ? err.message : String(err),
      }).eq('id', item.id)
    }
  }

  return { imported, duplicate, failed }
}
