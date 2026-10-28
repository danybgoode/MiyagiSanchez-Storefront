import { notFound } from 'next/navigation'
import { resolveRequestShopPresentation as resolveShopPresentation } from '@/lib/shop-presentation/request-context'
import CatalogBody, { catalogFor, catalogMetadata } from '../_shop-sections/CatalogBody'
import type { Metadata } from 'next'

/**
 * The shop's catalog page on an OWNED host — subdomain or custom domain (share-kit S1.2, D8).
 *
 * Middleware passes `/catalogo` through with the channel headers, so the shop comes from the unspoofable
 * `x-miyagi-shop-slug` header, never the URL — the same way `/tienda` does it. On the platform host there is no such
 * header and this bare path 404s.
 */

export async function generateMetadata(): Promise<Metadata> {
  const ctx = await resolveShopPresentation(null)
  return catalogMetadata(ctx, ctx ? await catalogFor(ctx) : null)
}

export default async function ChannelCatalogPage() {
  const ctx = await resolveShopPresentation(null)
  if (!ctx) notFound()
  return <CatalogBody ctx={ctx} />
}
