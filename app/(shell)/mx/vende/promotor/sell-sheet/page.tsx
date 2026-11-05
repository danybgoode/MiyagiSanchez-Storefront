import type { Metadata } from 'next'
import { PACKAGES, PACKAGE_SKUS, packageSplit } from '@/lib/promoter-packages'
import { getCommissionRates } from '@/lib/promoter'
import { getOverriddenDictionary } from '@/lib/copy-overrides'

export const metadata: Metadata = {
  title: 'Guía rápida del promotor',
  robots: { index: false },
}

/**
 * The promoter's quick guide: one printable es-MX page (epic 08 · promoter-funnel-v2 S1 · US-1.5, rewritten
 * 2026-11-05 for promoters recruited on the street, who will not read a handbook).
 *
 * Order is deliberate: the money first and largest (what you charge, what you pass us, what you keep), then one
 * sentence per option to say out loud, then four steps, then how our share is paid. Every amount comes from the live
 * commission rates through `packageSplit`; no amount is typed here. No printed ads and no retired extras (Daniel).
 *
 * Reuses the admin print view's idiom: an injected <style> with @media print that hides the site chrome and a
 * `.no-print` toolbar.
 */
const css = `
  @page { size: A4; margin: 14mm; }
  .ss-root { max-width: 760px; margin: 0 auto; padding: 24px 16px 64px; }
  .ss-h1 { font-size: 28px; font-weight: 800; margin: 0 0 4px; }
  .ss-sub { color: #555; margin: 0 0 24px; font-size: 15px; }
  .ss-h2 { font-size: 18px; font-weight: 800; margin: 28px 0 10px; }
  .ss-table { width: 100%; border-collapse: collapse; font-size: 15px; }
  .ss-table th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #666; padding: 6px 8px; border-bottom: 2px solid #222; }
  .ss-table td { padding: 12px 8px; border-bottom: 1px solid #ddd; vertical-align: top; }
  .ss-table .ss-num { text-align: right; white-space: nowrap; }
  .ss-option { font-weight: 700; }
  .ss-option small { display: block; font-weight: 400; color: #555; font-size: 13px; margin-top: 2px; }
  .ss-keep { font-size: 24px; font-weight: 800; color: #0a7a3d; }
  .ss-note { font-size: 14px; margin: 10px 0 0; }
  .ss-say { margin: 0; padding: 0; list-style: none; }
  .ss-say li { margin: 0 0 10px; font-size: 15px; }
  .ss-steps { margin: 0; padding-left: 22px; font-size: 15px; }
  .ss-steps li { margin: 0 0 8px; }
  .ss-pay p { margin: 0 0 8px; font-size: 15px; }
  .no-print { margin-bottom: 20px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; font-size: 14px; }
  @media print {
    html, body { background: #fff !important; }
    body > *:not(main) { display: none !important; }
    body > main { display: block !important; margin: 0 !important; padding: 0 !important; }
    .no-print { display: none !important; }
    .ss-root { max-width: none; padding: 0; }
    .ss-table tr { break-inside: avoid; }
  }
`

const pesos = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`

export default async function PromoterSellSheetPage() {
  const g = (await getOverriddenDictionary('es')).sellerAcquisition.promotor.guide
  const rates = await getCommissionRates()
  const renewalPct = rates.negocio_renewal ?? 0

  return (
    <main className="ss-root" data-testid="sell-sheet">
      <style dangerouslySetInnerHTML={{ __html: css }} />

      <div className="no-print">
        <a href="/mx/vende/promotor" style={{ textDecoration: 'underline' }}>{g.back}</a>
        <span style={{ color: '#888' }}>{g.printHint}</span>
      </div>

      <h1 className="ss-h1">{g.title}</h1>
      <p className="ss-sub">{g.lead}</p>

      <h2 className="ss-h2">{g.packagesTitle}</h2>
      <table className="ss-table" data-testid="sell-sheet-packages">
        <thead>
          <tr>
            <th>{g.colOption}</th>
            <th className="ss-num">{g.colCharge}</th>
            <th className="ss-num">{g.colPay}</th>
            <th className="ss-num">{g.colKeep}</th>
          </tr>
        </thead>
        <tbody>
          {PACKAGE_SKUS.map((sku) => {
            const rate = rates[sku]
            const split = rate ? packageSplit(sku, rate) : null
            return (
              <tr key={sku} data-testid={`sell-sheet-package-${sku}`}>
                <td className="ss-option">
                  {PACKAGES[sku].label}
                  <small>{PACKAGES[sku].summary}</small>
                </td>
                <td className="ss-num">{pesos(PACKAGES[sku].priceMxn * 100)}</td>
                {split ? (
                  <>
                    <td className="ss-num">{pesos(split.payPlatformCents)}</td>
                    <td className="ss-num ss-keep">{pesos(split.keepCents)}</td>
                  </>
                ) : (
                  <td className="ss-num" colSpan={2}>{g.ratesPending}</td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      {renewalPct > 0 ? (
        <p className="ss-note" data-testid="sell-sheet-renewal">{g.renewalLine.replace('{renewalPct}', String(renewalPct))}</p>
      ) : null}

      <h2 className="ss-h2">{g.sayTitle}</h2>
      <ul className="ss-say">
        {PACKAGE_SKUS.map((sku) => (
          <li key={sku}><strong>{PACKAGES[sku].label}:</strong> {g.say[sku]}</li>
        ))}
      </ul>

      <h2 className="ss-h2">{g.stepsTitle}</h2>
      <ol className="ss-steps">
        {g.steps.map((step) => <li key={step}>{step}</li>)}
      </ol>

      <h2 className="ss-h2">{g.payTitle}</h2>
      <div className="ss-pay">
        <p>{g.payCard}</p>
        <p>{g.payTransfer}</p>
        <p><strong>{g.payKeep}</strong></p>
      </div>

      <p className="no-print" style={{ marginTop: 28 }}>
        <a href="/mx/vende/promotor/migracion" style={{ textDecoration: 'underline', fontWeight: 600 }}>→ {g.migrationLink}</a>
      </p>
    </main>
  )
}
