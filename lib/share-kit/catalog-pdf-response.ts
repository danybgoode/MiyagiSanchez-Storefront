import { NextResponse } from 'next/server'
import type { CatalogPdfResult } from './catalog-pdf'

/** One response shape for both PDF routes, so the public link and the seller's button cannot drift. */
export function catalogPdfResponse(result: CatalogPdfResult): NextResponse {
  if (result.status !== 200) {
    return NextResponse.json({ error: result.error }, { status: result.status, headers: { 'Cache-Control': 'no-store' } })
  }
  return new NextResponse(result.pdf, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      // The URL is stable while the PDF behind it changes with the catalog; the R2 hit is what makes it fast.
      'Cache-Control': 'no-store',
      'X-Catalog-Pdf-Cache': result.cache,
    },
  })
}
