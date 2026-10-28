import { notFound } from 'next/navigation'
import { resolveShopPresentation } from '@/lib/shop-presentation/context'
import CatalogBody, { catalogFor, catalogMetadata } from '@/app/(shell)/_shop-sections/CatalogBody'
import type { Metadata } from 'next'

/**
 * The `/us` adapter of the catalog page — the US market mirrors every MX catalog route (`market-route-population`).
 * The share kit is Mexico-only (share-kit D5): a US shop resolves here and `CatalogBody` 404s it, so this route
 * renders nothing until a US catalog is built. It is the place that one goes.
 */

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const ctx = await resolveShopPresentation(slug, { marketBasePath: '/us', market: 'us' })
  return catalogMetadata(ctx, ctx ? await catalogFor(ctx) : null)
}

export default async function UsCatalogPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await resolveShopPresentation(slug, { marketBasePath: '/us', market: 'us' })
  if (!ctx) notFound()
  return <CatalogBody ctx={ctx} />
}
