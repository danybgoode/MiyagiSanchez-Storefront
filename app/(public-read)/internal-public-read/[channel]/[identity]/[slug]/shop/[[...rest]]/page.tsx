import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import {
  ShopPage,
  generateShopMetadata,
  type ShopRequestContext,
} from '@/app/(shell)/s/[slug]/ShopRenderer'
import { ShopAcercaPage, generateShopAcercaMetadata } from '@/app/(shell)/s/[slug]/acerca/page'
import { ShopFaqPage, generateShopFaqMetadata } from '@/app/(shell)/s/[slug]/faq/page'
import { ShopPoliticasPage, generateShopPoliciesMetadata } from '@/app/(shell)/s/[slug]/politicas/page'
import { resolveShopPresentation } from '@/lib/shop-presentation/context'
import { navSections } from '@/lib/shop-presentation/sections'
import CollectionsIndexBody from '@/app/(shell)/_shop-sections/CollectionsIndexBody'
import EventsIndexBody from '@/app/(shell)/_shop-sections/EventsIndexBody'
import ShopIndexBody from '@/app/(shell)/_shop-sections/ShopIndexBody'
import CatalogBody, { catalogFor, catalogMetadata } from '@/app/(shell)/_shop-sections/CatalogBody'
import EmbedShopPage, { generateMetadata as generateEmbedMetadata } from '@/app/(shell)/embed/s/[slug]/page'
import { isPublicReadChannel, type PublicReadChannel } from '@/lib/public-read'

// D19: Next requires a literal. Story 2.3 proves this equals CACHE.SHOP.
export const revalidate = 120

// Next 16 only creates runtime ISR entries for an unbounded dynamic route when
// generateStaticParams returns an empty population (or force-static is set).
export function generateStaticParams() {
  return []
}

/**
 * The four Living Shop sections, rendered here through the request-neutral `context.ts` rather than by importing the
 * `/mx/s/[slug]/<section>` route files: those read the visitor's language cookie (2026-11-13), and anything this cached
 * route imports must not (`lib/revalidate-truth.ts`). Same bodies, same nav gate, same metadata as those routes.
 */
type SectionKey = 'collections' | 'events' | 'shop'

const mxShopContext = (slug: string) => resolveShopPresentation(slug, { marketBasePath: '/mx', market: 'mx' })

async function sectionMetadata(slug: string): Promise<Metadata> {
  const ctx = await mxShopContext(slug)
  return ctx ? { title: ctx.shop.name } : { title: 'Página no encontrada' }
}

async function sectionPage(slug: string, key: SectionKey) {
  const ctx = await mxShopContext(slug)
  if (!ctx) notFound()
  if (!navSections(ctx.sections, ctx.availability).includes(key)) notFound()
  if (key === 'collections') return <CollectionsIndexBody ctx={ctx} />
  if (key === 'events') return <EventsIndexBody ctx={ctx} />
  return <ShopIndexBody ctx={ctx} />
}

async function catalogMetadataFor(slug: string): Promise<Metadata> {
  const ctx = await mxShopContext(slug)
  return catalogMetadata(ctx, ctx ? await catalogFor(ctx) : null)
}

async function catalogPage(slug: string) {
  const ctx = await mxShopContext(slug)
  if (!ctx) notFound()
  return <CatalogBody ctx={ctx} />
}

type Props = {
  params: Promise<{
    channel: string
    identity: string
    slug: string
    rest?: string[]
  }>
}

function renderContext(channel: PublicReadChannel, identity: string): ShopRequestContext {
  return { channel, domain: channel === 'subdomain' ? identity : null }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { channel, identity, slug, rest = [] } = await params
  if (!isPublicReadChannel(channel)) return { title: 'Página no encontrada' }
  const routeParams = Promise.resolve({ slug })

  if (channel === 'embed') {
    if (rest.length) return { title: 'Página no encontrada' }
    return generateEmbedMetadata({ params: routeParams })
  }
  if (channel !== 'marketplace' && rest.length) return { title: 'Página no encontrada' }

  if (rest.length === 0) {
    return generateShopMetadata({
      params: routeParams,
      market: channel === 'marketplace' ? 'mx' : undefined,
      marketBasePath: channel === 'marketplace' ? '/mx' : '',
      requestContext: renderContext(channel, identity),
    })
  }

  switch (rest[0]) {
    case 'acerca': return generateShopAcercaMetadata({ params: routeParams, market: 'mx', marketBasePath: '/mx' })
    case 'colecciones': return sectionMetadata(slug)
    case 'eventos': return sectionMetadata(slug)
    case 'faq': return generateShopFaqMetadata({ params: routeParams, market: 'mx', marketBasePath: '/mx' })
    case 'politicas': return generateShopPoliciesMetadata({ params: routeParams, market: 'mx', marketBasePath: '/mx' })
    case 'tienda': return sectionMetadata(slug)
    case 'catalogo': return catalogMetadataFor(slug)
    default: return { title: 'Página no encontrada' }
  }
}

export default async function PublicShopPage({ params }: Props) {
  const { channel, identity, slug, rest = [] } = await params
  if (!isPublicReadChannel(channel)) notFound()
  const routeParams = Promise.resolve({ slug })

  if (channel === 'embed') {
    if (rest.length) notFound()
    return EmbedShopPage({ params: routeParams, searchParams: Promise.resolve({}) })
  }
  if (channel !== 'marketplace' && rest.length) notFound()

  if (rest.length === 0) {
    return ShopPage({
      params: routeParams,
      market: channel === 'marketplace' ? 'mx' : undefined,
      marketBasePath: channel === 'marketplace' ? '/mx' : '',
      requestContext: renderContext(channel, identity),
    })
  }

  switch (rest[0]) {
    case 'acerca': return ShopAcercaPage({ params: routeParams, market: 'mx', marketBasePath: '/mx' })
    case 'colecciones': return sectionPage(slug, 'collections')
    case 'eventos': return sectionPage(slug, 'events')
    case 'faq': return ShopFaqPage({ params: routeParams, market: 'mx', marketBasePath: '/mx' })
    case 'politicas': return ShopPoliticasPage({ params: routeParams, market: 'mx', marketBasePath: '/mx' })
    case 'tienda': return sectionPage(slug, 'shop')
    case 'catalogo': return catalogPage(slug)
    default: notFound()
  }
}
