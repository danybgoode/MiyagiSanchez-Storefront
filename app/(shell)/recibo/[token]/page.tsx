import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { contactMailto } from '@/lib/contact'
import { getOverriddenDictionary } from '@/lib/copy-overrides'
import { PACKAGES } from '@/lib/promoter-packages'
import { fillTemplate, formatReceiptAmount, formatReceiptDate, verifyReceiptToken } from '@/lib/promoter-receipt'
import { readReceiptView, receiptSecret } from '@/lib/promoter-receipt-server'

/**
 * «El recibo del negocio» (promoter-panel S4.1, D10): what a merchant opens from the promoter's WhatsApp. Amount,
 * option, promoter and date from the signed token; the status read live, so the same link turns «Activo» once our
 * share lands. A tampered or unknown token is a 404. Never indexed: a receipt is private to the merchant.
 */
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: 'no-referrer' }

export default async function ReceiptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const secret = receiptSecret()
  // Next hands the segment already decoded; a receipt token is base64url, so it never needs decoding again.
  const payload = secret ? verifyReceiptToken(token, secret) : null
  if (!payload) notFound()
  const view = await readReceiptView(payload)
  if (!view) notFound()

  const t = (await getOverriddenDictionary('es')).promotorPanel.recibo
  // A failed read leaves the names unknown: the receipt still renders from the signed token (amount, option, date).
  const values = {
    negocio: view.shopName ?? '',
    monto: formatReceiptAmount(payload.amountCents),
    promotor: view.promoterName?.trim() || view.promoterCode || '',
    codigo: view.promoterCode ?? '',
    fecha: formatReceiptDate(payload.issuedAt),
    opcion: PACKAGES[payload.sku].label,
  }
  const s = view.status
  const statusLine =
    s.kind === 'active'
      ? s.endsAt ? fillTemplate(s.plan === 'tienda' ? t.activeTienda : t.active, { fecha: formatReceiptDate(s.endsAt) }) : t.activeNoDate
      : s.kind === 'ended' ? fillTemplate(s.plan === 'tienda' ? t.endedTienda : t.ended, { fecha: formatReceiptDate(s.endsAt) })
      : s.kind === 'ready' ? t.ready
      : s.kind === 'pending' ? t.pending
      : s.kind === 'problem' ? t.problem
      : t.statusUnavailable
  const tone = s.kind === 'active' || s.kind === 'ready' ? 'var(--success)' : s.kind === 'problem' ? 'var(--danger)' : 'var(--fg)'

  return (
    <main className="mx-auto max-w-xl px-5 py-12 grid gap-5" data-testid="receipt-page" data-status={s.kind}>
      <h1 className="t-h2" style={{ margin: 0, letterSpacing: 0 }}>{view.shopName ? fillTemplate(t.title, values) : t.titleGeneric}</h1>
      <div className="card-panel grid gap-3" style={{ padding: 'var(--s-5)' }}>
        <p style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700 }}>{values.monto}</p>
        <p style={{ margin: 0 }}>{fillTemplate(view.promoterCode ? t.paid : t.paidNoPromoter, values)}</p>
        <p style={{ margin: 0 }}>{fillTemplate(t.for, values)}</p>
        <p role="status" style={{ margin: 0, fontWeight: 600, color: tone }}>{statusLine}</p>
      </div>
      <div className="grid gap-2">
        {/* The receipt is the promoter's record of a cash payment, not Miyagi Sánchez's confirmation of it: say who issued
            it and what to do if it is wrong (Codex security lens, #483). */}
        {view.promoterCode ? <p className="t-small" style={{ margin: 0 }} data-testid="receipt-issued-by">{fillTemplate(t.issuedBy, values)}</p> : null}
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{t.help}</p>
        <a className="btn btn-secondary" style={{ justifySelf: 'start' }} href={contactMailto(view.shopName ? fillTemplate(t.title, values) : t.titleGeneric)}>{t.helpCta}</a>
      </div>
    </main>
  )
}
