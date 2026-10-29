import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { resolveShopPresentation } from '@/lib/shop-presentation/context'
import { catalogFor } from '@/lib/share-kit/catalog-server'

/**
 * The `/us` adapter of the catalog print page (`market-route-population` mirrors every MX catalog route and requires a
 * market decision, not only a URL prefix). The share kit is Mexico-only (share-kit D5): a US shop resolves here and
 * `catalogFor` answers null, so this is always a 404 — and the place a US printed catalog would go.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { robots: { index: false, follow: false } }

export default async function UsCatalogPrintPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await resolveShopPresentation(slug, { marketBasePath: '/us', market: 'us' })
  // `catalogFor` is null for every non-Mexico shop today, so this always 404s; a US print layout replaces this line.
  if (!ctx || !(await catalogFor(ctx))) notFound()
  notFound()
}
