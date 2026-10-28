import { notFound } from 'next/navigation'
import { resolveShopPresentation } from '@/lib/shop-presentation/context'
import CatalogBody, { catalogFor, catalogMetadata } from '@/app/(shell)/_shop-sections/CatalogBody'
import type { Metadata } from 'next'

/** The shop's catalog page under the `/mx` market prefix — the link the merchant shares (share-kit S1.2, D8). */

export const revalidate = 120

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const ctx = await resolveShopPresentation(slug, { marketBasePath: '/mx', market: 'mx' })
  return catalogMetadata(ctx, ctx ? await catalogFor(ctx) : null)
}

export default async function MarketCatalogPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await resolveShopPresentation(slug, { marketBasePath: '/mx', market: 'mx' })
  if (!ctx) notFound()
  return <CatalogBody ctx={ctx} />
}
