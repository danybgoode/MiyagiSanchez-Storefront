import { notFound, permanentRedirect } from 'next/navigation'
import { getShop } from '@/lib/listings'
import { assertShopNotPreviewPrivate, isShopPreviewPrivateBySlug } from '@/lib/preview-access'
import { isLikelyShopSlug } from '@/lib/route-shape'
import { getSlugRedirect } from '@/lib/slug-redirect'
import { getActiveCustomDomain } from '@/lib/custom-domain'
import { readPublicSellerMarket } from '@/lib/owned-market'
import { marketCatalogCanonical } from '@/lib/market-seo'
import PoliticasBody from '../../../_shop-content/PoliticasBody'
import type { MarketCode } from '@/lib/markets'
import type { SiteLanguage } from '@/lib/site-language'
import type { Metadata } from 'next'
import { getDictionary } from '@/lib/dictionary'
import { resolveMarketPresentation } from '@/lib/market-presentation'

export async function generateShopPoliciesMetadata({
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
    title: `${market === 'us' ? 'Policies' : 'Políticas'} — ${shop.name}`,
    ...(marketBasePath ? marketCatalogCanonical(`${marketBasePath}/s/${slug}/politicas`) : {}),
  }
}

export const generateMetadata = generateShopPoliciesMetadata

// Marketplace path: /s/[slug]/politicas. On subdomain/custom domain this route
// is never reached (middleware's boundary-isolation deny-list redirects /s/*
// home there) — the channel path is app/(shell)/politicas/page.tsx.
export async function ShopPoliticasPage({
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
    if (current) permanentRedirect(`${marketBasePath}/s/${current}/politicas`)
    notFound()
  }
  if (market && readPublicSellerMarket(shop)?.market_code !== market) notFound()
  // Consent-safe previews: never render a preview-private shop's shell.
  await assertShopNotPreviewPrivate(shop)

  if (!marketBasePath) {
    const domain = await getActiveCustomDomain(shop.slug)
    if (domain) permanentRedirect(`https://${domain}/politicas`)
  }

  const presentationMarket = market ?? readPublicSellerMarket(shop)?.market_code ?? 'mx'
  const buyerCopy = (await getDictionary(resolveMarketPresentation(presentationMarket, language).language)).buyerCopy
  const settings = ((shop.metadata as Record<string, unknown> | null)?.settings ?? {}) as Record<string, unknown>
  const returnsPolicy = settings.returns_policy as { window?: string } | null | undefined
  const returnsLabel = returnsPolicy?.window === '7d' ? buyerCopy['listing.returnWindow7']
    : returnsPolicy?.window === '14d' ? buyerCopy['listing.returnWindow14']
    : returnsPolicy?.window === '30d' ? buyerCopy['listing.returnWindow30']
    : undefined
  return <PoliticasBody shop={shop} basePath={`${marketBasePath}/s/${shop.slug}`} language={language} returnsLabel={returnsLabel} />
}

export default ShopPoliticasPage
