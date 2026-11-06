'use client'

import { PACKAGES, packageSplit, type PackageSku } from '@/lib/promoter-packages'
import { useEffect, useState } from 'react'
import ProductosStep from './ProductosStep'
import type { SellsToday } from '@/lib/promoter-panel'
import PreviewStep from './PreviewStep'
import NegocioStep from './NegocioStep'
import type { Dictionary } from '@/lib/dictionary'

type Bound = { code: string; name: string | null } | null
type Shop = { shopId: string; slug: string; name: string; currency?: 'MXN' | 'USD'; estado?: string | null; municipio?: string | null }

/** Promoter Funnel v2 · Sprint 4 (US-4.1) — a net-remittance transfer request. */
type Transfer = {
  id: string
  sku: string
  method: 'spei' | 'dimo' | 'codi'
  owed_cents: number
  transfer_details: { clabe?: string; bank_name?: string; account_holder?: string; dimo_phone?: string; codi_reference?: string }
  status: 'pending' | 'reported' | 'approved' | 'rejected'
}

/**
 * Promoter "close" workspace client island (epic 08 · S4). Steps for the
 * in-store motion: (0, activation-crm flag only) capture the merchant
 * relationship record BEFORE any shop exists — README D1, the relationship
 * precedes the shop; (1) bind your PRM- code, (2) set up the merchant's shop,
 * (3) charge a SKU on their behalf (a picker over the one-time close routes —
 * domain / ml-sync — with an optional net-remittance transfer alongside Stripe,
 * Sprint 4 · US-4.1), (4) hand off the WhatsApp claim link.
 * Thin screens over /api/promoter/{relationship,me/bind,shop/setup,close/<sku>,close/transfer/*,claim/link}.
 */
export default function PromoterCloseClient({
  bound: initialBound,
  transferEnabled,
  previewEnabled,
  activationCrmEnabled,
  packageRates,
  copy,
}: {
  copy: Dictionary['promotorPanel']
  bound: Bound
  transferEnabled: boolean
  previewEnabled: boolean
  activationCrmEnabled: boolean
  /** Each option's commission rate, so the promoter sees what they charge, pass on and keep before paying. */
  packageRates: Partial<Record<PackageSku, number>>
}) {
  const [bound, setBound] = useState<Bound>(initialBound)
  const [shop, setShop] = useState<Shop | null>(null)
  // The lead (merchant_relationships) the promoter is working on; the preview step records in-person consent on it.
  const [relationshipId, setRelationshipId] = useState<string | null>(null)
  // From «El negocio»: step 2's path and the default category for a new product.
  const [choices, setChoices] = useState<{ sellsToday: SellsToday | null; mainCategory: string | null }>({ sellsToday: null, mainCategory: null })

  if (!bound) return <BindStep copy={copy} onBound={setBound} />

  // «Cobra» and «Entrégala» keep their running numbers until Sprint 4 rebuilds them on the same shell.
  let n = 2
  return (
    <div className="max-w-xl mx-auto px-4 py-8 grid gap-6" data-testid="promoter-panel">
      <header className="grid gap-1">
        <h1 className="t-h2" style={{ margin: 0, letterSpacing: 0 }}>{copy.header.title}</h1>
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{copy.header.lead}</p>
        <p className="t-small" style={{ margin: 0 }}>
          <span className="font-mono font-semibold">{bound.code}</span>
          {bound.name ? <span> · {bound.name}</span> : null}
        </p>
      </header>

      <PanelStepper copy={copy} current={shop ? 2 : 1} />

      <NegocioStep
        copy={copy}
        promoterCode={bound.code}
        crmEnabled={activationCrmEnabled}
        shop={shop}
        onShop={setShop}
        onRelationship={(id) => setRelationshipId(id)}
        onChoices={setChoices}
      />
      {shop && <ProductosStep copy={copy} shop={shop} sellsToday={choices.sellsToday} mainCategory={choices.mainCategory} />}
      {shop && previewEnabled && <PreviewStep shop={shop} n={(n += 1)} relationshipId={relationshipId} panelCopy={copy} />}
      {shop && <CloseStep shop={shop} transferEnabled={transferEnabled} packageRates={packageRates} n={(n += 1)} />}
      {shop && <HandoffStep shop={shop} n={(n += 1)} />}
    </div>
  )
}

/** «1 El negocio · 2 Sus productos · 3 Cobra · 4 Entrégala» — where the promoter is (promoter-panel D12). */
function PanelStepper({ copy, current }: { copy: Dictionary['promotorPanel']; current: number }) {
  const labels = [copy.steps.negocio, copy.steps.productos, copy.steps.cobra, copy.steps.entrega]
  return (
    <nav aria-label={copy.steps.of.replace('{n}', String(current))} data-testid="panel-stepper">
      <ol className="grid grid-cols-4 gap-2" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {labels.map((label, i) => {
          const step = i + 1
          const state = step < current ? 'done' : step === current ? 'current' : 'next'
          return (
            <li key={label} aria-current={state === 'current' ? 'step' : undefined} className="grid gap-1 text-center">
              <span
                className="mx-auto grid h-7 w-7 place-items-center rounded-full text-sm font-semibold"
                style={{
                  background: state === 'next' ? 'transparent' : 'var(--accent)',
                  color: state === 'next' ? 'var(--fg-muted)' : 'var(--fg-inverse)',
                  border: state === 'next' ? '1px solid var(--color-border)' : 'none',
                }}
              >
                {state === 'done' ? <i className="iconoir-check" aria-hidden /> : step}
              </span>
              <span className="t-small" style={{ color: state === 'next' ? 'var(--fg-muted)' : 'var(--fg)', fontWeight: state === 'current' ? 600 : 400 }}>{label}</span>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function Card({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-[var(--color-border)] p-4 space-y-3">
      <h2 className="font-semibold">
        <span className="text-[var(--color-muted)] mr-2">{n}.</span>{title}
      </h2>
      {children}
    </section>
  )
}

function BindStep({ copy, onBound }: { copy: Dictionary['promotorPanel']; onBound: (b: Bound) => void }) {
  const t = copy.bind
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function bind() {
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/promoter/me/bind', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) { setError(t.error); return }
      onBound(data.promoter)
    } catch { setError(copy.errors.network) }
    finally { setBusy(false) }
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-8 grid gap-6">
      <header className="grid gap-1">
        <h1 className="t-h2" style={{ margin: 0, letterSpacing: 0 }}>{t.title}</h1>
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{t.hint}</p>
      </header>
      <div className="card-panel grid gap-3" style={{ padding: 'var(--s-5)' }}>
        <label className="block text-sm font-medium">{t.title}
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={t.placeholder}
            autoCapitalize="characters"
            className="mt-1 w-full rounded-lg border border-[var(--color-border)] px-3 py-2 font-mono"
          />
        </label>
        {error && <p className="t-small" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p>}
        <button type="button" className="btn btn-primary" onClick={bind} disabled={busy || !code.trim()}>
          {busy ? t.busy : t.button}
        </button>
      </div>
    </div>
  )
}

/**
 * The one-time SKUs a promoter can close on a merchant's behalf — each maps to a
 * `/api/promoter/close/<id>` route that takes `{ shopId }` and returns `{ url }`
 * (a Stripe checkout redirect) OR, for `subdomain` when the admin has configured
 * the free-first-year perk (Sprint 3 · US-3.1/US-3.2), `{ free: true }` with NO
 * redirect — the grant activates immediately, no charge.
 * (Print is a different flow — it needs ad content — so it's not in this picker.)
 */
// The package name and price come from `lib/promoter-packages.ts`, never typed here.
const packagePrice = (sku: keyof typeof PACKAGES) => `$${PACKAGES[sku].priceMxn.toLocaleString('en-US')}`
const CLOSE_SKUS = [
  // plans-gratis-negocio S4 (D12): the three packages first — the deal a promoter says in one sentence. The custom
  // domain and ML sync are no longer sold on their own (they are part of Negocio).
  { id: 'package/negocio_anual', label: `${PACKAGES.negocio_anual.label} (cobras ${packagePrice('negocio_anual')})`, payLabel: 'Pagar la parte de Miyagi Sánchez' },
  { id: 'package/negocio_arranque', label: `${PACKAGES.negocio_arranque.label} (cobras ${packagePrice('negocio_arranque')})`, payLabel: 'Pagar la parte de Miyagi Sánchez' },
  { id: 'package/setup_gratis', label: `${PACKAGES.setup_gratis.label} (cobras ${packagePrice('setup_gratis')})`, payLabel: 'Pagar la parte de Miyagi Sánchez' },
  { id: 'migration', label: 'Migración desde otra plataforma', payLabel: 'Cobrar migración' },
] as const
type CloseSkuId = (typeof CLOSE_SKUS)[number]['id']

const TRANSFER_METHOD_LABEL: Record<Transfer['method'], string> = {
  spei: 'SPEI',
  dimo: 'DiMo',
  codi: 'CoDi',
}

const mxn = (cents: number) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 }).format(cents / 100)

function CloseStep({ shop, transferEnabled, packageRates, n }: { shop: Shop; transferEnabled: boolean; packageRates: Partial<Record<PackageSku, number>>; n: number }) {
  const [sku, setSku] = useState<CloseSkuId>('package/negocio_anual')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [payMethod, setPayMethod] = useState<'stripe' | 'transfer'>(transferEnabled ? 'transfer' : 'stripe')
  const [transferMethod, setTransferMethod] = useState<Transfer['method']>('spei')
  const [transfer, setTransfer] = useState<Transfer | null>(null)
  const [reporting, setReporting] = useState(false)
  // migration only — a catalog over the flat 150-listing cap must reference the
  // merchant's stored quote (shown on their parity/estimate page); the server is
  // the real guard (it 403s a >150 close with no quote), this is just the input.
  const [quoteId, setQuoteId] = useState('')

  const selected = CLOSE_SKUS.find((s) => s.id === sku) ?? CLOSE_SKUS[0]

  // Restore a persisted transfer for this shop+SKU on mount / SKU change — so a
  // reload after "Ya transferí" doesn't lose the "pendiente de aprobación" state.
  useEffect(() => {
    if (!transferEnabled) {
      // The flag is external configuration; clear the synchronized snapshot when
      // that external source disables the transfer rail.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTransfer(null)
      return
    }
    const transferSku = sku.startsWith('package/') ? sku.slice('package/'.length) : sku
    let cancelled = false
    fetch(`/api/promoter/close/transfer?shopId=${encodeURIComponent(shop.shopId)}&sku=${transferSku}`)
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setTransfer(data?.transfer ?? null) })
      .catch(() => { /* best-effort restore — a fresh close is still possible */ })
    return () => { cancelled = true }
  }, [shop.shopId, sku, transferEnabled])

  async function pay() {
    setBusy(true); setError(null); setDone(null)
    try {
      const res = await fetch(`/api/promoter/close/${sku}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopId: shop.shopId,
          ...(payMethod === 'transfer' ? { paymentMethod: 'transfer', transferMethod } : {}),
          ...(sku === 'migration' && quoteId.trim() ? { quoteId: quoteId.trim() } : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) { setError(data.error ?? 'No se pudo iniciar el pago.'); return }
      if (data.transfer) { setTransfer(data.transfer); return }
      if (data.free) { setDone('¡Listo! El subdominio ya está activo — sin costo, primer año GRATIS.'); return }
      if (!data.url) { setError('No se pudo iniciar el pago.'); return }
      window.location.href = data.url
    } catch { setError('Error de red. Intenta de nuevo.') }
    finally { setBusy(false) }
  }

  async function reportTransfer() {
    if (!transfer) return
    setReporting(true); setError(null)
    try {
      const res = await fetch(`/api/promoter/close/transfer/${encodeURIComponent(transfer.id)}/report`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok || !data.ok) { setError(data.error ?? 'No se pudo reportar la transferencia.'); return }
      setTransfer(data.transfer)
    } catch { setError('Error de red. Intenta de nuevo.') }
    finally { setReporting(false) }
  }

  // A transfer already exists for this shop+SKU — show its state instead of the picker.
  if (transfer) {
    return (
      <Card n={n} title="Cobra y pásanos nuestra parte">
        {transfer.status === 'pending' && (
          <div className="space-y-3">
            <p className="text-sm">
              Transfiere <span className="font-semibold">{mxn(transfer.owed_cents)}</span> vía{' '}
              <span className="font-semibold">{TRANSFER_METHOD_LABEL[transfer.method]}</span>:
            </p>
            <ul className="text-sm space-y-1 rounded-lg bg-[var(--color-surface)] p-3">
              {transfer.transfer_details.clabe && <li>CLABE: <span className="font-mono">{transfer.transfer_details.clabe}</span></li>}
              {transfer.transfer_details.bank_name && <li>Banco: {transfer.transfer_details.bank_name}</li>}
              {transfer.transfer_details.account_holder && <li>Titular: {transfer.transfer_details.account_holder}</li>}
              {transfer.transfer_details.dimo_phone && <li>DiMo: {transfer.transfer_details.dimo_phone}</li>}
              {transfer.transfer_details.codi_reference && <li>CoDi: {transfer.transfer_details.codi_reference}</li>}
            </ul>
            {error && <p className="text-sm text-[color:var(--danger)]">{error}</p>}
            <button onClick={reportTransfer} disabled={reporting}
              className="rounded-lg bg-[var(--color-accent)] text-[var(--fg-inverse)] px-4 py-2 font-medium disabled:opacity-50">
              {reporting ? 'Reportando…' : 'Ya transferí'}
            </button>
          </div>
        )}
        {transfer.status === 'reported' && (
          <p className="text-sm text-[color:var(--success)]">
            Transferencia reportada — pendiente de aprobación. Te avisamos en cuanto se confirme.
          </p>
        )}
        {transfer.status === 'approved' && (
          <p className="text-sm text-[color:var(--success)]"><i className="iconoir-check-circle" aria-hidden /> Transferencia aprobada — el beneficio ya está activo.</p>
        )}
        {transfer.status === 'rejected' && (
          <p className="text-sm text-[color:var(--danger)]">
            Esta transferencia fue rechazada. Vuelve a elegir qué vendes para intentar de nuevo.
          </p>
        )}
      </Card>
    )
  }

  return (
    <Card n={n} title="Cobra y pásanos nuestra parte">
      <p className="text-sm text-[var(--color-muted)]">
        Cobra al dueño del negocio (en efectivo o por transferencia) y pásanos solo nuestra parte. Lo demás es tuyo.
        {sku.startsWith('package/') ? ' Por transferencia, el plan se activa en cuanto confirmamos que llegó; con tu tarjeta, al instante.' : ''}
      </p>
      <label className="block text-sm">
        <span className="text-[var(--color-muted)]">Qué vendes</span>
        <select
          value={sku}
          onChange={(e) => { setSku(e.target.value as CloseSkuId); setDone(null); setError(null) }}
          disabled={busy}
          aria-label="Qué vendes"
          className="mt-1 w-full rounded-lg border border-[var(--color-border)] px-3 py-2"
        >
          {CLOSE_SKUS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
      {sku.startsWith('package/') ? <SplitLine sku={sku.slice('package/'.length) as PackageSku} rate={packageRates[sku.slice('package/'.length) as PackageSku]} /> : null}
      {sku === 'migration' && (
        <label className="block text-sm">
          <span className="text-[var(--color-muted)]">
            ID de cotización (solo catálogos de más de 150 productos)
          </span>
          <input
            type="text"
            value={quoteId}
            onChange={(e) => setQuoteId(e.target.value)}
            disabled={busy}
            placeholder="Pégalo desde el reporte de paridad del comerciante"
            className="mt-1 w-full rounded-lg border border-[var(--color-border)] px-3 py-2 font-mono text-sm"
          />
        </label>
      )}
      {transferEnabled && (
        <div className="space-y-2">
          <div className="flex gap-2" role="radiogroup" aria-label="Forma de pago">
            <button type="button" onClick={() => setPayMethod('transfer')} disabled={busy}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${payMethod === 'transfer' ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--fg-inverse)]' : 'border-[var(--color-border)]'}`}>
              Por transferencia
            </button>
            <button type="button" onClick={() => setPayMethod('stripe')} disabled={busy}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${payMethod === 'stripe' ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--fg-inverse)]' : 'border-[var(--color-border)]'}`}>
              Con mi tarjeta
            </button>
          </div>
          {payMethod === 'transfer' && (
            <label className="block text-sm">
              <span className="text-[var(--color-muted)]">Método de transferencia</span>
              <select
                value={transferMethod}
                onChange={(e) => setTransferMethod(e.target.value as Transfer['method'])}
                disabled={busy}
                className="mt-1 w-full rounded-lg border border-[var(--color-border)] px-3 py-2"
              >
                <option value="spei">SPEI</option>
                <option value="dimo">DiMo</option>
                <option value="codi">CoDi</option>
              </select>
            </label>
          )}
        </div>
      )}
      {done && <p className="text-sm text-[color:var(--success)]">{done}</p>}
      {error && <p className="text-sm text-[color:var(--danger)]">{error}</p>}
      <button onClick={pay} disabled={busy}
        className="rounded-lg bg-[var(--color-accent)] text-[var(--fg-inverse)] px-4 py-2 font-medium disabled:opacity-50">
        {busy ? 'Procesando…' : payMethod === 'transfer' ? 'Ver datos de transferencia' : selected.payLabel}
      </button>
    </Card>
  )
}

/** The money for the chosen option, large: what the promoter charges, passes on and keeps (from the live rate). */
function SplitLine({ sku, rate }: { sku: PackageSku; rate: number | undefined }) {
  if (!rate) return <p className="text-sm">Cobras ${PACKAGES[sku].priceMxn.toLocaleString('en-US')}. Tu parte se confirma con Miyagi Sánchez.</p>
  const s = packageSplit(sku, rate)
  const p = (c: number) => `$${Math.round(c / 100).toLocaleString('en-US')}`
  return (
    <div className="grid grid-cols-3 gap-2 rounded-lg bg-[var(--color-surface)] p-3 text-center" data-testid="close-split">
      <div><div className="text-xs text-[var(--color-muted)]">Cobras</div><div className="text-lg font-bold">{p(s.chargeCents)}</div></div>
      <div><div className="text-xs text-[var(--color-muted)]">Nos pasas</div><div className="text-lg font-bold">{p(s.payPlatformCents)}</div></div>
      <div><div className="text-xs text-[var(--color-muted)]">Te quedas</div><div className="text-2xl font-extrabold text-[color:var(--success)]">{p(s.keepCents)}</div></div>
    </div>
  )
}

function HandoffStep({ shop, n }: { shop: Shop; n: number }) {
  const [link, setLink] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function genLink() {
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/promoter/claim/link', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopId: shop.shopId }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) { setError(data.error ?? 'No se pudo generar el enlace.'); return }
      setLink(data.whatsappLink)
    } catch { setError('Error de red. Intenta de nuevo.') }
    finally { setBusy(false) }
  }

  return (
    <Card n={n} title="Entregar por WhatsApp">
      <p className="text-sm text-[var(--color-muted)]">
        Genera el enlace de reclamo y compártelo con el comerciante. Al tocarlo e iniciar sesión, la
        tienda pasa a su cuenta — tu atribución se conserva.
      </p>
      {error && <p className="text-sm text-[color:var(--danger)]">{error}</p>}
      {link ? (
        <a href={link} target="_blank" rel="noreferrer"
          className="inline-block rounded-lg bg-[color:var(--provider-whatsapp)] text-[color:var(--fg-inverse)] px-4 py-2 font-medium">
          Abrir en WhatsApp →
        </a>
      ) : (
        <button onClick={genLink} disabled={busy}
          className="rounded-lg bg-[var(--color-accent)] text-[var(--fg-inverse)] px-4 py-2 font-medium disabled:opacity-50">
          {busy ? 'Generando…' : 'Generar enlace de reclamo'}
        </button>
      )}
    </Card>
  )
}
