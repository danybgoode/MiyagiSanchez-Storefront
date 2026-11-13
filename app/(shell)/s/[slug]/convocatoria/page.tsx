import { getLanguagePreference } from '@/lib/site-language-server'
import { BuyerCopyText } from '@/app/components/BuyerPresentationContext'
import Link from 'next/link'
import type { Metadata } from 'next'
import { isEnabled } from '@/lib/flags'
import { getLaunchpadShopBySlug } from '@/lib/launchpad'
import { isShopPreviewPrivateBySlug } from '@/lib/preview-access'
import { MAX_MANUSCRIPT_SIZE_MB } from '@/lib/launchpad-types'
import ConvocatoriaClient from './ConvocatoriaClient'
import { getShop } from '@/lib/listings'
import { readPublicSellerMarket } from '@/lib/owned-market'
import { marketCatalogCanonical } from '@/lib/market-seo'
import type { MarketCode } from '@/lib/markets'
import { getDictionary } from '@/lib/dictionary'
import { resolveMarketPresentation } from '@/lib/market-presentation'

export const dynamic = 'force-dynamic'

export async function generateConvocatoriaMetadata({
  params,
  market,
  marketBasePath = '',
}: {
  params: Promise<{ slug: string }>
  market?: MarketCode
  marketBasePath?: string
}): Promise<Metadata> {
  const { slug } = await params
  const [launchpadShop, shop] = await Promise.all([getLaunchpadShopBySlug(slug), getShop(slug, market)])
  if (market && readPublicSellerMarket(shop)?.market_code !== market) {
    return { title: 'Convocatoria', robots: { index: false } }
  }
  return {
    title: launchpadShop ? `Convocatoria — ${launchpadShop.name}` : 'Convocatoria',
    robots: { index: false },
    ...(marketBasePath ? marketCatalogCanonical(`${marketBasePath}/s/${slug}/convocatoria`) : {}),
  }
}

export const generateMetadata = generateConvocatoriaMetadata

function StateMessage({ title, body }: { title: string; body: string }) {
  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-12 bg-[var(--color-background)]">
      <div className="max-w-md w-full border border-[var(--color-border)] rounded-xl p-6 text-center">
        <Link href="/" className="text-xs text-[var(--color-muted)] no-underline hover:underline"><BuyerCopyText copyKey="s.slug.convocatoria.page.d51591f3" /></Link>
        <h1 className="mt-4 text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)] leading-6">{body}</p>
      </div>
    </main>
  )
}

export async function ConvocatoriaPage({
  params,
  market,
  marketBasePath = '',
}: {
  params: Promise<{ slug: string }>
  market?: MarketCode
  marketBasePath?: string
}) {
  const { slug } = await params
  const [enabled, shop, seller] = await Promise.all([
    isEnabled('launchpad.enabled'),
    getLaunchpadShopBySlug(slug),
    getShop(slug, market),
  ])
  const presentationMarket = market ?? readPublicSellerMarket(seller)?.market_code ?? 'mx'
  const copy = (await getDictionary(resolveMarketPresentation(presentationMarket, await getLanguagePreference()).language)).buyerCopy

  if (!enabled) {
    return <StateMessage title={copy['s.slug.convocatoria.page.d8d969db']} body={copy['shop.submissionsUnavailableBody']} />
  }
  if (!shop) {
    return <StateMessage title={copy['s.slug.convocatoria.page.22c71655']} body={copy['shop.checkLinkBody']} />
  }
  if (market && readPublicSellerMarket(seller)?.market_code !== market) {
    return <StateMessage title={copy['s.slug.convocatoria.page.22c71655']} body={copy['shop.checkLinkBody']} />
  }
  // Consent-safe previews: this is the ONE shop sub-page middleware rewrites onto
  // the subdomain + custom-domain channels, so a preview-private shop would
  // otherwise leak its name on all three. Same copy as an unknown shop.
  // clerk_user_id: null — LaunchpadShop doesn't carry it, and a launchpad portal
  // is only enabled on a claimed, set-up shop, so a preview-private (unclaimed)
  // shop can't reach this; the by-id path still re-reads clerk_user_id.
  if (await isShopPreviewPrivateBySlug(slug, null)) {
    return <StateMessage title={copy['s.slug.convocatoria.page.22c71655']} body={copy['shop.checkLinkBody']} />
  }
  if (!shop.acceptsManuscripts) {
    return (
      <StateMessage
        title={copy['s.slug.convocatoria.page.45829866'].replace('{0}', shop.name)}
        body={copy['shop.noOpenSubmissionsBody']}
      />
    )
  }

  return (
    <main className="min-h-screen bg-[var(--color-background)]">
      <div className="max-w-2xl mx-auto px-4 py-6 sm:py-10">
        <div className="mb-6">
          <Link href={`${marketBasePath}/s/${shop.slug}`} className="text-sm text-[var(--color-muted)] no-underline hover:underline">
            ← {shop.name}
          </Link>
          <h1 className="text-3xl sm:text-4xl font-bold mt-3 leading-tight"><BuyerCopyText copyKey="s.slug.convocatoria.page.1194d92b" /></h1>
          <p className="text-base text-[var(--color-muted)] leading-7 mt-2">
            {shop.name} <BuyerCopyText copyKey="s.slug.convocatoria.page.b9c06d3a" /></p>
        </div>

        <ConvocatoriaClient
          slug={shop.slug}
          shopName={shop.name}
          guidelines={shop.guidelines}
          maxSizeMb={MAX_MANUSCRIPT_SIZE_MB}
        />

        <div className="mt-6 border border-[var(--color-border)] rounded-xl p-5">
          <h3 className="font-semibold text-sm mb-2"><BuyerCopyText copyKey="s.slug.convocatoria.page.fd1018d4" /></h3>
          <p className="text-xs leading-5 text-[var(--color-muted)] whitespace-pre-line"><BuyerCopyText copyKey="shop.manuscriptTerms" /></p>
          <p className="text-xs text-[var(--color-muted)] mt-3">
            <BuyerCopyText copyKey="s.slug.convocatoria.page.49e2830e" />{' '}
            <Link href="/terminos" className="underline"><BuyerCopyText copyKey="s.slug.convocatoria.page.a9e527dd" /></Link>.
          </p>
        </div>
      </div>
    </main>
  )
}

export default ConvocatoriaPage
