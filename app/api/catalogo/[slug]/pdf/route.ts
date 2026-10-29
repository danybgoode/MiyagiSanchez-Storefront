import { getClientIp } from '@/lib/ratelimit'
import { serveCatalogPdf } from '@/lib/share-kit/catalog-pdf'
import { catalogPdfDeps } from '@/lib/share-kit/catalog-pdf-server'
import { catalogPdfResponse } from '@/lib/share-kit/catalog-pdf-response'

/**
 * GET /api/catalogo/<slug>/pdf — a shop's catalog as a PDF, the link a merchant forwards (share-kit S2.3, D16).
 * Public: it prints the same public catalog the page shows, through the same resolver (an unknown, preview-private
 * or non-Mexico shop is a 404). A cached PDF streams from R2; a render is rate-limited per shop and per IP.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return catalogPdfResponse(await serveCatalogPdf(slug, getClientIp(req), catalogPdfDeps))
}
