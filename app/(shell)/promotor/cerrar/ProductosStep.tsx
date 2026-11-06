'use client'

/**
 * «2 · Sus productos» (epic 08 · promoter-panel S3.1/S3.2, decisions D4/D7/D8/D9). Manual-first: the promoter
 * photographs a product, sets name, price, stock and category, and saves — through the existing listing route, which
 * writes only to a shop they opened that nobody has claimed (D1). When the merchant already sells online, step 2 opens
 * with the matching import above the cards:
 *   - Shopify → the store's address, a preview count, then one confirm (`/api/promoter/import/shopify/*`).
 *   - Tiendanube / WooCommerce → their export file (`/api/promoter/import/file`), with the platform's export guide.
 *   - Mercado Libre → a note: it connects from the merchant's own panel after the claim (Daniel's call c).
 * Imports add up to 150 products (D4); the rest is the paid migration, offered in «Cobra».
 *
 * No origin fields and no image-URL box (D7/D8): a promoter at a counter has a camera, not URLs. «Llenar los datos con
 * la foto» stays as an optional link (Daniel's call a). Every word comes from `promotorPanel.productos`.
 */
import { useState } from 'react'
import type { Dictionary } from '@/lib/dictionary'
import { CATEGORIES } from '@/lib/types'
import { stepTwoPath, type SellsToday } from '@/lib/promoter-panel'

type Copy = Dictionary['promotorPanel']
type Shop = { shopId: string; slug: string; name: string; currency?: 'MXN' | 'USD' }
type ImportResult = { imported?: number; skipped?: number; invalid?: number; overCap?: number }

const fill = (s: string, n: number | string) => s.replace('{n}', String(n))

export default function ProductosStep({
  copy,
  shop,
  sellsToday,
  mainCategory,
}: {
  copy: Copy
  shop: Shop
  sellsToday: SellsToday | null
  mainCategory: string | null
}) {
  const t = copy.productos
  const path = stepTwoPath(sellsToday)
  const currency = shop.currency ?? 'MXN'
  const [added, setAdded] = useState(0)

  return (
    <section id="panel-productos" className="card-panel grid gap-4" style={{ padding: 'var(--s-5)' }} data-testid="panel-productos">
      <div>
        <h2 className="t-h4" style={{ margin: 0, letterSpacing: 0 }}>2 · {copy.steps.productos}</h2>
        {added > 0 ? <p className="t-small" style={{ margin: 'var(--s-1) 0 0', color: 'var(--success)' }} data-testid="panel-counter">{fill(t.counter, added)}</p> : null}
      </div>

      {path === 'shopify' ? <ShopifyImport copy={copy} shop={shop} onAdded={(n) => setAdded((a) => a + n)} /> : null}
      {path === 'file' && sellsToday ? <FileImport copy={copy} shop={shop} platform={sellsToday} onAdded={(n) => setAdded((a) => a + n)} /> : null}
      {path === 'mercadolibre' ? <p className="t-small" style={{ margin: 0 }}>{t.mercadolibre}</p> : null}
      {path === 'shopify' || path === 'file' ? <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{t.orByHand}</p> : null}

      <ProductCard copy={copy} shop={shop} currency={currency} defaultCategory={mainCategory} onSaved={() => setAdded((a) => a + 1)} />
    </section>
  )
}

function ResultLines({ copy, result }: { copy: Copy; result: ImportResult }) {
  const t = copy.productos
  return (
    <div className="grid gap-1" role="status">
      <p className="t-small" style={{ margin: 0, color: 'var(--success)', fontWeight: 600 }}>{fill(t.imported, result.imported ?? 0)}</p>
      {result.skipped ? <p className="t-small" style={{ margin: 0 }}>{fill(t.skipped, result.skipped)}</p> : null}
      {result.invalid ? <p className="t-small" style={{ margin: 0 }}>{fill(t.invalid, result.invalid)}</p> : null}
      {result.overCap ? <p className="t-small" style={{ margin: 0 }} data-testid="panel-overcap">{fill(t.overCap, result.overCap)}</p> : null}
    </div>
  )
}

function ShopifyImport({ copy, shop, onAdded }: { copy: Copy; shop: Shop; onAdded: (n: number) => void }) {
  const t = copy.productos.shopify
  const [domain, setDomain] = useState('')
  const [busy, setBusy] = useState<'search' | 'add' | null>(null)
  const [preview, setPreview] = useState<{ batchId: string; total: number; take: number; overCap: number; sample: Array<{ title: string; image: string | null }> } | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function search() {
    setBusy('search'); setError(null); setPreview(null); setResult(null)
    try {
      const res = await fetch('/api/promoter/import/shopify/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shopId: shop.shopId, domain: domain.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) { setError(data.error ?? t.error); return }
      setPreview(data)
    } catch { setError(copy.errors.network) }
    finally { setBusy(null) }
  }

  async function add() {
    if (!preview) return
    setBusy('add'); setError(null)
    try {
      const res = await fetch('/api/promoter/import/shopify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shopId: shop.shopId, batchId: preview.batchId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) { setError(data.error ?? copy.errors.network); return }
      setResult(data)
      setPreview(null)
      onAdded(data.imported ?? 0)
    } catch { setError(copy.errors.network) }
    finally { setBusy(null) }
  }

  return (
    <div className="grid gap-3 rounded-lg border border-[var(--color-border)] p-4" data-testid="panel-shopify">
      <p className="t-small" style={{ margin: 0 }}>{t.lead}</p>
      <label className="block text-sm font-medium">{t.field}
        <div className="mt-1 flex gap-2">
          <input className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder={t.placeholder} inputMode="url" autoCapitalize="none" />
          <button type="button" className="btn btn-secondary" onClick={search} disabled={busy !== null || !domain.trim()}>{busy === 'search' ? t.searching : t.search}</button>
        </div>
      </label>
      {preview ? (
        <div className="grid gap-2">
          <p className="t-small" style={{ margin: 0, fontWeight: 600 }}>{fill(t.found, preview.total)}</p>
          {preview.sample.length > 0 ? (
            <div className="flex gap-2 overflow-x-auto">
              {preview.sample.map((s) => (
                <div key={s.title} className="w-20 shrink-0 text-center">
                  {s.image ? (
                    /* eslint-disable-next-line @next/next/no-img-element -- a remote preview thumbnail before import */
                    <img src={s.image} alt="" className="h-20 w-20 rounded object-cover" />
                  ) : <div className="h-20 w-20 rounded bg-[var(--color-surface)]" />}
                  <span className="t-small line-clamp-2">{s.title}</span>
                </div>
              ))}
            </div>
          ) : null}
          {preview.overCap > 0 ? <p className="t-small" style={{ margin: 0 }}>{fill(copy.productos.overCap, preview.overCap)}</p> : null}
          <button type="button" className="btn btn-primary" onClick={add} disabled={busy !== null || preview.take === 0}>{busy === 'add' ? t.adding : fill(t.add, preview.take)}</button>
        </div>
      ) : null}
      {result ? <ResultLines copy={copy} result={result} /> : null}
      {error ? <p className="t-small" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p> : null}
    </div>
  )
}

function FileImport({ copy, shop, platform, onAdded }: { copy: Copy; shop: Shop; platform: SellsToday; onAdded: (n: number) => void }) {
  const t = copy.productos.file
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function upload(file: File | undefined) {
    if (!file) return
    setBusy(true); setError(null); setResult(null)
    try {
      const fileText = await file.text()
      const res = await fetch('/api/promoter/import/file', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopId: shop.shopId, fileText, fileName: file.name, platform }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) { setError(data.error ?? copy.errors.network); return }
      setResult(data)
      onAdded(data.imported ?? 0)
    } catch { setError(copy.errors.network) }
    finally { setBusy(false) }
  }

  return (
    <div className="grid gap-3 rounded-lg border border-[var(--color-border)] p-4" data-testid="panel-file">
      <p className="t-small" style={{ margin: 0 }}>{t.lead} <a href={`/mx/vende/migracion/${platform}`} target="_blank" rel="noreferrer" className="underline">{t.howTo}</a></p>
      <label className="btn btn-secondary" style={{ justifySelf: 'start' }}>
        {busy ? t.uploading : t.upload}
        <input type="file" accept=".csv,text/csv" className="sr-only" disabled={busy} onChange={(e) => upload(e.target.files?.[0])} />
      </label>
      {result ? <ResultLines copy={copy} result={result} /> : null}
      {error ? <p className="t-small" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p> : null}
    </div>
  )
}

function ProductCard({ copy, shop, currency, defaultCategory, onSaved }: { copy: Copy; shop: Shop; currency: string; defaultCategory: string | null; onSaved: () => void }) {
  const t = copy.productos
  const [photos, setPhotos] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [filling, setFilling] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [price, setPrice] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [category, setCategory] = useState(defaultCategory ?? '')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onPhotos(files: FileList | null) {
    if (!files?.length) return
    setUploading(true); setError(null)
    let failed = 0
    const uploaded: string[] = []
    try {
      for (const file of Array.from(files).slice(0, 6 - photos.length)) {
        const fd = new FormData()
        fd.append('file', file)
        const res = await fetch('/api/sell/upload', { method: 'POST', body: fd }).catch(() => null)
        const url = res && res.ok ? ((await res.json().catch(() => ({}))) as { url?: string }).url : undefined
        if (url) uploaded.push(url); else failed += 1
      }
      setPhotos((prev) => [...prev, ...uploaded].slice(0, 6))
      if (failed > 0) setError(t.uploadFailed)
    } finally { setUploading(false) }
  }

  async function fillFromPhoto() {
    if (!photos[0] || filling) return
    setFilling(true); setNote(null)
    try {
      const res = await fetch('/api/promoter/close/photo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shopId: shop.shopId, imageUrl: photos[0] }),
      })
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; suggestion?: { title: string; description: string; category: string; price: number } | null } | null
      if (!res.ok || !data?.ok) { setNote(data?.error ?? t.fillFailed); return }
      if (!data.suggestion) { setNote(t.fillFailed); return }
      setTitle(data.suggestion.title)
      setDescription(data.suggestion.description)
      setCategory(data.suggestion.category)
      setPrice(String(data.suggestion.price))
      setNote(t.filled)
    } catch { setNote(t.fillFailed) }
    finally { setFilling(false) }
  }

  async function save() {
    setError(null)
    if (title.trim().length < 3) { setError(t.nameRequired); return }
    if (!category) { setError(t.categoryRequired); return }
    setBusy(true)
    try {
      const res = await fetch('/api/promoter/close/listing', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopId: shop.shopId,
          title: title.trim(),
          description: description.trim() || undefined,
          category,
          price: price ? Number(price) : undefined,
          currency,
          quantity: quantity ? Number(quantity) : undefined,
          images: photos.map((url) => ({ url })),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) { setError(data.error ?? copy.errors.network); return }
      setPhotos([]); setTitle(''); setPrice(''); setQuantity('1'); setDescription(''); setNote(t.saved)
      setCategory(defaultCategory ?? '')
      onSaved()
    } catch { setError(copy.errors.network) }
    finally { setBusy(false) }
  }

  const field = 'mt-1 w-full rounded-lg border border-[var(--color-border)] px-3 py-2'
  return (
    <div className="grid gap-3" data-testid="panel-card">
      <p className="t-small" style={{ margin: 0 }}>{t.leadCards}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="btn btn-primary btn-lg" data-testid="panel-take-photo">
          <i className="iconoir-camera" aria-hidden /> {uploading ? t.uploading : t.takePhoto}
          <input type="file" accept="image/*" capture="environment" className="sr-only" disabled={uploading || photos.length >= 6} onChange={(e) => onPhotos(e.target.files)} />
        </label>
        <label className="btn btn-secondary btn-lg">
          <i className="iconoir-media-image" aria-hidden /> {t.gallery}
          <input type="file" accept="image/*" multiple className="sr-only" disabled={uploading || photos.length >= 6} onChange={(e) => onPhotos(e.target.files)} />
        </label>
      </div>
      {photos.length > 0 ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap gap-2">
            {photos.map((url) => (
              <button key={url} type="button" className="btn btn-ghost" style={{ padding: 0 }} title={t.removePhoto} aria-label={t.removePhoto} onClick={() => setPhotos((cur) => cur.filter((p) => p !== url))}>
                {/* eslint-disable-next-line @next/next/no-img-element -- the promoter's own just-uploaded photo */}
                <img src={url} alt="" className="h-16 w-16 rounded object-cover" />
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="t-small" style={{ color: 'var(--fg-muted)' }}>{fill(t.photos, photos.length)}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={fillFromPhoto} disabled={filling || uploading} data-testid="promoter-photo-fill">
              {filling ? t.filling : t.fillFromPhoto}
            </button>
          </div>
        </div>
      ) : null}
      {note ? <p className="t-small" role="status" style={{ margin: 0 }}>{note}</p> : null}
      <label className="block text-sm font-medium">{t.name}
        <input className={field} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm font-medium">{t.price} ({currency})
          <input className={field} value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" />
        </label>
        <label className="block text-sm font-medium">{t.stock}
          <input className={field} value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/\D/g, ''))} inputMode="numeric" />
        </label>
        <label className="block text-sm font-medium">{t.category}
          <select className={field} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">{t.choose}</option>
            {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
      </div>
      <details>
        <summary className="t-small" style={{ cursor: 'pointer' }}>{t.description}</summary>
        <textarea className={field} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </details>
      {error ? <p className="t-small" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p> : null}
      <button type="button" className="btn btn-primary" onClick={save} disabled={busy || uploading} data-testid="panel-save-product">
        {busy ? t.saving : t.save}
      </button>
    </div>
  )
}
