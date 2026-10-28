import type { Metadata } from 'next'
import Link from 'next/link'
import { getComparatorDataset } from '@/lib/cost-comparator-data'
import {
  shopifyRatesFromDataset,
  mercadoLibreRatesFromDataset,
  wooCommerceRatesFromDataset,
  tiendanubeRatesFromDataset,
  t1RatesFromDataset,
  miyagiRatesFromDataset,
  premiumAppsFromDataset,
  fxUsdToMxnFromDataset,
} from '@/lib/cost-comparator-dataset'
import { parseComparadorState } from '@/lib/cost-comparator-url'
import ComparadorTool, { type ComparadorInitial } from './_components/ComparadorTool'
import ComparadorAnalytics from './_components/ComparadorAnalytics'

const BASE_URL = 'https://miyagisanchez.com'
const PAGE_PATH = '/comparador'

const TITLE = 'Comparador de costos — Miyagi Sánchez vs. Shopify, Mercado Libre, WooCommerce, Tiendanube y T1'
const DESCRIPTION =
  'Compara lo que pagas hoy en Shopify, Mercado Libre, WooCommerce, Tiendanube o T1 contra Miyagi Sánchez (0% comisión) — con tus propios números de ventas.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: `${BASE_URL}${PAGE_PATH}` },
  openGraph: {
    type: 'website',
    locale: 'es_MX',
    url: `${BASE_URL}${PAGE_PATH}`,
    siteName: 'Miyagi Sánchez',
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
  },
}

type ComparadorPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function formatVerifiedDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${iso}T00:00:00`))
  } catch {
    return iso
  }
}

/**
 * Comparador de costos (epic 08 · cost-comparator-homepage, Sprint 1 · US-1.3) —
 * an anonymous, mobile-first calculator. Reads `searchParams` (query-string
 * prefill: `?platform=shopify&tier=basico&volume=100&aov=500`) so a linked-to
 * comparison renders its exact numbers in the initial server HTML — no client
 * JS required to see the right totals (the `e2e/comparador.spec.ts` `api`
 * project spec depends on this: it's a raw HTTP GET, no browser).
 *
 * `/` (the homepage) stays static — this route is intentionally NOT under the
 * `(site)` group, so reading `searchParams` here can't taint the homepage's
 * prerender (see `e2e/home-static.spec.ts` / `home-comparador-teaser.spec.ts`).
 */
export default async function ComparadorPage({ searchParams }: ComparadorPageProps) {
  const sp = await searchParams
  const dataset = await getComparatorDataset('es')

  const rates = {
    shopify: shopifyRatesFromDataset(dataset),
    mercadolibre: mercadoLibreRatesFromDataset(dataset),
    woocommerce: wooCommerceRatesFromDataset(dataset),
    tiendanube: tiendanubeRatesFromDataset(dataset),
    t1: t1RatesFromDataset(dataset),
    miyagi: miyagiRatesFromDataset(dataset),
  }
  const apps = premiumAppsFromDataset(dataset)
  const fx = fxUsdToMxnFromDataset(dataset)

  // US-2.2 — the same codec a "Copiar enlace" share button builds from, so a
  // consultant's prefilled link restores EXACTLY what they set (platform, tier/
  // band/type/hosting/gateway, volume, AOV, selected apps, Miyagi SKU toggles).
  const initial: ComparadorInitial = parseComparadorState(
    sp,
    apps.map((a) => a.id),
  )

  return (
    <div className="app-shell" style={{ paddingTop: 'var(--s-8)', paddingBottom: 'var(--s-10)', maxWidth: 720, margin: '0 auto', paddingLeft: 'var(--s-4)', paddingRight: 'var(--s-4)' }}>
      <ComparadorAnalytics />
      <div style={{ marginBottom: 'var(--s-6)' }}>
        <h1 className="t-h1" style={{ letterSpacing: 0, marginBottom: 'var(--s-2)', fontSize: 'clamp(var(--t-xl), 6vw, var(--t-3xl))' }}>
          Compara lo que pagas hoy contra Miyagi
        </h1>
        <p className="t-lead" style={{ color: 'var(--fg-muted)', marginBottom: 'var(--s-3)' }}>
          Con tus propios números — plataforma, volumen, ticket promedio y las apps que ya pagas.
        </p>
        <span className="badge badge-verified" data-testid="comparador-verified-date">
          Datos verificados: {formatVerifiedDate(dataset.generatedAt)}
        </span>
      </div>

      <ComparadorTool rates={rates} apps={apps} fx={fx} initial={initial} dataset={dataset} />

      <p className="t-caption" style={{ color: 'var(--fg-muted)', marginTop: 'var(--s-6)' }}>
        Comparación de referencia con tarifas públicas de cada plataforma — cada cifra es editable y muestra
        su fuente al pasar el cursor. Las tarifas cambian: pídele a tu IA que las confirme antes de decidir.
      </p>

      {/* pricing-page D10 — the back-link to the full Miyagi price list. */}
      <p className="t-small" style={{ marginTop: 'var(--s-4)' }}>
        <Link href="/mx/precios" data-testid="comparador-pricing-link" prefetch={false} style={{ color: 'var(--accent)' }}>
          Ver precios de Miyagi Sánchez <i className="iconoir-arrow-right" aria-hidden="true" />
        </Link>
      </p>
    </div>
  )
}
