import type { Metadata } from 'next'
import es from '@/locales/es.json'
import { getOverriddenDictionary } from '@/lib/copy-overrides'
import { sellerPersonaCtaHref, sellerLandingPath } from '@/lib/seller-acquisition'
import { SellerAcquisitionPage } from '@/app/(shell)/mx/vende/_components/SellerAcquisitionSections'
import { buildAnchorPageConfig } from '@/app/(shell)/mx/vende/_components/page-config'
import DescribeBox from '@/app/(shell)/mx/vende/_components/DescribeBox'
import RootMarketLinks from './RootMarketLinks'

/**
 * `/` — the Mexico shop builder. Epic root-shop-builder-home (D1).
 *
 * `miyagisanchez.com` is the address that gets said out loud, printed and handed over by
 * promoters, and until this epic it opened on a country picker that never showed the offer:
 * the describe box lived at `/mx/vende`, a URL nobody guesses. So the anchor seller page moved
 * HERE (moved, not copied — `/mx/vende` is now a 308 to `/` in `next.config.ts`), and the
 * marketplace became one tap away at `/mx`.
 *
 * The country picker did not disappear: `/en` still renders it (`MarketSelector`, untouched by
 * product-owner decision), and the strip at the end of this page links México · Estados Unidos ·
 * English. What `/` no longer does is HOP: the selector moved English browsers to `/en`, and an
 * `en-MX` phone — common in Mexico — would have skipped the pitch entirely (D5).
 *
 * Rendered per request (D2), like `/mx/vende` was: it reads the A/B `v` and UTM from
 * `searchParams`, and the describe box needs `TURNSTILE_SITE_KEY` at RUNTIME (prompt-to-shop D8),
 * not baked at build. Measured live before the move (2026-10-29, cache-busted): static `/`
 * ≈ 0.28 s TTFB, dynamic `/mx/vende` ≈ 0.31 s. `force-dynamic` rather than an implicit dynamic
 * render because it also ends the CDN-pinning bug class on this route for good: no `s-maxage`
 * means Cloudflare never stores the HTML whose build-hashed chunks the next deploy deletes
 * (2026-08-06, an unstyled homepage for 7 days).
 */
export const dynamic = 'force-dynamic'

const BASE_URL = 'https://miyagisanchez.com'
const PAGE_PATH = sellerLandingPath('mx')

const meta = es.sellerAcquisition.anchor.metadata

// No `languages` alternates on purpose (D3): `/` and `/en` are no longer the same document in
// two languages, so an hreflang pair would tell crawlers something false. The OG image is the
// sibling `opengraph-image.tsx` file convention, which hashes the served route.
export const metadata: Metadata = {
  // `absolute`: the title already ends with the brand; a layout template must not append it twice.
  title: { absolute: meta.title },
  description: meta.description,
  alternates: { canonical: `${BASE_URL}${PAGE_PATH}` },
  openGraph: {
    type: 'website',
    locale: 'es_MX',
    url: `${BASE_URL}${PAGE_PATH}`,
    siteName: 'Miyagi Sánchez',
    title: meta.title,
    description: meta.description,
  },
  twitter: {
    card: 'summary_large_image',
    title: meta.title,
    description: meta.description,
  },
}

type HomePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const query = await searchParams
  const dict = await getOverriddenDictionary('es')
  const ui = dict.sellerAcquisition
  const config = buildAnchorPageConfig(ui, query)

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: meta.title,
    description: meta.description,
    url: `${BASE_URL}${PAGE_PATH}`,
    inLanguage: 'es-MX',
    isPartOf: {
      '@type': 'WebSite',
      name: 'Miyagi Sánchez',
      url: BASE_URL,
    },
    potentialAction: {
      '@type': 'CreateAction',
      name: ui.anchor.primaryCta,
      target: `${BASE_URL}${sellerPersonaCtaHref('vende', query)}`,
    },
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <SellerAcquisitionPage
        config={{
          ...config,
          // Prompt-to-shop S2.2: the describe box is the hero's first action.
          describe: <DescribeBox siteKey={process.env.TURNSTILE_SITE_KEY || null} manualHref={config.primaryCta?.href ?? '/sell'} />,
        }}
      />
      <RootMarketLinks copy={ui.anchor.marketLinks} />
    </>
  )
}
