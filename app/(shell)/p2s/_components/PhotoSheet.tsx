'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/feedback/Banner'
import { CATEGORIES } from '@/lib/types'
import { analyzePhotoRequest, confirmPhotoRequest, uploadPhoto } from '@/lib/prompt-to-shop/client'
import { CHECKLIST_COPY, PHOTO_COPY } from '@/lib/prompt-to-shop/copy'
import { photosLeftCopy } from '@/lib/prompt-to-shop/allowance'
import type { PhotoSuggestion } from '@/lib/prompt-to-shop/photo'
import OwnerSheet from './OwnerSheet'

/**
 * Photo → product (epic prompt-to-shop S4.2), as a sheet over the kept-shop canvas.
 *
 *   pick  → the camera (`capture="environment"`) or the gallery;
 *   send  → shrink on the phone, then `POST /api/sell/upload` (our own storage — the only URL the next step accepts);
 *   read  → `POST /api/p2s/photo`: the card fills from what the model saw, or comes back EMPTY for the merchant to
 *           fill in (the model could not read it — never a crash, never a dead end);
 *   card  → the merchant edits, then «Confirmar» → `POST /api/p2s/photo/confirm`: one product, one photo spent.
 *
 * The nonce is minted ONCE per card. A double tap, or a retry after a failed create, sends the same one, so the
 * server makes one product and spends one photo however many times the button is pressed. The product's image is
 * the merchant's own photo; nothing here generates an image.
 */

type Phase =
  | { kind: 'pick' }
  | { kind: 'busy'; label: string; preview: string | null }
  | { kind: 'card'; imageUrl: string; preview: string; nonce: string; note: string | null }
  | { kind: 'added' }

const MAX_DIM = 1600

/** Resize on the phone before uploading: a 12 MP photo is 4–8 MB, the upload cap is 8 MB, and the model needs less. */
async function shrink(file: File): Promise<File> {
  if (typeof window === 'undefined' || !window.createImageBitmap) return file
  try {
    const bitmap = await createImageBitmap(file)
    const ratio = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * ratio)
    canvas.height = Math.round(bitmap.height * ratio)
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    if (!blob) return file
    const out = new File([blob], 'foto.jpg', { type: 'image/jpeg' })
    return out.size < file.size ? out : file
  } catch {
    return file
  }
}

const emptyCard = (): PhotoSuggestion => ({ title: '', description: '', category: 'otros', price: 0 })

export default function PhotoSheet({
  replace,
  photosLeft: initialLeft,
  onClose,
  onAdded,
}: {
  /** The example this photo replaces, or null for a new product. */
  replace: { index: number; title: string } | null
  photosLeft: number | null
  onClose: () => void
  onAdded: () => void
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' })
  const [card, setCard] = useState<PhotoSuggestion>(emptyCard)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [left, setLeft] = useState(initialLeft)
  // «Agregar otra foto» after replacing an example adds a NEW product: it must not aim at the same example again.
  const [target, setTarget] = useState(replace)
  const cameraRef = useRef<HTMLInputElement | null>(null)
  const galleryRef = useRef<HTMLInputElement | null>(null)
  // A ref, not state: two taps inside one render must both see that a confirm is already in flight.
  const inFlight = useRef(false)

  async function onFile(file: File | undefined) {
    if (!file) return
    setError(null)
    const preview = URL.createObjectURL(file)
    setPhase({ kind: 'busy', label: PHOTO_COPY.uploading, preview })
    const uploaded = await uploadPhoto(await shrink(file))
    if (!uploaded.ok) {
      setError(uploaded.message)
      setPhase({ kind: 'pick' })
      return
    }
    setPhase({ kind: 'busy', label: PHOTO_COPY.reading, preview })
    const read = await analyzePhotoRequest(uploaded.url)
    if (!read.ok) {
      setError(read.message)
      setPhase({ kind: 'pick' })
      return
    }
    if (read.photosLeft !== null) setLeft(read.photosLeft)
    setCard(read.suggestion ?? emptyCard())
    setPhase({ kind: 'card', imageUrl: uploaded.url, preview, nonce: crypto.randomUUID(), note: read.suggestion ? null : read.message })
  }

  async function confirm() {
    if (phase.kind !== 'card' || inFlight.current) return
    inFlight.current = true
    setConfirming(true)
    setError(null)
    const result = await confirmPhotoRequest({ nonce: phase.nonce, image_url: phase.imageUrl, card: { ...card, price: Number(card.price) }, replace: target })
    inFlight.current = false
    setConfirming(false)
    if (result.ok) {
      if (result.photosLeft !== null) setLeft(result.photosLeft)
      setPhase({ kind: 'added' })
      onAdded()
      return
    }
    // A 409 means the same card is already being added (another tap): the shop will show it on refresh.
    if (result.code === 'in_progress') onAdded()
    setError(result.message)
  }

  const ready = card.title.trim().length >= 5 && Number(card.price) > 0

  return (
    <OwnerSheet title={CHECKLIST_COPY.fotosTitle} lead={CHECKLIST_COPY.fotosLead} onClose={onClose} testId="p2s-photo-sheet">
      {left !== null ? <p className="t-small" style={{ margin: 0, fontWeight: 600 }} data-testid="p2s-photos-left">{photosLeftCopy(left)}</p> : null}
      {error ? <Banner variant="warning">{error}</Banner> : null}

      {phase.kind === 'pick' ? (
        <div className="grid gap-2">
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} onChange={(e) => onFile(e.target.files?.[0])} data-testid="p2s-photo-camera" />
          <input ref={galleryRef} type="file" accept="image/*" className="sr-only" tabIndex={-1} onChange={(e) => onFile(e.target.files?.[0])} data-testid="p2s-photo-gallery" />
          <Button type="button" variant="primary" size="lg" disabled={left === 0} onClick={() => cameraRef.current?.click()} style={{ width: '100%' }}>
            <i className="iconoir-camera" aria-hidden="true" /> {PHOTO_COPY.take}
          </Button>
          <Button type="button" variant="secondary" disabled={left === 0} onClick={() => galleryRef.current?.click()} style={{ width: '100%' }}>
            <i className="iconoir-media-image" aria-hidden="true" /> {PHOTO_COPY.pick}
          </Button>
        </div>
      ) : null}

      {phase.kind === 'busy' ? (
        <div className="grid gap-3" aria-busy="true">
          {phase.preview ? <img src={phase.preview} alt="" className="w-full rounded object-cover" style={{ maxHeight: 220 }} /> : null}
          <p className="t-small" style={{ margin: 0 }} role="status" aria-live="polite">{phase.label}</p>
          <div className="grid gap-2" aria-hidden="true">
            <span className="block h-4 rounded animate-pulse motion-reduce:animate-none" style={{ background: 'var(--border)', width: '70%' }} />
            <span className="block h-4 rounded animate-pulse motion-reduce:animate-none" style={{ background: 'var(--border)', width: '90%' }} />
            <span className="block h-4 rounded animate-pulse motion-reduce:animate-none" style={{ background: 'var(--border)', width: '40%' }} />
          </div>
        </div>
      ) : null}

      {phase.kind === 'card' ? (
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void confirm() }} data-testid="p2s-photo-card">
          <img src={phase.preview} alt="" className="w-full rounded object-cover" style={{ maxHeight: 220 }} />
          {phase.note ? <Banner variant="info">{phase.note}</Banner> : null}
          <label className="grid gap-1 t-small">
            <span style={{ fontWeight: 600 }}>{PHOTO_COPY.titleLabel}</span>
            <input className="input" value={card.title} maxLength={100} onChange={(e) => setCard({ ...card, title: e.target.value })} required />
          </label>
          <label className="grid gap-1 t-small">
            <span style={{ fontWeight: 600 }}>{PHOTO_COPY.descriptionLabel}</span>
            <textarea className="input" rows={3} value={card.description} maxLength={2000} onChange={(e) => setCard({ ...card, description: e.target.value })} />
          </label>
          <label className="grid gap-1 t-small">
            <span style={{ fontWeight: 600 }}>{PHOTO_COPY.categoryLabel}</span>
            <select className="input" value={card.category} onChange={(e) => setCard({ ...card, category: e.target.value as PhotoSuggestion['category'] })}>
              {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
          <label className="grid gap-1 t-small">
            <span style={{ fontWeight: 600 }}>{PHOTO_COPY.priceLabel}</span>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={card.price ? String(card.price) : ''}
              onChange={(e) => setCard({ ...card, price: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
              required
            />
            <span style={{ color: 'var(--fg-muted)' }}>{PHOTO_COPY.priceHint}</span>
          </label>
          <Button type="submit" variant="primary" size="lg" disabled={!ready || confirming} style={{ width: '100%' }} data-testid="p2s-photo-confirm">
            {confirming ? PHOTO_COPY.confirming : PHOTO_COPY.confirm}
          </Button>
        </form>
      ) : null}

      {phase.kind === 'added' ? (
        <div className="grid gap-2">
          <p className="t-small" style={{ margin: 0 }} role="status" aria-live="polite">{PHOTO_COPY.added}</p>
          {left !== 0 ? (
            <div>
              <Button type="button" variant="secondary" onClick={() => { setError(null); setTarget(null); setCard(emptyCard()); setPhase({ kind: 'pick' }) }}>{PHOTO_COPY.another}</Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </OwnerSheet>
  )
}
