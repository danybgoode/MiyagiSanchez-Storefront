import type { Metadata } from 'next'
import es from '@/locales/es.json'
import { getOverriddenDictionary } from '@/lib/copy-overrides'
import { SellerAcquisitionPage } from '@/app/(shell)/mx/vende/_components/SellerAcquisitionSections'
import { buildUsMarketPageConfig } from '@/app/(shell)/mx/vende/_components/page-config'
import DescribeBox from '@/app/(shell)/mx/vende/_components/DescribeBox'
import Link from 'next/link'

/**
 * `/us/vende` — the US landing, told in Spanish (epic one-front-door-both-markets D17, product owner 2026-11-12:
 * "spanish for US yes").
 *
 * Same US money truth as `/us/sell` — dollars, the merchant's own Stripe account, no SPEI, no Mercado Pago — read from
 * the `sellerAcquisition.us` block of `es.json`, which was already written against that truth. The builder here makes
 * US shops: the describe box hints `us`, and the claim still asks (D13).
 *
 * It sits in `(us-site)`, so the chrome around it is the US market's English chrome; the page body is marked
 * `lang="es"`. A Spanish US chrome is a larger change (the market document sets `<html lang>`), recorded in the epic
 * README as a deviation. Rendered per request for the describe box's runtime `TURNSTILE_SITE_KEY`.
 */
export const dynamic = 'force-dynamic'

const BASE_URL = 'https://miyagisanchez.com'
const meta = es.sellerAcquisition.us.metadata

export const metadata: Metadata = {
  title: meta.title,
  description: meta.description,
  alternates: {
    canonical: `${BASE_URL}/us/vende`,
    languages: { 'es-US': `${BASE_URL}/us/vende`, 'en-US': `${BASE_URL}/us/sell` },
  },
  openGraph: { type: 'website', locale: 'es_US', url: `${BASE_URL}/us/vende`, siteName: 'Miyagi Sánchez', title: meta.title, description: meta.description },
  robots: { index: true, follow: true },
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

export default async function UnitedStatesVendePage({ searchParams }: Props) {
  const query = await searchParams
  const ui = (await getOverriddenDictionary('es')).sellerAcquisition
  const config = buildUsMarketPageConfig(ui, query)
  return (
    <div lang="es">
      <SellerAcquisitionPage
        config={{
          ...config,
          pageId: 'us-vende',
          describe: <DescribeBox siteKey={process.env.TURNSTILE_SITE_KEY || null} manualHref={config.primaryCta?.href ?? '/sell?market=us'} locale="es" marketHint="us" />,
        }}
      />
      <p className="app-shell t-small" style={{ textAlign: 'center', paddingBottom: 'var(--s-8)' }}>
        <Link href="/us/sell" hrefLang="en-US" prefetch={false} data-testid="us-vende-english">Read this page in English</Link>
      </p>
    </div>
  )
}
