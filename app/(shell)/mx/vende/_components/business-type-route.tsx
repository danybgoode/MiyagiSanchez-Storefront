import type { Metadata } from 'next'
import { getOverriddenDictionary } from '@/lib/copy-overrides'
import {
  BUSINESS_TYPE_PAGES,
  businessTypePath,
  type NewBusinessTypeSlug,
} from '@/lib/business-types'
import { SellerAcquisitionPage } from './SellerAcquisitionSections'
import { buildBusinessTypePageConfig } from './page-config'
import { createSellerAcquisitionOgImage } from './SellerAcquisitionOgImage'

/**
 * The shared body of the eight business-type routes written in `lib/business-types.ts` (own-shop-positioning S3.1).
 * Each `/mx/vende/<slug>/page.tsx` is three lines that call these, so the eight cannot drift apart — and each keeps
 * its own folder, exactly like the existing verticals (`autos`, `servicios`), so its `opengraph-image.tsx` is picked
 * up by Next's file convention (a hand-built `…/opengraph-image` URL 404s: Next serves a content-hashed path).
 */

const BASE_URL = 'https://miyagisanchez.com'

export function businessTypeMetadata(slug: NewBusinessTypeSlug): Metadata {
  const page = BUSINESS_TYPE_PAGES[slug]
  const url = `${BASE_URL}${businessTypePath(slug)}`
  return {
    title: page.metaTitle,
    description: page.metaDescription,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      locale: 'es_MX',
      url,
      siteName: 'Miyagi Sánchez',
      title: page.metaTitle,
      description: page.metaDescription,
    },
    twitter: { card: 'summary_large_image', title: page.metaTitle, description: page.metaDescription },
  }
}

export async function renderBusinessTypePage(
  slug: NewBusinessTypeSlug,
  searchParams: Promise<Record<string, string | string[] | undefined>>,
) {
  const query = await searchParams
  const ui = (await getOverriddenDictionary('es')).sellerAcquisition
  const config = buildBusinessTypePageConfig(ui, slug, query)
  const page = BUSINESS_TYPE_PAGES[slug]
  const url = `${BASE_URL}${businessTypePath(slug)}`

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: page.metaTitle,
    description: page.metaDescription,
    url,
    inLanguage: 'es-MX',
    isPartOf: { '@type': 'WebSite', name: 'Miyagi Sánchez', url: BASE_URL },
  }

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SellerAcquisitionPage config={config} />
    </>
  )
}

export function businessTypeOgAlt(slug: NewBusinessTypeSlug): string {
  return BUSINESS_TYPE_PAGES[slug].ogAlt
}

export function businessTypeOgImage(slug: NewBusinessTypeSlug) {
  const page = BUSINESS_TYPE_PAGES[slug]
  return createSellerAcquisitionOgImage({
    eyebrow: page.eyebrow,
    title: page.heroTitle,
    lead: page.heroLead,
    path: businessTypePath(slug),
    tags: [...page.ogTags],
  })
}
