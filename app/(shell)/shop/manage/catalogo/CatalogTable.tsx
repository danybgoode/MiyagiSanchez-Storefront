'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { deriveCatalogStatus } from '@/lib/catalog-status'
import { deriveChannelBadges } from '@/lib/catalog-channels'
import {
  derivePublicationState,
  nextPublicationRequest,
  publicationChangeToastMessage,
  PUBLICATION_STATE_LABEL,
  PUBLICATION_STATE_HINT,
} from '@/lib/publication-state'
import { PROCESSING_LABELS } from '@/lib/trust-inputs'
import type { CatalogSearchParams } from '@/lib/catalog-query'
import { deriveProductMargin, type MarginCell } from '@/lib/catalog-margin'
import { formatPct, type SkuMarginRow } from '@/lib/profit'
import { useSellerFormat } from '@/app/components/SellerFormatProvider'
import { Toast, useToast } from '@/components/feedback/Toast'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { READINESS_COPY } from '@/lib/listing-readiness'
import { catalogStatusToToken, publicationStateToToken } from '@/lib/status-badge'
import { rsvpEventSlug } from '@/lib/evento-preset'
import BulkActionBar from './BulkActionBar'
import BulkDiffPreview from './BulkDiffPreview'
import { usePendingListingDelete } from '@/components/seller/PendingListingDeleteProvider'

export interface CatalogListing {
  id: string
  title: string
  /** Owner listing shape's type — a product is the only type that can be «Solo catálogo» (listing-readiness D1). */
  listing_type?: string
  sku: string | null
  price_cents: number | null
  currency: string
  category: string | null
  status: string
  manage_inventory: boolean
  available_quantity: number | null
  /** Reserved units (in-flight orders); null = unlimited (catalog-management S2 · 2.1). */
  reserved_quantity?: number | null
  in_stock: boolean
  /** Native Medusa "sobre pedido" flag (catalog-management S2 · 2.1). */
  allow_backorder?: boolean
  /** Seller's estimated dispatch note for a backorder listing (catalog-management S2 · 2.1). */
  dispatch_estimate?: string | null
  /** Marketplace-browse visibility toggle (catalog-management S2 · 2.2) — absent = true. */
  miyagi_visible?: boolean
  /** Optional Mercado Libre-specific price override, in centavos (catalog-management S2 · 2.3). */
  ml_price_cents?: number | null
  channels: string[]
  /**
   * Buyable on the owned shop (owned-shop-operating-channel epic, S3.3) — a
   * Medusa Sales-Channel-level fact, INDEPENDENT of `in_marketplace_channel` and
   * of every field above (those are ML-sync/browse-visibility concerns, a
   * different axis entirely). Absent = deploy-lag fallback to `false`, same
   * pattern as `catalog-channels.ts#deriveChannelBadges`.
   */
  in_operating_channel?: boolean
  /** Published to the country marketplace (S3.3) — the other separate fact. */
  in_marketplace_channel?: boolean
  images: Array<{ url: string; alt?: string | null }>
  /** Product metadata — read only for `rsvp_event_slug` (a free Evento's roster link). */
  metadata?: Record<string, unknown> | null
  created_at: string
}

const STATUS_LABEL: Record<string, { label: string }> = {
  activo: { label: 'Activo' },
  pausado: { label: 'Pausado' },
  borrador: { label: 'Borrador' },
  agotado: { label: 'Agotado' },
  sobre_pedido: { label: 'Sobre pedido' },
}

function stockLabel(listing: CatalogListing) {
  if (listing.manage_inventory && listing.allow_backorder) {
    if (!listing.dispatch_estimate) return 'Sobre pedido'
    const label = PROCESSING_LABELS[listing.dispatch_estimate] ?? listing.dispatch_estimate
    return `Sobre pedido — ${label}`
  }
  if (!listing.manage_inventory) return 'Sin límite'
  if (!listing.in_stock) return 'Agotado'
  const reserved = listing.reserved_quantity ?? 0
  return reserved > 0
    ? `${listing.available_quantity ?? 0} disponibles (${reserved} reservados)`
    : `${listing.available_quantity ?? 0} disponibles`
}

// Margin column (catalog-management S4 · Story 4.1) — one honest cell per
// channel, never a fake number. `useSellerFormat().money`/`formatPct` are the
// SAME formatters the profit dashboard uses (no forked display logic either).
//
// A margin has no currency column of its own, so it falls back to the SHOP's
// currency rather than to a literal — `lib/profit.ts`'s `formatCents` defaults to
// MXN, which rendered a US shop's margins in pesos.
function MarginCellDisplay({ label, cell }: { label: string; cell: MarginCell }) {
  const fmt = useSellerFormat()
  if (cell.state === 'no_sales') {
    return <span className="text-[10px] text-[var(--color-muted)]">{label}: sin ventas</span>
  }
  if (cell.state === 'no_cogs') {
    return (
      <span className="text-[10px] text-[var(--warning)]">
        {label}: sin COGS ·{' '}
        <Link href="/shop/manage/profit" className="underline">registrar costo</Link>
      </span>
    )
  }
  return (
    <span className={`text-[10px] ${cell.isKiller ? 'text-[var(--danger)] font-semibold' : 'text-[var(--color-muted)]'}`}>
      {label}: {fmt.money(cell.marginCents ?? 0)} · {formatPct(cell.marginPct ?? null)}
      {cell.isKiller && <i className="iconoir-warning-triangle" aria-hidden />}
    </span>
  )
}
function DeleteDialog({
  listing,
  onConfirm,
  onCancel,
  pending,
}: {
  listing: CatalogListing
  onConfirm: () => void
  onCancel: () => void
  pending: boolean
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" role="dialog" aria-modal>
      <Card variant="panel" className="shadow-xl w-full max-w-sm p-6">
        <h2 className="font-bold text-base mb-2">¿Eliminar anuncio?</h2>
        <p className="text-sm text-[var(--color-muted)] mb-4">
          Quitaremos <strong className="text-[var(--color-foreground)]">{listing.title}</strong> de tu catálogo.
          Tendrás 10 segundos para deshacer antes de que se confirme.
        </p>
        <div className="flex gap-3 justify-end">
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            Cancelar
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={pending}>
            {pending ? 'Eliminando…' : 'Sí, eliminar'}
          </Button>
        </div>
      </Card>
    </div>
  )
}

type MarginSort = 'none' | 'asc' | 'desc'

export default function CatalogTable({
  listings: initialListings,
  channelsFlagEnabled = false,
  mlEntitled = false,
  bulkFlagEnabled = false,
  totalFiltered = 0,
  filterParams = {},
  profitFlagEnabled = false,
  marginRowsByChannel = [],
  ownedShopOnlyEnabled = false,
  eventRosterBySlug = {},
  shopCannotCollect = false,
}: {
  listings: CatalogListing[]
  /** catalog.inventory_channels_enabled (catalog-management S2 · 2.2) — fail-safe OFF: no toggle UI renders while OFF. */
  channelsFlagEnabled?: boolean
  /** `ml_sync` entitlement — disables (not hides) the ML toggle with an upsell hint when false. */
  mlEntitled?: boolean
  /** catalog.bulk_enabled (catalog-management S3) — fail-safe OFF: no selection/bulk UI renders while OFF. */
  bulkFlagEnabled?: boolean
  /** Total count matching the active filter (server-reported, not just this page) — powers "seleccionar todos (N)". */
  totalFiltered?: number
  /** The active table filter (q/status/category/channel/stock/sort) — passed through to a "select all across filter" bulk stage. */
  filterParams?: CatalogSearchParams
  /** ops.profit_enabled (catalog-management S4 · Story 4.1) — fail-safe OFF: no Margen column/sort toggle render while OFF. */
  profitFlagEnabled?: boolean
  /** Per-channel ledger rows (lib/profit.ts's computeSkuMarginsByChannel), already fetched server-side. */
  marginRowsByChannel?: SkuMarginRow[]
  /**
   * catalog.owned_shop_only_enabled (owned-shop-operating-channel epic, D8) —
   * fail-safe OFF: with the flag off, this table renders EXACTLY as it did
   * before Sprint 3 — no "Mercado" column, no publish/unpublish action.
   */
  ownedShopOnlyEnabled?: boolean
  /** RSVP event slug → its roster page; a listing carrying `metadata.rsvp_event_slug` shows «Registros». */
  eventRosterBySlug?: Record<string, string>
  /**
   * listing-readiness S2.2: the shop has no way to take a payment (read from the Medusa seller on the server), so its
   * live products are «Solo catálogo» — seen, but bought by writing to the merchant.
   */
  shopCannotCollect?: boolean
}) {
  const fmt = useSellerFormat()
  // The listing's OWN currency. "Precio a convenir" is authored here rather than
  // left to the copy boundary because the boundary substitutes text nodes against
  // a generated population, and a string returned from a formatter never reached
  // that scan — it stayed Spanish in an English portal with every gate green.
  const formatPrice = (cents: number | null, currency: string) =>
    cents === null
      ? (fmt.locale === 'en' ? 'Price on request' : 'Precio a convenir')
      : fmt.price(cents, currency)
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [listings, setListings] = useState(initialListings)
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set())
  const { toast, showToast, dismissToast } = useToast()
  const [deleteTarget, setDeleteTarget] = useState<CatalogListing | null>(null)
  const [mobileActionTarget, setMobileActionTarget] = useState<CatalogListing | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [marginSort, setMarginSort] = useState<MarginSort>('none')
  const { pendingIds: pendingDeleteIds, hasPendingDelete, scheduleDelete } = usePendingListingDelete()

  // A router refresh after an expired delete brings the new server list into
  // this long-lived client component. Without this sync, React would preserve
  // the pre-delete useState initializer and briefly resurrect a deleted row.
  // The server router refresh is the external source of truth after the undo
  // window expires; keep the long-lived client island aligned with it.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setListings(initialListings), [initialListings])

  // Margin cells, keyed by product id — derived once per render from the
  // server-fetched ledger rows (lib/catalog-margin.ts, pure, no formula fork).
  const marginByProduct = useMemo(() => {
    const map = new Map<string, ReturnType<typeof deriveProductMargin>>()
    if (!profitFlagEnabled) return map
    for (const listing of listings) {
      map.set(listing.id, deriveProductMargin(listing.id, marginRowsByChannel))
    }
    return map
  }, [profitFlagEnabled, listings, marginRowsByChannel])

  // Client-only sort, THIS PAGE ONLY (24 rows) — margin is a bounded ledger
  // aggregate, not a persisted/indexed product field, so this deliberately
  // does not touch the URL-driven server sort (lib/catalog-query.ts). Rows
  // with no computed Miyagi margin (no_sales/no_cogs) always sort last,
  // regardless of direction — they can't be meaningfully ranked.
  const displayedListings = useMemo(() => {
    const visible = listings.filter((listing) => !pendingDeleteIds.has(listing.id))
    if (marginSort === 'none' || !profitFlagEnabled) return visible
    const withValue: Array<{ listing: CatalogListing; value: number }> = []
    const withoutValue: CatalogListing[] = []
    for (const listing of visible) {
      const cell = marginByProduct.get(listing.id)?.miyagi
      if (cell?.state === 'computed' && cell.marginCents != null) withValue.push({ listing, value: cell.marginCents })
      else withoutValue.push(listing)
    }
    withValue.sort((a, b) => (marginSort === 'asc' ? a.value - b.value : b.value - a.value))
    return [...withValue.map((v) => v.listing), ...withoutValue]
  }, [listings, marginSort, marginByProduct, pendingDeleteIds, profitFlagEnabled])

  // Current Miyagi price + ML-link state per listing (S4 · Story 4.2) — feeds
  // BulkActionBar's "apply precio sugerido" fee-estimate lookup, which needs
  // the LIVE catalog price as its reference (not the ledger's realized
  // historical average).
  const listingInfoById = useMemo(() => {
    const map = new Map<string, { priceCents: number | null; mlLinked: boolean }>()
    for (const listing of listings) {
      map.set(listing.id, { priceCents: listing.price_cents, mlLinked: (listing.channels ?? []).includes('ml') })
    }
    return map
  }, [listings])

  const activeBatchId = searchParams.get('batch')

  function setBatchInUrl(batchId: string | null) {
    const sp = new URLSearchParams(searchParams.toString())
    if (batchId) sp.set('batch', batchId)
    else sp.delete('batch')
    router.push(sp.toString() ? `${pathname}?${sp.toString()}` : pathname)
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAllVisible() {
    setSelectedIds((prev) =>
      prev.size === listings.length ? new Set() : new Set(listings.map((l) => l.id)),
    )
  }

  const markPending = (id: string, on: boolean) =>
    setPendingIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  async function handleToggle(listing: CatalogListing, next: 'active' | 'paused') {
    const id = listing.id
    const prevStatus = deriveCatalogStatus(listing)
    markPending(id, true)
    setListings((prev) => prev.map((l) => (l.id === id ? { ...l, status: next === 'active' ? 'active' : 'paused' } : l)))

    try {
      const res = await fetch(`/api/sell/listing/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      })
      const data = await res.json() as { error?: string }
      if (!res.ok) {
        setListings((prev) => prev.map((l) => (l.id === id ? { ...l, status: prevStatus === 'pausado' ? 'paused' : 'active' } : l)))
        showToast(data.error ?? 'Error al cambiar el estado.', 'error')
      } else {
        showToast(
          next === 'active' ? 'Anuncio activado.' : 'Anuncio pausado.',
          'success',
          { label: 'Deshacer', onClick: () => handleToggle(listing, next === 'active' ? 'paused' : 'active') },
        )
      }
    } catch {
      setListings((prev) => prev.map((l) => (l.id === id ? { ...l, status: prevStatus === 'pausado' ? 'paused' : 'active' } : l)))
      showToast('Sin conexión. Inténtalo de nuevo.', 'error')
    } finally {
      markPending(id, false)
    }
  }

  // Miyagi marketplace-browse visibility toggle (catalog-management S2 · 2.2)
  // — independent of pause/activate: only affects `/l` browse, never this
  // seller's own storefront. Same optimistic/rollback/toast pattern as
  // handleToggle above.
  async function handleMiyagiToggle(listing: CatalogListing) {
    const id = listing.id
    const prevVisible = listing.miyagi_visible !== false
    const next = !prevVisible
    markPending(id, true)
    setListings((prev) => prev.map((l) => (l.id === id ? { ...l, miyagi_visible: next } : l)))

    try {
      const res = await fetch(`/api/sell/listing/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ miyagi_visible: next }),
      })
      const data = await res.json() as { error?: string }
      if (!res.ok) {
        setListings((prev) => prev.map((l) => (l.id === id ? { ...l, miyagi_visible: prevVisible } : l)))
        showToast(data.error ?? 'Error al cambiar la visibilidad.', 'error')
      } else {
        showToast(
          next ? 'Visible en el marketplace Miyagi.' : 'Oculto del marketplace Miyagi (sigue en tu tienda).',
          'success',
          { label: 'Deshacer', onClick: () => handleMiyagiToggle({ ...listing, miyagi_visible: next }) },
        )
      }
    } catch {
      setListings((prev) => prev.map((l) => (l.id === id ? { ...l, miyagi_visible: prevVisible } : l)))
      showToast('Sin conexión. Inténtalo de nuevo.', 'error')
    } finally {
      markPending(id, false)
    }
  }

  // Mercado Libre publish toggle (catalog-management S2 · 2.2). Always
  // attempts the toggle write in place (works whether the product was
  // previously linked+closed or genuinely never linked) — the backend tells
  // us via `needs_category` when turning ON hit a never-linked product with
  // no ML category yet, in which case we deep-link to the edit page's
  // existing predict→confirm flow instead of building a second one here.
  async function handleMlToggle(listing: CatalogListing) {
    const id = listing.id
    const wasOn = (listing.channels ?? []).includes('ml')
    const next = !wasOn
    const rollbackChannels = listing.channels ?? ['miyagi']
    markPending(id, true)
    setListings((prev) => prev.map((l) => (l.id === id
      ? { ...l, channels: next ? [...(l.channels ?? ['miyagi']), 'ml'] : (l.channels ?? []).filter((c) => c !== 'ml') }
      : l)))

    try {
      const res = await fetch(`/api/sell/listing/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ml_enabled: next }),
      })
      const data = await res.json() as { error?: string; needs_category?: boolean }
      if (!res.ok) {
        setListings((prev) => prev.map((l) => (l.id === id ? { ...l, channels: rollbackChannels } : l)))
        showToast(data.error ?? 'Error al cambiar Mercado Libre.', 'error')
      } else if (next && data.needs_category) {
        showToast('Elige una categoría de Mercado Libre para terminar de publicar…', 'success')
        router.push(`/sell/edit/${id}`)
      } else {
        const undoChannels = next
          ? [...(listing.channels ?? ['miyagi']), 'ml']
          : (listing.channels ?? []).filter((c) => c !== 'ml')
        showToast(
          next ? 'Publicado en Mercado Libre.' : 'Desactivado en Mercado Libre.',
          'success',
          { label: 'Deshacer', onClick: () => handleMlToggle({ ...listing, channels: undoChannels }) },
        )
      }
    } catch {
      setListings((prev) => prev.map((l) => (l.id === id ? { ...l, channels: rollbackChannels } : l)))
      showToast('Sin conexión. Inténtalo de nuevo.', 'error')
    } finally {
      markPending(id, false)
    }
  }

  // Publish / unpublish to the country marketplace (owned-shop-operating-channel
  // epic, S3.2/3.3 · D11). NOT optimistic like the toggles above — this flips a
  // Sales-Channel membership on the money path, so we wait for the backend's
  // answer before touching local state. `nextPublicationRequest` is the ONE
  // decision function (pure, tested) for "what does this click mean"; this
  // handler is pure I/O plumbing around it.
  async function handlePublicationToggle(listing: CatalogListing) {
    const id = listing.id
    const state = derivePublicationState({
      in_operating_channel: listing.in_operating_channel ?? false,
      in_marketplace_channel: listing.in_marketplace_channel ?? false,
    })
    const requested = nextPublicationRequest(state)
    if (requested === undefined) return // 'unsellable' — no action offered (see lib/publication-state.ts)

    markPending(id, true)
    try {
      const res = await fetch(`/api/sell/listing/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publish_to_market: requested }),
      })
      const data = await res.json() as { error?: string }
      if (!res.ok) {
        // 423 (flag off) reads as a different fact from 422/503 — see
        // publicationChangeToastMessage's header. The backend's own es-MX
        // message wins whenever present; this is only the fallback.
        showToast(publicationChangeToastMessage(res.status, data.error), 'error')
      } else {
        setListings((prev) => prev.map((l) => (l.id === id
          ? { ...l, in_marketplace_channel: requested === 'mx' }
          : l)))
        showToast(
          requested === 'mx'
            ? 'Publicado en el marketplace de México.'
            : 'Quitado del marketplace — sigue a la venta en tu tienda.',
          'success',
        )
      }
    } catch {
      showToast('Sin conexión. Inténtalo de nuevo.', 'error')
    } finally {
      markPending(id, false)
    }
  }

  function handleDeleteConfirm() {
    if (!deleteTarget) return
    const listing = deleteTarget
    const { id } = listing
    setDeleteTarget(null)
    const scheduled = scheduleDelete({
      ids: [id],
      label: `“${listing.title}”`,
      commit: async () => {
        const res = await fetch(`/api/sell/listing/${id}`, { method: 'DELETE' })
        const data = await res.json().catch(() => ({})) as { error?: string }
        return res.ok
          ? { ok: true, message: 'Anuncio eliminado.' }
          : { ok: false, message: data.error ?? 'No se pudo eliminar el anuncio.' }
      },
      onSuccess: () => {
        setListings((prev) => prev.filter((item) => item.id !== id))
        setSelectedIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      },
    })
    if (!scheduled) showToast('Termina o deshaz la eliminación pendiente antes de iniciar otra.', 'error')
  }

  return (
    <div>
      {bulkFlagEnabled && selectedIds.size > 0 && (
        <BulkActionBar
          selectedCount={selectedIds.size}
          totalFiltered={totalFiltered}
          allVisibleSelected={selectedIds.size === listings.length}
          filterParams={filterParams}
          selectedIds={[...selectedIds]}
          onStaged={(batchId) => setBatchInUrl(batchId)}
          onClearSelection={() => setSelectedIds(new Set())}
          profitFlagEnabled={profitFlagEnabled}
          marginRowsByChannel={marginRowsByChannel}
          listingInfoById={listingInfoById}
        />
      )}

      <div className="overflow-x-auto border border-[var(--color-border)] rounded-[var(--r-lg)]">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--color-border)] text-left text-xs uppercase tracking-wide text-[var(--color-muted)]">
            {bulkFlagEnabled && (
              <th className="w-11 p-0 font-medium md:p-3">
                <label className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
                  <input
                    type="checkbox"
                    checked={listings.length > 0 && selectedIds.size === listings.length}
                    onChange={toggleSelectAllVisible}
                    aria-label="Seleccionar todos los visibles"
                    className="h-4 w-4 accent-[var(--color-accent)]"
                  />
                </label>
              </th>
            )}
            <th className="p-3 font-medium">Producto</th>
            <th className="hidden p-3 font-medium md:table-cell">SKU</th>
            <th className="hidden p-3 font-medium md:table-cell">Precio</th>
            <th className="hidden p-3 font-medium md:table-cell">Stock</th>
            <th className="hidden p-3 font-medium md:table-cell">Canales</th>
            {ownedShopOnlyEnabled && <th className="hidden p-3 font-medium md:table-cell">Mercado</th>}
            {profitFlagEnabled && (
              <th className="hidden p-3 font-medium md:table-cell">
                <button
                  type="button"
                  onClick={() => setMarginSort((prev) => (prev === 'asc' ? 'desc' : prev === 'desc' ? 'none' : 'asc'))}
                  className="flex items-center gap-1 normal-case font-medium hover:underline"
                  title="Ordena solo los anuncios de esta página — el margen no está indexado para ordenar en todo el catálogo"
                >
                  Margen (esta página)
                  {marginSort === 'asc' && ' ↑'}
                  {marginSort === 'desc' && ' ↓'}
                </button>
              </th>
            )}
            <th className="p-3 font-medium">Estado</th>
            <th className="p-3 font-medium sr-only">Acciones</th>
          </tr>
        </thead>
        <tbody>
          {displayedListings.map((listing) => {
            const status = deriveCatalogStatus(listing)
            const meta = STATUS_LABEL[status]
            const badges = deriveChannelBadges(listing)
            const thumb = listing.images?.[0]?.url
            const isPending = pendingIds.has(listing.id) || pendingDeleteIds.has(listing.id)
            const canToggle = status === 'activo' || status === 'agotado' || status === 'pausado'
            const nextStatus = status === 'pausado' ? 'active' : 'paused'
            const margin = marginByProduct.get(listing.id)
            return (
              <tr key={listing.id} className={`border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--color-surface-alt)] ${isPending ? 'opacity-60' : ''}`}>
                {bulkFlagEnabled && (
                  <td className="p-0 md:p-3">
                    <label className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(listing.id)}
                        onChange={() => toggleSelect(listing.id)}
                        aria-label={`Seleccionar ${listing.title}`}
                        className="h-4 w-4 accent-[var(--color-accent)]"
                      />
                    </label>
                  </td>
                )}
                <td className="p-3">
                  <Link href={`/sell/edit/${listing.id}`} className="flex items-center gap-3 no-underline text-[var(--color-foreground)]">
                    <div className="w-10 h-10 flex-shrink-0 rounded-[var(--r-md)] overflow-hidden bg-[var(--color-surface-alt)] border border-[var(--color-border)]">
                      {thumb ? (
                        // `next/image` rather than a bare <img>: the changed-files lint
                        // gate runs at --max-warnings 0, so touching this file at all makes
                        // its pre-existing no-img-element warning blocking. Safe here — the
                        // project uses a CUSTOM image loader with `hostname: '**'`, so an
                        // arbitrary seller-image host (an ML import, say) still resolves.
                        // Fixed 40x40, so explicit dimensions rather than `fill`.
                        <Image src={thumb} alt="" width={40} height={40} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-lg"><i className="iconoir-package" aria-hidden /></div>
                      )}
                    </div>
                    <span className="font-medium truncate max-w-[240px]">{listing.title}</span>
                  </Link>
                  {(() => {
                    const rosterHref = eventRosterBySlug[rsvpEventSlug(listing.metadata) ?? '']
                    return rosterHref ? (
                      <Link href={rosterHref} data-testid="event-roster-link" className="inline-block mt-1 text-xs text-[var(--color-accent)] underline">
                        Registros y entrada
                      </Link>
                    ) : null
                  })()}
                </td>
                <td className="hidden p-3 text-[var(--color-muted)] md:table-cell">{listing.sku ?? '—'}</td>
                <td className="hidden p-3 font-semibold whitespace-nowrap md:table-cell">
                  {formatPrice(listing.price_cents, listing.currency)}
                  {listing.ml_price_cents != null && listing.ml_price_cents !== listing.price_cents && (
                    <div className="text-xs font-normal text-[var(--color-muted)]">
                      ML: {formatPrice(listing.ml_price_cents, listing.currency)}
                    </div>
                  )}
                </td>
                <td className="hidden p-3 whitespace-nowrap md:table-cell">{stockLabel(listing)}</td>
                <td className="hidden p-3 md:table-cell">
                  <div className="flex gap-1 flex-wrap items-center">
                    {badges.miyagi && <span className="badge badge-soft">Miyagi</span>}
                    {badges.ml && <span className="badge badge-soft">ML</span>}
                    {channelsFlagEnabled && (
                      <button
                        type="button"
                        onClick={() => handleMiyagiToggle(listing)}
                        disabled={isPending}
                        title={listing.miyagi_visible !== false
                          ? 'Ocultar del marketplace Miyagi (sigue en tu tienda)'
                          : 'Mostrar en el marketplace Miyagi'}
                        className="text-[10px] px-1.5 py-0.5 rounded-[var(--r-md)] border border-[var(--color-border)] hover:bg-[var(--color-surface-alt)] disabled:opacity-50"
                      >
                        {listing.miyagi_visible !== false ? 'Ocultar Miyagi' : 'Mostrar Miyagi'}
                      </button>
                    )}
                    {channelsFlagEnabled && (
                      <button
                        type="button"
                        onClick={() => handleMlToggle(listing)}
                        disabled={isPending || !mlEntitled}
                        title={!mlEntitled ? 'Requiere la integración de Mercado Libre' : undefined}
                        className="text-[10px] px-1.5 py-0.5 rounded-[var(--r-md)] border border-[var(--color-border)] hover:bg-[var(--color-surface-alt)] disabled:opacity-50"
                      >
                        {badges.ml ? 'Quitar de ML' : 'Publicar en ML'}
                      </button>
                    )}
                  </div>
                </td>
                {ownedShopOnlyEnabled && (() => {
                  const pubState = derivePublicationState({
                    in_operating_channel: listing.in_operating_channel ?? false,
                    in_marketplace_channel: listing.in_marketplace_channel ?? false,
                  })
                  const pubRequest = nextPublicationRequest(pubState)
                  return (
                    <td className="hidden p-3 md:table-cell">
                      <div className="flex flex-col gap-1 items-start">
                        <StatusBadge token={publicationStateToToken(pubState)} title={PUBLICATION_STATE_HINT[pubState]}>
                          {PUBLICATION_STATE_LABEL[pubState]}
                        </StatusBadge>
                        {pubRequest !== undefined && (
                          <button
                            type="button"
                            onClick={() => handlePublicationToggle(listing)}
                            disabled={isPending}
                            className="text-[10px] px-1.5 py-0.5 rounded-[var(--r-md)] border border-[var(--color-border)] hover:bg-[var(--color-surface-alt)] disabled:opacity-50"
                          >
                            {pubRequest === 'mx' ? 'Publicar en el marketplace' : 'Quitar del marketplace'}
                          </button>
                        )}
                      </div>
                    </td>
                  )
                })()}
                {profitFlagEnabled && (
                  <td className="hidden p-3 md:table-cell">
                    {margin && (
                      <div className="flex flex-col gap-0.5">
                        <MarginCellDisplay label="Miyagi" cell={margin.miyagi} />
                        {badges.ml && <MarginCellDisplay label="ML" cell={margin.ml} />}
                      </div>
                    )}
                  </td>
                )}
                <td className="p-3">
                  <div className="flex flex-wrap items-center gap-1">
                    <StatusBadge token={catalogStatusToToken(status)}>{meta.label}</StatusBadge>
                    {shopCannotCollect && status === 'activo' && (listing.listing_type ?? 'product') === 'product' && (
                      <StatusBadge token="warning" title={READINESS_COPY.catalogBadgeHint}>
                        <span data-testid="badge-catalog-only">{READINESS_COPY.catalogBadge}</span>
                      </StatusBadge>
                    )}
                  </div>
                </td>
                <td className="p-3">
                  <div className="hidden items-center justify-end gap-1 md:flex">
                    {canToggle && (
                      <button
                        type="button"
                        onClick={() => handleToggle(listing, nextStatus)}
                        disabled={isPending}
                        title={status === 'pausado' ? 'Activar anuncio' : 'Pausar anuncio'}
                        className="p-1.5 rounded-[var(--r-md)] hover:bg-[var(--color-border)] text-[var(--color-muted)] disabled:opacity-50"
                        aria-label={status === 'pausado' ? 'Activar' : 'Pausar'}
                      >
                        <i className={status === 'pausado' ? 'iconoir-play' : 'iconoir-pause'} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(listing)}
                      disabled={isPending}
                      title="Eliminar anuncio"
                      className="p-1.5 rounded-[var(--r-md)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)] text-[var(--color-muted)] disabled:opacity-50"
                      aria-label="Eliminar"
                    >
                      <i className="iconoir-trash" />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setMobileActionTarget(listing)}
                    disabled={isPending}
                    className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-[var(--r-md)] border border-[var(--color-border)] px-2 text-xs font-semibold text-[var(--color-text)] disabled:opacity-50 md:hidden"
                    aria-label={`Más acciones para ${listing.title}`}
                  >
                    <i className="iconoir-more-horiz" aria-hidden /> Más
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {deleteTarget && (
        <DeleteDialog
          listing={deleteTarget}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
          pending={hasPendingDelete}
        />
      )}
      {mobileActionTarget && (() => {
        const listing = mobileActionTarget
        const status = deriveCatalogStatus(listing)
        const canToggle = status === 'activo' || status === 'agotado' || status === 'pausado'
        const nextStatus = status === 'pausado' ? 'active' : 'paused'
        const badges = deriveChannelBadges(listing)
        const publicationState = derivePublicationState({
          in_operating_channel: listing.in_operating_channel ?? false,
          in_marketplace_channel: listing.in_marketplace_channel ?? false,
        })
        const publicationRequest = nextPublicationRequest(publicationState)
        const run = (action: () => void) => {
          setMobileActionTarget(null)
          action()
        }
        const actionClass = 'flex min-h-11 w-full items-center gap-3 rounded-[var(--r-md)] px-3 text-left text-sm font-medium hover:bg-[var(--color-surface-alt)] disabled:opacity-50'
        return (
          <>
            <button
              type="button"
              aria-label="Cerrar acciones"
              onClick={() => setMobileActionTarget(null)}
              className="fixed inset-0 z-[59] bg-black/35 md:hidden"
            />
            <section
              role="dialog"
              aria-modal="true"
              aria-label={`Acciones para ${listing.title}`}
              className="fixed inset-x-3 bottom-[calc(88px+env(safe-area-inset-bottom))] z-[60] rounded-[var(--r-lg)] border border-[var(--color-border)] bg-[var(--bg-elevated)] p-3 shadow-[var(--shadow-3)] md:hidden"
            >
              <div className="mb-2 flex items-center justify-between gap-3 px-2">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Acciones del anuncio</p>
                  <p className="truncate text-sm font-semibold">{listing.title}</p>
                </div>
                <button type="button" onClick={() => setMobileActionTarget(null)} className="inline-flex min-h-11 min-w-11 items-center justify-center" aria-label="Cerrar">
                  <i className="iconoir-xmark" aria-hidden />
                </button>
              </div>
              {canToggle && (
                <button type="button" className={actionClass} onClick={() => run(() => { void handleToggle(listing, nextStatus) })}>
                  <i className={status === 'pausado' ? 'iconoir-play' : 'iconoir-pause'} aria-hidden />
                  {status === 'pausado' ? 'Activar anuncio' : 'Pausar anuncio'}
                </button>
              )}
              {channelsFlagEnabled && (
                <button type="button" className={actionClass} onClick={() => run(() => { void handleMiyagiToggle(listing) })}>
                  <i className="iconoir-shop" aria-hidden />
                  {listing.miyagi_visible !== false ? 'Ocultar de Miyagi' : 'Mostrar en Miyagi'}
                </button>
              )}
              {channelsFlagEnabled && (
                <button type="button" disabled={!mlEntitled} className={actionClass} onClick={() => run(() => { void handleMlToggle(listing) })}>
                  <i className="iconoir-cloud-upload" aria-hidden />
                  {badges.ml ? 'Quitar de Mercado Libre' : 'Publicar en Mercado Libre'}
                </button>
              )}
              {ownedShopOnlyEnabled && publicationRequest !== undefined && (
                <button type="button" className={actionClass} onClick={() => run(() => { void handlePublicationToggle(listing) })}>
                  <i className="iconoir-globe" aria-hidden />
                  {publicationRequest === 'mx' ? 'Publicar en el marketplace' : 'Quitar del marketplace'}
                </button>
              )}
              <button
                type="button"
                className={`${actionClass} text-[var(--danger)]`}
                onClick={() => run(() => setDeleteTarget(listing))}
              >
                <i className="iconoir-trash" aria-hidden /> Eliminar anuncio
              </button>
            </section>
          </>
        )
      })()}
      <Toast toast={toast} onDismiss={dismissToast} />
      </div>

      {activeBatchId && (
        <BulkDiffPreview
          batchId={activeBatchId}
          onClose={() => setBatchInUrl(null)}
          onApplied={() => {
            setSelectedIds(new Set())
            router.refresh()
          }}
        />
      )}
    </div>
  )
}
