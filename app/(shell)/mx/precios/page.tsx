import type { Metadata } from 'next'
import Link from 'next/link'
import es from '@/locales/es.json'
import { getOverriddenDictionary } from '@/lib/copy-overrides'
import { getPricingCatalog } from '@/lib/pricing-catalog-server'
import { contactMailto } from '@/lib/contact'
import type { ExtraRow, PricingCatalog } from '@/lib/pricing-catalog'
import { PreciosTrackedLink, PreciosViewed } from './_components/PreciosTracking'

/**
 * `/mx/precios` — what selling on Miyagi Sánchez costs (epic 08 · pricing-page, S1.2; README D6).
 * Every number on this page comes from `lib/pricing-catalog.ts`; the copy holds none.
 *
 * No `revalidate`: everything under `app/(shell)` renders per request (the shell reads
 * headers and the Clerk session), so the page is served `no-store` and an admin price
 * change shows on the next request. `e2e/revalidate-truth.spec.ts` rejects a `revalidate`
 * this route group cannot honour — the lock's D6 assumed otherwise.
 */

const BASE_URL = 'https://miyagisanchez.com'
const PAGE_PATH = '/mx/precios'
const meta = es.precios.metadata

// No manual `images` — the sibling opengraph-image.tsx is picked up by Next's file convention.
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
  twitter: { card: 'summary_large_image', title: meta.title, description: meta.description },
}

/** JSON-LD `Offer`s for fixed-price extras only (D9) — an admin-set price never gets one. */
function offersJsonLd(catalog: PricingCatalog) {
  const offers = catalog.extras
    .filter((r) => r.kind === 'fixed')
    .flatMap((r) => [
      ...(r.yearlyMxn != null
        ? [{ name: `${r.name.es} (anual)`, price: r.yearlyMxn, unit: 'ANN' }]
        : []),
      ...(r.monthlyMxn != null
        ? [{ name: `${r.name.es} (mensual)`, price: r.monthlyMxn, unit: 'MON' }]
        : []),
    ])
    .map((o) => ({
      '@type': 'Offer',
      name: o.name,
      price: String(o.price),
      priceCurrency: 'MXN',
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: String(o.price),
        priceCurrency: 'MXN',
        unitCode: o.unit,
      },
    }))
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: meta.title,
    description: meta.description,
    url: `${BASE_URL}${PAGE_PATH}`,
    inLanguage: 'es-MX',
    isPartOf: { '@type': 'WebSite', name: 'Miyagi Sánchez', url: BASE_URL },
    mainEntity: { '@type': 'OfferCatalog', name: 'Extras opcionales de Miyagi Sánchez', itemListElement: offers },
  }
}

function formatVerifiedAt(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('es-MX', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function ExtraCard({ row, ui }: { row: ExtraRow; ui: typeof es.precios.extras }) {
  return (
    <article className="card-panel" data-testid={`precios-extra-${row.sku}`} style={{ padding: 'var(--s-5)', display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
      <span className={row.quoted ? 'badge' : 'badge badge-success'} style={{ alignSelf: 'flex-start' }}>
        {row.quoted ? ui.quotedBadge : ui.fixedBadge}
      </span>
      <h3 className="t-h4" style={{ letterSpacing: 0, margin: 0 }}>{row.name.es}</h3>
      <p className="t-h4" data-testid={`precios-extra-${row.sku}-price`} style={{ letterSpacing: 0, margin: 0, color: 'var(--accent)' }}>
        {row.priceLabel.es}
      </p>
      <p className="t-small" style={{ color: 'var(--fg-muted)', margin: 0 }}>{row.description.es}</p>
      {row.quoted ? (
        <a href={contactMailto(`Precio: ${row.name.es}`)} className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start', marginTop: 'var(--s-2)' }}>
          {ui.quotedCta}
          <i className="iconoir-mail" aria-hidden="true" />
        </a>
      ) : null}
    </article>
  )
}

const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 'var(--s-3)' } as const
const SECTION = { marginBottom: 'var(--s-10)' } as const

export default async function PreciosPage() {
  const [dict, catalog] = await Promise.all([getOverriddenDictionary('es'), getPricingCatalog()])
  const ui = dict.precios

  return (
    <main className="app-shell" data-testid="precios-page" style={{ paddingTop: 'var(--s-8)', paddingBottom: 'var(--s-10)' }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(offersJsonLd(catalog)) }} />
      <PreciosViewed />

      <header style={{ ...SECTION, maxWidth: 'var(--measure-prose)' }}>
        <p className="t-small" style={{ color: 'var(--accent)', fontWeight: 600, marginBottom: 'var(--s-2)' }}>{ui.eyebrow}</p>
        <h1 className="t-h1" style={{ letterSpacing: 0, marginBottom: 'var(--s-3)' }}>{ui.heroTitle}</h1>
        <p className="t-lead" style={{ marginBottom: 'var(--s-5)' }}>{ui.heroLead}</p>
        <PreciosTrackedLink href="/mx/vende" event="precios_signup_clicked" className="btn btn-primary btn-lg" testId="precios-primary-cta">
          {ui.primaryCta}
          <i className="iconoir-arrow-right" aria-hidden="true" />
        </PreciosTrackedLink>
      </header>

      <section aria-labelledby="precios-free-title" data-testid="precios-free" style={SECTION}>
        <h2 id="precios-free-title" className="t-h2" style={{ letterSpacing: 0, marginBottom: 'var(--s-2)' }}>{ui.free.title}</h2>
        <p className="t-lead" style={{ color: 'var(--fg-muted)', marginBottom: 'var(--s-5)' }}>{ui.free.lead}</p>
        <div style={GRID}>
          {catalog.free.map((item) => (
            <article key={item.id} className="card-panel" style={{ padding: 'var(--s-5)' }}>
              <i className={item.icon} aria-hidden="true" style={{ color: 'var(--accent)', fontSize: 24, display: 'block', marginBottom: 'var(--s-3)' }} />
              <h3 className="t-h4" style={{ letterSpacing: 0, marginBottom: 'var(--s-1)' }}>{item.title.es}</h3>
              <p className="t-small" style={{ color: 'var(--fg-muted)', margin: 0 }}>{item.body.es}</p>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="precios-extras-title" data-testid="precios-extras" style={SECTION}>
        <h2 id="precios-extras-title" className="t-h2" style={{ letterSpacing: 0, marginBottom: 'var(--s-2)' }}>{ui.extras.title}</h2>
        <p className="t-lead" style={{ color: 'var(--fg-muted)', marginBottom: 'var(--s-5)' }}>{ui.extras.lead}</p>
        <div style={GRID}>
          {catalog.extras.map((row) => <ExtraCard key={row.sku} row={row} ui={ui.extras} />)}
        </div>
      </section>

      <section aria-labelledby="precios-processors-title" data-testid="precios-processors" style={SECTION}>
        <h2 id="precios-processors-title" className="t-h2" style={{ letterSpacing: 0, marginBottom: 'var(--s-2)' }}>{ui.processors.title}</h2>
        <p className="t-lead" style={{ color: 'var(--fg-muted)', marginBottom: 'var(--s-5)', maxWidth: 'var(--measure-prose)' }}>{ui.processors.lead}</p>
        <div style={GRID}>
          {catalog.processors.map((p) => (
            <article key={p.id} className="card-panel" data-testid={`precios-processor-${p.id}`} style={{ padding: 'var(--s-5)', display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
              <h3 className="t-h4" style={{ letterSpacing: 0, margin: 0 }}>{p.name}</h3>
              <p style={{ fontWeight: 600, margin: 0 }}>{p.rateLabel.es}</p>
              <p className="t-small" style={{ color: 'var(--fg-muted)', margin: 0 }}>{p.note.es}</p>
              {p.source && p.verifiedAt ? (
                <p className="t-small" style={{ color: 'var(--fg-muted)', margin: 0 }}>
                  {ui.processors.sourceLabel}:{' '}
                  <a href={p.source} rel="noopener noreferrer" target="_blank" style={{ color: 'var(--accent)' }}>
                    {new URL(p.source).hostname.replace(/^www\./, '')}
                  </a>
                  , {ui.processors.verifiedLabel} {formatVerifiedAt(p.verifiedAt)}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="precios-compare-title" data-testid="precios-compare" style={SECTION}>
        <article className="card-panel" style={{ padding: 'var(--s-6)', display: 'flex', flexWrap: 'wrap', gap: 'var(--s-5)', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ maxWidth: 560 }}>
            <h2 id="precios-compare-title" className="t-h3" style={{ letterSpacing: 0, marginBottom: 'var(--s-2)' }}>{ui.compare.title}</h2>
            <p className="t-lead" style={{ color: 'var(--fg-muted)', margin: 0 }}>{ui.compare.body}</p>
          </div>
          <PreciosTrackedLink href="/comparador" event="precios_comparador_clicked" className="btn btn-secondary" testId="precios-compare-cta">
            {ui.compare.cta}
            <i className="iconoir-arrow-right" aria-hidden="true" />
          </PreciosTrackedLink>
        </article>
      </section>

      <section aria-labelledby="precios-faq-title" data-testid="precios-faq" style={{ ...SECTION, maxWidth: 'var(--measure-prose)' }}>
        <h2 id="precios-faq-title" className="t-h2" style={{ letterSpacing: 0, marginBottom: 'var(--s-4)' }}>{ui.faq.title}</h2>
        {ui.faq.items.map((item) => (
          <details key={item.q} className="card-panel" style={{ padding: 'var(--s-4)', marginBottom: 'var(--s-3)' }}>
            <summary style={{ fontWeight: 600, cursor: 'pointer' }}>{item.q}</summary>
            <p className="t-small" style={{ color: 'var(--fg-muted)', margin: 'var(--s-2) 0 0' }}>{item.a}</p>
          </details>
        ))}
      </section>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-3)' }}>
        <PreciosTrackedLink href="/mx/vende" event="precios_signup_clicked" className="btn btn-primary btn-lg" testId="precios-closing-cta">
          {ui.primaryCta}
          <i className="iconoir-arrow-right" aria-hidden="true" />
        </PreciosTrackedLink>
        <Link href="/acerca" className="btn btn-secondary btn-lg" prefetch={false}>
          {dict.buyerShell.footer.about}
        </Link>
      </div>
    </main>
  )
}
