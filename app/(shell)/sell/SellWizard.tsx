'use client'

import React, { useState, useRef, useCallback, useId, useEffect } from 'react'
import { CATEGORIES, CITIES_BY_STATE } from '@/lib/types'
import { ESTADOS, ESTADO_INEGI_BY_NAME } from '@/lib/mx-locations'
import { AttrsSection, type Attrs } from './AttrsSection'
import { SlugField, type SlugStatus } from '@/components/SlugField'
import { slugify } from '@/lib/slug'
import { Banner } from '@/components/feedback/Banner'
import { SuccessCard } from '@/components/SuccessCard'
import { listingUrlFor, shopUrlFor } from '@/lib/market-url'
import { SITE_ORIGIN } from '@/lib/market-seo'
import { createPublishToMarket } from '@/lib/publication-state'
import { DEFAULT_MARKET, MARKETS, type MarketCode } from '@/lib/markets'
import { resolveSellerSignupMarket } from '@/lib/seller-signup-market'
import { seatsForWrite } from '@/lib/event-seats'

// ── Types ────────────────────────────────────────────────────────────────────

interface ExistingShop {
  id: string
  slug: string
  name: string
  location: string | null
  market: MarketCode
}

interface UploadedPhoto {
  localId: string          // stable key for React
  localUrl: string         // blob URL, shown immediately
  remoteUrl: string | null // Supabase URL once uploaded
  status: 'uploading' | 'done' | 'error'
  errorMsg?: string
}

type ListingType = 'product' | 'service' | 'rental' | 'digital' | 'subscription'

// ── Canvas image compression ──────────────────────────────────────────────────
// Runs entirely client-side: resize to ≤1920px wide, convert to WebP at 0.82 quality.
// Falls back to the original file if canvas is unavailable (SSR, old browser).

async function compressImage(file: File): Promise<File> {
  if (typeof window === 'undefined' || !window.createImageBitmap) return file
  // Skip tiny files — no benefit compressing images already under 200KB
  if (file.size < 200 * 1024 && file.type === 'image/webp') return file

  try {
    const bitmap = await createImageBitmap(file)
    const MAX_DIM = 1920
    let { width, height } = bitmap
    if (width > MAX_DIM || height > MAX_DIM) {
      const ratio = Math.min(MAX_DIM / width, MAX_DIM / height)
      width  = Math.round(width  * ratio)
      height = Math.round(height * ratio)
    }

    const canvas = document.createElement('canvas')
    canvas.width  = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()

    const blob = await new Promise<Blob | null>(resolve =>
      canvas.toBlob(resolve, 'image/webp', 0.82),
    )
    if (!blob) return file

    const compressed = new File(
      [blob],
      file.name.replace(/\.[^.]+$/, '.webp'),
      { type: 'image/webp' },
    )
    // Only use compressed if it's actually smaller
    return compressed.size < file.size ? compressed : file
  } catch {
    return file
  }
}

interface DigitalFile {
  path: string
  name: string
  size: number
  mime: string
  label: string
}
type Condition = 'new' | 'like_new' | 'good' | 'fair' | 'parts'

const CONDITIONS: { key: Condition; label: string; hint: string }[] = [
  { key: 'new',      label: 'Nuevo',        hint: 'Sin uso, en empaque original' },
  { key: 'like_new', label: 'Como nuevo',   hint: 'Casi sin uso, sin daños' },
  { key: 'good',     label: 'Buen estado',  hint: 'Uso normal, todo funciona' },
  { key: 'fair',     label: 'Aceptable',    hint: 'Señales de uso visibles' },
  { key: 'parts',    label: 'Para piezas',  hint: 'No funciona o incompleto' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function parsePriceCents(raw: string): number | null {
  const num = parseFloat(raw.replace(/,/g, '').replace(/\s/g, ''))
  if (isNaN(num) || num <= 0) return null
  return Math.round(num * 100)
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressSteps({
  step,
  hasShopStep,
}: {
  step: 1 | 2 | 3
  hasShopStep: boolean
}) {
  const steps = hasShopStep
    ? ['Tu tienda', 'Tu anuncio']
    : ['Tu anuncio']

  // Map logical step to display index
  const displayIndex = hasShopStep ? step - 1 : step - 2

  if (step === 3) return null // success state has its own UI

  return (
    <div className="flex items-center gap-2 mb-8">
      {steps.map((label, i) => {
        const done = i < displayIndex
        const active = i === displayIndex
        return (
          <div key={label} className="flex items-center gap-2">
            {i > 0 && (
              <div className={`h-px flex-1 w-8 ${done ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'}`} />
            )}
            <div className="flex items-center gap-1.5">
              <div
                className={`w-6 h-6 rounded-[var(--r-pill)] flex items-center justify-center text-xs font-bold transition-colors ${
                  done
                    ? 'bg-[var(--color-accent)] text-white'
                    : active
                    ? 'bg-[var(--color-accent)] text-white'
                    : 'bg-[var(--color-border)] text-[var(--color-muted)]'
                }`}
              >
                {done ? <i className="iconoir-check" aria-hidden /> : i + 1}
              </div>
              <span
                className={`text-sm font-medium ${
                  active ? 'text-[var(--color-text)]' : done ? 'text-[var(--color-muted)]' : 'text-[var(--color-muted)]'
                }`}
              >
                {label}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Photo upload zone ─────────────────────────────────────────────────────────

function PhotoUploader({
  photos,
  onChange,
}: {
  photos: UploadedPhoto[]
  onChange: (updater: React.SetStateAction<UploadedPhoto[]>) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const MAX_PHOTOS = 10

  async function uploadFile(file: File, localId: string) {
    // Compress before upload: resize to ≤1920px, convert to WebP
    const compressed = await compressImage(file)
    const fd = new FormData()
    fd.append('file', compressed)
    try {
      const res = await fetch('/api/sell/upload', { method: 'POST', body: fd })
      const data = await res.json() as { url?: string; error?: string }
      if (!res.ok || !data.url) {
        onChange(prev =>
          prev.map(p =>
            p.localId === localId
              ? { ...p, status: 'error', errorMsg: data.error ?? 'Error al subir. Toca para reintentar.' }
              : p
          )
        )
        return
      }
      onChange(prev =>
        prev.map(p => (p.localId === localId ? { ...p, status: 'done', remoteUrl: data.url! } : p))
      )
    } catch {
      onChange(prev =>
        prev.map(p =>
          p.localId === localId
            ? { ...p, status: 'error', errorMsg: 'Sin conexión. Toca para reintentar.' }
            : p
        )
      )
    }
  }

  function addFiles(files: FileList | File[]) {
    const remaining = MAX_PHOTOS - photos.length
    if (remaining <= 0) return
    const toAdd = Array.from(files).slice(0, remaining)

    const newPhotos: UploadedPhoto[] = toAdd.map(file => ({
      localId: `${Date.now()}-${Math.random()}`,
      localUrl: URL.createObjectURL(file),
      remoteUrl: null,
      status: 'uploading' as const,
    }))

    onChange(prev => [...prev, ...newPhotos])

    // Start uploads
    newPhotos.forEach((photo, i) => {
      uploadFile(toAdd[i], photo.localId)
    })
  }

  function retryUpload(photo: UploadedPhoto, index: number) {
    // Can't retry without original file — mark for re-add
    // Best UX: remove the failed one so user can re-add it
    removePhoto(index)
  }

  function removePhoto(index: number) {
    onChange(prev => {
      const next = [...prev]
      URL.revokeObjectURL(next[index].localUrl)
      next.splice(index, 1)
      return next
    })
  }

  const isAtMax = photos.length >= MAX_PHOTOS

  return (
    <div>
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mb-2">
        {photos.map((photo, index) => (
          <div key={photo.localId} className="relative aspect-square rounded-[var(--r-md)] overflow-hidden border border-[var(--color-border)] bg-[var(--color-background)]">
            {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview before upload */}
            <img
              src={photo.localUrl}
              alt=""
              className={`w-full h-full object-cover transition-opacity ${photo.status === 'uploading' ? 'opacity-50' : ''}`}
            />
            {/* Status overlay */}
            {photo.status === 'uploading' && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                <span className="text-white text-xl animate-spin">⟳</span>
              </div>
            )}
            {photo.status === 'error' && (
              <button
                type="button"
                onClick={() => retryUpload(photo, index)}
                title={photo.errorMsg}
                className="absolute inset-0 flex flex-col items-center justify-center bg-[var(--danger)]/80 text-white text-xs p-1 text-center cursor-pointer"
              >
                <i className="iconoir-warning-triangle text-lg mb-0.5" aria-hidden />
                <span>Reintentar</span>
              </button>
            )}
            {/* Cover label */}
            {index === 0 && photo.status === 'done' && (
              <div className="absolute bottom-0 left-0 right-0 bg-[var(--color-accent)] text-white text-[10px] text-center py-0.5 font-medium">
                Portada
              </div>
            )}
            {/* Remove button */}
            {photo.status !== 'uploading' && (
              <button
                type="button"
                onClick={() => removePhoto(index)}
                className="absolute top-1 right-1 w-5 h-5 bg-black/60 hover:bg-black/80 text-white rounded-[var(--r-pill)] flex items-center justify-center text-xs leading-none transition-colors"
                aria-label="Eliminar foto"
              >
                ×
              </button>
            )}
          </div>
        ))}

        {/* Drop zone / add more */}
        {!isAtMax && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => {
              e.preventDefault()
              setDragging(false)
              addFiles(e.dataTransfer.files)
            }}
            className={`aspect-square rounded-[var(--r-md)] border-2 border-dashed flex flex-col items-center justify-center text-[var(--color-muted)] transition-colors cursor-pointer ${
              dragging
                ? 'border-[var(--color-accent)] bg-[var(--accent-soft)] text-[var(--color-accent)]'
                : 'border-[var(--color-border)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]'
            } ${photos.length === 0 ? 'col-span-3 sm:col-span-4 aspect-auto min-h-[120px]' : ''}`}
          >
            <span className="text-2xl mb-1">{photos.length === 0 ? <i className="iconoir-camera" aria-hidden /> : '+'}</span>
            {photos.length === 0 ? (
              <>
                <span className="text-sm font-medium text-center px-4">Arrastra tus fotos aquí</span>
                <span className="text-xs mt-1 text-center px-4">o haz clic para seleccionar · máx. 8 MB por foto</span>
              </>
            ) : (
              <span className="text-xs">Agregar</span>
            )}
          </button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
        multiple
        className="hidden"
        onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }}
      />

      <p className="text-xs text-[var(--color-muted)]">
        {photos.length > 0
          ? `${photos.length}/${MAX_PHOTOS} fotos · La primera foto es la portada`
          : 'Agrega fotos claras del frente, los lados y los detalles importantes'}
      </p>
    </div>
  )
}

// ── Field helpers ─────────────────────────────────────────────────────────────

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null
  return <p className="text-[var(--danger)] text-xs mt-1 flex items-center gap-1"><i className="iconoir-warning-triangle" aria-hidden />{msg}</p>
}

function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-sm font-medium text-[var(--color-text)] mb-1.5">
      {children}
      {required && <span className="text-[var(--danger)] ml-0.5">*</span>}
    </label>
  )
}

function CharCount({ current, max }: { current: number; max: number }) {
  const near = current > max * 0.85
  const over = current > max
  return (
    <span className={`text-xs ${over ? 'text-[var(--danger)] font-medium' : near ? 'text-[var(--warning)]' : 'text-[var(--color-muted)]'}`}>
      {current}/{max}
    </span>
  )
}

// ── Step 1: Shop info ─────────────────────────────────────────────────────────

function StepShop({
  shopName, setShopName,
  shopSlug, setShopSlug, slugStatus, setSlugStatus,
  shopState, setShopState,
  shopCity, setShopCity,
  shopDescription, setShopDescription,
  errors,
  submitting,
  onNext,
}: {
  shopName: string; setShopName: (v: string) => void
  shopSlug: string; setShopSlug: (v: string) => void
  slugStatus: SlugStatus; setSlugStatus: (s: SlugStatus) => void
  shopState: string; setShopState: (v: string) => void
  shopCity: string; setShopCity: (v: string) => void
  shopDescription: string; setShopDescription: (v: string) => void
  errors: Record<string, string>
  submitting: boolean
  onNext: () => void
}) {
  const slugBlocked = slugStatus === 'taken' || slugStatus === 'invalid'
  return (
    <div className="space-y-5">
      {/* Shop name */}
      <div>
        <Label required>Nombre de tu tienda</Label>
        <input
          type="text"
          value={shopName}
          onChange={e => setShopName(e.target.value)}
          maxLength={80}
          placeholder="Ej: Automotriz García, Moda Oaxaca, Gadgets MX..."
          className={`w-full border rounded-[var(--r-sm)] px-3 py-2.5 text-sm bg-[var(--bg-elevated)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent transition ${
            errors.shopName ? 'border-[var(--danger)]' : 'border-[var(--color-border)]'
          }`}
          autoFocus
        />
        <div className="flex justify-between mt-1">
          <FieldError msg={errors.shopName} />
          <CharCount current={shopName.length} max={80} />
        </div>
        <p className="text-xs text-[var(--color-muted)] mt-1">
          Este nombre aparecerá en tu perfil público y en cada anuncio.
        </p>
      </div>

      {/* Shop URL (slug) — auto-suggested from the name, editable */}
      <div>
        <SlugField
          value={shopSlug}
          onChange={setShopSlug}
          onStatusChange={setSlugStatus}
          label="URL de tu tienda"
        />
        <p className="text-xs text-[var(--color-muted)] mt-1">
          Tu enlace para compartir. Lo puedes cambiar después en ajustes.
        </p>
      </div>

      {/* Location */}
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <Label required>Estado</Label>
          <select
            value={shopState}
            onChange={e => { setShopState(e.target.value); setShopCity('') }}
            className={`w-full border rounded-[var(--r-sm)] px-3 py-2.5 text-sm bg-[var(--bg-elevated)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent transition ${
              errors.shopState ? 'border-[var(--danger)]' : 'border-[var(--color-border)]'
            }`}
          >
            <option value="">Selecciona un estado</option>
            {ESTADOS.map(e => (
              <option key={e.inegi_code} value={e.name}>{e.name}</option>
            ))}
          </select>
          <FieldError msg={errors.shopState} />
        </div>
        <div>
          <Label>Municipio</Label>
          <select
            value={shopCity}
            onChange={e => setShopCity(e.target.value)}
            disabled={!shopState}
            className="w-full border border-[var(--color-border)] rounded-[var(--r-sm)] px-3 py-2.5 text-sm bg-[var(--bg-elevated)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">{shopState ? 'Municipio (opcional)' : 'Primero elige estado'}</option>
            {(CITIES_BY_STATE[shopState] ?? []).map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Description */}
      <div>
        <Label>Descripción de tu tienda <span className="text-[var(--color-muted)] font-normal">(opcional)</span></Label>
        <textarea
          value={shopDescription}
          onChange={e => setShopDescription(e.target.value)}
          maxLength={200}
          rows={3}
          placeholder="Cuéntale a tus compradores qué ofreces, tu especialidad, años de experiencia..."
          className="w-full border border-[var(--color-border)] rounded-[var(--r-sm)] px-3 py-2.5 text-sm bg-[var(--bg-elevated)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent transition resize-none"
        />
        <div className="flex justify-end mt-0.5">
          <CharCount current={shopDescription.length} max={200} />
        </div>
      </div>

      <button
        type="button"
        onClick={onNext}
        disabled={submitting || slugBlocked}
        className="btn btn-primary w-full"
      >
        {submitting ? 'Creando tu tienda…' : 'Continuar — Tu anuncio →'}
      </button>

      <p className="text-center text-xs text-[var(--color-muted)]">
        Creamos tu tienda al continuar — podrás personalizar el logo, colores y redes sociales más adelante.
      </p>
    </div>
  )
}

// ── Step 2: Listing form ──────────────────────────────────────────────────────

// ── REPUVE section (autos only) ───────────────────────────────────────────────

type RepuveStatus = 'sin_reporte' | 'con_reporte' | ''

function RepuveSection({
  status, setStatus,
  folio, setFolio,
}: {
  status: RepuveStatus; setStatus: (v: RepuveStatus) => void
  folio: string; setFolio: (v: string) => void
}) {
  const [pasteError, setPasteError] = useState('')

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText()
      const cleaned = text.trim().replace(/\s+/g, '').toUpperCase().slice(0, 40)
      setFolio(cleaned)
      setPasteError('')
    } catch {
      setPasteError('Activa el permiso de portapapeles en tu navegador.')
      setTimeout(() => setPasteError(''), 3000)
    }
  }

  return (
    <div className="border border-[var(--warning)] bg-[var(--warning-soft)] rounded-[var(--r-lg)] p-4 space-y-4">
      {/* Header */}
      <div className="flex items-start gap-3">
        <i className="iconoir-car text-2xl mt-0.5" aria-hidden />
        <div>
          <h3 className="font-semibold text-sm text-[var(--warning)]">Verificación REPUVE</h3>
          <p className="text-xs text-[var(--warning)] mt-0.5 leading-relaxed">
            El REPUVE es el Registro Público Vehicular del gobierno mexicano. Los compradores
            pueden consultar el estatus del vehículo antes de contactarte. Agrega el folio exacto del
            reporte para que puedan verificarlo.
          </p>
        </div>
      </div>

      {/* How-to link */}
      <a
        href="https://www.repuve.gob.mx/"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 text-xs font-semibold text-[var(--warning)] no-underline bg-[var(--warning-soft)] hover:bg-[var(--warning-soft)] border border-[var(--warning)] rounded-[var(--r-md)] px-3 py-2 transition-colors w-full"
      >
        <i className="iconoir-notes" aria-hidden />
        <span>Paso 1 — Consultar gratis en repuve.gob.mx →</span>
        <span className="ml-auto text-[var(--warning)] text-[10px] uppercase tracking-wide">Abre en nueva pestaña</span>
      </a>

      <p className="text-xs text-[var(--warning)]">
        <strong>Paso 2</strong> — Descarga el PDF del resultado. El folio aparece en la parte superior del documento.
      </p>

      {/* Status radio */}
      <div>
        <p className="text-xs font-medium text-[var(--warning)] mb-2">Paso 3 — ¿Qué dice el reporte?</p>
        <div className="grid grid-cols-2 gap-2">
          {([
            { key: 'sin_reporte', label: '✓ Sin reporte', hint: 'Vehículo limpio' },
            { key: 'con_reporte', label: '⚠ Con reporte',  hint: 'Robo u otro reporte' },
          ] as const).map(opt => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setStatus(opt.key)}
              className={`border rounded-[var(--r-md)] py-2.5 px-3 text-left transition-all ${
                status === opt.key
                  ? opt.key === 'sin_reporte'
                    ? 'border-[var(--success)] bg-[var(--success-soft)]'
                    : 'border-[var(--danger)] bg-[var(--danger-soft)]'
                  : 'border-[var(--warning)] bg-[var(--bg-elevated)] hover:border-[var(--warning)]'
              }`}
            >
              <p className={`text-sm font-semibold ${
                status === opt.key
                  ? opt.key === 'sin_reporte' ? 'text-[var(--success)]' : 'text-[var(--danger)]'
                  : 'text-[var(--warning)]'
              }`}>{opt.label}</p>
              <p className="text-xs text-[var(--warning)] mt-0.5">{opt.hint}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Folio input — only when status selected */}
      {status && (
        <div>
          <p className="text-xs font-medium text-[var(--warning)] mb-1.5">
            Paso 4 — Folio del reporte <span className="font-normal text-[var(--warning)]">(aparece en el PDF)</span>
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={folio}
              onChange={e => setFolio(e.target.value.toUpperCase().replace(/\s+/g, '').slice(0, 40))}
              placeholder="Ej: MX202600001234"
              className="flex-1 border border-[var(--warning)] rounded-[var(--r-md)] px-3 py-2 text-sm bg-[var(--bg-elevated)] focus:outline-none focus:ring-2 focus:ring-[var(--warning)] focus:border-transparent font-mono uppercase"
            />
            <button
              type="button"
              onClick={pasteFromClipboard}
              className="flex items-center gap-1.5 border border-[var(--warning)] rounded-[var(--r-md)] px-3 py-2 text-xs text-[var(--warning)] bg-[var(--bg-elevated)] hover:bg-[var(--warning-soft)] transition-colors whitespace-nowrap"
              title="Pegar desde portapapeles"
            >
              <i className="iconoir-paste-clipboard" aria-hidden /> Pegar
            </button>
          </div>
          {pasteError && <p className="text-[var(--danger)] text-xs mt-1">{pasteError}</p>}
        </div>
      )}

      {/* Skip option */}
      {!status && (
        <p className="text-xs text-[var(--warning)] text-center">
          Puedes agregar la verificación después desde tu panel de gestión.
        </p>
      )}
    </div>
  )
}

function StepListing({
  photos, setPhotos,
  title, setTitle,
  category, setCategory,
  listingType, setListingType,
  deliveryMode, setDeliveryMode,
  arrangedOnlyEnabled,
  ownedShopOnly, setOwnedShopOnly,
  ownedShopOnlyEnabled,
  condition, setCondition,
  quantity, setQuantity,
  seats, setSeats,
  priceRaw, setPriceRaw,
  priceOnRequest, setPriceOnRequest,
  description, setDescription,
  listingState, setListingState,
  listingCity, setListingCity,
  digitalFile, setDigitalFile,
  repuveStatus, setRepuveStatus,
  repuveFolio, setRepuveFolio,
  subTiers, setSubTiers,
  attrs, setAttr,
  errors,
  submitting,
  submitError,
  onBack,
  onSubmit,
  hasShopStep,
  currency,
}: {
  photos: UploadedPhoto[]; setPhotos: (fn: React.SetStateAction<UploadedPhoto[]>) => void
  title: string; setTitle: (v: string) => void
  category: string; setCategory: (v: string) => void
  listingType: ListingType; setListingType: (v: ListingType) => void
  deliveryMode: 'carrier' | 'arranged'; setDeliveryMode: (v: 'carrier' | 'arranged') => void
  arrangedOnlyEnabled: boolean
  /** "Solo mi tienda" — owned-shop-operating-channel epic, S3.1. */
  ownedShopOnly: boolean; setOwnedShopOnly: (v: boolean) => void
  /** catalog.owned_shop_only_enabled (D8) — gates whether the checkbox renders at all. */
  ownedShopOnlyEnabled: boolean
  condition: Condition; setCondition: (v: Condition) => void
  quantity: string; setQuantity: (v: string) => void
  seats: string; setSeats: (v: string) => void
  priceRaw: string; setPriceRaw: (v: string) => void
  priceOnRequest: boolean; setPriceOnRequest: (v: boolean) => void
  description: string; setDescription: (v: string) => void
  listingState: string; setListingState: (v: string) => void
  listingCity: string; setListingCity: (v: string) => void
  digitalFile: DigitalFile | null; setDigitalFile: (f: DigitalFile | null) => void
  repuveStatus: RepuveStatus; setRepuveStatus: (v: RepuveStatus) => void
  repuveFolio: string; setRepuveFolio: (v: string) => void
  subTiers: { id: string; label: string; price_raw: string; interval: 'month' | 'year'; features_raw: string; is_highlighted: boolean }[]
  setSubTiers: React.Dispatch<React.SetStateAction<{ id: string; label: string; price_raw: string; interval: 'month' | 'year'; features_raw: string; is_highlighted: boolean }[]>>
  attrs: Attrs; setAttr: (k: string, v: string) => void
  errors: Record<string, string>
  submitting: boolean
  submitError: string | null
  onBack: () => void
  onSubmit: () => void
  hasShopStep: boolean
  currency: string
}) {
  const [digitalUploading, setDigitalUploading] = useState(false)
  const digitalInputRef = useRef<HTMLInputElement>(null)
  const pendingUploads = photos.filter(p => p.status === 'uploading').length
  const failedUploads = photos.filter(p => p.status === 'error').length
  const canSubmit = !submitting && pendingUploads === 0 && failedUploads === 0 && !digitalUploading

  // Submit button copy depending on state
  let btnLabel = '✓ Publicar anuncio'
  if (submitting) btnLabel = 'Publicando…'
  else if (pendingUploads > 0) btnLabel = `Subiendo ${pendingUploads} foto${pendingUploads > 1 ? 's' : ''}…`
  else if (failedUploads > 0) btnLabel = `${failedUploads} foto${failedUploads > 1 ? 's' : ''} con error — corrige antes de publicar`

  return (
    <div className="space-y-6">
      {/* Global error banner */}
      {submitError && (
        <Banner variant="danger" title="No se pudo publicar">
          {submitError}
        </Banner>
      )}

      {/* Photos */}
      <div>
        <Label>Fotos</Label>
        <PhotoUploader
          photos={photos}
          onChange={useCallback((fn) => setPhotos(typeof fn === 'function' ? fn : () => fn), [setPhotos])}
        />
        {failedUploads > 0 && (
          <p className="text-[var(--danger)] text-xs mt-1.5 flex items-center gap-1">
            <i className="iconoir-warning-triangle" aria-hidden /> {failedUploads} foto{failedUploads > 1 ? 's' : ''} no se pudo subir — toca la foto roja para eliminarla y agrega una nueva.
          </p>
        )}
      </div>

      {/* Title */}
      <div>
        <Label required>Título del anuncio</Label>
        <input
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          maxLength={100}
          placeholder="Ej: iPhone 14 Pro 256 GB negro espacial, Toyota Corolla 2021, Clases de guitarra..."
          className={`w-full border rounded-[var(--r-sm)] px-3 py-2.5 text-sm bg-[var(--bg-elevated)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent transition ${
            errors.title ? 'border-[var(--danger)]' : 'border-[var(--color-border)]'
          }`}
        />
        <div className="flex justify-between mt-1">
          <FieldError msg={errors.title} />
          <CharCount current={title.length} max={100} />
        </div>
        <p className="text-xs text-[var(--color-muted)] mt-1">Sé específico: marca, modelo, características importantes. Mejora la visibilidad en búsquedas.</p>
      </div>

      {/* Category */}
      <div>
        <Label required>Categoría</Label>
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {CATEGORIES.map(cat => (
            <button
              key={cat.key}
              type="button"
              onClick={() => setCategory(cat.key)}
              className={`border rounded-[var(--r-md)] py-2 px-1 text-xs text-center flex flex-col items-center gap-1 transition-all ${
                category === cat.key
                  ? 'border-[var(--color-accent)] bg-[var(--accent-soft)] text-[var(--color-accent)] font-semibold'
                  : 'border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]'
              }`}
            >
              <i className={`iconoir-${cat.icon} leading-none`} style={{ fontSize: 18 }} aria-hidden />
              <span className="leading-tight">{cat.label}</span>
            </button>
          ))}
        </div>
        <FieldError msg={errors.category} />
      </div>

      {/* Listing type */}
      <div>
        <Label>Tipo de anuncio</Label>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {([
            { key: 'product',      label: '📦 Producto',     hint: 'Artículo físico' },
            { key: 'service',      label: '🔧 Servicio',     hint: 'Clases, reparaciones…' },
            { key: 'rental',       label: '🔑 Renta',        hint: 'Alquiler por tiempo' },
            { key: 'digital',      label: '💻 Digital',      hint: 'PDF, ZIP, MP3, video, plantillas…' },
            { key: 'subscription', label: '🔔 Suscripción',  hint: 'Contenido mensual / acceso recurrente' },
          ] as const).map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => setListingType(t.key)}
              title={t.hint}
              className={`border rounded-[var(--r-md)] py-2.5 text-sm transition-all ${
                listingType === t.key
                  ? 'border-[var(--color-accent)] bg-[var(--accent-soft)] text-[var(--color-accent)] font-semibold'
                  : 'border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-accent)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {listingType === 'digital' && (
          <p className="text-xs text-[var(--color-muted)] mt-1.5">
            <i className="iconoir-light-bulb" aria-hidden /> Entrega automática al comprar — el comprador recibe su archivo al instante.
          </p>
        )}
        {listingType === 'subscription' && (
          <p className="text-xs text-[var(--color-muted)] mt-1.5">
            <i className="iconoir-bell" aria-hidden /> Los suscriptores pagan mensual o anualmente y acceden a tu biblioteca de contenido exclusivo.
          </p>
        )}
      </div>

      {/* Entrega (arranged-only delivery, epic S1.2) — 'servicio'/'renta' always
          coordinate; only 'producto' gets an independent choice, and only once
          the flag is on. */}
      {(listingType === 'service' || listingType === 'rental') && (
        <p className="text-xs text-[var(--color-muted)]">
          <i className="iconoir-community" aria-hidden /> Este tipo de anuncio siempre coordina la entrega directamente con el comprador.
        </p>
      )}
      {arrangedOnlyEnabled && listingType === 'product' && (
        <div>
          <Label>Entrega</Label>
          <div className="grid grid-cols-2 gap-2">
            {([
              { key: 'carrier' as const,  label: '📦 Paquetería',           hint: 'Envío a domicilio o recolección' },
              { key: 'arranged' as const, label: '🤝 Acordada con el comprador', hint: 'Sin paquetería — coordinas fecha, lugar y pago' },
            ]).map(t => (
              <button
                key={t.key}
                type="button"
                onClick={() => setDeliveryMode(t.key)}
                title={t.hint}
                className={`border rounded-[var(--r-md)] py-2.5 text-sm transition-all ${
                  deliveryMode === t.key
                    ? 'border-[var(--color-accent)] bg-[var(--accent-soft)] text-[var(--color-accent)] font-semibold'
                    : 'border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-accent)]'
                }`}
              >
                {t.label}
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

      {/* "Solo mi tienda" (owned-shop-operating-channel epic, S3.1) — publish_to_market:
          null. Gated on catalog.owned_shop_only_enabled (D8): with the flag off this
          renders nothing, and the create payload never sends the field, so the
          request is byte-identical to before this sprint. Unchecked (the default)
          publishes into the marketplace exactly as today — this never offers a
          market picker, so it can't be used to reach `us` (AGENTS rule "no general
          seller UI offers US marketplace publication"). */}
      {ownedShopOnlyEnabled && (
        <div>
          <label className="flex min-h-11 items-start gap-2 cursor-pointer py-1">
            <input
              type="checkbox"
              checked={ownedShopOnly}
              onChange={e => setOwnedShopOnly(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="text-sm font-medium text-[var(--color-text)]">Solo mi tienda</span>
              <p className="text-xs text-[var(--color-muted)] mt-0.5">
                No se publicará en el marketplace de México — seguirá comprable en tu propia tienda.
                Puedes publicarlo al marketplace más tarde desde tu catálogo.
              </p>
            </span>
          </label>
        </div>
      )}

      {/* Multi-tier subscription builder */}
      {listingType === 'subscription' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-[var(--color-text)]"><i className="iconoir-settings" aria-hidden /> Planes de suscripción</p>
            {subTiers.length < 3 && (
              <button
                type="button"
                onClick={() => setSubTiers(prev => [...prev, { id: Math.random().toString(36).slice(2), label: '', price_raw: '', interval: 'month', features_raw: '', is_highlighted: false }])}
                className="text-xs text-[var(--color-accent)] border border-[var(--color-accent)] px-2.5 py-1 rounded-[var(--r-md)] hover:bg-[var(--accent-soft)] transition-colors"
              >
                + Agregar plan
              </button>
            )}
          </div>
          <FieldError msg={errors.subscription_tiers} />

          {subTiers.map((tier, idx) => (
            <div key={tier.id} className={`border rounded-[var(--r-lg)] p-4 space-y-3 ${tier.is_highlighted ? 'border-[var(--color-accent)] bg-[var(--accent-soft)]' : 'border-[var(--color-border)] bg-[var(--color-background)]'}`}>
              {/* Header */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-[var(--color-muted)] uppercase tracking-wide">Plan {idx + 1}</span>
                <div className="flex items-center gap-2">
                  <label className="flex min-h-11 items-center gap-1.5 cursor-pointer px-1">
                    <input
                      type="checkbox"
                      checked={tier.is_highlighted}
                      onChange={e => setSubTiers(prev => prev.map(t => t.id === tier.id ? { ...t, is_highlighted: e.target.checked } : { ...t, is_highlighted: false }))}
                      className="w-3.5 h-3.5 accent-[var(--color-accent)]"
                    />
                    <span className="text-xs text-[var(--color-muted)]">Destacado</span>
                  </label>
                  {subTiers.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setSubTiers(prev => prev.filter(t => t.id !== tier.id))}
                      className="inline-flex min-h-11 items-center gap-1 px-2 text-xs text-[var(--danger)] hover:text-[var(--danger)]"
                    >
                      <i className="iconoir-xmark" aria-hidden /> Quitar
                    </button>
                  )}
                </div>
              </div>

              {/* Label + price row */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text)] mb-1">Nombre del plan <span className="text-[var(--danger)]">*</span></label>
                  <input
                    type="text"
                    value={tier.label}
                    onChange={e => setSubTiers(prev => prev.map(t => t.id === tier.id ? { ...t, label: e.target.value } : t))}
                    placeholder="Ej: Básico, Pro, Premium"
                    maxLength={40}
                    className="w-full border border-[var(--color-border)] rounded-[var(--r-sm)] px-2.5 py-2 text-sm bg-[var(--bg-elevated)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text)] mb-1">Precio <span className="text-[var(--danger)]">*</span></label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={tier.price_raw}
                    onChange={e => setSubTiers(prev => prev.map(t => t.id === tier.id ? { ...t, price_raw: e.target.value } : t))}
                    placeholder="199"
                    className="w-full border border-[var(--color-border)] rounded-[var(--r-sm)] px-2.5 py-2 text-sm bg-[var(--bg-elevated)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent"
                  />
                </div>
              </div>

              {/* Interval */}
              <div className="grid grid-cols-2 gap-2">
                {([
                  { key: 'month', label: '📅 Mensual' },
                  { key: 'year',  label: '🗓️ Anual' },
                ] as const).map(opt => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setSubTiers(prev => prev.map(t => t.id === tier.id ? { ...t, interval: opt.key } : t))}
                    className={`border rounded-[var(--r-md)] py-2 text-xs transition-all ${
                      tier.interval === opt.key
                        ? 'border-[var(--color-accent)] bg-[var(--accent-soft)] text-[var(--color-accent)] font-semibold'
                        : 'border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-accent)]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {/* Features */}
              <div>
                <label className="block text-xs font-medium text-[var(--color-text)] mb-1">¿Qué incluye? <span className="text-[var(--color-muted)] font-normal">(una por línea)</span></label>
                <textarea
                  value={tier.features_raw}
                  onChange={e => setSubTiers(prev => prev.map(t => t.id === tier.id ? { ...t, features_raw: e.target.value } : t))}
                  rows={3}
                  placeholder={'Recetas semanales exclusivas\nClases en vivo mensuales\nDescuentos de miembro'}
                  className="w-full border border-[var(--color-border)] rounded-[var(--r-sm)] px-2.5 py-2 text-sm bg-[var(--bg-elevated)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent resize-none"
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Digital file uploader */}
      {listingType === 'digital' && (
        <div>
          <Label required>Archivo digital</Label>
          {digitalFile ? (
            <div className="flex items-center gap-3 p-3 border border-[var(--success)] bg-[var(--success-soft)] rounded-[var(--r-md)]">
              <i className="iconoir-page text-2xl" aria-hidden />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{digitalFile.name}</div>
                <div className="text-xs text-[var(--color-muted)]">
                  {digitalFile.label} · {(digitalFile.size / 1024 / 1024).toFixed(1)} MB
                </div>
              </div>
              <button type="button" onClick={() => setDigitalFile(null)}
                className="text-xs text-[var(--danger)] hover:underline flex-shrink-0">
                Cambiar
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => digitalInputRef.current?.click()}
              disabled={digitalUploading}
              className={`w-full border-2 border-dashed border-[var(--color-border)] rounded-[var(--r-md)] py-8 flex flex-col items-center gap-2 transition-colors ${
                digitalUploading ? 'opacity-60 cursor-not-allowed' : 'hover:border-[var(--color-accent)] cursor-pointer'
              }`}
            >
              <i className={`text-3xl ${digitalUploading ? 'iconoir-hourglass' : 'iconoir-folder'}`} aria-hidden />
              <span className="text-sm font-medium">
                {digitalUploading ? 'Subiendo archivo…' : 'Haz clic para seleccionar el archivo'}
              </span>
              <span className="text-xs text-[var(--color-muted)]">
                PDF, ZIP, MP3, MP4, EPUB y más · máx. 100 MB
              </span>
            </button>
          )}
          <input
            ref={digitalInputRef}
            type="file"
            className="hidden"
            onChange={async e => {
              const file = e.target.files?.[0]
              if (!file) return
              e.target.value = ''
              setDigitalUploading(true)
              try {
                const fd = new FormData()
                fd.append('file', file)
                const res = await fetch('/api/sell/digital-upload', { method: 'POST', body: fd })
                const data = await res.json() as DigitalFile & { error?: string }
                if (!res.ok || data.error) {
                  // surfaced via errors.digitalFile
                  setDigitalFile(null)
                } else {
                  setDigitalFile({ path: data.path, name: data.name, size: data.size, mime: data.mime, label: data.label })
                }
              } catch {
                // no-op — user retries
              } finally {
                setDigitalUploading(false)
              }
            }}
          />
          <FieldError msg={errors.digitalFile} />
        </div>
      )}

      {/* Category-specific attributes (brand, size, year, etc.) */}
      {category && (
        <AttrsSection
          category={category}
          listingType={listingType}
          attrs={attrs}
          setAttr={setAttr}
          seats={seats}
          setSeats={setSeats}
          seatsError={errors.seats}
        />
      )}

      {/* Condition (only for products) */}
      {listingType === 'product' && (
        <div>
          <Label>Estado del artículo</Label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {CONDITIONS.map(c => (
              <button
                key={c.key}
                type="button"
                onClick={() => setCondition(c.key)}
                title={c.hint}
                className={`border rounded-[var(--r-md)] py-2 px-3 text-left transition-all ${
                  condition === c.key
                    ? 'border-[var(--color-accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--color-border)] hover:border-[var(--color-accent)]'
                }`}
              >
                <p className={`text-sm font-medium ${condition === c.key ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'}`}>
                  {c.label}
                </p>
                <p className="text-xs text-[var(--color-muted)] mt-0.5">{c.hint}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Cantidad (stock) — only for physical products. Default 1 (artículo único). */}
      {listingType === 'product' && (
        <div>
          <Label>Cantidad disponible</Label>
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value.replace(/[^0-9]/g, ''))}
            onBlur={() => setQuantity(String(Math.max(1, parseInt(quantity) || 1)))}
            className="w-32 border rounded-[var(--r-sm)] px-3 py-2.5 focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent transition"
          />
          <p className="text-xs text-[var(--color-muted)] mt-1">
            Para artículos únicos deja 1. Al venderse, el anuncio se marca como agotado automáticamente.
          </p>
        </div>
      )}

      {/* Price — hidden for subscription (price is per-tier in the builder above) */}
      <div className={listingType === 'subscription' ? 'hidden' : ''}>
        <Label required={!priceOnRequest}>Precio</Label>
        <div className="flex gap-2 items-start">
          <div className="flex-1">
            <div className="flex items-center border rounded-[var(--r-sm)] overflow-hidden focus-within:ring-2 focus-within:ring-[var(--color-accent)] focus-within:border-transparent transition">
              <span className="px-3 text-[var(--color-muted)] text-sm border-r border-[var(--color-border)] py-2.5 bg-[var(--color-background)] shrink-0">
                {currency} $
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={priceRaw}
                disabled={priceOnRequest}
                onChange={e => {
                  // Allow digits, commas, one decimal point
                  const v = e.target.value.replace(/[^0-9.,]/g, '')
                  setPriceRaw(v)
                }}
                placeholder={priceOnRequest ? 'Precio a consultar' : '0.00'}
                className={`flex-1 px-3 py-2.5 text-sm bg-[var(--bg-elevated)] focus:outline-none disabled:bg-[var(--color-background)] disabled:text-[var(--color-muted)] ${
                  errors.price ? 'border-[var(--danger)]' : ''
                }`}
              />
            </div>
            <FieldError msg={errors.price} />
          </div>
        </div>
        <label className="flex min-h-11 items-center gap-2 mt-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={priceOnRequest}
            onChange={e => {
              setPriceOnRequest(e.target.checked)
              if (e.target.checked) setPriceRaw('')
            }}
            className="w-4 h-4 accent-[var(--color-accent)]"
          />
          <span className="text-sm text-[var(--color-text)]">Precio a consultar</span>
          <span className="text-xs text-[var(--color-muted)]">(el comprador te contacta)</span>
        </label>
      </div>

      {/* Description */}
      <div>
        <Label>Descripción <span className="text-[var(--color-muted)] font-normal">(opcional pero recomendada)</span></Label>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          maxLength={2000}
          rows={5}
          placeholder={
            listingType === 'product'
              ? 'Describe el estado, medidas, accesorios incluidos, motivo de venta...'
              : listingType === 'service'
              ? 'Describe tu experiencia, metodología, qué incluye el servicio, horarios...'
              : 'Describe el inmueble/artículo, condiciones de renta, qué incluye...'
          }
          className="w-full border border-[var(--color-border)] rounded-[var(--r-sm)] px-3 py-2.5 text-sm bg-[var(--bg-elevated)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent transition resize-none"
        />
        <div className="flex justify-between mt-0.5">
          <p className="text-xs text-[var(--color-muted)]">Incluye estado, medidas, accesorios y condiciones de entrega.</p>
          <CharCount current={description.length} max={2000} />
        </div>
      </div>

      {/* Location */}
      <div>
        <Label>Ubicación del anuncio</Label>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <select
              value={listingState}
              onChange={e => { setListingState(e.target.value); setListingCity('') }}
              className="w-full border border-[var(--color-border)] rounded-[var(--r-sm)] px-3 py-2.5 text-sm bg-[var(--bg-elevated)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent transition"
            >
              <option value="">Estado (opcional)</option>
              {ESTADOS.map(e => (
                <option key={e.inegi_code} value={e.name}>{e.name}</option>
              ))}
            </select>
          </div>
          <div>
            <select
              value={listingCity}
              onChange={e => setListingCity(e.target.value)}
              disabled={!listingState}
              className="w-full border border-[var(--color-border)] rounded-[var(--r-sm)] px-3 py-2.5 text-sm bg-[var(--bg-elevated)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="">{listingState ? 'Municipio (opcional)' : 'Primero elige estado'}</option>
              {(CITIES_BY_STATE[listingState] ?? []).map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>
        <p className="text-xs text-[var(--color-muted)] mt-1">Ayuda a compradores cercanos a encontrarte.</p>
      </div>

      {/* REPUVE — only for autos */}
      {category === 'autos' && (
        <RepuveSection
          status={repuveStatus}
          setStatus={setRepuveStatus}
          folio={repuveFolio}
          setFolio={setRepuveFolio}
        />
      )}

      {/* Actions */}
      <div className="flex gap-3 pt-2">
        {hasShopStep && (
          <button
            type="button"
            onClick={onBack}
            disabled={submitting}
            className="btn btn-secondary flex-1"
          >
            ← Atrás
          </button>
        )}
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
          className="btn btn-primary flex-1"
        >
          {btnLabel}
        </button>
      </div>

      <p className="text-xs text-[var(--color-muted)] text-center">
        Tu anuncio se publicará de inmediato y será visible para todos los compradores.
      </p>

      {/* Escape hatch — shop is already created, so the dashboard is reachable now */}
      <p className="text-xs text-center">
        <a href="/shop/manage" className="text-[var(--color-muted)] hover:text-[var(--color-accent)] no-underline">
          Terminar después — ir a mi tienda →
        </a>
      </p>
    </div>
  )
}

// ── Step 3: Success (F12 convergence — shared <SuccessCard>, Sprint 2 · Story 2.2) ──
// The per-listing photo/price preview this step rendered before is dropped in
// favor of the identical SuccessCard layout every setup path now ends on —
// intentional per F12 (same layout beats a richer one-off preview here).

function StepSuccess({
  result,
  onPublishAnother,
}: {
  result: { shopSlug: string; listingId: string }
  onPublishAnother: () => void
}) {
  // This card shares the free marketplace presence, even when a seller reached
  // the wizard through their custom domain. Tenant middleware rejects `/mx/*`,
  // so never combine the canonical platform path with the ambient origin.
  const publicShopUrl = shopUrlFor(SITE_ORIGIN, result.shopSlug)

  return (
    <SuccessCard
      headline="¡Tu anuncio está publicado!"
      subcopy="Ya está visible para compradores en todo México."
      counts={{ created: 1, updated: 0, failed: 0, draft: 0 }}
      liveUrl={publicShopUrl}
      liveLabel="Ver mi tienda pública ↗"
      nextActions={[
        { label: 'Ver mi anuncio', href: listingUrlFor(SITE_ORIGIN, result.listingId) },
        { label: '+ Publicar otro anuncio', onClick: onPublishAnother },
      ]}
      shareUrl={publicShopUrl}
    />
  )
}

// ── Main wizard ───────────────────────────────────────────────────────────────

export default function SellWizard({
  existingShop,
  arrangedOnlyEnabled = false,
  ownedShopOnlyEnabled = false,
  signupMarket,
}: {
  existingShop: ExistingShop | null
  /** Arranged-only delivery (epic, S1.2) — gates the "Entrega" toggle's visibility. */
  arrangedOnlyEnabled?: boolean
  /** catalog.owned_shop_only_enabled (owned-shop-operating-channel epic, D8) — gates the "Solo mi tienda" checkbox. */
  ownedShopOnlyEnabled?: boolean
  /**
   * The market this merchant is signing up from (us-marketplace S5.2 / D17), resolved
   * by the server page. Sent with the shop create; the API route narrows it and the
   * backend is the authority. Undefined ⇒ the documented MX legacy default.
   */
  signupMarket?: string
}) {
  const hasShopStep = existingShop === null
  const listingMarket = existingShop?.market ?? resolveSellerSignupMarket(signupMarket) ?? DEFAULT_MARKET
  const listingCurrency = MARKETS[listingMarket].currency_code.toUpperCase()
  const initialStep = hasShopStep ? 1 : 2

  // Navigation
  const [step, setStep] = useState<1 | 2 | 3>(initialStep as 1 | 2 | 3)

  // Step 1 — shop
  const [shopName, setShopName] = useState('')
  const [shopSlug, setShopSlug] = useState('')
  const [slugStatus, setSlugStatus] = useState<SlugStatus>('idle')
  const slugTouched = useRef(false)
  const [shopState, setShopState] = useState('')
  const [shopCity, setShopCity] = useState('')
  const [shopDescription, setShopDescription] = useState('')
  const [shopErrors, setShopErrors] = useState<Record<string, string>>({})
  const [creatingShop, setCreatingShop] = useState(false)

  // Auto-suggest the slug from the shop name until the seller edits it directly.
  useEffect(() => {
    if (!slugTouched.current) setShopSlug(slugify(shopName))
  }, [shopName])
  function handleSlugChange(v: string) { slugTouched.current = true; setShopSlug(v) }

  // Step 2 — listing
  const [photos, setPhotos] = useState<UploadedPhoto[]>([])
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState('')
  const [listingType, setListingType] = useState<ListingType>('product')
  // Arranged-only delivery (epic, S1.2) — 'carrier' (default) or 'arranged'.
  const [deliveryMode, setDeliveryMode] = useState<'carrier' | 'arranged'>('carrier')
  // "Solo mi tienda" (owned-shop-operating-channel epic, S3.1) — unchecked by
  // default, so an untouched form publishes into the marketplace exactly as
  // before this sprint.
  const [ownedShopOnly, setOwnedShopOnly] = useState(false)
  const [condition, setCondition] = useState<Condition>('good')
  const [quantity, setQuantity] = useState('1')
  // Event seats («Lugares disponibles») — empty means untracked, exactly as before this field existed.
  const [seats, setSeats] = useState('')
  const [priceRaw, setPriceRaw] = useState('')
  const [priceOnRequest, setPriceOnRequest] = useState(false)
  const [description, setDescription] = useState('')
  const [listingState, setListingState] = useState(existingShop?.location?.split(', ').pop() ?? '')
  const [listingCity, setListingCity] = useState('')
  const [digitalFile, setDigitalFile] = useState<DigitalFile | null>(null)
  const [repuveStatus, setRepuveStatus] = useState<RepuveStatus>('')
  const [repuveFolio, setRepuveFolio] = useState('')
  // Category-specific structured attributes (brand, size, year, km…)
  const [attrs, setAttrs] = useState<Attrs>({})
  function setAttr(k: string, v: string) {
    setAttrs(prev => ({ ...prev, [k]: v }))
  }
  // Multi-tier subscription state (Phase B)
  interface SubTier {
    id: string
    label: string
    price_raw: string
    interval: 'month' | 'year'
    features_raw: string   // newline-separated list
    is_highlighted: boolean
  }
  const initialTierId = useId()
  const makeDefaultTier = (id: string): SubTier => ({
    id,
    label: '',
    price_raw: '',
    interval: 'month',
    features_raw: '',
    is_highlighted: false,
  })
  const [subTiers, setSubTiers] = useState<SubTier[]>([makeDefaultTier(initialTierId)])
  const [listingErrors, setListingErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Step 3 — result
  const [result, setResult] = useState<{ shopSlug: string; listingId: string } | null>(null)

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleShopNext() {
    const errs: Record<string, string> = {}
    if (shopName.trim().length < 2) errs.shopName = 'El nombre debe tener al menos 2 caracteres.'
    if (shopName.trim().length > 80) errs.shopName = 'El nombre no puede superar los 80 caracteres.'
    if (!shopState) errs.shopState = 'Selecciona tu estado.'
    setShopErrors(errs)
    if (Object.keys(errs).length > 0) return

    // Persist the shop now so it survives an abandoned listing — decouples shop
    // creation from listing creation. Idempotent on the server.
    setCreatingShop(true)
    try {
      const res = await fetch('/api/sell/shop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: shopName.trim(),
          slug: shopSlug.trim() || undefined,
          state: shopState,
          city: shopCity.trim() || undefined,
          description: shopDescription.trim() || undefined,
          // Where this merchant is signing up FROM (D17). The route narrows it to a
          // real, open market and the backend refuses anything it does not like, so
          // this is an intent, not an assertion. Omitted ⇒ the MX legacy default.
          market: signupMarket,
        }),
      })
      const data = await res.json() as { shopSlug?: string; error?: string; field?: string }
      if (!res.ok || !data.shopSlug) {
        setShopErrors({ shopName: data.error ?? 'No se pudo crear la tienda. Inténtalo de nuevo.' })
        return
      }
      setStep(2)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch {
      setShopErrors({ shopName: 'Sin conexión. Inténtalo de nuevo.' })
    } finally {
      setCreatingShop(false)
    }
  }

  function handleBack() {
    setStep(1)
    setSubmitError(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function handleSubmit() {
    // Validate listing fields
    const errs: Record<string, string> = {}
    if (title.trim().length < 5) errs.title = 'El título debe tener al menos 5 caracteres.'
    if (title.trim().length > 100) errs.title = 'El título no puede superar los 100 caracteres.'
    if (!category) errs.category = 'Selecciona una categoría para tu anuncio.'
    if (listingType !== 'subscription' && !priceOnRequest && !priceRaw.trim()) {
      errs.price = 'Ingresa un precio o marca "Precio a consultar".'
    }
    if (listingType !== 'subscription' && !priceOnRequest && priceRaw) {
      const cents = parsePriceCents(priceRaw)
      if (!cents || cents <= 0) errs.price = 'El precio debe ser mayor a $0.'
    }
    if (listingType === 'digital' && !digitalFile) {
      errs.digitalFile = 'Sube el archivo que los compradores recibirán al pagar.'
    }
    if (listingType === 'subscription') {
      for (const t of subTiers) {
        if (!t.label.trim()) { errs.subscription_tiers = 'Cada plan necesita un nombre.'; break }
        if (!parsePriceCents(t.price_raw)) { errs.subscription_tiers = `El plan "${t.label || 'sin nombre'}" necesita un precio válido.`; break }
      }
    }
    const seatsResult = seatsForWrite({ listingType, attrs, seatsRaw: seats })
    if (!seatsResult.ok) errs.seats = seatsResult.error
    setListingErrors(errs)
    if (Object.keys(errs).length > 0) {
      // A bad seat count is the only error that is far from the top: bring the field into view.
      if (errs.seats && Object.keys(errs).length === 1) {
        requestAnimationFrame(() => document.getElementById('event-seats')?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' })
      }
      return
    }

    setSubmitting(true)
    setSubmitError(null)

    try {
      const priceCents = priceOnRequest ? null : parsePriceCents(priceRaw)
      const readyPhotos = photos.filter(p => p.status === 'done' && p.remoteUrl)
        .map(p => ({ url: p.remoteUrl!, alt: title.trim() }))

      const payload = {
        createShop: hasShopStep
          ? { name: shopName.trim(), slug: shopSlug.trim() || undefined, state: shopState, city: shopCity.trim() || undefined, description: shopDescription.trim() || undefined, market: signupMarket }
          : undefined,
        listing: {
          title: title.trim(),
          description: description.trim() || undefined,
          price_cents: priceCents,
          currency: listingCurrency,
          condition: listingType === 'product' ? condition : undefined,
          // Products: units (>= 1). An event with its block filled: «Lugares disponibles».
          quantity: listingType === 'product'
            ? Math.max(1, parseInt(quantity) || 1)
            : seatsResult.ok ? seatsResult.quantity : undefined,
          listing_type: listingType,
          // Arranged-only delivery (epic, S1.2) — backend forces 'arranged' for
          // service/rental regardless of this value. Defense-in-depth: only ever
          // send 'arranged' when the flag is actually on, so a future code path
          // that sets `deliveryMode` without checking the flag can't submit it.
          delivery_mode: arrangedOnlyEnabled ? deliveryMode : 'carrier',
          // "Solo mi tienda" (owned-shop-operating-channel epic, S3.1) — only ever
          // sent when the flag is on AND the seller checked the box; `undefined`
          // (omitted key) preserves today's default-publish behaviour exactly,
          // same defense-in-depth shape as `delivery_mode` above.
          publish_to_market: createPublishToMarket(ownedShopOnlyEnabled && ownedShopOnly),
          category,
          state: listingState || undefined,
          estado_code: listingState ? ESTADO_INEGI_BY_NAME[listingState] : undefined,
          municipio: listingCity.trim() || undefined,
          // Non-empty attrs only (strip blank strings)
          attrs: Object.fromEntries(
            Object.entries(attrs).filter(([, v]) => v !== '' && v !== null && v !== undefined)
          ),
          images: readyPhotos,
          digital_file: digitalFile ?? undefined,
          repuve: repuveStatus ? { status: repuveStatus, folio: repuveFolio || undefined } : undefined,
          subscription_tiers: listingType === 'subscription' ? subTiers.map(t => ({
            id: t.id,
            label: t.label.trim(),
            price_cents: parsePriceCents(t.price_raw)!,
            interval: t.interval,
            features: t.features_raw.split('\n').map(s => s.trim()).filter(Boolean),
            is_highlighted: t.is_highlighted,
          })) : undefined,
        },
      }

      const res = await fetch('/api/sell/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const data = await res.json() as { shopSlug?: string; listingId?: string; error?: string; field?: string }

      if (!res.ok || !data.shopSlug || !data.listingId) {
        if (data.field === 'title') setListingErrors(prev => ({ ...prev, title: data.error! }))
        else if (data.field === 'category') setListingErrors(prev => ({ ...prev, category: data.error! }))
        else if (data.field === 'shopName') { setShopErrors(prev => ({ ...prev, shopName: data.error! })); setStep(1) }
        else setSubmitError(data.error ?? 'Algo salió mal. Inténtalo de nuevo.')
        window.scrollTo({ top: 0, behavior: 'smooth' })
        return
      }

      setResult({ shopSlug: data.shopSlug, listingId: data.listingId })
      setStep(3)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch {
      setSubmitError('Sin conexión. Verifica tu internet e inténtalo de nuevo.')
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } finally {
      setSubmitting(false)
    }
  }

  function handlePublishAnother() {
    // Reset listing fields, keep shop fields
    setPhotos([])
    setTitle('')
    setCategory('')
    setListingType('product')
    setCondition('good')
    setOwnedShopOnly(false)
    setAttrs({})
    setSubTiers([{ id: Math.random().toString(36).slice(2), label: '', price_raw: '', interval: 'month', features_raw: '', is_highlighted: false }])
    setPriceRaw('')
    setPriceOnRequest(false)
    setDescription('')
    setListingErrors({})
    setSubmitError(null)
    setResult(null)
    setStep(2)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      {/* Header */}
      {step !== 3 && (
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-[var(--color-text)]">
            {step === 1 ? 'Crea tu tienda' : 'Publica tu anuncio'}
          </h1>
          <p className="text-[var(--color-muted)] text-sm mt-1">
            {step === 1
              ? 'Es gratis y tarda menos de 2 minutos.'
              : existingShop
              ? `Publicando en: ${existingShop.name}`
              : 'Completa los datos de tu anuncio.'}
          </p>
        </div>
      )}

      {/* Progress */}
      <ProgressSteps step={step} hasShopStep={hasShopStep} />

      {/* Card */}
      <div className="bg-[var(--bg-elevated)] border border-[var(--color-border)] rounded-[var(--r-lg)] p-5 sm:p-7">
        {step === 1 && (
          <StepShop
            shopName={shopName} setShopName={setShopName}
            shopSlug={shopSlug} setShopSlug={handleSlugChange}
            slugStatus={slugStatus} setSlugStatus={setSlugStatus}
            shopState={shopState} setShopState={setShopState}
            shopCity={shopCity} setShopCity={setShopCity}
            shopDescription={shopDescription} setShopDescription={setShopDescription}
            errors={shopErrors}
            submitting={creatingShop}
            onNext={handleShopNext}
          />
        )}
        {step === 2 && (
          <StepListing
            photos={photos} setPhotos={setPhotos}
            title={title} setTitle={setTitle}
            category={category} setCategory={setCategory}
            listingType={listingType} setListingType={setListingType}
            deliveryMode={deliveryMode} setDeliveryMode={setDeliveryMode}
            arrangedOnlyEnabled={arrangedOnlyEnabled}
            ownedShopOnly={ownedShopOnly} setOwnedShopOnly={setOwnedShopOnly}
            ownedShopOnlyEnabled={ownedShopOnlyEnabled}
            condition={condition} setCondition={setCondition}
            quantity={quantity} setQuantity={setQuantity}
            seats={seats} setSeats={setSeats}
            priceRaw={priceRaw} setPriceRaw={setPriceRaw}
            priceOnRequest={priceOnRequest} setPriceOnRequest={setPriceOnRequest}
            description={description} setDescription={setDescription}
            listingState={listingState} setListingState={setListingState}
            listingCity={listingCity} setListingCity={setListingCity}
            digitalFile={digitalFile} setDigitalFile={setDigitalFile}
            repuveStatus={repuveStatus} setRepuveStatus={setRepuveStatus}
            repuveFolio={repuveFolio} setRepuveFolio={setRepuveFolio}
            subTiers={subTiers} setSubTiers={setSubTiers}
            attrs={attrs} setAttr={setAttr}
            errors={listingErrors}
            submitting={submitting}
            submitError={submitError}
            onBack={handleBack}
            onSubmit={handleSubmit}
            hasShopStep={hasShopStep}
            currency={listingCurrency}
          />
        )}
        {step === 3 && result && (
          <StepSuccess
            result={result}
            onPublishAnother={handlePublishAnother}
          />
        )}
      </div>

      {/* Trust signals */}
      {step !== 3 && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-xs text-[var(--color-muted)]">
          <span><i className="iconoir-check" aria-hidden /> Sin comisiones</span>
          <span><i className="iconoir-check" aria-hidden /> Publicación instantánea</span>
          <span><i className="iconoir-check" aria-hidden /> 100% gratis</span>
        </div>
      )}
    </div>
  )
}
