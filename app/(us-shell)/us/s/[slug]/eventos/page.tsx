import { notFound } from 'next/navigation'
import { resolveShopPresentation } from '@/lib/shop-presentation/context'
import { resolveMarketShopPresentation } from '@/lib/shop-presentation/request-context'
import { navSections } from '@/lib/shop-presentation/sections'
import Body from '@/app/(shell)/_shop-sections/EventsIndexBody'
import type { Metadata } from 'next'

/** Living Shop — the "eventos" section under the `/us` market prefix (epic 07, Sprint 3). */

// Per request: the body follows the visitor's stored language (`lib/site-language.ts`).
export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const ctx = await resolveShopPresentation(slug, { marketBasePath: '/us', market: 'us' })
  if (!ctx) return { title: 'Página no encontrada' }
  return { title: ctx.shop.name }
}

export default async function MarketSectionPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await resolveMarketShopPresentation(slug, { marketBasePath: '/us', market: 'us' })
  if (!ctx) notFound()
  if (!navSections(ctx.sections, ctx.availability).includes('events')) notFound()
  return <Body ctx={ctx} />
}
