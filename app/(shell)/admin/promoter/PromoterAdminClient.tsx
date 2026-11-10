'use client'

import { useMemo, useState } from 'react'
import {
  PROMOTER_SKUS,
  type Promoter,
  type PromoterSettings,
  type PromoterAttribution,
  type PromoterSku,
  type Commission,
} from '@/lib/promoter'
import type { OperatorDetailsV1, OperatorDetailsV2, PromoterApplication } from '@/lib/promoter-applications'
import { PROMOTER_SKU_BASE_PRICE_MXN } from '@/lib/promoter-earnings'
import { buildSkuPriceTable, computeBundleRow, type PromoterSkuPrices } from '@/lib/promoter-pricing'
import { TRANSFER_SKU_LABEL, type TransferSku } from '@/lib/promoter-transfer'
import { PACKAGES, PACKAGE_FREE_MONTHS, isSellablePackageSku, packageSentence } from '@/lib/promoter-packages'
import type { PromoterTransfer } from '@/lib/promoter-transfers'
import { SELLER_LANDING_PATHS } from '@/lib/seller-acquisition'

/**
 * Promoter console — provision promoters + edit the seller discount + (S3) set the
 * per-SKU commission % and settle accrued commissions offline, over
 * `/api/admin/promoter*`. **Clerk-gated** (same-origin requests carry the session
 * cookie). The feature stays hidden behind the `promoter.enabled` flag; this admin
 * screen only manages the data.
 *
 * `discount_amount_cents` is reused for both discount types: pesos (×100) when
 * `fixed`, a raw percentage when `percentage` — the input adapts its label.
 */

const SKU_LABEL: Record<PromoterSku, string> = {
  custom_domain: 'Dominio propio',
  print_ad: 'Anuncio impreso',
  subdomain: 'Subdominio propio',
  ml_sync: 'Sincronización Mercado Libre',
  migration: 'Migración de tienda',
  // The packages are named by lib/promoter-packages.ts (plan-tienda D18); retired ones keep a label so old rows read.
  tienda_anual: PACKAGES.tienda_anual.label,
  negocio_semestral: PACKAGES.negocio_semestral.label,
  negocio_anual: PACKAGES.negocio_anual.label,
  negocio_arranque: `${PACKAGES.negocio_arranque.label} (ya no se vende)`,
  setup_gratis: `${PACKAGES.setup_gratis.label} (ya no se vende)`,
  negocio_renewal: 'Renovación del Plan Negocio (12 meses después del paquete)',
  tienda_renewal: 'Renovación del Plan Tienda (12 meses después del paquete)',
  negocio_upgrade: 'Cambio de Plan Tienda a Plan Negocio (primer año)',
}

/**
 * SKUs with no `PROMOTER_SKU_BASE_PRICE_MXN` entry that are STILL directly priced at
 * checkout from `skuPrices[sku]` (unlike `print_ad`, whose real price is per-tier —
 * see `lib/print-server.ts` — and never reads this table at all). The price input
 * below must stay settable for these even though there's no "regular" price to show
 * a discount against — platform-migrations S3, fixing a real gap: the input was
 * unconditionally disabled whenever `base == null`, which made `migration`'s $999
 * flat price impossible to set through this screen (see `lib/migration-checkout.ts`).
 */
const DIRECT_PRICE_SKUS: PromoterSku[] = ['migration']

const mxn = (cents: number) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(cents / 100)

const APPLICATION_STATUS_LABEL: Record<PromoterApplication['status'], string> = {
  pending: 'Pendiente',
  approved: 'Aprobada',
  rejected: 'Rechazada',
}

const INVITATION_PROVIDER_LABEL = {
  pending: 'Confirmación del proveedor pendiente',
  provider_accepted: 'Proveedor aceptó la solicitud de envío',
  unconfirmed: 'Aceptación del proveedor no confirmada',
} as const

function invitationProviderLabel(value: unknown): string {
  if (value === 'pending') return INVITATION_PROVIDER_LABEL.pending
  if (value === 'provider_accepted') return INVITATION_PROVIDER_LABEL.provider_accepted
  if (value === 'unconfirmed') return INVITATION_PROVIDER_LABEL.unconfirmed
  return 'Estado del proveedor no disponible'
}

function applicationActionErrorLabel(value: unknown): string {
  if (value === 'not_found') return 'La solicitud ya no está disponible.'
  if (value === 'invalid_transition') return 'La solicitud cambió de estado. Actualiza la página e inténtalo de nuevo.'
  if (value === 'unavailable') return 'No pudimos completar la operación en este momento. Inténtalo de nuevo.'
  return 'No se pudo procesar la solicitud.'
}

function merchantAwarenessLabel(value: unknown): string {
  if (value === 'not_contacted') return 'Sin contactar sobre la nominación'
  if (value === 'aware_of_nomination') return 'Conoce la nominación'
  if (value === 'interested_in_conversation') return 'Interés en conversar'
  return 'Estado no disponible'
}

function platformLabel(value: unknown): string {
  if (value === 'shopify') return 'Shopify'
  if (value === 'woocommerce') return 'WooCommerce'
  if (value === 'other') return 'Otra'
  return 'Plataforma no disponible'
}

/** Build a tappable wa.me link from a stored WhatsApp number (digits only). */
function whatsappLink(whatsapp: string): string {
  return `https://wa.me/${whatsapp.replace(/\D/g, '')}`
}

/**
 * Operator answers, rendered per stored version. v2 is what the live form submits;
 * v1 is the retired three-shop dossier, kept renderable so a historical row does not
 * silently show as a blank panel. An unrecognized version says so rather than
 * guessing at fields that may not be there.
 */
function OperatorDetailsBlock({ id, version, details }: {
  id: string
  version: PromoterApplication['operator_details_version']
  details: NonNullable<PromoterApplication['operator_details']>
}) {
  if (version === 2) {
    const v2 = details as OperatorDetailsV2
    return (
      <dl className="space-y-2 text-xs">
        <div><dt className="text-[var(--color-muted)]">Ciudad o territorio</dt><dd className="font-medium">{v2.city ?? 'Sin especificar'}</dd></div>
        {v2.motivation && (
          <div><dt className="font-semibold">Por qué quiere entrar</dt><dd className="mt-0.5 text-[var(--color-muted)] whitespace-pre-wrap">{v2.motivation}</dd></div>
        )}
      </dl>
    )
  }
  if (version !== 1) return <p className="text-xs text-[var(--color-muted)]">Formato de solicitud no reconocido (v{String(version)}).</p>

  const v1 = details as OperatorDetailsV1
  return (
    <>
      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <div><dt className="text-[var(--color-muted)]">Firma o práctica</dt><dd className="font-medium">{v1.company_name}</dd></div>
        <div><dt className="text-[var(--color-muted)]">Rol</dt><dd className="font-medium">{v1.operator_role}</dd></div>
        <div><dt className="text-[var(--color-muted)]">Tiendas activas</dt><dd className="font-medium">{v1.active_shop_count}</dd></div>
        <div><dt className="text-[var(--color-muted)]">Revisión a 90 días</dt><dd className="font-medium">Confirmada</dd></div>
      </dl>
      <ol className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
        {v1.candidate_shops.map((shop, index) => (
          <li key={`${id}-${index}`} className="grid gap-1 py-2 text-xs sm:grid-cols-[2rem_1fr_auto] sm:items-center">
            <span className="font-mono text-[var(--color-agent)]">0{index + 1}</span>
            <a href={shop.url} target="_blank" rel="noopener noreferrer" className="underline break-all">{shop.url}</a>
            <span className="text-[var(--color-muted)]">{platformLabel(shop.platform)} · {merchantAwarenessLabel(shop.merchant_awareness)}</span>
          </li>
        ))}
      </ol>
      <dl className="space-y-2 text-xs">
        <div><dt className="font-semibold">Problema operativo reciente</dt><dd className="mt-0.5 text-[var(--color-muted)] whitespace-pre-wrap">{v1.recent_operating_problem}</dd></div>
        <div><dt className="font-semibold">Sistemas que deben permanecer</dt><dd className="mt-0.5 text-[var(--color-muted)] whitespace-pre-wrap">{v1.must_retain_systems}</dd></div>
        <div><dt className="font-semibold">Por qué ahora</dt><dd className="mt-0.5 text-[var(--color-muted)] whitespace-pre-wrap">{v1.why_now}</dd></div>
      </dl>
    </>
  )
}

export default function PromoterAdminClient({
  initialPromoters,
  initialSettings,
  initialCommissionRates,
  initialSkuPrices,
  initialPendingCommissions,
  initialApplications,
  initialPendingTransfers,
  siteUrl,
}: {
  initialPromoters: Promoter[]
  initialSettings: PromoterSettings
  initialCommissionRates: Record<PromoterSku, number>
  initialSkuPrices: PromoterSkuPrices
  initialPendingCommissions: Commission[]
  initialApplications: PromoterApplication[]
  initialPendingTransfers: PromoterTransfer[]
  siteUrl: string
}) {
  const [promoters, setPromoters] = useState<Promoter[]>(initialPromoters)
  const [applications, setApplications] = useState<PromoterApplication[]>(initialApplications)
  const [decidingId, setDecidingId] = useState<string | null>(null)
  const [resendingId, setResendingId] = useState<string | null>(null)
  const [settings, setSettings] = useState<PromoterSettings>(initialSettings)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  // Per-promoter attribution ledger (lazy-loaded on expand).
  const [openId, setOpenId] = useState<string | null>(null)
  const [attributions, setAttributions] = useState<Record<string, PromoterAttribution[]>>({})
  const [loadingAttrs, setLoadingAttrs] = useState<string | null>(null)
  // S3 — per-SKU commission rates + settlement.
  const [rates, setRates] = useState<Record<PromoterSku, number>>(initialCommissionRates)
  const [savingRate, setSavingRate] = useState<PromoterSku | null>(null)
  const [pending, setPending] = useState<Commission[]>(initialPendingCommissions)
  const [refs, setRefs] = useState<Record<string, string>>({})
  const [settling, setSettling] = useState<string | null>(null)
  // Sprint 3 (US-3.1) — per-SKU promoter price overrides + the bundle offer.
  const [skuPrices, setSkuPrices] = useState<PromoterSkuPrices>(initialSkuPrices)
  const [priceInputs, setPriceInputs] = useState<Record<string, string>>(
    Object.fromEntries(PROMOTER_SKUS.map((sku) => [sku, initialSkuPrices[sku] != null ? String(initialSkuPrices[sku]) : ''])),
  )
  const [savingPrice, setSavingPrice] = useState<PromoterSku | null>(null)
  // Sprint 4 (US-4.2) — pending net-remittance transfers + admin approve/reject.
  const [transfers, setTransfers] = useState<PromoterTransfer[]>(initialPendingTransfers)
  const [decidingTransferId, setDecidingTransferId] = useState<string | null>(null)
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({})
  // Captured once at mount — keeps render pure (no Date.now() in the render body).
  const [now] = useState(() => Date.now())

  const codeById = new Map(promoters.map((p) => [p.id, p.code]))

  // Live preview — the SAME deriver the landing/handbook/close workspace use, so
  // "what you see here is what they see" holds without a deploy or a page reload.
  const priceTable = useMemo(() => buildSkuPriceTable(PROMOTER_SKU_BASE_PRICE_MXN, skuPrices, settings), [skuPrices, settings])
  const bundleRow = useMemo(
    () => computeBundleRow(priceTable, { skus: settings.bundle_skus, bundlePriceMxn: settings.bundle_price_mxn }),
    [priceTable, settings.bundle_skus, settings.bundle_price_mxn],
  )

  async function toggleAttributions(promoterId: string) {
    if (openId === promoterId) { setOpenId(null); return }
    setOpenId(promoterId)
    if (attributions[promoterId]) return // cached
    setLoadingAttrs(promoterId)
    try {
      const res = await fetch(`/api/admin/promoter/attributions?promoterId=${encodeURIComponent(promoterId)}`)
      const data = await res.json().catch(() => ({}))
      setAttributions((m) => ({ ...m, [promoterId]: data.attributions ?? [] }))
    } finally {
      setLoadingAttrs((id) => (id === promoterId ? null : id))
    }
  }

  const isFixed = settings.discount_type === 'fixed'
  const amountDisplay = isFixed ? settings.discount_amount_cents / 100 : settings.discount_amount_cents

  function setAmountFromDisplay(value: number) {
    const cents = isFixed ? Math.round(value * 100) : Math.round(value)
    setSettings((s) => ({ ...s, discount_amount_cents: cents }))
  }

  function shareLink(code: string) {
    // The MX landing, read from the one place that knows where a market recruits.
    // `/vende` still 308s here with the query intact, so the old form worked — but
    // this link is MINTED fresh, then printed on cards and pasted into chats where it
    // outlives any redirect rule. A share link should be the destination, not a hop.
    return `${siteUrl}${SELLER_LANDING_PATHS.mx}?promo=${code}`
  }

  async function createPromoter() {
    setCreating(true)
    setMsg(null)
    try {
      const res = await fetch('/api/admin/promoter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.promoter) {
        setMsg(data?.error ?? 'No se pudo crear el promotor.')
        return
      }
      setPromoters((list) => [data.promoter, ...list])
      setName('')
      setMsg('Promotor creado.')
    } finally {
      setCreating(false)
    }
  }

  async function saveSettings() {
    setSavingSettings(true)
    setMsg(null)
    try {
      const res = await fetch('/api/admin/promoter', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMsg(data?.error ?? 'No se pudo guardar.')
        return
      }
      if (data.settings) setSettings(data.settings)
      setMsg('Descuento guardado.')
    } finally {
      setSavingSettings(false)
    }
  }

  async function savePrice(sku: PromoterSku) {
    setSavingPrice(sku)
    setMsg(null)
    try {
      const raw = priceInputs[sku] ?? ''
      const promoterPriceMxn = raw.trim() === '' ? null : Number(raw)
      const res = await fetch('/api/admin/promoter/pricing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku, promoter_price_mxn: promoterPriceMxn }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMsg(data?.error ?? 'No se pudo guardar.')
        return
      }
      // Resync the text input to the SAVED (possibly rounded) value — otherwise a
      // stale unrounded input (e.g. "12.7") can sit next to the actual "13" the
      // server persisted (caught in cross-agent review of PR 165).
      if (data.prices) {
        setSkuPrices(data.prices)
        setPriceInputs((p) => ({ ...p, [sku]: data.prices[sku] != null ? String(data.prices[sku]) : '' }))
      }
      setMsg('Precio guardado.')
    } finally {
      setSavingPrice(null)
    }
  }

  async function saveRate(sku: PromoterSku) {
    setSavingRate(sku)
    setMsg(null)
    try {
      const res = await fetch('/api/admin/promoter/commission', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku, rate_pct: rates[sku] }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMsg(data?.error ?? 'No se pudo guardar.')
        return
      }
      if (data.rates) setRates(data.rates)
      setMsg('Comisión guardada.')
    } finally {
      setSavingRate(null)
    }
  }

  async function settle(id: string) {
    setSettling(id)
    setMsg(null)
    try {
      const res = await fetch(`/api/admin/promoter/commission/${encodeURIComponent(id)}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference: refs[id] ?? '' }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMsg(data?.error ?? 'No se pudo marcar como pagada.')
        return
      }
      setPending((list) => list.filter((c) => c.id !== id))
      setMsg(data.alreadyPaid ? 'Ya estaba pagada.' : 'Comisión marcada como pagada.')
    } finally {
      setSettling(null)
    }
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(shareLink(code))
      setCopied(code)
      setTimeout(() => setCopied((c) => (c === code ? null : c)), 1500)
    } catch {
      /* clipboard unavailable — the link is visible to copy by hand */
    }
  }

  async function decide(id: string, action: 'approve' | 'reject') {
    setDecidingId(id)
    setMsg(null)
    try {
      const res = await fetch(`/api/admin/promoter/applications/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setMsg(applicationActionErrorLabel(data?.error))
        return
      }
      setApplications((list) => list.map((a) => (a.id === id ? data.application : a)))
      if (data.promoter) setPromoters((list) => [data.promoter, ...list])
      if (action === 'approve' && data.application?.program_track === 'founding_operator') {
        setMsg(`Solicitud aprobada. ${invitationProviderLabel(data.invitation?.providerStatus)}.`)
      } else {
        setMsg(action === 'approve' ? 'Solicitud aprobada — se envió el código por correo.' : 'Solicitud rechazada.')
      }
    } catch {
      setMsg('No se pudo procesar la solicitud.')
    } finally {
      setDecidingId(null)
    }
  }

  async function resendInvitation(id: string) {
    const application = applications.find((candidate) => candidate.id === id)
    if (!application || application.program_track !== 'founding_operator'
      || application.status !== 'approved' || application.activation_used_at != null) {
      setMsg('La invitación ya no se puede rotar desde este estado.')
      return
    }
    setResendingId(id)
    setMsg(null)
    try {
      const res = await fetch(`/api/admin/promoter/applications/${encodeURIComponent(id)}/resend`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setMsg(applicationActionErrorLabel(data?.error))
        return
      }
      setApplications((list) => list.map((application) => application.id === id ? data.application : application))
      setMsg(`Invitación rotada. ${invitationProviderLabel(data.invitation?.providerStatus)}.`)
    } catch {
      setMsg('No se pudo rotar la invitación.')
    } finally {
      setResendingId(null)
    }
  }

  async function decideTransfer(id: string, action: 'approve' | 'reject') {
    setDecidingTransferId(id)
    setMsg(null)
    try {
      const res = await fetch(`/api/admin/promoter/transfers/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        ...(action === 'reject' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: rejectReasons[id] ?? '' }) } : {}),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setMsg(data?.error ?? 'No se pudo procesar la transferencia.')
        return
      }
      setTransfers((list) => list.filter((t) => t.id !== id))
      setMsg(action === 'approve' ? 'Transferencia aprobada — beneficio activado.' : 'Transferencia rechazada.')
    } finally {
      setDecidingTransferId(null)
    }
  }

  /** Age since reported, es-MX short form — so a stale transfer is visible at a glance. */
  function ageSince(iso: string | null): string {
    if (!iso) return '—'
    const ms = now - new Date(iso).getTime()
    const hours = Math.floor(ms / 3_600_000)
    if (hours < 1) return 'hace unos minutos'
    if (hours < 24) return `hace ${hours}h`
    return `hace ${Math.floor(hours / 24)}d`
  }

  const pendingTotalCents = pending.reduce((sum, c) => sum + (c.commission_cents ?? 0), 0)

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Promotores</h1>
        <p className="text-sm text-[var(--color-muted)] mt-1">
          Provisiona promotores y configura el descuento que su código ofrece a la tienda. Los cambios aplican sin redeploy.
        </p>
      </div>

      {/* Provision a new promoter */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Nuevo promotor</h2>
        <div className="flex items-end gap-3">
          <label className="block text-sm flex-1">
            Nombre (opcional)
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej. María — zona centro"
              className="w-full mt-1 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm bg-transparent"
            />
          </label>
          <button
            onClick={createPromoter}
            disabled={creating}
            className="btn btn-primary"
          >
            {creating ? 'Creando…' : 'Crear promotor'}
          </button>
        </div>
      </section>

      {/* One queue; qualification is structured while shop authority stays elsewhere. */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Solicitudes ({applications.filter((a) => a.status === 'pending').length} pendientes)</h2>
        {applications.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">Aún no hay solicitudes.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
            {applications.map((a) => (
              <li key={a.id} className="p-3 space-y-2 text-sm">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <span className="font-semibold">{a.name}</span>
                    {a.city && <span className="text-[var(--color-muted)] ml-2">· {a.city}</span>}
                    {a.program_track === 'founding_operator' && <span className="ml-2 text-xs font-medium rounded bg-[var(--color-agent-soft)] text-[var(--color-agent)] px-1.5 py-0.5">Operador fundador de comercio · EE. UU.</span>}
                  </div>
                  <span className="text-xs rounded bg-[var(--color-surface-alt)] px-1.5 py-0.5">
                    {APPLICATION_STATUS_LABEL[a.status]}
                  </span>
                </div>
                <div className="text-xs text-[var(--color-muted)]">
                  {a.email} ·{' '}
                  <a href={whatsappLink(a.whatsapp)} target="_blank" rel="noreferrer" className="underline">
                    WhatsApp
                  </a>
                </div>
                {a.program_track === 'founding_operator' && a.operator_details ? (
                  <div className="space-y-3 border-l-2 border-[var(--color-agent)] pl-3">
                    <OperatorDetailsBlock id={a.id} version={a.operator_details_version} details={a.operator_details} />
                    {a.status === 'approved' && a.invitation_provider_status && (
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="rounded bg-[var(--color-surface-alt)] px-2 py-1">
                          {invitationProviderLabel(a.invitation_provider_status)}
                        </span>
                        {a.invitation_attempt_count != null && <span className="text-[var(--color-muted)]">Intentos registrados: {a.invitation_attempt_count}</span>}
                      </div>
                    )}
                  </div>
                ) : a.motivation ? <p className="text-xs text-[var(--color-muted)] italic">&ldquo;{a.motivation}&rdquo;</p> : null}
                {a.status === 'pending' && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={() => decide(a.id, 'approve')}
                      disabled={decidingId === a.id}
                      className="btn btn-primary btn-sm"
                    >
                      {decidingId === a.id ? 'Procesando…' : 'Aprobar'}
                    </button>
                    {a.program_track === 'founding_operator' && (
                      <a href={`mailto:${encodeURIComponent(a.email)}?subject=${encodeURIComponent('Miyagi Partners — conversación sobre solicitud')}`} className="rounded-lg border border-[var(--color-border)] px-3 py-1 text-sm font-semibold hover:bg-[var(--color-surface)]">
                        Solicitar conversación
                      </a>
                    )}
                    <button
                      onClick={() => decide(a.id, 'reject')}
                      disabled={decidingId === a.id}
                      className="btn btn-secondary btn-sm"
                    >
                      Rechazar
                    </button>
                  </div>
                )}
                {a.program_track === 'founding_operator' && a.status === 'approved' && !a.activation_used_at && (
                  <button
                    onClick={() => resendInvitation(a.id)}
                    disabled={resendingId === a.id}
                    className="btn btn-secondary btn-sm"
                  >
                    {resendingId === a.id ? 'Rotando…' : 'Rotar y reenviar invitación'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Promoter list with code + share link */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Promotores ({promoters.length})</h2>
        {promoters.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">Aún no hay promotores.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
            {promoters.map((p) => (
              <li key={p.id} className="p-3 space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <span className="font-mono font-semibold">{p.code}</span>
                    {p.name && <span className="text-sm text-[var(--color-muted)] ml-2">{p.name}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => toggleAttributions(p.id)}
                      className="btn btn-secondary btn-sm"
                    >
                      {openId === p.id ? 'Ocultar' : 'Atribuciones'}
                    </button>
                    <button
                      onClick={() => copy(p.code)}
                      className="btn btn-secondary btn-sm"
                    >
                      {copied === p.code ? 'Copiado' : 'Copiar liga'}
                    </button>
                  </div>
                </div>
                <div className="text-xs text-[var(--color-muted)] font-mono break-all">{shareLink(p.code)}</div>
                {openId === p.id && (
                  <div className="mt-2 rounded-lg bg-[var(--color-surface)] p-2 text-xs">
                    {loadingAttrs === p.id ? (
                      <p className="text-[var(--color-muted)]">Cargando…</p>
                    ) : (attributions[p.id]?.length ?? 0) === 0 ? (
                      <p className="text-[var(--color-muted)]">Sin atribuciones todavía.</p>
                    ) : (
                      <ul className="space-y-1">
                        {attributions[p.id].map((a) => (
                          <li key={a.id} className="flex items-center justify-between gap-2">
                            <span className="font-mono">{a.sku ?? '—'}</span>
                            <span className="text-[var(--color-muted)] truncate">{a.seller_id ?? '—'}</span>
                            <span className="rounded bg-[var(--color-surface-alt)] px-1.5 py-0.5">{a.status}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Discount settings */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Descuento del promotor</h2>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => setSettings((s) => ({ ...s, enabled: e.target.checked }))}
            className="h-4 w-4 accent-[var(--color-accent)]"
          />
          Descuento de promotor activo
        </label>

        <label className="block text-sm">
          Tipo de descuento
          <select
            value={settings.discount_type}
            onChange={(e) => setSettings((s) => ({ ...s, discount_type: e.target.value as PromoterSettings['discount_type'] }))}
            className="w-full mt-1 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm bg-transparent"
          >
            <option value="fixed">Monto fijo (MXN)</option>
            <option value="percentage">Porcentaje (%)</option>
          </select>
        </label>

        <label className="block text-sm">
          {isFixed ? 'Monto (MXN)' : 'Porcentaje (%)'}
          <input
            type="number"
            min={0}
            value={amountDisplay}
            onChange={(e) => setAmountFromDisplay(Number(e.target.value))}
            className="w-full mt-1 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm bg-transparent"
          />
        </label>

        <div className="flex items-center gap-3">
          <button
            onClick={saveSettings}
            disabled={savingSettings}
            className="btn btn-primary"
          >
            {savingSettings ? 'Guardando…' : 'Guardar descuento'}
          </button>
        </div>
      </section>

      {/* Sprint 4 (US-4.1) — net-remittance transfer instructions (admin-config, never hardcoded) */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Detalles de transferencia (SPEI/DiMo/CoDi)</h2>
        <p className="text-sm text-[var(--color-muted)]">
          Se muestran al promotor cuando elige &ldquo;Transferir a Miyagi&rdquo; en el cierre.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {([
            ['clabe', 'CLABE'],
            ['bank_name', 'Banco'],
            ['account_holder', 'Titular'],
            ['dimo_phone', 'Teléfono DiMo'],
            ['codi_reference', 'Referencia CoDi'],
          ] as const).map(([key, label]) => (
            <label key={key} className="block text-sm">
              {label}
              <input
                type="text"
                value={settings.transfer_details?.[key] ?? ''}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, transfer_details: { ...s.transfer_details, [key]: e.target.value } }))
                }
                className="w-full mt-1 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm bg-transparent"
              />
            </label>
          ))}
        </div>
        <button
          onClick={saveSettings}
          disabled={savingSettings}
          className="btn btn-primary"
        >
          {savingSettings ? 'Guardando…' : 'Guardar datos de transferencia'}
        </button>
      </section>

      {/* Sprint 3 (US-3.1) — per-SKU promoter price + bundle offer */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Precio por SKU + paquete</h2>
        <p className="text-sm text-[var(--color-muted)]">
          Precio exacto con código de promotor por SKU (vacío = usa el descuento general de arriba). El
          checkout cobra exactamente este número — nunca hay diferencia con lo que se anuncia.
        </p>
        <ul className="space-y-2">
          {PROMOTER_SKUS.map((sku) => {
            const base = PROMOTER_SKU_BASE_PRICE_MXN[sku]
            const directPriced = DIRECT_PRICE_SKUS.includes(sku)
            const priceDisabled = base == null && !directPriced
            const placeholder = base != null
              ? 'usar descuento general'
              : directPriced
                ? 'sin descuento general — precio directo'
                : 'variable (anuncio impreso)'
            return (
              <li key={sku} className="flex items-end gap-3">
                <label className="block text-sm flex-1">
                  {SKU_LABEL[sku]} {base != null && <span className="text-[var(--color-muted)]">· regular {mxn(base * 100)}</span>}
                  <div className="flex items-center gap-2 mt-1">
                    <input
                      type="number"
                      min={0}
                      placeholder={placeholder}
                      value={priceInputs[sku] ?? ''}
                      onChange={(e) => setPriceInputs((p) => ({ ...p, [sku]: e.target.value }))}
                      disabled={priceDisabled}
                      className="w-48 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm bg-transparent disabled:opacity-40"
                    />
                    <span className="text-sm text-[var(--color-muted)]">MXN</span>
                  </div>
                </label>
                <button
                  onClick={() => savePrice(sku)}
                  disabled={savingPrice === sku || priceDisabled}
                  className="btn btn-secondary"
                >
                  {savingPrice === sku ? 'Guardando…' : 'Guardar'}
                </button>
              </li>
            )
          })}
        </ul>

        <div className="pt-2 border-t border-[var(--color-border)] space-y-3">
          <h3 className="text-sm font-semibold">Paquete (todo esto cuesta $X — con tu promotor $Y)</h3>
          <div className="flex flex-wrap gap-3">
            {PROMOTER_SKUS.filter((sku) => PROMOTER_SKU_BASE_PRICE_MXN[sku] != null).map((sku) => (
              <label key={sku} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={settings.bundle_skus.includes(sku)}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      bundle_skus: e.target.checked ? [...s.bundle_skus, sku] : s.bundle_skus.filter((x) => x !== sku),
                    }))
                  }
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                {SKU_LABEL[sku]}
              </label>
            ))}
          </div>
          <label className="block text-sm max-w-xs">
            Precio del paquete (MXN)
            <input
              type="number"
              min={0}
              value={settings.bundle_price_mxn ?? ''}
              onChange={(e) =>
                setSettings((s) => ({ ...s, bundle_price_mxn: e.target.value.trim() === '' ? null : Number(e.target.value) }))
              }
              placeholder="sin configurar"
              className="w-full mt-1 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm bg-transparent"
            />
          </label>
          <button
            onClick={saveSettings}
            disabled={savingSettings}
            className="btn btn-primary"
          >
            {savingSettings ? 'Guardando…' : 'Guardar paquete'}
          </button>
        </div>

        {/* Live preview — same deriver the landing/handbook/close workspace read. */}
        <div className="pt-2 border-t border-[var(--color-border)] space-y-2">
          <h3 className="text-sm font-semibold">Vista previa</h3>
          <ul className="text-sm space-y-1">
            {priceTable.filter((r) => !r.variablePrice).map((r) => (
              <li key={r.sku} className="flex items-center justify-between text-[var(--color-muted)]">
                <span>{SKU_LABEL[r.sku]}</span>
                <span>
                  <span className="line-through mr-2">{mxn((r.regularPriceMxn ?? 0) * 100)}</span>
                  <span className="font-semibold text-[var(--color-fg)]">{r.isFree ? 'GRATIS' : mxn((r.promoterPriceMxn ?? 0) * 100)}</span>
                </span>
              </li>
            ))}
          </ul>
          {bundleRow && (
            <p className="text-sm font-semibold">
              Paquete: {mxn(bundleRow.regularTotalMxn * 100)} → {mxn(bundleRow.bundlePriceMxn * 100)} ({bundleRow.savingsPct}% de ahorro)
            </p>
          )}
        </div>
      </section>

      {/* S3 · US-7 — Per-SKU commission % */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Comisión por SKU</h2>
        <p className="text-sm text-[var(--color-muted)]">
          Porcentaje que gana el promotor. En un paquete es lo que se queda del precio al cobrar, así que no genera
          comisión aparte. En una renovación gana en cada pago del negocio dentro de su año; en el cambio de Plan Tienda a
          Plan Negocio, solo en el primer pago. En los demás productos, solo en el primer pago.
        </p>
        <ul className="space-y-2">
          {PROMOTER_SKUS.map((sku) => (
            <li key={sku} className="flex items-end gap-3">
              <label className="block text-sm flex-1">
                {SKU_LABEL[sku]}
                <div className="flex items-center gap-2 mt-1">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={rates[sku] ?? 0}
                    onChange={(e) => setRates((r) => ({ ...r, [sku]: Math.round(Number(e.target.value)) }))}
                    className="w-24 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm bg-transparent"
                  />
                  <span className="text-sm text-[var(--color-muted)]">%</span>
                </div>
                {/* plan-tienda S4.4: a package on sale reads as the promoter says it, from the rate being edited. */}
                {isSellablePackageSku(sku) && rates[sku] ? (
                  <span className="block mt-1 text-xs text-[var(--color-muted)]" data-testid={`admin-package-sentence-${sku}`}>
                    {packageSentence(sku, rates[sku])}. {PACKAGES[sku].summary}: los {PACKAGE_FREE_MONTHS} meses gratis van además del tiempo pagado.
                  </span>
                ) : null}
              </label>
              <button
                onClick={() => saveRate(sku)}
                disabled={savingRate === sku}
                className="btn btn-secondary"
              >
                {savingRate === sku ? 'Guardando…' : 'Guardar'}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* S3 · US-9 — Offline settlement */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Liquidación de comisiones</h2>
        <p className="text-sm text-[var(--color-muted)]">
          Comisiones acumuladas pendientes de pago (liquidación en efectivo/transferencia — no mueve dinero en la app).
          Total pendiente: <span className="font-semibold">{mxn(pendingTotalCents)}</span>.
        </p>
        {pending.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">No hay comisiones pendientes.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
            {pending.map((c) => (
              <li key={c.id} className="p-3 flex items-center justify-between gap-3 text-sm flex-wrap">
                <div>
                  <div className="font-mono font-semibold">{codeById.get(c.promoter_id) ?? c.promoter_id}</div>
                  <div className="text-xs text-[var(--color-muted)]">
                    {SKU_LABEL[(c.sku ?? '') as PromoterSku] ?? c.sku ?? '—'} · {c.rate_pct}% · {mxn(c.commission_cents)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="Referencia"
                    value={refs[c.id] ?? ''}
                    onChange={(e) => setRefs((m) => ({ ...m, [c.id]: e.target.value }))}
                    className="w-32 rounded-lg border border-[var(--color-border)] px-2 py-1 text-sm bg-transparent"
                  />
                  <button
                    onClick={() => settle(c.id)}
                    disabled={settling === c.id}
                    className="btn btn-secondary btn-sm"
                  >
                    {settling === c.id ? 'Marcando…' : 'Marcar pagada'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Sprint 4 (US-4.2) — pending net-remittance transfers */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Transferencias pendientes ({transfers.length})</h2>
        <p className="text-sm text-[var(--color-muted)]">
          Aprobar activa el producto en la tienda del comerciante y notifica al promotor; rechazar regresa la
          venta a estado sin pagar.
        </p>
        {transfers.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">No hay transferencias pendientes.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
            {transfers.map((t) => (
              <li key={t.id} className="p-3 space-y-2 text-sm">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <span className="font-mono font-semibold">{codeById.get(t.promoter_id) ?? t.promoter_id}</span>
                    <span className="text-[var(--color-muted)] ml-2">
                      {TRANSFER_SKU_LABEL[t.sku as TransferSku] ?? t.sku} · {t.method.toUpperCase()}
                    </span>
                  </div>
                  <span className="text-xs rounded bg-[var(--color-surface-alt)] px-1.5 py-0.5">
                    {ageSince(t.reported_at)}
                  </span>
                </div>
                <div className="text-xs text-[var(--color-muted)] truncate">Tienda: {t.seller_id}</div>
                <div className="font-semibold">{mxn(t.owed_cents)} <span className="text-xs font-normal text-[var(--color-muted)]">(comisión retenida: {mxn(t.commission_cents)})</span></div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => decideTransfer(t.id, 'approve')}
                    disabled={decidingTransferId === t.id}
                    className="btn btn-primary btn-sm"
                  >
                    {decidingTransferId === t.id ? 'Procesando…' : 'Aprobar'}
                  </button>
                  <input
                    type="text"
                    placeholder="Motivo de rechazo (opcional)"
                    value={rejectReasons[t.id] ?? ''}
                    onChange={(e) => setRejectReasons((m) => ({ ...m, [t.id]: e.target.value }))}
                    className="w-48 rounded-lg border border-[var(--color-border)] px-2 py-1 text-sm bg-transparent"
                  />
                  <button
                    onClick={() => decideTransfer(t.id, 'reject')}
                    disabled={decidingTransferId === t.id}
                    className="btn btn-secondary btn-sm"
                  >
                    Rechazar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {msg && <p className="text-sm text-[var(--color-muted)]">{msg}</p>}
    </div>
  )
}
