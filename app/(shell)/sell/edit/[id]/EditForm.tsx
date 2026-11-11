'use client'
/* eslint-disable @next/next/no-img-element -- seller-uploaded media comes from arbitrary remote hosts */

import { useSellerFormat } from '@/app/components/SellerFormatProvider'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AttrsSection, type Attrs, type ListingType } from '../../AttrsSection'
import { ESTADOS, ESTADO_INEGI_BY_NAME } from '@/lib/mx-locations'
import { CITIES_BY_STATE } from '@/lib/types'
import PersonalizationSection from './PersonalizationSection'
import OpcionesSection from './OpcionesSection'
import { sanitizeFieldDefs, type CustomFieldDef } from '@/lib/personalization'
import { SlugField, type SlugStatus } from '@/components/SlugField'
import { parsePesosToCents, parseCostPesosToCents } from '@/lib/opciones'
import type { PriceGrid } from '@/lib/price-grid'
import { EXCERPT_MAX_CHARS } from '@/lib/excerpt'
import { deriveInventoryMode, type InventoryMode } from '@/lib/inventory-mode'
import { PROCESSING_LABELS } from '@/lib/trust-inputs'
import { SEATS_EDIT_HINT, seatsForWrite } from '@/lib/event-seats'

interface ShortlinkInfo {
  shopSlug: string
  /** Auto short code (always present after backfill). */
  code: string
  /** Seller-set custom slug (optional, preferred over the code). */
  slug: string
}

interface EditableFields {
  title: string
  description: string
  price_cents: number | null
  currency: string
  listing_type: string
  category: string
  attrs: Record<string, unknown>
  custom_fields?: unknown
  available_quantity: number | null
  /** Whether the variant tracks finite stock — catalog-management S2 · 2.1. */
  manage_inventory?: boolean
  /** Native Medusa "sobre pedido" flag — catalog-management S2 · 2.1. */
  allow_backorder?: boolean
  /** Seller's estimated dispatch note for a backorder listing — catalog-management S2 · 2.1. */
  dispatch_estimate?: string | null
  images: Array<{ url: string; alt?: string }>
  state?: string
  municipio?: string
  estado_code?: string
  /** Arranged-only delivery (epic, S1.2) — 'carrier' (default) or 'arranged'. */
  delivery_mode?: 'carrier' | 'arranged' | null
}

export default function EditForm({
  id,
  initial,
  shortlink,
  priceGrid = null,
  isActive = false,
  knownMultiVariant = false,
  variantCosts = {},
  variantMlPrices = {},
  launchpadEnabled = false,
  initialExcerpt = '',
  inventoryChannelsEnabled = false,
  arrangedOnlyEnabled = false,
}: {
  id: string
  initial: EditableFields
  shortlink?: ShortlinkInfo
  /** The listing's live price-grid (same route the PDP reads); null when unavailable. */
  priceGrid?: PriceGrid | null
  /** Supabase mirror status === 'active' (Medusa: published). */
  isActive?: boolean
  /**
   * Mirror metadata `has_variants` — the publish-status-independent
   * multi-variant signal (the price-grid is unreadable for paused/draft
   * listings, so the grid alone can't gate the flat inputs there).
   */
  knownMultiVariant?: boolean
  /**
   * Per-variant unit costs (COGS) keyed by variant id, from the seller-scoped
   * GET (seller-private — never on the public price-grid). Feeds the flat
   * cost input (sole variant) and the per-combination cost editors.
   */
  variantCosts?: Record<string, number | null>
  /**
   * Optional Mercado Libre-specific price override, in centavos, keyed by
   * variant id — same seller-scoped GET/seller-private discipline as
   * `variantCosts` (catalog-management epic, Sprint 2 · Story 2.3).
   */
  variantMlPrices?: Record<string, number | null>
  /**
   * Bookshop launchpad S2.1 — true only for a digital listing while
   * `launchpad.enabled` is ON (the page pre-ANDs the type + flag). Shows the
   * "Lee un adelanto" excerpt editor; the PDP viewer renders on presence.
   */
  launchpadEnabled?: boolean
  /** The stored excerpt text (from the Medusa product metadata), '' when none. */
  initialExcerpt?: string
  /**
   * catalog.inventory_channels_enabled (catalog-management epic, Sprint 2 ·
   * Story 2.1) — fail-safe OFF: while OFF, only today's flat "Cantidad
   * disponible" input renders (no mode a buy box won't honor).
   */
  inventoryChannelsEnabled?: boolean
  /**
   * shipping.arranged_only_enabled (arranged-only-delivery epic, Sprint 1 ·
   * S1.2) — fail-safe OFF: while OFF, the "Entrega" toggle stays hidden.
   */
  arrangedOnlyEnabled?: boolean
}) {
  const fmt = useSellerFormat()
  const router = useRouter()
  const [title, setTitle] = useState(initial.title)
  const [description, setDescription] = useState(initial.description ?? '')
  const [priceRaw, setPriceRaw] = useState(
    initial.price_cents != null ? String(initial.price_cents / 100) : '',
  )
  const [quantityRaw, setQuantityRaw] = useState(
    initial.available_quantity != null ? String(initial.available_quantity) : '',
  )
  // Inventory mode (catalog-management epic, Sprint 2 · Story 2.1).
  const initialInventoryMode = deriveInventoryMode({
    manage_inventory: initial.manage_inventory ?? true,
    allow_backorder: initial.allow_backorder ?? false,
  })
  const [inventoryMode, setInventoryMode] = useState<InventoryMode>(initialInventoryMode)
  const [dispatchEstimate, setDispatchEstimate] = useState(initial.dispatch_estimate ?? '')
  // Unit cost (COGS) — flat input for single-variant listings only; the map
  // holds exactly one entry there (multi-variant costs live in Opciones).
  const initialCostCents = (() => {
    const vals = Object.values(variantCosts ?? {})
    return vals.length === 1 ? vals[0] : null
  })()
  const [costRaw, setCostRaw] = useState(
    initialCostCents != null ? String(initialCostCents / 100) : '',
  )
  // ML price override (catalog-management S2 · 2.3) — same single-variant-
  // only resolution as unit cost above.
  const initialMlPriceCents = (() => {
    const vals = Object.values(variantMlPrices ?? {})
    return vals.length === 1 ? vals[0] : null
  })()
  const [mlPriceRaw, setMlPriceRaw] = useState(
    initialMlPriceCents != null ? String(initialMlPriceCents / 100) : '',
  )
  const [attrs, setAttrs] = useState<Attrs>(
    Object.fromEntries(
      Object.entries(initial.attrs ?? {}).map(([k, v]) => [k, String(v ?? '')])
    )
  )
  function setAttr(k: string, v: string) {
    setAttrs(prev => ({ ...prev, [k]: v }))
  }
  const [customFields, setCustomFields] = useState<CustomFieldDef[]>(
    () => sanitizeFieldDefs(initial.custom_fields),
  )
  // "Lee un adelanto" excerpt text (bookshop launchpad S2.1) — digital only.
  const [excerpt, setExcerpt] = useState(initialExcerpt ?? '')
  const [listingState, setListingState] = useState(initial.state ?? '')
  const [listingCity, setListingCity] = useState(initial.municipio ?? '')
  const hasLegacyLocation = !!(initial.state && !initial.estado_code)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)

  // Product short link (mschz.org/[slug || code]) — US-3b/US-4
  const [shortSlug, setShortSlug] = useState(shortlink?.slug ?? '')
  const [shortStatus, setShortStatus] = useState<SlugStatus>('idle')
  const [shortCopied, setShortCopied] = useState(false)
  const shortSeg = shortSlug.trim() || shortlink?.code || ''
  const shortUrl = shortSeg ? `mschz.org/${shortSeg}` : ''

  const isSubscription = initial.listing_type === 'subscription'
  const isDigital = initial.listing_type === 'digital'
  const isProduct = initial.listing_type === 'product'
  const priceReadOnly = isSubscription

  // Arranged-only delivery (epic, S1.2) — 'carrier' (default) or 'arranged'.
  const initialDeliveryMode = initial.delivery_mode ?? 'carrier'
  const [deliveryMode, setDeliveryMode] = useState<'carrier' | 'arranged'>(initialDeliveryMode)

  // Opciones (custom-print-products Story 2.4): a multi-variant listing has no
  // single flat price/stock — the backend 422s a bare `price_cents`/`quantity`
  // ("especifica variant_id"), and a tiered sole variant 422s `price_cents`
  // ("usa variant_tiers"). Hide those legacy inputs and route everything
  // through the Opciones section instead of letting the save fail.
  const isMultiVariant = (priceGrid?.variants.length ?? 0) > 1 || knownMultiVariant
  const soleVariantHasTiers = priceGrid?.variants.length === 1 && priceGrid.variants[0].tiers.length > 1
  const hideFlatPrice = isMultiVariant || soleVariantHasTiers
  const hideFlatQuantity = isMultiVariant

  // Price/quantity are only SENT when actually changed (dirty check by parsed
  // value, so "15" vs "15.00" isn't a change). Defense in depth alongside
  // `knownMultiVariant`: a converted listing missing the mirror flag (e.g.
  // converted via direct API before this UI existed) and paused has no
  // readable price-grid, so the flat inputs render — without the dirty check,
  // saving an unrelated field would submit the stale flat price and the
  // backend would 422 the whole save with "especifica variant_id"
  // (cross-agent review catches, Antigravity rounds 1-2, 2026-07-05).

  async function handleSave() {
    const errs: Record<string, string> = {}
    if (title.trim().length < 5) errs.title = 'El título debe tener al menos 5 caracteres.'
    if (title.trim().length > 100) errs.title = 'El título no puede superar los 100 caracteres.'
    if (!priceReadOnly && !hideFlatPrice && priceRaw) {
      const cents = parsePesosToCents(priceRaw)
      if (cents !== null && cents <= 0) errs.price = 'El precio debe ser mayor a $0.'
    }
    if (!isSubscription && !isMultiVariant && costRaw.trim() !== ''
      && parseCostPesosToCents(costRaw) === null) {
      errs.unit_cost = 'El costo unitario debe ser de $0 o más.'
    }
    if (inventoryChannelsEnabled && !isSubscription && !isMultiVariant && mlPriceRaw.trim() !== ''
      && parseCostPesosToCents(mlPriceRaw) === null) {
      errs.ml_price = 'El precio de Mercado Libre debe ser de $0 o más.'
    }
    // A refused seat count blocks the save with a visible field error — it used to be dropped
    // silently and the rest of the form saved as if the merchant had not typed it (review #490).
    if (!isProduct) {
      const seatsCheck = seatsForWrite({ listingType: initial.listing_type, attrs, seatsRaw: quantityRaw })
      if (!seatsCheck.ok) errs.seats = seatsCheck.error
    }
    if (shortStatus === 'taken' || shortStatus === 'invalid') {
      errs.short_slug = 'Corrige el enlace corto antes de guardar.'
    }
    setFieldErrors(errs)
    if (Object.keys(errs).length > 0) return

    setSaving(true)
    setError(null)
    setSaved(false)

    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        description: description.trim() || null,
        attrs: Object.fromEntries(
          Object.entries(attrs).filter(([, v]) => v !== '' && v !== null && v !== undefined)
        ),
        state: listingState || null,
        estado_code: listingState ? ESTADO_INEGI_BY_NAME[listingState] : null,
        municipio: listingCity.trim() || null,
        custom_fields: sanitizeFieldDefs(customFields),
        ...(shortlink ? { short_slug: shortSlug.trim() || null } : {}),
      }
      if (!priceReadOnly && !hideFlatPrice) {
        const nextPriceCents = priceRaw ? parsePesosToCents(priceRaw) : null
        if (nextPriceCents !== (initial.price_cents ?? null)) body.price_cents = nextPriceCents
      }
      if (isProduct && !hideFlatQuantity && quantityRaw.trim() !== '') {
        const nextQuantity = Math.max(0, parseInt(quantityRaw) || 0)
        if (nextQuantity !== (initial.available_quantity ?? null)) body.quantity = nextQuantity
      }
      // An event's «Lugares disponibles» (merchant-panel-gaps S1.1): sent only when changed, so an
      // unrelated save never touches seats — and a first-time value turns tracking on server-side.
      if (!isProduct) {
        // Blank = «unchanged» on EDIT (create: blank = untracked); 0 stops the sale. See SEATS_EDIT_HINT.
        const seatsResult = seatsForWrite({ listingType: initial.listing_type, attrs, seatsRaw: quantityRaw })
        if (seatsResult.ok && seatsResult.quantity !== undefined
          && seatsResult.quantity !== (initial.available_quantity ?? null)) {
          body.quantity = seatsResult.quantity
        }
      }
      // Inventory mode + dispatch estimate — catalog-management S2 · 2.1.
      // Flag-gated at the selector UI level (only 'tracked' is offered while
      // OFF), but dirty-check by value regardless so a no-op save never sends
      // a field the backend would otherwise have to interpret.
      if (isProduct && !hideFlatQuantity && inventoryChannelsEnabled && inventoryMode !== initialInventoryMode) {
        body.inventory_mode = inventoryMode
      }
      if (isProduct && !hideFlatQuantity && inventoryChannelsEnabled) {
        const nextDispatchEstimate = inventoryMode === 'backorder' && dispatchEstimate.trim() !== ''
          ? dispatchEstimate.trim()
          : null
        if (nextDispatchEstimate !== (initial.dispatch_estimate ?? null)) {
          body.dispatch_estimate = nextDispatchEstimate
        }
      }
      // Unit cost (COGS) — dirty-checked by parsed value, same discipline as
      // price/quantity; empty clears (null). Multi-variant costs save per
      // combination in the Opciones section, never through this PUT.
      if (!isSubscription && !isMultiVariant) {
        const nextCostCents = costRaw.trim() !== '' ? parseCostPesosToCents(costRaw) : null
        if (nextCostCents !== initialCostCents) body.unit_cost_cents = nextCostCents
      }
      // ML price override (catalog-management S2 · 2.3) — same dirty-check
      // discipline; empty clears (null). Single-variant only.
      if (inventoryChannelsEnabled && !isSubscription && !isMultiVariant) {
        const nextMlPriceCents = mlPriceRaw.trim() !== '' ? parseCostPesosToCents(mlPriceRaw) : null
        if (nextMlPriceCents !== initialMlPriceCents) body.ml_price_cents = nextMlPriceCents
      }
      // Excerpt (S2.1) — only sent when the field is available (digital + flag)
      // AND changed; the route normalizes + clears on empty. Sending the raw
      // value keeps the client dumb (the server owns the trim/cap rules).
      if (launchpadEnabled && excerpt !== initialExcerpt) body.excerpt = excerpt
      // Arranged-only delivery (epic, S1.2) — flag-gated at the toggle UI
      // level, but dirty-check by value regardless (same discipline as
      // inventory_mode above).
      if (isProduct && arrangedOnlyEnabled && deliveryMode !== initialDeliveryMode) {
        body.delivery_mode = deliveryMode
      }

      const res = await fetch(`/api/sell/listing/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json() as { updated?: boolean; error?: string; field?: string }

      if (!res.ok) {
        if (data.field) setFieldErrors(prev => ({ ...prev, [data.field!]: data.error! }))
        else setError(data.error ?? 'Error al guardar los cambios.')
        return
      }
      setSaved(true)
      router.refresh()
    } catch {
      setError('Sin conexión. Verifica tu internet e inténtalo de nuevo.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-[var(--r-sm)] px-4 py-3 text-sm flex items-start gap-2">
          <i className="iconoir-warning-triangle mt-0.5 shrink-0" aria-hidden />
          <p>{error}</p>
        </div>
      )}
      {saved && (
        <div className="bg-green-50 border border-green-200 text-green-700 rounded-[var(--r-sm)] px-4 py-3 text-sm flex items-center gap-2">
          <i className="iconoir-check" aria-hidden />
          <p>Cambios guardados correctamente.</p>
        </div>
      )}

      {/* Images preview */}
      {initial.images.length > 0 && (
        <div>
          <p className="text-sm font-medium text-[var(--color-text)] mb-2">Fotos actuales</p>
          <div className="flex gap-2 flex-wrap">
            {initial.images.map((img, i) => (
              <img
                key={i}
                src={img.url}
                alt={img.alt ?? ''}
                className="w-20 h-20 object-cover rounded-[var(--r-sm)] border border-[var(--color-border)]"
              />
            ))}
          </div>
          <p className="text-xs text-[var(--color-muted)] mt-1">
            Para cambiar las fotos, elimina este anuncio y crea uno nuevo.
          </p>
        </div>
      )}

      {/* Title */}
      <div>
        <label className="block text-sm font-medium text-[var(--color-text)] mb-1">
          Título <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          maxLength={100}
          className={`w-full border rounded-[var(--r-sm)] px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent transition ${
            fieldErrors.title ? 'border-red-400' : 'border-[var(--color-border)]'
          }`}
        />
        {fieldErrors.title && <p className="text-red-600 text-xs mt-1">{fieldErrors.title}</p>}
        <p className="text-xs text-[var(--color-muted)] mt-1">{title.length}/100</p>
      </div>

      {/* Description */}
      <div>
        <label className="block text-sm font-medium text-[var(--color-text)] mb-1">Descripción</label>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          rows={5}
          className="w-full border border-[var(--color-border)] rounded-[var(--r-sm)] px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent transition resize-y"
          placeholder="Describe tu anuncio..."
        />
      </div>

      {/* Excerpt — "Lee un adelanto" free sample (digital + launchpad.enabled).
          Stored on the product metadata; renders inline on the PDP. */}
      {launchpadEnabled && (
        <div>
          <label className="block text-sm font-medium text-[var(--color-text)] mb-1">
            Adelanto — &quot;Lee un adelanto&quot;
          </label>
          <textarea
            value={excerpt}
            onChange={e => setExcerpt(e.target.value)}
            rows={8}
            maxLength={EXCERPT_MAX_CHARS}
            className="w-full border border-[var(--color-border)] rounded-[var(--r-sm)] px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent transition resize-y"
            placeholder="Pega aquí un fragmento gratuito (por ejemplo, el primer capítulo). Los lectores podrán leerlo en la página del producto antes de comprar."
          />
          <p className="text-xs text-[var(--color-muted)] mt-1">
            Muestra un fragmento gratis para dar ganas de leer más. El archivo completo sigue
            siendo privado hasta la compra. Déjalo vacío para no mostrar adelanto. {fmt.number(excerpt.length)}/{fmt.number(EXCERPT_MAX_CHARS)}
          </p>
        </div>
      )}

      {/* Category-specific attrs */}
      {initial.category && (
        <AttrsSection
          category={initial.category}
          listingType={initial.listing_type as ListingType}
          attrs={attrs}
          setAttr={setAttr}
          seats={quantityRaw}
          setSeats={setQuantityRaw}
          seatsError={fieldErrors.seats}
          seatsHint={SEATS_EDIT_HINT}
        />
      )}

      {/* Personalization fields — buyer-entered custom inputs (not for subscriptions) */}
      {!isSubscription && (
        <PersonalizationSection fields={customFields} setFields={setCustomFields} />
      )}

      {/* Opciones — priced dimensions + quantity tiers (products only; Story 2.4) */}
      {isProduct && (
        <OpcionesSection
          productId={id}
          priceGrid={priceGrid}
          isActive={isActive}
          currency={initial.currency}
          variantCosts={variantCosts}
        />
      )}

      {/* Short link (mschz.org) — copy + optional custom slug (US-3b / US-4) */}
      {shortlink && (
        <div className="border border-[var(--color-border)] rounded-[var(--r-md)] p-4 bg-[var(--color-surface-alt)]">
          <h3 className="text-sm font-medium mb-1">Enlace corto del producto</h3>
          <div className="flex items-center gap-2 mt-2">
            <code className="flex-1 min-w-0 truncate text-sm font-mono bg-[var(--fg-inverse)] border border-[var(--color-border)] rounded-[var(--r-sm)] px-3 py-2">
              {shortUrl}
            </code>
            <button
              type="button"
              onClick={() => { navigator.clipboard.writeText(`https://${shortUrl}`); setShortCopied(true); setTimeout(() => setShortCopied(false), 2000) }}
              className={`text-xs px-3 py-2 rounded-[var(--r-sm)] transition-colors whitespace-nowrap ${shortCopied ? 'bg-green-100 text-green-700' : 'bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--fg-inverse)]'}`}
            >
              {shortCopied ? <><i className="iconoir-check" aria-hidden /> Copiado</> : 'Copiar'}
            </button>
          </div>
          <p className="text-xs text-[var(--color-muted)] mt-2">
            Compártelo en redes y mensajes. Por defecto usa un código; personalízalo si quieres:
          </p>
          <div className="mt-3">
            <SlugField
              value={shortSlug}
              onChange={setShortSlug}
              currentSlug={shortlink.slug || undefined}
              onStatusChange={setShortStatus}
              label="Personaliza el enlace (opcional)"
              prefix="mschz.org/"
              checkUrl={`/api/sell/shortlink/check?excludeListing=${id}`}
              placeholder={shortlink.code}
              successText="¡Disponible!"
            />
            {fieldErrors.short_slug && <p className="text-xs text-red-600 mt-1">{fieldErrors.short_slug}</p>}
          </div>
        </div>
      )}

      {/* Price — hidden for multi-variant/tiered listings (managed per combination above) */}
      {!priceReadOnly && !hideFlatPrice && (
        <div>
          <label className="block text-sm font-medium text-[var(--color-text)] mb-1">
            Precio ({initial.currency})
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted)] text-sm">$</span>
            <input
              type="text"
              inputMode="decimal"
              value={priceRaw}
              onChange={e => setPriceRaw(e.target.value)}
              placeholder="0.00"
              className={`w-full border rounded-[var(--r-sm)] pl-7 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent transition ${
                fieldErrors.price ? 'border-red-400' : 'border-[var(--color-border)]'
              }`}
            />
          </div>
          {fieldErrors.price && <p className="text-red-600 text-xs mt-1">{fieldErrors.price}</p>}
          {isDigital && <p className="text-xs text-[var(--color-muted)] mt-1">Precio por descarga única.</p>}
        </div>
      )}
      {isSubscription && (
        <div className="bg-[var(--color-background)] border border-[var(--color-border)] rounded-[var(--r-md)] px-4 py-3 text-sm text-[var(--color-muted)]">
          <i className="iconoir-light-bulb" aria-hidden /> Los precios de suscripción se gestionan en los planes del anuncio.
        </div>
      )}

      {/* Unit cost (COGS) — single-variant only; multi-variant costs live per
          combination in Opciones. Seller-private: buyers never see it. */}
      {!isSubscription && !isMultiVariant && (
        <div>
          <label className="block text-sm font-medium text-[var(--color-text)] mb-1">
            Costo unitario ({initial.currency}) <span className="text-[var(--color-muted)] font-normal">— privado</span>
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted)] text-sm">$</span>
            <input
              type="text"
              inputMode="decimal"
              value={costRaw}
              onChange={e => setCostRaw(e.target.value)}
              placeholder="0.00"
              className={`w-full border rounded-[var(--r-sm)] pl-7 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent transition ${
                fieldErrors.unit_cost ? 'border-red-400' : 'border-[var(--color-border)]'
              }`}
            />
          </div>
          {fieldErrors.unit_cost && <p className="text-red-600 text-xs mt-1">{fieldErrors.unit_cost}</p>}
          <p className="text-xs text-[var(--color-muted)] mt-1">
            Lo que te cuesta producir o adquirir una unidad. Solo tú lo ves — alimenta tu análisis
            de ganancias. Déjalo vacío si no quieres registrarlo.
          </p>
        </div>
      )}

      {/* ML price override — single-variant only, catalog-management S2 · 2.3 */}
      {inventoryChannelsEnabled && !isSubscription && !isMultiVariant && (
        <div>
          <label className="block text-sm font-medium text-[var(--color-text)] mb-1">
            Precio en Mercado Libre ({initial.currency}) <span className="text-[var(--color-muted)] font-normal">— opcional</span>
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted)] text-sm">$</span>
            <input
              type="text"
              inputMode="decimal"
              value={mlPriceRaw}
              onChange={e => setMlPriceRaw(e.target.value)}
              placeholder="Igual que el precio en Miyagi"
              className={`w-full border rounded-[var(--r-sm)] pl-7 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent transition ${
                fieldErrors.ml_price ? 'border-red-400' : 'border-[var(--color-border)]'
              }`}
            />
          </div>
          {fieldErrors.ml_price && <p className="text-red-600 text-xs mt-1">{fieldErrors.ml_price}</p>}
          <p className="text-xs text-[var(--color-muted)] mt-1">
            Precio distinto solo para Mercado Libre — así sus comisiones no suben tu precio en Miyagi.
            Déjalo vacío para usar el mismo precio en ambos.
          </p>
        </div>
      )}

      {/* Inventory mode + quantity/restock — hidden for multi-variant listings (per-combination stock) */}
      {isProduct && !hideFlatQuantity && (
        <div>
          {inventoryChannelsEnabled && (
            <div className="mb-3">
              <label className="block text-sm font-medium text-[var(--color-text)] mb-1">
                Modo de inventario
              </label>
              <div className="flex gap-2 flex-wrap">
                {([
                  { value: 'tracked', label: 'Rastreado' },
                  { value: 'unlimited', label: 'Sin límite' },
                  { value: 'backorder', label: 'Sobre pedido' },
                ] as { value: InventoryMode; label: string }[]).map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setInventoryMode(opt.value)}
                    className={`text-xs px-3 py-1.5 rounded-[var(--r-pill)] border transition-colors ${
                      inventoryMode === opt.value
                        ? 'bg-[var(--color-accent)] text-white border-[var(--color-accent)]'
                        : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-alt)]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Falls back to the flat quantity input whenever the flag is OFF, even for a
              listing whose stored mode is 'unlimited'/'backorder' (e.g. set while the
              flag was ON, then flipped off) — otherwise the whole quantity section goes
              blank with no way to act (cross-agent review catch). Saving a quantity here
              already re-enables manage_inventory via the existing quantity-write block
              below, giving the seller a real path back to tracked mode. */}
          {(inventoryMode === 'tracked' || !inventoryChannelsEnabled) && (
            <>
              <label className="block text-sm font-medium text-[var(--color-text)] mb-1">
                Cantidad disponible
              </label>
              <input
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                value={quantityRaw}
                onChange={e => setQuantityRaw(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="0"
                className={`w-32 border rounded-[var(--r-sm)] px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent transition ${
                  fieldErrors.quantity ? 'border-red-400' : 'border-[var(--color-border)]'
                }`}
              />
              {fieldErrors.quantity && <p className="text-red-600 text-xs mt-1">{fieldErrors.quantity}</p>}
              <p className="text-xs text-[var(--color-muted)] mt-1">
                Pon 0 para marcar como agotado. No afecta pedidos en curso.
              </p>
            </>
          )}

          {inventoryChannelsEnabled && inventoryMode === 'unlimited' && (
            <p className="text-xs text-[var(--color-muted)]">
              Este producto nunca se marca como agotado — no se rastrea cantidad.
            </p>
          )}

          {inventoryChannelsEnabled && inventoryMode === 'backorder' && (
            <div>
              <label className="block text-sm font-medium text-[var(--color-text)] mb-1">
                Envío estimado
              </label>
              <select
                value={dispatchEstimate}
                onChange={e => setDispatchEstimate(e.target.value)}
                className="w-full border border-[var(--color-border)] rounded-[var(--r-sm)] px-3 py-2 text-sm bg-[var(--fg-inverse)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent"
              >
                <option value="">Selecciona…</option>
                {Object.entries(PROCESSING_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
              <p className="text-xs text-[var(--color-muted)] mt-1">
                El comprador verá &quot;Sobre pedido&quot; y este tiempo de envío estimado. Nunca se marca como agotado.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Entrega (arranged-only delivery, epic S1.2) */}
      {isProduct && arrangedOnlyEnabled && (
        <div>
          <label className="block text-sm font-medium text-[var(--color-text)] mb-1">
            Entrega
          </label>
          <div className="grid grid-cols-2 gap-2">
            {([
              { key: 'carrier' as const, label: '📦 Paquetería' },
              { key: 'arranged' as const, label: '🤝 Acordada con el comprador' },
            ]).map(opt => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setDeliveryMode(opt.key)}
                className={`border rounded-[var(--r-md)] py-2.5 text-sm transition-all ${
                  deliveryMode === opt.key
                    ? 'border-[var(--color-accent)] bg-[var(--accent-soft)] text-[var(--color-accent)] font-semibold'
                    : 'border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-accent)]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {deliveryMode === 'arranged' && (
            <p className="text-xs text-[var(--color-muted)] mt-1.5">
              <i className="iconoir-community" aria-hidden /> El comprador verá solo pago directo (SPEI / efectivo) — necesitas un método de
              pago manual configurado para publicar.
            </p>
          )}
        </div>
      )}

      {/* Location */}
      <div>
        <label className="block text-sm font-medium text-[var(--color-text)] mb-1">
          Ubicación / Location
        </label>
        {hasLegacyLocation && !listingState && (
          <div className="mb-2 bg-amber-50 border border-amber-200 text-amber-800 rounded-[var(--r-md)] px-3 py-2 text-xs">
            <i className="iconoir-warning-triangle" aria-hidden /> Actualizar ubicación / Update location — tu anuncio tiene una ubicación guardada como texto libre (&quot;{initial.state}&quot;). Selecciona el estado correcto para que aparezca en los filtros de búsqueda.
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <select
            value={listingState}
            onChange={e => { setListingState(e.target.value); setListingCity('') }}
            className="w-full border border-[var(--color-border)] rounded-[var(--r-sm)] px-3 py-2 text-sm bg-[var(--fg-inverse)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent"
          >
            <option value="">Estado / State (opcional)</option>
            {ESTADOS.map(e => (
              <option key={e.inegi_code} value={e.name}>{e.name}</option>
            ))}
          </select>
          <select
            value={listingCity}
            onChange={e => setListingCity(e.target.value)}
            disabled={!listingState}
            className="w-full border border-[var(--color-border)] rounded-[var(--r-sm)] px-3 py-2 text-sm bg-[var(--fg-inverse)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">{listingState ? 'Municipio (opcional)' : 'Primero elige estado'}</option>
            {(CITIES_BY_STATE[listingState] ?? []).map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>

      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="w-full bg-[var(--color-accent)] text-white font-semibold py-3 rounded-[var(--r-md)] text-sm hover:bg-[var(--color-accent-hover)] transition disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {saving ? 'Guardando…' : <><i className="iconoir-check" aria-hidden /> Guardar cambios</>}
      </button>
    </div>
  )
}
