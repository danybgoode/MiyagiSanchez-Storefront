import { notFound, permanentRedirect } from 'next/navigation'
import { getShop } from '@/lib/listings'
import { assertShopNotPreviewPrivate, isShopPreviewPrivateBySlug } from '@/lib/preview-access'
import { isLikelyShopSlug } from '@/lib/route-shape'
import { getSlugRedirect } from '@/lib/slug-redirect'
import { getActiveCustomDomain } from '@/lib/custom-domain'
import { readPublicSellerMarket } from '@/lib/owned-market'
import { marketCatalogCanonical } from '@/lib/market-seo'
import AcercaBody from '../../../_shop-content/AcercaBody'
import type { MarketCode } from '@/lib/markets'
import type { SiteLanguage } from '@/lib/site-language'
import type { Metadata } from 'next'

export async function generateShopAcercaMetadata({
  params,
  market,
  marketBasePath = '',
}: {
  params: Promise<{ slug: string }>
  market?: MarketCode
  marketBasePath?: string
}): Promise<Metadata> {
  const { slug } = await params
  const missingTitle = market === 'us' ? 'Page not found' : 'Página no encontrada'
  if (!isLikelyShopSlug(slug)) return { title: missingTitle }
  const shop = await getShop(slug, market)
  if (!shop) return { title: missingTitle }
  if (market && readPublicSellerMarket(shop)?.market_code !== market) {
    return { title: missingTitle }
  }
  // Don't leak a preview-private shop's name in the <title>. Guarded explicitly
  // rather than relying on Next discarding metadata when the body notFound()s —
  // that behavior was asserted in review but never actually verified.
  if (await isShopPreviewPrivateBySlug(shop.slug, shop.clerk_user_id)) return { title: missingTitle }
  return {
    title: `${market === 'us' ? 'About' : 'Acerca'} — ${shop.name}`,
    ...(marketBasePath ? marketCatalogCanonical(`${marketBasePath}/s/${slug}/acerca`) : {}),
  }
}

export const generateMetadata = generateShopAcercaMetadata

// Marketplace path: /s/[slug]/acerca. On subdomain/custom domain this route is
// never reached (middleware's boundary-isolation deny-list redirects /s/*
// home there) — the channel path is app/(shell)/acerca/page.tsx.
export async function ShopAcercaPage({
  params,
  market,
  marketBasePath = '',
  language,
}: {
  params: Promise<{ slug: string }>
  market?: MarketCode
  marketBasePath?: string
  /** The visitor's stored ES/EN choice, from the dynamic market route. The public-read cache passes none. */
  language?: SiteLanguage | null
}) {
  const { slug } = await params
  if (!isLikelyShopSlug(slug)) notFound()
  const shop = await getShop(slug, market)
  if (!shop) {
    const current = await getSlugRedirect(slug)
    if (current) permanentRedirect(`${marketBasePath}/s/${current}/acerca`)
    notFound()
  }
  if (market && readPublicSellerMarket(shop)?.market_code !== market) notFound()
  // Consent-safe previews: never render a preview-private shop's shell.
  await assertShopNotPreviewPrivate(shop)

  // SEO continuity: a shop with a LIVE custom domain moves its canonical URL
  // there — same convention as the shop home page and collection pages.
  if (!marketBasePath) {
    const domain = await getActiveCustomDomain(shop.slug)
    if (domain) permanentRedirect(`https://${domain}/acerca`)
  }

  return <AcercaBody shop={shop} basePath={`${marketBasePath}/s/${shop.slug}`} language={language} />
}

export default ShopAcercaPage
