'use client'

import { useState } from 'react'
import { CATEGORIES } from '@/lib/types'
import { shopUrlFor } from '@/lib/market-url'
import { SITE_ORIGIN } from '@/lib/market-seo'

type Shop = { shopId: string; slug: string; name: string; currency?: 'MXN' | 'USD' }

/** Authenticated promoter listing close, with source-image URLs for prepared claim-shop waves. */
export default function ListingStep({ shop, n }: { shop: Shop; n: number }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [category, setCategory] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [sourcePlatform, setSourcePlatform] = useState('shopify')
  const [photos, setPhotos] = useState<string[]>([])
  const [photoUrl, setPhotoUrl] = useState('')
  const [uploading, setUploading] = useState(false)
  // plans-gratis-negocio S5.1 (D14): fill the form from the first photo with AI — the promoter still reviews and saves.
  const [suggesting, setSuggesting] = useState(false)
  const [suggestNote, setSuggestNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const currency = shop.currency ?? 'MXN'

  function resetForAnother() {
    setTitle(''); setDescription(''); setPrice(''); setQuantity('1'); setCategory('')
    setSourceUrl(''); setSourcePlatform('shopify'); setPhotos([]); setPhotoUrl('')
    setError(null); setDone(false)
  }

  function addPhotoUrl() {
    const candidate = photoUrl.trim()
    try {
      const url = new URL(candidate)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol')
      if (!photos.includes(url.href)) setPhotos((current) => [...current, url.href].slice(0, 6))
      setPhotoUrl('')
    } catch {
      setError('Pega una URL de imagen válida (https).')
    }
  }

  async function fillFromPhoto() {
    if (!photos[0] || suggesting) return
    setSuggesting(true); setSuggestNote(null); setError(null)
    try {
      const res = await fetch('/api/promoter/close/photo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopId: shop.shopId, imageUrl: photos[0] }),
      })
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; message?: string; suggestion?: { title: string; description: string; category: string; price: number } | null } | null
      if (!res.ok || !data?.ok) { setSuggestNote(data?.error ?? 'No pudimos revisar la foto. Llena el producto a mano.'); return }
      if (!data.suggestion) { setSuggestNote(data.message ?? 'No pudimos leer el producto en la foto. Llénalo a mano.'); return }
      setTitle(data.suggestion.title)
      setDescription(data.suggestion.description)
      setCategory(data.suggestion.category)
      setPrice(String(data.suggestion.price))
      setSuggestNote('Listo: revisa el nombre, el precio y la categoría antes de guardar.')
    } catch {
      setSuggestNote('Error de red. Llena el producto a mano o intenta de nuevo.')
    } finally {
      setSuggesting(false)
    }
  }

  async function uploadPhoto(file: File): Promise<string | null> {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch('/api/sell/upload', { method: 'POST', body: fd })
    if (!res.ok) return null
    const { url } = await res.json()
    return url ?? null
  }

  async function onPhotos(files: FileList | null) {
    if (!files?.length) return
    setUploading(true); setError(null)
    try {
      const uploaded: string[] = []
      let failed = 0
      for (const file of Array.from(files).slice(0, 6)) {
        const url = await uploadPhoto(file)
        if (url) uploaded.push(url); else failed++
      }
      setPhotos((prev) => [...prev, ...uploaded].slice(0, 6))
      if (failed > 0) setError('Una o más fotos no se pudieron subir. Intenta de nuevo.')
    } finally {
      setUploading(false)
    }
  }

  async function addListing() {
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/promoter/close/listing', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopId: shop.shopId,
          title,
          description: description.trim() || undefined,
          category,
          price: price ? Number(price) : undefined,
          currency,
          quantity: quantity ? Number(quantity) : undefined,
          source_url: sourceUrl.trim() || undefined,
          source_platform: sourcePlatform.trim() || undefined,
          images: photos.map((url) => ({ url })),
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) { setError(data.error ?? 'No se pudo crear el anuncio.'); return }
      setDone(true)
    } catch { setError('Error de red. Intenta de nuevo.') }
    finally { setBusy(false) }
  }

  return (
    <section className="rounded-lg border border-[var(--color-border)] p-4 space-y-3">
      <h2 className="font-semibold"><span className="text-[var(--color-muted)] mr-2">{n}.</span>Agregar anuncios</h2>
      {done ? (
        <div className="space-y-3 text-sm text-[color:var(--success)]">
          <p><i className="iconoir-check-circle" aria-hidden /> Anuncio guardado en la vista previa de <a className="underline" href={shopUrlFor(SITE_ORIGIN, shop.slug)} target="_blank" rel="noreferrer">{shop.name}</a>.</p>
          <button type="button" onClick={resetForAnother} className="rounded-lg border border-[var(--color-border)] px-4 py-2 font-medium text-[var(--fg)]">Agregar otro anuncio</button>
        </div>
      ) : (
        <div className="space-y-3">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título del anuncio" className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2" />
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Descripción del producto (opcional)" rows={3} className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2" />
          <div className="flex gap-2">
            <input value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))} placeholder={`Precio (${currency})`} inputMode="decimal" className="flex-1 rounded-lg border border-[var(--color-border)] px-3 py-2" />
            <input value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/\D/g, ''))} placeholder="Existencias" inputMode="numeric" className="w-32 rounded-lg border border-[var(--color-border)] px-3 py-2" />
            <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Categoría" className="flex-1 rounded-lg border border-[var(--color-border)] px-3 py-2">
              <option value="">Categoría…</option>
              {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </div>
          <input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="URL de origen (opcional)" inputMode="url" className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2" />
          <input value={sourcePlatform} onChange={(e) => setSourcePlatform(e.target.value)} placeholder="Plataforma de origen (opcional)" className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2" />
          <div className="space-y-2">
            <div className="flex gap-2">
              <input value={photoUrl} onChange={(e) => setPhotoUrl(e.target.value)} placeholder="URL de imagen" inputMode="url" disabled={photos.length >= 6} className="flex-1 rounded-lg border border-[var(--color-border)] px-3 py-2" />
              <button type="button" onClick={addPhotoUrl} disabled={photos.length >= 6 || !photoUrl.trim()} className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium disabled:opacity-50">Agregar URL</button>
            </div>
            <label className="block text-sm text-[var(--color-muted)]">O sube fotos ({photos.length}/6)
              <input type="file" accept="image/*" multiple disabled={uploading || photos.length >= 6} onChange={(e) => onPhotos(e.target.files)} className="mt-1 block w-full text-sm" />
            </label>
            {photos.length > 0 && <div className="flex gap-2 flex-wrap">
              {photos.map((url) => <button type="button" key={url} onClick={() => setPhotos((current) => current.filter((item) => item !== url))} title="Quitar imagen">
                {/* eslint-disable-next-line @next/next/no-img-element -- verified remote image URLs are previewed before the authenticated listing write */}
                <img src={url} alt="" className="h-16 w-16 rounded object-cover" />
              </button>)}
            </div>}
            {photos.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <button type="button" onClick={fillFromPhoto} disabled={suggesting || uploading} data-testid="promoter-photo-fill" className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium disabled:opacity-50">
                  {suggesting ? 'Revisando la foto…' : 'Llenar con la foto (IA)'}
                </button>
                {suggestNote && <span className="text-xs text-[var(--color-muted)]">{suggestNote}</span>}
              </div>
            )}
          </div>
          {error && <p className="text-sm text-[color:var(--danger)]">{error}</p>}
          <button onClick={addListing} disabled={busy || uploading || title.trim().length < 3 || !category} className="rounded-lg bg-[var(--color-accent)] text-[var(--fg-inverse)] px-4 py-2 font-medium disabled:opacity-50">
            {busy ? 'Guardando…' : 'Guardar anuncio privado'}
          </button>
        </div>
      )}
    </section>
  )
}
