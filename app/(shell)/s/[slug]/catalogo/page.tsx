import { notFound } from 'next/navigation'
import { resolveShopPresentation } from '@/lib/shop-presentation/context'
import CatalogBody, { catalogFor, catalogMetadata } from '@/app/(shell)/_shop-sections/CatalogBody'
import type { Metadata } from 'next'

/**
 * The shop's catalog page on the unprefixed MARKETPLACE host (share-kit S1.2, D8) — where `mschz.org/s/<slug>/catalogo`
 * lands. Same body and resolver as the `/mx` form, exactly like `/tienda`.
 */


export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const ctx = await resolveShopPresentation(slug)
  return catalogMetadata(ctx, ctx ? await catalogFor(ctx) : null)
}

export default async function MarketplaceCatalogPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await resolveShopPresentation(slug)
  if (!ctx) notFound()
  return <CatalogBody ctx={ctx} />
}
