'use client'

import { useEffect, useState } from 'react'
import { PACKAGES, PACKAGE_FREE_MONTHS, SELLABLE_PACKAGE_SKUS, packageSplit, packagePriceMxn, isFoundersPrice, type PackageSku, type SellablePackageSku } from '@/lib/promoter-packages'
import type { Dictionary } from '@/lib/dictionary'

/**
 * «3 · Cobra» (promoter-panel S4.1/S4.2, D10/D12). The promoter collects the package price from the owner in person and
 * sends Miyagi Sánchez only our share: by transfer first (#476's order), or with their own card. The moment the owner
 * pays them, «Sí, ya me pagó» gives the owner a receipt on WhatsApp (and by email when there is one), whose page reads
 * the plan's status live. Thin screen over /api/promoter/close/{package/<sku>,migration,transfer,receipt}.
 */
type Copy = Dictionary['promotorPanel']
type Shop = { shopId: string; slug: string; name: string }

type Transfer = {
  id: string
  sku: string
  method: 'spei' | 'dimo' | 'codi'
  owed_cents: number
  transfer_details: { clabe?: string; bank_name?: string; account_holder?: string; dimo_phone?: string; codi_reference?: string }
  status: 'pending' | 'reported' | 'approved' | 'rejected'
}

// The package names and prices come from `lib/promoter-packages.ts`, never typed here. Only the packages ON SALE
// (plan-tienda D11): a retired one would answer 410.
const PACKAGE_OPTIONS: readonly SellablePackageSku[] = SELLABLE_PACKAGE_SKUS
type Option = `package/${SellablePackageSku}` | 'migration'
const TRANSFER_METHODS: Array<{ id: Transfer['method']; label: string }> = [
  { id: 'spei', label: 'SPEI' },
  { id: 'dimo', label: 'DiMo' },
  { id: 'codi', label: 'CoDi' },
]

const field = 'mt-1 w-full rounded-lg border border-[var(--color-border)] px-3 py-2'
const pesos = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`
const fill = (template: string, values: Record<string, string>) =>
  Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), template)
const packageOf = (option: Option): SellablePackageSku | null => (option.startsWith('package/') ? (option.slice('package/'.length) as SellablePackageSku) : null)

export default function CobraStep({ copy, shop, transferEnabled, packageRates }: {
  copy: Copy
  shop: Shop
  transferEnabled: boolean
  packageRates: Partial<Record<PackageSku, number>>
}) {
  const t = copy.cobra
  const [option, setOption] = useState<Option>(`package/${PACKAGE_OPTIONS[0]}`)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [payMethod, setPayMethod] = useState<'card' | 'transfer'>(transferEnabled ? 'transfer' : 'card')
  const [transferMethod, setTransferMethod] = useState<Transfer['method']>('spei')
  const [transfer, setTransfer] = useState<Transfer | null>(null)
  const [reporting, setReporting] = useState(false)
  // Migration only: a catalog over 150 products must cite the merchant's stored quote; the server is the real guard.
  const [quoteId, setQuoteId] = useState('')
  const sku = packageOf(option)

  // Restore a transfer already started for this shop and option, so a reload after «Ya transferí» keeps its state.
  useEffect(() => {
    if (!transferEnabled) {
      // The flag is external configuration; clear the synchronized snapshot when it disables the transfer rail.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTransfer(null)
      return
    }
    // A switched option never keeps showing the previous option's transfer while this one loads (pr-reviewer, #483).
    setTransfer(null)
    const transferSku = sku ?? 'migration'
    let cancelled = false
    fetch(`/api/promoter/close/transfer?shopId=${encodeURIComponent(shop.shopId)}&sku=${transferSku}`)
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setTransfer(data?.transfer ?? null) })
      .catch(() => { /* best-effort restore: a fresh payment is still possible */ })
    return () => { cancelled = true }
  }, [shop.shopId, sku, transferEnabled])

  async function pay() {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/promoter/close/${option}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopId: shop.shopId,
          ...(payMethod === 'transfer' ? { paymentMethod: 'transfer', transferMethod } : {}),
          ...(option === 'migration' && quoteId.trim() ? { quoteId: quoteId.trim() } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) { setError(data.error ?? copy.errors.network); return }
      if (data.transfer) { setTransfer(data.transfer); return }
      if (!data.url) { setError(copy.errors.network); return }
      window.location.href = data.url
    } catch { setError(copy.errors.network) }
    finally { setBusy(false) }
  }

  async function reportTransfer() {
    if (!transfer) return
    setReporting(true); setError(null)
    try {
      const res = await fetch(`/api/promoter/close/transfer/${encodeURIComponent(transfer.id)}/report`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) { setError(data.error ?? copy.errors.network); return }
      setTransfer(data.transfer)
    } catch { setError(copy.errors.network) }
    finally { setReporting(false) }
  }

  const method = TRANSFER_METHODS.find((m) => m.id === transfer?.method)?.label ?? ''

  return (
    <section id="panel-cobra" className="card-panel grid gap-4" style={{ padding: 'var(--s-5)' }} data-testid="panel-cobra">
      <div>
        <h2 className="t-h4" style={{ margin: 0, letterSpacing: 0 }}>3 · {copy.steps.cobra}</h2>
        <p className="t-small" style={{ margin: 'var(--s-1) 0 0', color: 'var(--fg-muted)' }}>
          {t.lead}{sku ? ` ${t.activation}` : ''}
        </p>
      </div>

      <label className="block text-sm font-medium">{t.what}
        <select className={field} value={option} disabled={busy}
          onChange={(e) => { setOption(e.target.value as Option); setError(null) }}>
          {PACKAGE_OPTIONS.map((p) => (
            <option key={p} value={`package/${p}`}>{PACKAGES[p].label} ({fill(t.charges, { monto: pesos(packagePriceMxn(p) * 100) })}{isFoundersPrice(p) ? ' · precio de fundador' : ''})</option>
          ))}
          <option value="migration">{t.migration}</option>
        </select>
      </label>

      {sku ? <SplitLine copy={copy} sku={sku} rate={packageRates[sku]} /> : null}
      {sku ? <ReceiptBlock key={sku} copy={copy} shop={shop} sku={sku} /> : null}

      {transfer ? (
        <div className="grid gap-3" data-testid="panel-transfer">
          {transfer.status === 'pending' ? (
            <>
              <p className="text-sm" style={{ margin: 0 }}>{fill(t.transferTo, { monto: pesos(transfer.owed_cents), metodo: method })}</p>
              <ul className="text-sm grid gap-1 rounded-lg bg-[var(--color-surface)] p-3" style={{ margin: 0, listStyle: 'none' }}>
                {transfer.transfer_details.clabe ? <li>{t.clabe}: <span className="font-mono">{transfer.transfer_details.clabe}</span></li> : null}
                {transfer.transfer_details.bank_name ? <li>{t.bank}: {transfer.transfer_details.bank_name}</li> : null}
                {transfer.transfer_details.account_holder ? <li>{t.holder}: {transfer.transfer_details.account_holder}</li> : null}
                {transfer.transfer_details.dimo_phone ? <li>DiMo: {transfer.transfer_details.dimo_phone}</li> : null}
                {transfer.transfer_details.codi_reference ? <li>CoDi: {transfer.transfer_details.codi_reference}</li> : null}
              </ul>
              <button type="button" className="btn btn-primary" style={{ justifySelf: 'start' }} onClick={reportTransfer} disabled={reporting}>
                {reporting ? t.reporting : t.transferred}
              </button>
            </>
          ) : null}
          {transfer.status === 'reported' ? <p className="text-sm" role="status" style={{ margin: 0, color: 'var(--success)' }}>{t.reported}</p> : null}
          {transfer.status === 'approved' ? <p className="text-sm" role="status" style={{ margin: 0, color: 'var(--success)' }}><i className="iconoir-check-circle" aria-hidden /> {t.approved}</p> : null}
          {transfer.status === 'rejected' ? <p className="text-sm" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{t.rejected}</p> : null}
        </div>
      ) : (
        <div className="grid gap-3">
          {option === 'migration' ? (
            <label className="block text-sm font-medium">{t.quote}
              <input type="text" className={`${field} font-mono`} value={quoteId} disabled={busy}
                onChange={(e) => setQuoteId(e.target.value)} placeholder={t.quotePlaceholder} />
            </label>
          ) : null}
          {transferEnabled ? (
            <div className="flex gap-2" role="radiogroup" aria-label={t.transferMethod}>
              <button type="button" role="radio" aria-checked={payMethod === 'transfer'} disabled={busy} onClick={() => setPayMethod('transfer')}
                className={payMethod === 'transfer' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}>{t.byTransfer}</button>
              <button type="button" role="radio" aria-checked={payMethod === 'card'} disabled={busy} onClick={() => setPayMethod('card')}
                className={payMethod === 'card' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}>{t.byCard}</button>
            </div>
          ) : null}
          {transferEnabled && payMethod === 'transfer' ? (
            <label className="block text-sm font-medium">{t.transferMethod}
              <select className={field} value={transferMethod} disabled={busy}
                onChange={(e) => setTransferMethod(e.target.value as Transfer['method'])}>
                {TRANSFER_METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
          ) : null}
          <button type="button" className="btn btn-primary" style={{ justifySelf: 'start' }} onClick={pay} disabled={busy}>
            {busy ? t.processing : payMethod === 'transfer' && transferEnabled ? t.seeTransfer : sku ? t.payShare : t.payMigration}
          </button>
        </div>
      )}
      {error ? <p className="text-sm" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p> : null}
    </section>
  )
}

/** The money for the chosen option, large: what the promoter charges, passes on and keeps (from the live rate), then
 *  what the merchant gets, with the three free months on top of the paid time (plan-tienda S4.4). */
function SplitLine({ copy, sku, rate }: { copy: Copy; sku: PackageSku; rate: number | undefined }) {
  const t = copy.cobra
  const onTop = <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }} data-testid="close-on-top">{fill(t.onTop, { resumen: PACKAGES[sku].summary, meses: String(PACKAGE_FREE_MONTHS) })}</p>
  if (!rate) {
    return (
      <>
        <p className="text-sm" style={{ margin: 0 }}>{fill(t.ratePending, { monto: pesos(packagePriceMxn(sku) * 100) })}</p>
        {onTop}
      </>
    )
  }
  const s = packageSplit(sku, rate)
  return (
    <>
      <div className="grid grid-cols-3 gap-2 rounded-lg bg-[var(--color-surface)] p-3 text-center" data-testid="close-split">
        <div><div className="text-xs" style={{ color: 'var(--fg-muted)' }}>{t.colCharge}</div><div className="text-lg font-bold">{pesos(s.chargeCents)}</div></div>
        <div><div className="text-xs" style={{ color: 'var(--fg-muted)' }}>{t.colPay}</div><div className="text-lg font-bold">{pesos(s.payPlatformCents)}</div></div>
        <div><div className="text-xs" style={{ color: 'var(--fg-muted)' }}>{t.colKeep}</div><div className="text-2xl font-extrabold" style={{ color: 'var(--success)' }}>{pesos(s.keepCents)}</div></div>
      </div>
      {onTop}
    </>
  )
}

/**
 * «¿Ya te pagó el dueño?» → «Sí, ya me pagó» → «Mandarle su recibo» (D10). The receipt is the owner's proof that they
 * paid the promoter; it does not depend on our share having arrived (its page says «Pendiente» until it does).
 */
function ReceiptBlock({ copy, shop, sku }: { copy: Copy; shop: Shop; sku: PackageSku }) {
  const t = copy.cobra
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<{ receiptUrl: string; whatsappUrl: string | null; emailed: boolean } | null>(null)
  const [copied, setCopied] = useState(false)

  async function issue() {
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/promoter/close/receipt', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopId: shop.shopId, sku }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) { setError(data.error ?? copy.errors.network); return }
      setReceipt({ receiptUrl: data.receiptUrl, whatsappUrl: data.whatsappUrl ?? null, emailed: data.emailed === true })
    } catch { setError(copy.errors.network) }
    finally { setBusy(false) }
  }

  async function copyLink() {
    if (!receipt) return
    try { await navigator.clipboard.writeText(receipt.receiptUrl); setCopied(true) } catch { /* the link stays visible to copy by hand */ }
  }

  return (
    <div className="grid gap-2 rounded-lg border border-[var(--color-border)] p-3" data-testid="panel-receipt">
      {receipt ? (
        <>
          <p className="text-sm font-medium" role="status" style={{ margin: 0 }}>{t.receiptReady}</p>
          <div className="flex flex-wrap gap-2">
            {receipt.whatsappUrl ? (
              <a className="btn btn-primary" href={receipt.whatsappUrl} target="_blank" rel="noreferrer" data-testid="panel-send-receipt">{t.sendReceipt}</a>
            ) : null}
            <button type="button" className="btn btn-secondary" onClick={copyLink}>{copied ? t.copied : t.copyReceipt}</button>
          </div>
          {receipt.whatsappUrl ? null : <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{t.noWhatsapp}</p>}
          {receipt.emailed ? <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{t.emailed}</p> : null}
          <p className="t-small font-mono" style={{ margin: 0, wordBreak: 'break-all', color: 'var(--fg-muted)' }}>{receipt.receiptUrl}</p>
        </>
      ) : (
        <>
          <p className="text-sm font-medium" style={{ margin: 0 }}>{t.paidQ}</p>
          <button type="button" className="btn btn-secondary" style={{ justifySelf: 'start' }} onClick={issue} disabled={busy} data-testid="panel-paid-yes">
            {busy ? t.preparing : t.paidYes}
          </button>
        </>
      )}
      {error ? <p className="text-sm" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p> : null}
    </div>
  )
}
