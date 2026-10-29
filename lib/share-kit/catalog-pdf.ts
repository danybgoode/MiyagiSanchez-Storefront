/**
 * The catalog PDF's decisions (share-kit S2.3, D16) — pure, with every I/O step injected, so the order of the gates
 * and "a cache hit never renders" are spec-proven without R2, Upstash or Chromium.
 *
 * The cache key is a hash of the MODEL the PDF prints, not a product `updated_at` (the seam does not carry one — lock
 * correction). Any change a buyer would see — a price, a photo, a name, the accent colour, the WhatsApp number — makes
 * a new key and so a new PDF; nothing else does.
 */

import { createHash } from 'node:crypto'
import type { CatalogModel } from './catalog'
import { CATALOG_PDF_ERROR } from './catalog-pdf-copy'

/** Bump when the print page's layout changes, so every cached PDF is re-rendered once. */
export const CATALOG_PDF_TEMPLATE_VERSION = 2

export { CATALOG_PDF_ERROR }

export function catalogPdfKey(model: CatalogModel): string {
  const hash = createHash('sha256')
    .update(JSON.stringify({ v: CATALOG_PDF_TEMPLATE_VERSION, model }))
    .digest('hex')
    .slice(0, 32)
  return `catalog-pdf/${model.shop.slug}/${hash}.pdf`
}

export function catalogPdfFilename(slug: string): string {
  return `${slug}-catalogo.pdf`
}

export interface CatalogPdfDeps {
  /** The shop's model, or null when it has no public catalog (unknown, preview-private, not a Mexico shop). */
  loadModel(slug: string): Promise<CatalogModel | null>
  /** The cached PDF's bytes, or null on a miss (or an unreadable cache — then it renders, never fails). */
  cacheGet(key: string): Promise<ArrayBuffer | null>
  /** true = allowed. */
  rateLimit(kind: 'catalog_pdf_shop' | 'catalog_pdf_ip', identifier: string): Promise<boolean>
  render(slug: string): Promise<ArrayBuffer | null>
  /** Best effort: a failed write still serves the freshly rendered PDF. */
  cachePut(key: string, pdf: ArrayBuffer): Promise<void>
}

export type CatalogPdfResult =
  | { status: 200; pdf: ArrayBuffer; cache: 'hit' | 'miss'; filename: string }
  | { status: 404 | 429 | 503; error: string }

/**
 * model → cache → limits → render → store. The limits sit AFTER the cache on purpose: a hit costs one R2 read and
 * charges nothing, so a merchant re-downloading the same catalog, or a buyer opening a forwarded link, is never
 * throttled; only a render — the expensive, queue-bound step — is.
 */
export async function serveCatalogPdf(slug: string, ip: string, deps: CatalogPdfDeps): Promise<CatalogPdfResult> {
  const model = await deps.loadModel(slug)
  if (!model) return { status: 404, error: 'Catálogo no encontrado.' }
  const key = catalogPdfKey(model)
  const filename = catalogPdfFilename(model.shop.slug)

  const cached = await deps.cacheGet(key).catch(() => null)
  if (cached) return { status: 200, pdf: cached, cache: 'hit', filename }

  // The IP first: a client already over its own limit must not spend the shop's, or a stranger could use up a
  // merchant's six renders an hour right after they edit their catalog (verifier, PR 448).
  if (!(await deps.rateLimit('catalog_pdf_ip', ip))) return { status: 429, error: CATALOG_PDF_ERROR }
  if (!(await deps.rateLimit('catalog_pdf_shop', model.shop.slug))) return { status: 429, error: CATALOG_PDF_ERROR }

  const pdf = await deps.render(model.shop.slug).catch(() => null)
  if (!pdf) return { status: 503, error: CATALOG_PDF_ERROR }
  await deps.cachePut(key, pdf).catch(() => {})
  return { status: 200, pdf, cache: 'miss', filename }
}
