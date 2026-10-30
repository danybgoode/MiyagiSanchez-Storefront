'use client'

/* eslint-disable @next/next/no-img-element -- order thumbnails preserve arbitrary seller-hosted image URLs */

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { SellerBreadcrumb } from '../SellerBreadcrumb'
import { manualPaymentStateFromOrder, manualPaymentBadge, whoActsNext } from '@/lib/manual-payment-state'
import { mlOrderBadgeLabel } from '@/lib/ml-order-badge'
import { filterBySource, inPersonBadgeLabel, orderSourceLabel, presentSources, type OrderSource } from '@/lib/in-person/order-source'
import { orderStatusToToken } from '@/lib/status-badge'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Banner } from '@/components/feedback/Banner'
import { shopUrlFor } from '@/lib/market-url'
import { SITE_ORIGIN } from '@/lib/market-seo'
import { formatWaitingOrderUrgency } from '@/lib/order-urgency'
import {
  reviewedStatusMap,
  selectionAfterBulkApply,
  type BulkOrderTransitionPlan,
} from '@/lib/order-bulk-preview'
import { useSellerFormat } from '@/app/components/SellerFormatProvider'

// ── Types ─────────────────────────────────────────────────────────────────────

interface OrderShipment {
  id: string
  carrier: string
  tracking_number: string | null
  status: string
  estimated_delivery_date: string | null
}

interface Order {
  id: string
  status: string
  amount_cents: number
  currency: string
  shipping_method: string
  buyer_name: string | null
  buyer_email: string | null
  created_at: string
  updated_at: string
  // Durable manual-payment lifecycle (curated top-level normalized fields).
  payment_method?: string | null
  payment_received?: boolean
  buyer_reported_paid?: boolean
  manual_payment_state?: string | null
  // Which marketplace sold this (ml-orders-native S1 · US-3).
  source?: string | null
  ml_order_id?: string | null
  ml_pack_id?: string | null
  // Free-form seller tags (ml-orders-native S3 · US-7).
  tags?: string[] | null
  marketplace_listings: { id: string; title: string; images: Array<{ url: string }> | null; listing_type: string }
    | { id: string; title: string; images: Array<{ url: string }> | null; listing_type: string }[]
  marketplace_shipments: OrderShipment[] | null
}

interface Shop {
  id: string
  slug: string
  name: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

type FilterTab = 'pending' | 'shipped' | 'delivered' | 'all'
type BulkTargetStatus = 'processing' | 'shipped' | 'delivered'

const STATUS_LABEL: Record<string, string> = {
  pending_payment: 'Pago pendiente',
  paid: 'Nuevo',
  processing: 'Procesando',
  shipped: 'Enviado',
  in_transit: 'En camino',
  delivered: 'Entregado',
  completed: 'Completado',
  refunded: 'Reembolsado',
  fulfilled: 'Entregado',
}

// ── Helpers ───────────────────────────────────────────────────────────────────


function getListing(order: Order) {
  const l = order.marketplace_listings
  return Array.isArray(l) ? l[0] : l
}

function getShipment(order: Order): OrderShipment | null {
  return order.marketplace_shipments?.[0] ?? null
}

function needsAction(order: Order) {
  return order.status === 'pending_payment' || order.status === 'paid' || order.status === 'processing'
}

function statusLabel(status: string | null) {
  return status ? (STATUS_LABEL[status] ?? status) : 'No disponible'
}

function BulkStatusPreview({
  plans,
  target,
  applying,
  onCancel,
  onApply,
}: {
  plans: BulkOrderTransitionPlan[]
  target: BulkTargetStatus
  applying: boolean
  onCancel: () => void
  onApply: () => void
}) {
  const eligibleCount = plans.filter((plan) => plan.eligible).length
  return (
    <div className="fixed inset-0 z-[70] flex items-end bg-black/40 p-3 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-labelledby="bulk-preview-title">
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-[var(--r-lg)] border border-[var(--color-border)] bg-[var(--bg-elevated)] p-5 shadow-[var(--shadow-3)] sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Antes de aplicar</p>
            <h2 id="bulk-preview-title" className="text-lg font-bold">Revisa el cambio de estado</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {eligibleCount} de {plans.length} pedido{plans.length === 1 ? '' : 's'} listo{eligibleCount === 1 ? '' : 's'} para cambiar a {statusLabel(target)}.
            </p>
          </div>
          <button type="button" onClick={onCancel} disabled={applying} className="inline-flex min-h-11 min-w-11 items-center justify-center" aria-label="Cerrar previsualización">
            <i className="iconoir-xmark" aria-hidden />
          </button>
        </div>

        <div className="space-y-2">
          {plans.map((plan) => (
            <div key={plan.order_id} className="rounded-[var(--r-md)] border border-[var(--color-border)] p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{plan.title ?? 'Pedido sin detalle disponible'}</p>
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    Pedido {plan.order_id.slice(-8)} · {statusLabel(plan.current_status)} <span aria-hidden>→</span> {statusLabel(plan.proposed_status)}
                  </p>
                </div>
                <StatusBadge token={plan.eligible ? 'success' : 'warning'}>
                  {plan.eligible ? 'Listo' : 'Sin cambio'}
                </StatusBadge>
              </div>
              {!plan.eligible && plan.reason && (
                <p className="mt-2 text-xs text-[var(--warning)]">{plan.reason}</p>
              )}
            </div>
          ))}
        </div>

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onCancel} disabled={applying} className="btn btn-secondary min-h-11">Cancelar</button>
          <button type="button" onClick={onApply} disabled={applying || eligibleCount === 0} className="btn btn-primary min-h-11 disabled:opacity-50" aria-busy={applying || undefined}>
            {applying ? 'Aplicando cambios…' : `Aplicar ${eligibleCount} cambio${eligibleCount === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Order card ────────────────────────────────────────────────────────────────

function OrderCard({
  order,
  selected,
  onToggleSelect,
}: {
  order: Order
  selected: boolean
  onToggleSelect: () => void
}) {
  const fmt = useSellerFormat()
  // Captured once at mount — keeps render pure (no Date.now() in the render body).
  // Same pattern as PromotionsClient; `relativeShort` takes the clock as an
  // argument precisely so the impurity lives at one visible call site.
  const [now] = useState(() => Date.now())
  // The order's OWN currency, never the shop's and never the language's: a US
  // order on an MX shop is dollars, and an MX merchant reading English is still
  // owed pesos. Only the grouping and the month name follow `fmt.locale`.
  // `price()` (not `money()`) so the peso convention stops rounding dollars —
  // this line used to render a $12.50 order as "$13".
  const formatPrice = (cents: number, currency: string) =>
    fmt.price(cents, currency)

  const listing  = getListing(order)
  const shipment = getShipment(order)
  const thumb    = listing?.images?.[0]?.url ?? null
  const statusLabel = STATUS_LABEL[order.status] ?? STATUS_LABEL.paid
  const statusToken  = orderStatusToToken(order.status)
  const urgent   = needsAction(order)
  // Manual-payment lifecycle: an unconfirmed manual order is pending OR reported —
  // never "ready to ship". The badge/footer reflect whose move it is.
  const manualState = manualPaymentStateFromOrder(order)
  const isUnpaidManual = manualState === 'pending_payment' || manualState === 'buyer_reported_paid'
  const badgeLabel = manualState === 'buyer_reported_paid' ? manualPaymentBadge(manualState) : statusLabel
  const mlBadge = mlOrderBadgeLabel(order)
  const counterBadge = inPersonBadgeLabel(order.source)

  return (
    <div className="flex items-center gap-2">
      {/* Bulk-select checkbox (ml-orders-native S3 · US-8) — outside the Link so
          it never triggers navigation. */}
      <label className="inline-flex min-h-11 min-w-11 flex-shrink-0 cursor-pointer items-center justify-center">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Seleccionar pedido ${order.id}`}
          className="h-4 w-4 accent-[var(--color-accent)]"
        />
      </label>
      <Link
        href={`/shop/manage/orders/${order.id}`}
        className={`no-underline block flex-1 min-w-0 rounded-[var(--r-lg)] border transition-all hover:shadow-sm ${
          urgent
            ? 'border-[var(--warning)] bg-[var(--warning-soft)] hover:border-[var(--warning)]'
            : 'border-[var(--color-border)] bg-[var(--bg-elevated)] hover:border-[var(--color-accent)]'
        }`}
      >
      <div className="flex items-start gap-3 p-4">
        {/* Thumbnail */}
        <div className="w-14 h-14 flex-shrink-0 rounded-[var(--r-md)] overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface-alt)]">
          {thumb
            ? <img src={thumb} alt="" className="w-full h-full object-cover" />
            : <div className="w-full h-full flex items-center justify-center text-xl"><i className="iconoir-package" aria-hidden /></div>
          }
        </div>

        {/* Body */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2 mb-0.5">
            <p className="text-sm font-semibold leading-snug truncate text-[var(--color-text)]">
              {listing?.title ?? '—'}
            </p>
            <span className="flex-shrink-0 flex items-center gap-1">
              {mlBadge && <StatusBadge token="promo">{mlBadge}</StatusBadge>}
              {counterBadge && <StatusBadge token="info">{counterBadge}</StatusBadge>}
              <StatusBadge token={statusToken}>{badgeLabel}</StatusBadge>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-[var(--color-muted)]">
            <span className="font-semibold text-[var(--color-text)]">
              {formatPrice(order.amount_cents, order.currency)}
            </span>
            <span>{order.buyer_name ?? 'Comprador'}</span>
            <span>{fmt.relativeShort(order.created_at, now)}</span>
          </div>

          {/* Tag chips */}
          {order.tags && order.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {order.tags.map(tag => (
                <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-[var(--r-pill)] bg-[var(--bg-sunk)] text-[var(--color-muted)]">
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Shipment tracking chip */}
          {shipment?.tracking_number && (
            <p className="mt-1.5 text-[11px] text-[var(--color-muted)] flex items-center gap-1">
              <i className="iconoir-delivery-truck" aria-hidden />
              <span className="font-mono">{shipment.tracking_number}</span>
              <span>· {shipment.carrier.toUpperCase()}</span>
            </p>
          )}
        </div>

        {/* Arrow */}
        <span className="text-[var(--color-muted)] text-lg flex-shrink-0 self-center">›</span>
      </div>

      {/* Urgency footer */}
      {urgent && (
        <div className="border-t border-[var(--warning)] px-4 py-2 flex items-center gap-2">
          <i className="iconoir-flash text-[var(--warning)] text-sm" aria-hidden />
          <p className="text-xs text-[var(--warning)] font-medium">
            {isUnpaidManual
              ? whoActsNext(manualState!, 'seller')
              : order.status === 'paid' ? 'Confirma y prepara el envío' : 'Listo para enviar'}
          </p>
          <span className="ml-auto text-xs text-[var(--warning)] font-semibold">Ver →</span>
        </div>
      )}
      </Link>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function OrdersInbox({
  shop,
  initialOrders,
}: {
  shop: Shop
  initialOrders: Order[]
}) {
  const router = useRouter()
  const [filter, setFilter] = useState<FilterTab>('pending')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [sourceFilter, setSourceFilter] = useState<OrderSource | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [previewBusy, setPreviewBusy] = useState<BulkTargetStatus | null>(null)
  const [bulkApplying, setBulkApplying] = useState(false)
  const [preview, setPreview] = useState<{ target: BulkTargetStatus; plans: BulkOrderTransitionPlan[] } | null>(null)
  const [bulkMessage, setBulkMessage] = useState<{ text: string; variant: 'success' | 'warning' | 'danger' } | null>(null)
  const [bulkResult, setBulkResult] = useState<{
    target: BulkTargetStatus
    plans: BulkOrderTransitionPlan[]
    advanced: string[]
    skipped: Array<{ order_id: string; reason: string }>
  } | null>(null)
  const bulkBusy = previewBusy !== null || bulkApplying

  // Compute counts per tab
  const needsActionOrders = initialOrders.filter(o => needsAction(o))
  const shippedOrders     = initialOrders.filter(o => ['shipped', 'in_transit'].includes(o.status))
  const deliveredOrders   = initialOrders.filter(o => ['delivered', 'completed', 'fulfilled'].includes(o.status))

  const statusFilteredOrders = filter === 'pending'
    ? needsActionOrders
    : filter === 'shipped'
      ? shippedOrders
      : filter === 'delivered'
        ? deliveredOrders
        : initialOrders

  // All distinct tags across every order (client-side — no pagination on this page).
  const allTags = useMemo(() => {
    const seen = new Set<string>()
    for (const o of initialOrders) for (const t of o.tags ?? []) seen.add(t)
    return Array.from(seen).sort((a, b) => a.localeCompare(b))
  }, [initialOrders])

  const tagFilteredOrders = tagFilter
    ? statusFilteredOrders.filter(o => (o.tags ?? []).includes(tagFilter))
    : statusFilteredOrders
  // Source filter (in-person-sales S2.3): shown only when the inbox holds more than one source.
  const sources = useMemo(() => presentSources(initialOrders), [initialOrders])
  const displayedOrders = filterBySource(tagFilteredOrders, sourceFilter)

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  // Bulk fulfillment-status action (ml-orders-native S3 · US-8). Status-only
  // transitions (no bulk carrier/tracking entry) — mixed ML + native selections
  // work with zero special-casing (the backend endpoint is source-agnostic).
  async function handleBulkPreview(status: BulkTargetStatus) {
    if (selected.size === 0) return
    setPreviewBusy(status)
    setBulkMessage(null)
    setBulkResult(null)
    try {
      const res = await fetch('/api/orders/bulk-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_ids: Array.from(selected), status }),
      })
      const data = await res.json() as {
        plans?: BulkOrderTransitionPlan[]
        error?: string
      }
      if (!res.ok) {
        setBulkMessage({ text: data.error ?? 'Error al previsualizar pedidos.', variant: 'danger' })
        return
      }
      setPreview({ target: status, plans: data.plans ?? [] })
    } catch {
      setBulkMessage({ text: 'Sin conexión.', variant: 'danger' })
    } finally {
      setPreviewBusy(null)
    }
  }

  async function handleBulkApply() {
    if (!preview) return
    setBulkApplying(true)
    setBulkMessage(null)
    try {
      const res = await fetch('/api/orders/bulk-status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_ids: preview.plans.map((plan) => plan.order_id),
          status: preview.target,
          expected_statuses: reviewedStatusMap(preview.plans),
        }),
      })
      const data = await res.json() as {
        advanced?: string[]
        skipped?: Array<{ order_id: string; reason: string }>
        error?: string
      }
      if (!res.ok) {
        setBulkMessage({ text: data.error ?? 'Error al actualizar pedidos.', variant: 'danger' })
        return
      }
      const advanced = data.advanced ?? []
      const skipped = data.skipped ?? []
      setSelected((current) => selectionAfterBulkApply(current, advanced))
      setBulkResult({ target: preview.target, plans: preview.plans, advanced, skipped })
      setBulkMessage({
        text: `${advanced.length} actualizado${advanced.length === 1 ? '' : 's'} · ${skipped.length} sin cambios.`,
        variant: skipped.length ? 'warning' : 'success',
      })
      setPreview(null)
      router.refresh()
    } catch {
      setBulkMessage({ text: 'Sin conexión.', variant: 'danger' })
    } finally {
      setBulkApplying(false)
    }
  }

  const tabs: Array<{ key: FilterTab; label: string; count: number }> = [
    { key: 'pending',   label: 'Por enviar',  count: needsActionOrders.length },
    { key: 'shipped',   label: 'Enviados',    count: shippedOrders.length },
    { key: 'delivered', label: 'Entregados',  count: deliveredOrders.length },
    { key: 'all',       label: 'Todos',       count: initialOrders.length },
  ]

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">

      {/* Breadcrumb */}
      <SellerBreadcrumb className="mb-6" />

      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-xl sm:text-2xl font-bold">Pedidos</h1>
      </div>
      <p className="text-sm text-[var(--color-muted)] mb-6">
        {initialOrders.length} pedido{initialOrders.length !== 1 ? 's' : ''} en total
      </p>

      {/* Urgency nudge */}
      {needsActionOrders.length > 0 && (
        <div className="flex items-start gap-3 bg-[var(--warning-soft)] border border-[var(--warning)] rounded-[var(--r-lg)] px-4 py-3 mb-5">
          <i className="iconoir-flash text-lg mt-0.5" aria-hidden />
          <div>
            <p className="text-sm font-semibold text-[var(--warning)]">
              {needsActionOrders.length} pedido{needsActionOrders.length > 1 ? 's' : ''} esperando tu acción
            </p>
            <p className="text-xs text-[var(--warning)] mt-0.5">
              {formatWaitingOrderUrgency(needsActionOrders)}
            </p>
          </div>
        </div>
      )}

      {/* Filter tabs */}
      {initialOrders.length > 0 && (
        <div className="flex gap-1 mb-5 border border-[var(--color-border)] rounded-[var(--r-lg)] p-1 w-fit">
          {tabs.map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => setFilter(t.key)}
              className={`px-3 py-1.5 rounded-[var(--r-md)] text-sm font-medium transition-colors flex items-center gap-1.5 ${
                filter === t.key
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'text-[var(--color-muted)] hover:text-[var(--color-text)]'
              }`}
            >
              {t.label}
              {t.count > 0 && (
                <span className={`text-[10px] rounded-[var(--r-pill)] px-1.5 py-0.5 font-bold ${
                  filter === t.key ? 'bg-white/25' : 'bg-[var(--color-border)] text-[var(--color-muted)]'
                }`}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Source filter (in-person-sales S2.3) */}
      {sources.length > 1 && (
        <div className="flex flex-wrap gap-1.5 mb-5" role="group" aria-label="Filtrar por origen">
          {sources.map(src => (
            <button
              key={src}
              type="button"
              onClick={() => setSourceFilter(prev => (prev === src ? null : src))}
              aria-pressed={sourceFilter === src}
              className={`text-xs px-2.5 py-1 rounded-[var(--r-pill)] font-medium transition-colors min-h-[32px] ${
                sourceFilter === src
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'bg-[var(--bg-sunk)] text-[var(--color-muted)] hover:text-[var(--color-text)]'
              }`}
            >
              {orderSourceLabel(src)}
            </button>
          ))}
        </div>
      )}

      {/* Tag filter (ml-orders-native S3 · US-7) */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-5">
          {allTags.map(tag => (
            <button
              key={tag}
              type="button"
              onClick={() => setTagFilter(prev => (prev === tag ? null : tag))}
              className={`text-xs px-2.5 py-1 rounded-[var(--r-pill)] font-medium transition-colors ${
                tagFilter === tag
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'bg-[var(--bg-sunk)] text-[var(--color-muted)] hover:text-[var(--color-text)]'
              }`}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {/* Bulk action bar (ml-orders-native S3 · US-8) */}
      {selected.size > 0 && (
        <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 bg-[var(--color-accent)] text-white rounded-[var(--r-lg)] px-4 py-2.5 mb-4">
          <span className="text-sm font-medium">
            {selected.size} seleccionado{selected.size !== 1 ? 's' : ''}
          </span>
          <div className="flex flex-wrap gap-1.5 ml-auto">
            <button type="button" disabled={bulkBusy} onClick={() => handleBulkPreview('processing')}
              className="min-h-11 text-xs font-semibold px-3 py-1 rounded-[var(--r-md)] bg-white/15 hover:bg-white/25 disabled:opacity-50">
              {previewBusy === 'processing' ? 'Preparando…' : 'Procesando'}
            </button>
            <button type="button" disabled={bulkBusy} onClick={() => handleBulkPreview('shipped')}
              className="min-h-11 text-xs font-semibold px-3 py-1 rounded-[var(--r-md)] bg-white/15 hover:bg-white/25 disabled:opacity-50">
              {previewBusy === 'shipped' ? 'Preparando…' : 'Enviado'}
            </button>
            <button type="button" disabled={bulkBusy} onClick={() => handleBulkPreview('delivered')}
              className="min-h-11 text-xs font-semibold px-3 py-1 rounded-[var(--r-md)] bg-white/15 hover:bg-white/25 disabled:opacity-50">
              {previewBusy === 'delivered' ? 'Preparando…' : 'Entregado'}
            </button>
            <button type="button" disabled={bulkBusy} onClick={() => setSelected(new Set())}
              className="min-h-11 text-xs font-medium px-3 py-1 rounded-[var(--r-md)] hover:bg-white/10">
              Cancelar
            </button>
          </div>
        </div>
      )}

      {bulkMessage && (
        <Banner variant={bulkMessage.variant} className="mb-4 text-xs">
          {bulkMessage.text}
        </Banner>
      )}

      {bulkResult && (
        <section className="mb-4 rounded-[var(--r-lg)] border border-[var(--color-border)] bg-[var(--bg-elevated)] p-4" aria-label="Resultado del cambio en bloque" aria-live="polite">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Resultado</p>
              <h2 className="text-sm font-semibold">Cambio a {statusLabel(bulkResult.target)}</h2>
            </div>
            <button type="button" onClick={() => setBulkResult(null)} className="inline-flex min-h-11 min-w-11 items-center justify-center" aria-label="Cerrar resultado">
              <i className="iconoir-xmark" aria-hidden />
            </button>
          </div>
          <div className="space-y-2 text-xs">
            {bulkResult.advanced.map((orderId) => {
              const plan = bulkResult.plans.find((item) => item.order_id === orderId)
              return (
                <div key={orderId} className="flex items-center justify-between gap-3 rounded-[var(--r-md)] bg-[var(--success-soft)] px-3 py-2">
                  <span className="truncate">{plan?.title ?? `Pedido ${orderId.slice(-8)}`}</span>
                  <StatusBadge token="success">Actualizado</StatusBadge>
                </div>
              )
            })}
            {bulkResult.skipped.map((skip) => {
              const plan = bulkResult.plans.find((item) => item.order_id === skip.order_id)
              return (
                <div key={skip.order_id} className="rounded-[var(--r-md)] bg-[var(--warning-soft)] px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-medium">{plan?.title ?? `Pedido ${skip.order_id.slice(-8)}`}</span>
                    <StatusBadge token="warning">Sin cambio</StatusBadge>
                  </div>
                  <p className="mt-1 text-[var(--warning)]">{skip.reason}</p>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Orders list */}
      {displayedOrders.length === 0 ? (
        <div className="text-center py-16 border-2 border-dashed border-[var(--color-border)] rounded-[var(--r-lg)]">
          {filter === 'pending' && initialOrders.length > 0 ? (
            <>
              <div className="text-4xl mb-3"><i className="iconoir-check" aria-hidden /></div>
              <h3 className="font-semibold text-lg mb-1">¡Al día!</h3>
              <p className="text-sm text-[var(--color-muted)]">No tienes pedidos pendientes de enviar.</p>
              <button type="button" onClick={() => setFilter('all')}
                className="mt-3 text-sm text-[var(--color-accent)] underline">
                Ver historial
              </button>
            </>
          ) : (
            <>
              <div className="text-4xl mb-3"><i className="iconoir-package" aria-hidden /></div>
              <h3 className="font-semibold text-lg mb-1">Sin pedidos aún</h3>
              <p className="text-sm text-[var(--color-muted)] mb-4 max-w-xs mx-auto">
                Cuando los compradores paguen tus productos, aparecerán aquí.
              </p>
              <Link href={shopUrlFor(SITE_ORIGIN, shop.slug)}
                className="text-sm text-[var(--color-accent)] no-underline hover:underline">
                Ver tu tienda →
              </Link>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-2.5">
          {displayedOrders.map(order => (
            <OrderCard
              key={order.id}
              order={order}
              selected={selected.has(order.id)}
              onToggleSelect={() => toggleSelect(order.id)}
            />
          ))}
        </div>
      )}

      {/* AI tip */}
      {initialOrders.length > 0 && (
        <div className="mt-8 flex items-start gap-3 bg-[var(--color-surface-alt)] border border-[var(--color-border)] rounded-[var(--r-lg)] px-4 py-3">
          <i className="iconoir-sparks text-base mt-0.5" aria-hidden />
          <p className="text-xs text-[var(--color-muted)] leading-relaxed">
            <strong className="text-[var(--color-text)]">Siguiente paso:</strong> abre el pedido más antiguo,
            confirma su pago cuando corresponda y mantén el estado de entrega al día.
          </p>
        </div>
      )}

      {preview && (
        <BulkStatusPreview
          plans={preview.plans}
          target={preview.target}
          applying={bulkApplying}
          onCancel={() => setPreview(null)}
          onApply={handleBulkApply}
        />
      )}
    </div>
  )
}
