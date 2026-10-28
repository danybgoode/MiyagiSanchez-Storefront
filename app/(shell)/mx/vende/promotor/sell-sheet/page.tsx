import type { Metadata } from 'next'
import { getOverriddenDictionary } from '@/lib/copy-overrides'
import { CUSTOM_DOMAIN_PRICE_MXN } from '@/lib/domain-pricing'
import { SUBDOMAIN_PRICE_YEARLY_MXN } from '@/lib/subdomain-pricing'
import { getPromoterSkuPrices } from '@/lib/promoter'
import { fillFixedPricingTokens } from '@/lib/pricing-catalog'

export const metadata: Metadata = {
  title: 'Manual del promotor',
  robots: { index: false },
}

/**
 * Printable promoter handbook (epic 08 · promoter-funnel-v2 S1 · US-1.5 — evolved
 * from the original sell-sheet, US-12). A single es-MX page the promoter prints /
 * saves as PDF to run a full close start-to-finish: the glossary + pricing pitch
 * (unchanged from the original sell-sheet), plus a close checklist, 30-second
 * per-SKU scripts, and how payments actually work today. Reuses the admin print
 * view's idiom: an injected <style> with @media print that hides the site chrome +
 * a `.no-print` toolbar. Copy comes from the same sellerAcquisition.promotor block
 * as /mx/vende/promotor, so the two never drift.
 */
const css = `
  @page { size: A4; margin: 14mm; }
  .ss-root { max-width: 760px; margin: 0 auto; padding: 24px 16px 64px; }
  .ss-h1 { font-size: 26px; font-weight: 800; margin: 0 0 4px; }
  .ss-sub { color: #555; margin: 0 0 20px; }
  .ss-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 16px 0; }
  .ss-card { border: 1px solid #ddd; border-radius: 8px; padding: 12px; min-width: 0; }
  .ss-card h3 { margin: 0 0 4px; font-size: 15px; }
  .ss-card p { margin: 0; font-size: 13px; color: #444; overflow-wrap: break-word; }
  .ss-steps { margin: 16px 0; padding: 0; list-style: none; }
  .ss-steps li { margin: 0 0 10px; font-size: 14px; }
  .ss-price { font-weight: 700; }
  .ss-soon { color: #a15c00; font-style: italic; }
  .no-print { margin-bottom: 16px; }
  @media print {
    html, body { background: #fff !important; }
    body > *:not(main) { display: none !important; }
    body > main { display: block !important; margin: 0 !important; padding: 0 !important; }
    .no-print { display: none !important; }
    .ss-root { max-width: none; padding: 0; }
    .ss-card { break-inside: avoid; }
  }
`

export default async function PromoterSellSheetPage() {
  const ui = (await getOverriddenDictionary('es')).sellerAcquisition
  const p = ui.promotor
  // Migración de tienda has no compile-time price constant (unlike custom_domain/
  // subdomain above) — it's admin-set (platform-migrations S2), so it's read live
  // rather than hardcoded, and the line is omitted entirely until an admin sets one.
  const migrationPriceMxn = (await getPromoterSkuPrices()).migration ?? null

  return (
    <main className="ss-root">
      <style dangerouslySetInnerHTML={{ __html: css }} />

      <div className="no-print" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <a href="/mx/vende/promotor" style={{ textDecoration: 'underline', fontSize: 14 }}>← Volver</a>
        <span style={{ color: '#888', fontSize: 13 }}>Usa Imprimir / Guardar como PDF (⌘P)</span>
        <a href="/api/promoter/rate-card" style={{ textDecoration: 'underline', fontSize: 13, fontWeight: 600 }}>
          <i className="iconoir-page" aria-hidden /> Descargar tarifario (anuncios impresos)
        </a>
      </div>

      {/* Comparador de costos (epic 08 · cost-comparator-homepage S2 · US-2.2) —
          the in-visit leave-behind: no per-visit data to prefill from a static
          printable page, so this points at the generic /comparador entry point. A
          live session's own "Copiar enlace" button (on /comparador itself) hands
          over the exact prefilled comparison once numbers are on screen. */}
      <p style={{ fontSize: 13, margin: '4px 0 20px' }}>
        <a href="/comparador" style={{ textDecoration: 'underline', fontWeight: 600 }}>
          <i className="iconoir-stats-report" aria-hidden /> Comparador de costos
        </a>{' '}
        — úsalo en la visita: carga los números reales del comercio ahí mismo y comparte el enlace
        o exporta un reporte al cerrar.
      </p>

      <h1 className="ss-h1">{p.handbookTitle}</h1>
      <p className="ss-sub">{p.handbookLead}</p>

      <h2 style={{ fontSize: 16 }}>{p.proofTitle}</h2>
      <div className="ss-grid">
        {p.glossary.map((g) => (
          <div key={g.title} className="ss-card">
            <h3>{g.title}</h3>
            <p>{fillFixedPricingTokens(g.body, 'es')}</p>
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: 16 }}>{p.checklistTitle}</h2>
      <ul className="ss-steps">
        {p.checklist.map((s) => (
          <li key={s.title}><strong>{s.title}.</strong> {s.body}</li>
        ))}
      </ul>

      <h2 style={{ fontSize: 16 }}>{p.scriptsTitle}</h2>
      <div className="ss-grid">
        {p.scripts.map((s) => (
          <div key={s.title} className="ss-card">
            <h3>{s.title}</h3>
            <p>{fillFixedPricingTokens(s.body, 'es')}</p>
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: 16 }}>{p.paymentsTitle}</h2>
      <p style={{ fontSize: 14 }}>{p.paymentsBody}</p>
      <p className="ss-soon" style={{ fontSize: 13 }}>{p.paymentsComingSoon}</p>

      <h2 style={{ fontSize: 16 }}>{p.pitchTitle}</h2>
      <p style={{ fontSize: 14 }}>{p.pitchBody}</p>
      <p className="ss-price">
        {p.priceDomainLabel}: ${CUSTOM_DOMAIN_PRICE_MXN} MXN · {p.priceSubdomainLabel}: ${SUBDOMAIN_PRICE_YEARLY_MXN} MXN/año
        {migrationPriceMxn != null ? ` · Migración de tienda: $${migrationPriceMxn} MXN` : ''}
      </p>
      <p className="no-print" style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 24 }}>
        <a href="/mx/vende/promotor/migracion" style={{ textDecoration: 'underline', fontSize: 14, fontWeight: 600 }}>
          → Manual de migración (fotografiar, entrevistar, cerrar)
        </a>
      </p>
    </main>
  )
}
