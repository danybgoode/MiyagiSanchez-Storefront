import type { Metadata } from 'next'
import es from '@/locales/es.json'
import { getOverriddenDictionary } from '@/lib/copy-overrides'
import { sellerPersonaCtaHref } from '@/lib/seller-acquisition'
import { SellerAcquisitionPage } from './_components/SellerAcquisitionSections'
import { buildAnchorPageConfig } from './_components/page-config'
import DescribeBox from './_components/DescribeBox'

const BASE_URL = 'https://miyagisanchez.com'
const PAGE_PATH = '/mx/vende'

const meta = es.sellerAcquisition.anchor.metadata

// No manual `images` field here — the sibling `opengraph-image.tsx` in this same route
// segment is auto-detected by Next's file-convention metadata resolution (like the root
// layout's og:image), which correctly hashes the actual served route. A hardcoded
// `${PAGE_PATH}/opengraph-image` URL 404s: Next serves these at a content-hashed path
// (e.g. `/mx/vende/opengraph-image-<hash>`), not the bare convention path.
export const metadata: Metadata = {
  title: meta.title,
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

type VendePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function VendePage({ searchParams }: VendePageProps) {
  const query = await searchParams
  const ui = (await getOverriddenDictionary('es')).sellerAcquisition
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
          // Prompt-to-shop S2.2: the describe box is the hero's first action. The site key is a RUNTIME env read
          // here (D8), not NEXT_PUBLIC, so this page must stay dynamic — it is, through `searchParams`.
          describe: <DescribeBox siteKey={process.env.TURNSTILE_SITE_KEY || null} manualHref={config.primaryCta?.href ?? '/sell'} />,
        }}
      />
    </>
  )
}
