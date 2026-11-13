import type { Metadata } from 'next'
import en from '@/locales/en.json'
import { getOverriddenDictionary } from '@/lib/copy-overrides'
import { rootSelectorMetadata } from '@/lib/market-seo'
import { GLOBAL_LANDING_EN } from '@/lib/global-landing-copy'
import { SellerAcquisitionPage } from '@/app/(shell)/mx/vende/_components/SellerAcquisitionSections'
import { buildGlobalEnglishPageConfig } from '@/app/(shell)/mx/vende/_components/page-config'
import DescribeBox from '@/app/(shell)/mx/vende/_components/DescribeBox'
import RootMarketLinks from '@/app/(site)/RootMarketLinks'

/**
 * `/en` — the shop builder, in English, for both markets (epic one-front-door-both-markets D16).
 *
 * Until this epic `/en` was the market picker, and `/` the Mexican builder: an English-reading merchant had to choose
 * a country before they could see what they would get. Now `/` and `/en` are the SAME page in two languages — the
 * builder first, the market chosen when the shop becomes theirs (D13) — so they name each other as hreflang
 * alternates again (reversing root-shop-builder-home D3, which held while they were different documents). The two
 * marketplaces and the Spanish document stay one tap away in the strip at the end.
 *
 * Rendered per request like `/` (`force-dynamic`): the describe box needs `TURNSTILE_SITE_KEY` at RUNTIME, and a
 * prerendered page would bake the build machine's empty value into it. It reads no request header: the language
 * comes from the route and its `(en-site)` layout, the hop from a client island (`lib/root-language.ts`).
 */
export const dynamic = 'force-dynamic'

const meta = GLOBAL_LANDING_EN.metadata

export const metadata: Metadata = {
  title: { absolute: meta.title },
  description: meta.description,
  ...rootSelectorMetadata('en'),
  openGraph: { type: 'website', locale: 'en_US', url: 'https://miyagisanchez.com/en', siteName: 'Miyagi Sánchez', title: meta.title, description: meta.description },
  twitter: { card: 'summary_large_image', title: meta.title, description: meta.description },
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

export default async function EnglishBuilderPage({ searchParams }: Props) {
  const query = await searchParams
  const dict = await getOverriddenDictionary('en')
  const config = buildGlobalEnglishPageConfig(dict.sellerAcquisition, query)
  return (
    <>
      <SellerAcquisitionPage
        config={{
          ...config,
          // No market: a visitor here may sell in either. The box asks the browser for a hint at the tap (D12).
          describe: <DescribeBox siteKey={process.env.TURNSTILE_SITE_KEY || null} manualHref="/sell" locale="en" />,
        }}
      />
      <RootMarketLinks copy={en.sellerAcquisition.anchor.marketLinks} language="en" />
    </>
  )
}
