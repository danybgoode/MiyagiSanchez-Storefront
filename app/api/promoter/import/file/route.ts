/**
 * POST /api/promoter/import/file  { shopId | slug, fileText, fileName, platform, defaultCategory }
 *
 * A promoter imports a merchant's export file (Tiendanube, WooCommerce) into the shop they just opened (epic 08 ·
 * promoter-panel D3/D4). The file is read by the shared catalog parser (quoted line breaks, `,`/`;`/tab, the platforms'
 * documented headers), a missing Miyagi Sánchez category is filled from the shop's «Categoría principal», and up to
 * 150 valid rows become products by the same path and the same private/published rule as a typed product.
 *
 * Big Cartel has no product export (only orders), so it is not offered here; its merchants type their products.
 * Re-sending the same file skips products whose title the shop already has, so a retry after a timeout never doubles
 * them. Images are copied into our storage through the DNS-pinned fetch (`ingestImageUrls`).
 */
import { NextRequest, NextResponse } from 'next/server'
import { CATALOG_CATEGORY_KEYS, MAX_IMPORT_ROWS, parseCatalogRecords, validateRows } from '@/lib/catalog-import'
import { ingestImageUrls } from '@/lib/image-ingest'
import { importCapPlan } from '@/lib/promoter-panel'
import { IMPORT_BUSY, IMPORT_UNAVAILABLE, claimShopImportLock, countShopListings, existingShopTitles, promoterImportPreamble, releaseShopImportLock } from '@/lib/promoter-import-server'
import { afterPromoterProductsAdded, createPromoterProduct, resolvePromoterListingStatus } from '@/lib/promoter-listing-server'
import { prepareImportRecords } from '@/lib/promoter-file-import'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** A product file is text; anything far bigger is not a catalog export. */
const MAX_FILE_CHARS = 3_000_000

export async function POST(req: NextRequest) {
  const pre = await promoterImportPreamble(req, { needsConnector: false })
  if (!pre.ok) return pre.response
  const { shop, body, promoter, userId } = pre.ctx

  const fileText = typeof body.fileText === 'string' ? body.fileText : ''
  const fileName = typeof body.fileName === 'string' ? body.fileName : 'productos.csv'
  const unreadable = 'No pudimos leer este archivo. Pídele que lo descargue otra vez desde su plataforma.'
  if (!fileText.trim() || fileText.length > MAX_FILE_CHARS) return NextResponse.json({ ok: false, error: unreadable }, { status: 422 })

  // The category asked for, or the shop's «Categoría principal» from «El negocio» (D6), or none (rows then fail clearly).
  const isKey = (v: unknown): v is string => typeof v === 'string' && (CATALOG_CATEGORY_KEYS as readonly string[]).includes(v)
  const defaultCategory = isKey(body.defaultCategory) ? body.defaultCategory : isKey(shop.metadata.main_category) ? shop.metadata.main_category : null
  const platform = body.platform === 'tiendanube' || body.platform === 'woocommerce' ? body.platform : null

  const read = parseCatalogRecords(fileText, fileName)
  if (read.fileErrors.length || read.records.length === 0) return NextResponse.json({ ok: false, error: unreadable }, { status: 422 })
  // Never validate more than the parser's own row limit (Codex security, #480): a long file can't cost unbounded work.
  const records = read.records.slice(0, MAX_IMPORT_ROWS)

  const staged = validateRows(prepareImportRecords(records, defaultCategory))
  const valid = staged.filter((r) => r.valid)
  const invalid = staged.length - valid.length
  if (valid.length === 0) return NextResponse.json({ ok: false, error: unreadable, invalid }, { status: 422 })

  const claim = await claimShopImportLock(shop, promoter.id)
  if (!claim.ok) return NextResponse.json({ ok: false, error: claim.reason === 'busy' ? IMPORT_BUSY : IMPORT_UNAVAILABLE }, { status: claim.reason === 'busy' ? 409 : 503 })
  try {
    // Skip what the shop already has, and count it toward the 150 — both read fail-closed (pr-reviewer, #480).
    const [have, already] = await Promise.all([existingShopTitles(shop.id, valid.map((r) => r.row.title)), countShopListings(shop.id)])
    if (!have || already === null) return NextResponse.json({ ok: false, error: IMPORT_UNAVAILABLE }, { status: 503 })
    const fresh = valid.filter((r) => !have.has(r.row.title.trim().toLowerCase()))

    const plan = importCapPlan(fresh.length, already)
    const rows = fresh.slice(0, plan.take)
    const overCap = plan.overCap + Math.max(0, read.records.length - records.length)
    if (rows.length === 0) return NextResponse.json({ ok: true, imported: 0, failed: 0, skipped: valid.length - fresh.length, invalid, overCap })

    const status = await resolvePromoterListingStatus({ shop, promoterCode: promoter.code, clerkUserId: userId })
    if (!status.ok) return NextResponse.json({ ok: false, error: status.error }, { status: status.status })

    let imported = 0
    let failed = 0
    for (const { row } of rows) {
      const ingest = row.images?.length ? await ingestImageUrls(`promoter-${promoter.id}`, row.images, row.title) : { images: [] }
      const created = await createPromoterProduct(shop, status.privatePreview, {
        title: row.title,
        description: row.description ?? null,
        category: row.category,
        priceCents: typeof row.price === 'number' ? Math.round(row.price * 100) : null,
        currency: row.currency ?? 'MXN',
        quantity: typeof row.quantity === 'number' ? row.quantity : null,
        images: ingest.images,
        sourcePlatform: platform,
      })
      if (created.ok) imported += 1
      else failed += 1
    }

    if (imported > 0) await afterPromoterProductsAdded(shop.id, status.privatePreview)
    return NextResponse.json({ ok: true, imported, failed, skipped: valid.length - fresh.length, invalid, overCap })
  } finally {
    await releaseShopImportLock(shop.id, claim.lock)
  }
}
