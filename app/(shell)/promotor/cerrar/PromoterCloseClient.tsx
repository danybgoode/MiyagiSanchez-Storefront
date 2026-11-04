'use client'

import { useEffect, useState } from 'react'
import { ESTADO_NAMES } from '@/lib/mx-locations'
import { shopUrlFor } from '@/lib/market-url'
import { SITE_ORIGIN } from '@/lib/market-seo'
import ListingStep from './ListingStep'
import PrintAdStep from './PrintAdStep'
import PreviewStep from './PreviewStep'
import RelationshipStep from './RelationshipStep'

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
}: {
  bound: Bound
  transferEnabled: boolean
  previewEnabled: boolean
  activationCrmEnabled: boolean
}) {
  const [bound, setBound] = useState<Bound>(initialBound)
  const [shop, setShop] = useState<Shop | null>(null)
  // S1 cross-review A3 — the relationship record (captured in RelationshipStep,
  // which reports its id up via `onRelationshipChange`) must not stay orphaned
  // from the shop it precedes (README D1). `handleShopCreated` below links the
  // two the instant SetupStep creates a shop. Also unblocks A7's "Registrar
  // permiso" button in practice: the consent route resolves a relationship's
  // preview by ITS linked shop_id when no explicit previewId is supplied
  // (lib/relationship-consent.ts / the consent route), so the button only ever
  // works once this link exists.
  const [relationshipId, setRelationshipId] = useState<string | null>(null)
  // S1 cross-review B3(b) — a failed shop↔relationship link (404 "not owned",
  // 409 "shop already has a relationship") must not fail silently; the
  // promoter's only symptom otherwise is a confusing refusal much later, at
  // consent time.
  const [shopLinkError, setShopLinkError] = useState<string | null>(null)

  if (!bound) return <BindStep onBound={setBound} />

  /** Wraps `setShop` so a newly created shop is also linked to the current
   *  relationship record, when the activation-crm flag is on and a relationship
   *  already exists. Checks the response (B3b) and surfaces a failed link
   *  instead of discarding it — shop creation itself still never blocks on
   *  this (the shop is real either way; RelationshipStep's own save also
   *  re-attempts the link on every save, B3a, so a transient failure here
   *  isn't the only chance). */
  async function handleShopCreated(s: Shop) {
    setShop(s)
    setShopLinkError(null)
    if (activationCrmEnabled && relationshipId) {
      try {
        const res = await fetch('/api/promoter/relationship', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ relationshipId, shopId: s.shopId }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.ok) {
          setShopLinkError(data.error ?? 'No se pudo vincular la tienda al registro del comercio.')
        }
      } catch {
        setShopLinkError('No se pudo vincular la tienda al registro del comercio (error de red).')
      }
    }
  }

  /** S1 cross-review B2 — reconciles `shop` with whichever relationship is
   *  currently active, reported by RelationshipStep from a FRESH read
   *  (mount-resume, a record switch, or "Nuevo registro"). `null` covers both
   *  "no shop yet" and "switched away" — either way, the PREVIOUS relationship's
   *  shop must never keep rendering (listing/preview/paid-close actions) once
   *  a different (or no) merchant is active. */
  function handleRelationshipShopHint(hint: Shop | null) {
    setShop(hint)
    setShopLinkError(null)
  }

  // When private previews are ON, the shop is prepared privately: the promoter
  // shares a preview link, the merchant approves, then the promoter activates.
  // The activation step slots in right after the listing step (where the products
  // are added) and before the paid-SKU / hand-off steps.
  //
  // Numbering is a running counter, not hardcoded per step — every step that
  // might not render (flag off, no shop yet) increments it only when it
  // actually shows, via `&&`'s short-circuit, so the visible steps always
  // number contiguously from 1 regardless of which optional steps are on.
  // With `activationCrmEnabled` false this behaves byte-identically to before
  // this step existed: RelationshipStep never renders, so SetupStep is still
  // the first counter increment (n=1), exactly as its old hardcoded `n={1}`.
  let n = 0
  return (
    <div className="max-w-xl mx-auto px-4 py-8 space-y-8">
      <header>
        <h1 className="text-2xl font-bold">Cerrar venta</h1>
        <p className="text-sm text-[var(--color-muted)] mt-1">
          Promotor <span className="font-mono font-semibold">{bound.code}</span>
          {bound.name && <span className="ml-2">· {bound.name}</span>}
        </p>
      </header>

      {activationCrmEnabled && (
        <RelationshipStep
          n={(n += 1)}
          promoterCode={bound.code}
          linkedShopId={shop?.shopId ?? null}
          onRelationshipChange={setRelationshipId}
          onRelationshipShopHint={handleRelationshipShopHint}
        />
      )}
      {activationCrmEnabled && shopLinkError && (
        <p className="text-sm text-[color:var(--danger)]">{shopLinkError}</p>
      )}
      <SetupStep n={(n += 1)} shop={shop} onShop={handleShopCreated} />
      {shop && <ListingStep shop={shop} n={(n += 1)} />}
      {shop && previewEnabled && <PreviewStep shop={shop} n={(n += 1)} />}
      {shop && <CloseStep shop={shop} transferEnabled={transferEnabled} n={(n += 1)} />}
      {shop && <PrintAdStep shop={shop} n={(n += 1)} />}
      {shop && <HandoffStep shop={shop} n={(n += 1)} />}
    </div>
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

function BindStep({ onBound }: { onBound: (b: Bound) => void }) {
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
      const data = await res.json()
      if (!res.ok || !data.ok) { setError(data.error ?? 'No se pudo vincular.'); return }
      onBound(data.promoter)
    } catch { setError('Error de red. Intenta de nuevo.') }
    finally { setBusy(false) }
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-8 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Vincula tu código</h1>
        <p className="text-sm text-[var(--color-muted)] mt-1">
          Ingresa tu código de promotor (PRM-…) para empezar a cerrar ventas.
        </p>
      </header>
      <div className="space-y-3">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="PRM-XXXXXX"
          className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2 font-mono"
        />
        {error && <p className="text-sm text-[color:var(--danger)]">{error}</p>}
        <button
          onClick={bind}
          disabled={busy || !code.trim()}
          className="rounded-lg bg-[var(--color-accent)] text-[var(--fg-inverse)] px-4 py-2 font-medium disabled:opacity-50"
        >
          {busy ? 'Vinculando…' : 'Vincular código'}
        </button>
      </div>
    </div>
  )
}

function SetupStep({ n, shop, onShop }: { n: number; shop: Shop | null; onShop: (s: Shop) => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [operatingMarket, setOperatingMarket] = useState<'mx' | 'us'>('mx')
  const [cp, setCp] = useState('')
  const [cpBusy, setCpBusy] = useState(false)
  const [cpError, setCpError] = useState<string | null>(null)
  const [estado, setEstado] = useState('')
  const [municipio, setMunicipio] = useState('')
  const [colonia, setColonia] = useState('')
  const [colonias, setColonias] = useState<string[]>([])
  const [manual, setManual] = useState(false)
  const [merchantEmail, setMerchantEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // CP-first lookup (Sprint 5 · US-5.2) — same envia geocode pattern checkout's
  // shipping-origin step already uses. A promoter standing in the shop can type
  // the 5-digit CP and get structured estado/municipio/colonia data, instead of
  // a free-text "Ubicación (opcional)" field nobody downstream could parse.
  async function lookupCp() {
    setCpBusy(true); setCpError(null)
    try {
      const res = await fetch('/api/checkout/postal-lookup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cp }),
      })
      const data = await res.json()
      if (!res.ok) { setCpError(data.error ?? 'Código postal no encontrado.'); return }
      setEstado(data.stateName ?? '')
      setMunicipio(data.alcaldia ?? '')
      setColonias(Array.isArray(data.colonias) ? data.colonias : [])
      setColonia(data.colonias?.[0] ?? '')
    } catch { setCpError('Error de red. Intenta de nuevo.') }
    finally { setCpBusy(false) }
  }

  async function setup() {
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/promoter/shop/setup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description: description.trim() || undefined,
          operating_market: operatingMarket,
          cp: cp.trim() || undefined,
          estado: estado.trim() || undefined,
          municipio: municipio.trim() || undefined,
          colonia: colonia.trim() || undefined,
          merchant_email: merchantEmail.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) { setError(data.error ?? 'No se pudo crear.'); return }
      onShop({ shopId: data.shopId, slug: data.slug, name: data.name, currency: operatingMarket === 'us' ? 'USD' : 'MXN', estado: data.estado ?? null, municipio: data.municipio ?? null })
    } catch { setError('Error de red. Intenta de nuevo.') }
    finally { setBusy(false) }
  }

  return (
    <Card n={n} title="Abrir la tienda">
      {shop ? (
        <p className="text-sm">
          <i className="iconoir-check-circle" aria-hidden /> <strong>{shop.name}</strong> · <a className="underline" href={shopUrlFor(SITE_ORIGIN, shop.slug)} target="_blank" rel="noreferrer">{shopUrlFor(SITE_ORIGIN, shop.slug)}</a>
        </p>
      ) : (
        <div className="space-y-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre del negocio"
            className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2" />

          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Descripción del negocio (opcional)"
            rows={3} maxLength={2000} className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2" />

          <select value={operatingMarket} onChange={(e) => setOperatingMarket(e.target.value as 'mx' | 'us')}
            aria-label="Mercado operativo"
            className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2">
            <option value="mx">México · MXN</option>
            <option value="us">Estados Unidos · USD</option>
          </select>

          {!manual ? (
            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  value={cp}
                  onChange={(e) => setCp(e.target.value.replace(/\D/g, '').slice(0, 5))}
                  placeholder="Código postal"
                  inputMode="numeric"
                  className="flex-1 rounded-lg border border-[var(--color-border)] px-3 py-2"
                />
                <button type="button" onClick={lookupCp} disabled={cpBusy || cp.length < 4}
                  className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium disabled:opacity-50">
                  {cpBusy ? 'Buscando…' : 'Buscar'}
                </button>
              </div>
              {cpError && <p className="text-sm text-[color:var(--danger)]">{cpError}</p>}
              {estado && (
                <p className="text-sm text-[var(--color-muted)]">
                  <i className="iconoir-map-pin" aria-hidden /> {municipio}, {estado}
                  {colonias.length > 0 && (
                    <select value={colonia} onChange={(e) => setColonia(e.target.value)}
                      aria-label="Colonia"
                      className="ml-2 rounded border border-[var(--color-border)] px-2 py-1 text-sm">
                      {colonias.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  )}
                </p>
              )}
              <button type="button" onClick={() => setManual(true)}
                className="text-xs underline text-[var(--color-muted)]">
                No tengo el código postal
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <select value={estado} onChange={(e) => setEstado(e.target.value)}
                aria-label="Estado"
                className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2">
                <option value="">Estado (opcional)…</option>
                {ESTADO_NAMES.map((e) => <option key={e} value={e}>{e}</option>)}
              </select>
              <input value={municipio} onChange={(e) => setMunicipio(e.target.value)}
                placeholder="Municipio / alcaldía (opcional)"
                className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2" />
            </div>
          )}

          <input value={merchantEmail} onChange={(e) => setMerchantEmail(e.target.value)}
            type="email" placeholder="Correo del comerciante (opcional)"
            className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2" />
          <p className="text-xs text-[var(--color-muted)]">
            Si lo dejas en blanco, el recibo de cada compra te llega a ti para que se lo compartas.
          </p>

          {error && <p className="text-sm text-[color:var(--danger)]">{error}</p>}
          <button onClick={setup} disabled={busy || name.trim().length < 2}
            className="rounded-lg bg-[var(--color-accent)] text-[var(--fg-inverse)] px-4 py-2 font-medium disabled:opacity-50">
            {busy ? 'Creando…' : 'Crear tienda'}
          </button>
        </div>
      )}
    </Card>
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
const CLOSE_SKUS = [
  { id: 'domain', label: 'Dominio propio', payLabel: 'Pagar dominio propio (1 año)' },
  { id: 'ml-sync', label: 'Sincronización Mercado Libre', payLabel: 'Pagar sincronización ML (1 año)' },
  { id: 'migration', label: 'Migración de tienda', payLabel: 'Cobrar migración' },
] as const
type CloseSkuId = (typeof CLOSE_SKUS)[number]['id']

const TRANSFER_METHOD_LABEL: Record<Transfer['method'], string> = {
  spei: 'SPEI',
  dimo: 'DiMo',
  codi: 'CoDi',
}

const mxn = (cents: number) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 }).format(cents / 100)

function CloseStep({ shop, transferEnabled, n }: { shop: Shop; transferEnabled: boolean; n: number }) {
  const [sku, setSku] = useState<CloseSkuId>('domain')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [payMethod, setPayMethod] = useState<'stripe' | 'transfer'>('stripe')
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
    const transferSku = sku === 'ml-sync' ? 'ml_sync' : sku
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
      <Card n={n} title="Cobrar y pagar (a nombre del comerciante)">
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
            Esta transferencia fue rechazada. Vuelve a elegir un producto para intentar de nuevo.
          </p>
        )}
      </Card>
    )
  }

  return (
    <Card n={2} title="Cobrar y pagar (a nombre del comerciante)">
      <p className="text-sm text-[var(--color-muted)]">
        Cobra al comerciante (efectivo) y paga con tu tarjeta — o repórtale la transferencia a Miyagi. La
        venta se atribuye a tu código y el beneficio queda activado en la tienda del comerciante.
      </p>
      <label className="block text-sm">
        <span className="text-[var(--color-muted)]">Producto</span>
        <select
          value={sku}
          onChange={(e) => { setSku(e.target.value as CloseSkuId); setDone(null); setError(null) }}
          disabled={busy}
          aria-label="Producto a cerrar"
          className="mt-1 w-full rounded-lg border border-[var(--color-border)] px-3 py-2"
        >
          {CLOSE_SKUS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
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
            <button type="button" onClick={() => setPayMethod('stripe')} disabled={busy}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${payMethod === 'stripe' ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--fg-inverse)]' : 'border-[var(--color-border)]'}`}>
              Tarjeta (Stripe)
            </button>
            <button type="button" onClick={() => setPayMethod('transfer')} disabled={busy}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${payMethod === 'transfer' ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--fg-inverse)]' : 'border-[var(--color-border)]'}`}>
              Transferir a Miyagi
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
