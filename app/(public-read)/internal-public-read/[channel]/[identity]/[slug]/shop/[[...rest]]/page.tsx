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
import CollectionsPage, { generateMetadata as generateCollectionsMetadata } from '@/app/(shell)/mx/s/[slug]/colecciones/page'
import EventsPage, { generateMetadata as generateEventsMetadata } from '@/app/(shell)/mx/s/[slug]/eventos/page'
import ShopIndexPage, { generateMetadata as generateShopIndexMetadata } from '@/app/(shell)/mx/s/[slug]/tienda/page'
import CatalogPage, { generateMetadata as generateCatalogMetadata } from '@/app/(shell)/mx/s/[slug]/catalogo/page'
import EmbedShopPage, { generateMetadata as generateEmbedMetadata } from '@/app/(shell)/embed/s/[slug]/page'
import { isPublicReadChannel, type PublicReadChannel } from '@/lib/public-read'

// D19: Next requires a literal. Story 2.3 proves this equals CACHE.SHOP.
export const revalidate = 120

// Next 16 only creates runtime ISR entries for an unbounded dynamic route when
// generateStaticParams returns an empty population (or force-static is set).
export function generateStaticParams() {
  return []
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
    case 'colecciones': return generateCollectionsMetadata({ params: routeParams })
    case 'eventos': return generateEventsMetadata({ params: routeParams })
    case 'faq': return generateShopFaqMetadata({ params: routeParams, market: 'mx', marketBasePath: '/mx' })
    case 'politicas': return generateShopPoliciesMetadata({ params: routeParams, market: 'mx', marketBasePath: '/mx' })
    case 'tienda': return generateShopIndexMetadata({ params: routeParams })
    case 'catalogo': return generateCatalogMetadata({ params: routeParams })
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
    case 'colecciones': return CollectionsPage({ params: routeParams })
    case 'eventos': return EventsPage({ params: routeParams })
    case 'faq': return ShopFaqPage({ params: routeParams, market: 'mx', marketBasePath: '/mx' })
    case 'politicas': return ShopPoliticasPage({ params: routeParams, market: 'mx', marketBasePath: '/mx' })
    case 'tienda': return ShopIndexPage({ params: routeParams })
    case 'catalogo': return CatalogPage({ params: routeParams })
    default: notFound()
  }
}
