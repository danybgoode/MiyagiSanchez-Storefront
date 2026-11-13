import type { Metadata } from 'next'
import en from '@/locales/en.json'
import { getOverriddenDictionary } from '@/lib/copy-overrides'
import { usSellerCtaHref } from '@/lib/seller-acquisition'
import { SellerAcquisitionPage } from '@/app/(shell)/mx/vende/_components/SellerAcquisitionSections'
import { buildUsMarketPageConfig } from '@/app/(shell)/mx/vende/_components/page-config'
import DescribeBox from '@/app/(shell)/mx/vende/_components/DescribeBox'
import { LANDING_EXAMPLES } from '@/lib/prompt-to-shop/landing-examples'
import Link from 'next/link'

/**
 * `/us/sell` — the US merchant landing, with a URL of its own.
 *
 * ── Why this route exists ────────────────────────────────────────────────────
 * This page shipped in PR 389 with no URL. It rendered ONLY as the signed-out branch
 * of `/sell` when the request happened to carry `?market=us`, which meant:
 *
 *   · `/sell` — the URL a person types, shares or prints — served the MEXICAN
 *     hero to a US merchant, in Spanish, promising SPEI and Mercado Pago;
 *   · the page could not be linked from an ad, an email or the US chrome's own
 *     "Post for free" button without hand-appending a query parameter;
 *   · its canonical was `…/sell?market=us`, so the indexable US landing was a
 *     query string hanging off a route whose default content is a different
 *     page in a different language.
 *
 * A market's landing now sits under that market's prefix, beside `/mx/vende`. The
 * URL states the market, and the market chrome — `(us-site)`'s English shell,
 * `<html lang="en-US">`, English Clerk localization — follows from the route
 * instead of from a parameter that any link could drop.
 *
 * ── English, not the visitor's stored preference ─────────────────────────────
 * `getOverriddenDictionary('en')` is literal here, and that is NOT the hardcoded
 * locale PR 389 removed from `/sell`. That one ignored a signed-in seller's own
 * explicit Spanish choice inside their portal. This is a public marketing page on
 * the US market root: it is served under English chrome by its layout, its
 * canonical and `og:locale` say `en_US`, and its copy is authored against US money
 * truth. Rendering its body in Spanish inside an English shell would be neither
 * language done properly. A Spanish-speaking merchant selling in Mexico belongs on
 * `/mx/vende`, which the root selector and the market chrome both offer.
 *
 * ── The CTA still converts on `/sign-up` ─────────────────────────────────────
 * `usSellerCtaHref` is unchanged: account creation first, with `market=us`, the
 * A/B `v` and every sanitized UTM preserved INSIDE `redirect_url` so the new
 * seller reaches the wizard with the attribution the CTA carried. The market is
 * immutable after shop creation (us-marketplace S5.2 · D17), so that parameter
 * surviving Clerk is what makes this landing produce US shops rather than Mexican
 * ones.
 */

/**
 * Bounds the CDN TTL, and that is the whole reason it is here.
 *
 * A prerendered page in a static route group with no `revalidate` is served with
 * `s-maxage=31536000`, so Cloudflare can keep serving HTML whose build-hashed
 * `/_next/static/chunks/*` are deleted by the next Cloud Run revision — that is
 * exactly how `/` shipped an unstyled homepage on 2026-08-06. This page reads
 * `searchParams` (UTM, the A/B `v`) so it renders per request anyway; the export
 * is what keeps the edge from pinning a stale document if that ever changes.
 * `e2e/market-route-population.spec.ts` guards the whole `*-site` population, and
 * it is what caught this file.
 */
export const revalidate = 60

const BASE_URL = 'https://miyagisanchez.com'
const PAGE_PATH = '/us/sell'

const meta = en.sellerAcquisition.us.metadata

// No manual `images` field — the sibling `opengraph-image.tsx` is auto-detected by
// Next's file-convention metadata resolution. A hardcoded `${PAGE_PATH}/opengraph-image`
// URL 404s: Next serves these at a content-hashed path.
export const metadata: Metadata = {
  title: meta.title,
  description: meta.description,
  alternates: { canonical: `${BASE_URL}${PAGE_PATH}`, languages: { "en-US": `${BASE_URL}${PAGE_PATH}`, "es-US": `${BASE_URL}/us/vende` } },
  openGraph: {
    type: 'website',
    locale: 'en_US',
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
  robots: { index: true, follow: true },
}

type UnitedStatesSellPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function UnitedStatesSellPage({ searchParams }: UnitedStatesSellPageProps) {
  const query = await searchParams
  const ui = (await getOverriddenDictionary('en')).sellerAcquisition
  const config = buildUsMarketPageConfig(ui, query)

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: meta.title,
    description: meta.description,
    url: `${BASE_URL}${PAGE_PATH}`,
    inLanguage: 'en-US',
    isPartOf: {
      '@type': 'WebSite',
      name: 'Miyagi Sánchez',
      url: BASE_URL,
    },
    potentialAction: {
      '@type': 'CreateAction',
      name: ui.us.primaryCta,
      target: `${BASE_URL}${usSellerCtaHref(query)}`,
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
          // one-front-door-both-markets S2.4/S3.1 — the builder is the hero here too, and it makes US shops.
          describe: <DescribeBox siteKey={process.env.TURNSTILE_SITE_KEY || null} manualHref={config.primaryCta?.href ?? '/sell?market=us'} locale="en" marketHint="us" examples={LANDING_EXAMPLES['us']} />,
        }}
      />
      <p className="app-shell t-small" style={{ textAlign: 'center', paddingBottom: 'var(--s-8)' }}>
        <Link href="/us/vende" hrefLang="es-US" prefetch={false} data-testid="us-sell-spanish">Lee esta página en español</Link>
      </p>
    </>
  )
}
