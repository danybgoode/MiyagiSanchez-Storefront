import { notFound } from 'next/navigation'
import { isLikelyShopSlug } from '@/lib/route-shape'
import { ShopScopedListingPage, generateShopScopedListingMetadata } from '../../../../../l/[id]/page'

/**
 * The shop-scoped PDP on the platform host: `/mx/s/<slug>/l/<id>`.
 *
 * Why it exists: `/mx/l/<id>` is the MARKETPLACE PDP and only knows products
 * published into the Mexico marketplace. A «Solo mi tienda» product is on its
 * shop (`/mx/s/<slug>`, `/tienda`) but in no marketplace, so every shop card for
 * it 404'd — reported live 2026-11-11 (`miel-verduras`). This route reads the
 * product through the shop's own channel, exactly as a subdomain or custom domain
 * does, so it works for every product the shop shows. The renderer 404s a
 * product that is not this shop's (`listing.shop.slug !== channelSlug`).
 *
 * `/mx/l` stays marketplace-only (owned-shop-operating-channel). A product that
 * is in both places is canonical at `/mx/l/<id>` (see `generateListingMetadata`).
 */
type Props = { params: Promise<{ slug: string; id: string }> }

async function scopeFrom(params: Props['params']) {
  const { slug, id } = await params
  return { slug, id }
}

export async function generateMetadata({ params }: Props) {
  const { slug, id } = await scopeFrom(params)
  if (!isLikelyShopSlug(slug)) return { title: 'Anuncio no encontrado' }
  return generateShopScopedListingMetadata(
    { params: Promise.resolve({ id }), market: 'mx', marketBasePath: '/mx' },
    { shopSlug: slug },
  )
}

export default async function MexicoShopScopedListingPage({ params }: Props) {
  const { slug, id } = await scopeFrom(params)
  if (!isLikelyShopSlug(slug)) notFound()
  return ShopScopedListingPage(
    { params: Promise.resolve({ id }), market: 'mx', marketBasePath: '/mx' },
    { shopSlug: slug },
  )
}
