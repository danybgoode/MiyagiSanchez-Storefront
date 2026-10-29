import 'server-only'

import { publicCatalogModel } from '@/lib/share-kit/catalog-server'
import { renderPrintPdf } from '@/lib/print-pdf-client'
import { isR2Configured, uploadToR2 } from '@/lib/r2'
import { checkRateLimit } from '@/lib/ratelimit'
import { PLATFORM_ORIGIN } from '@/lib/shortlink'
import type { CatalogPdfDeps } from './catalog-pdf'

/**
 * The real I/O behind `serveCatalogPdf` (share-kit D16): the shop's model through the same resolver the catalog page
 * uses (preview-private and non-Mexico shops resolve to nothing), the PDF cache in the public R2 bucket, the two rate
 * limits, and the renderer on the VM loading the print page.
 */
export const catalogPdfDeps: CatalogPdfDeps = {
  loadModel: publicCatalogModel,
  async cacheGet(key) {
    const base = process.env.R2_PUBLIC_URL
    if (!base) return null
    const res = await fetch(`${base.replace(/\/$/, '')}/${key}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    const bytes = await res.arrayBuffer()
    return bytes.byteLength > 0 ? bytes : null
  },
  async rateLimit(kind, identifier) {
    return (await checkRateLimit(kind, identifier)).allowed
  },
  async render(slug) {
    const result = await renderPrintPdf(`${PLATFORM_ORIGIN}/mx/s/${slug}/catalogo/imprimir`)
    if (!result.ok || !result.buffer) {
      console.error(`[catalog-pdf] render failed for ${slug}: ${result.status} ${result.error ?? ''}`)
      return null
    }
    if (result.missingImages !== 0) {
      console.warn(`[catalog-pdf] ${slug}: ${result.missingImages ?? 'unknown'} image(s) missing — served, not cached`)
    }
    return { pdf: result.buffer, complete: result.missingImages === 0 }
  },
  async cachePut(key, pdf) {
    if (!isR2Configured()) return
    try {
      await uploadToR2(pdf, key, 'application/pdf')
    } catch (e) {
      console.error('[catalog-pdf] cache write failed:', e)
    }
  },
}
