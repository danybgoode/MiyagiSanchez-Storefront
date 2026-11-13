'use client'

import { useSellerFormat } from '@/app/components/SellerFormatProvider'

import { useRef, useState } from 'react'
import { runIntake } from '@/lib/prompt-to-shop/client'
import { INTAKE_FILE_ACCEPT, INTAKE_PHOTO_ACCEPT } from '@/lib/prompt-to-shop/intake'
import Link from 'next/link'
import { SellerBreadcrumb } from '../SellerBreadcrumb'
import {
  buildCopilotPrompt,
  CATALOG_IMPORT_FIELDS,
  EXAMPLE_CATALOG,
  MAX_IMPORT_ROWS,
  EXTRACT_CHAR_LIMIT,
  parseCatalogFile,
  validateRows,
  CATALOG_CATEGORY_KEYS,
  type CatalogParseResult,
  type CatalogImportRow,
} from '@/lib/catalog-import'
import { SuccessCard } from '@/components/SuccessCard'
import { shopUrlFor } from '@/lib/market-url'
import { SITE_ORIGIN } from '@/lib/market-seo'

/** Must match CHUNK_MAX in app/api/sell/import/route.ts. */
const IMPORT_CHUNK = 25

type RowResult = {
  line: number
  title: string
  status: 'created' | 'updated' | 'failed'
  product_id?: string
  reason?: string
  images_failed?: number
}

// ── Copy-to-clipboard button ─────────────────────────────────────────────────

function CopyButton({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1800)
        } catch {
          // clipboard blocked — no-op; the textarea below is still selectable
        }
      }}
      className="inline-flex items-center gap-1.5 bg-[var(--color-accent)] text-white px-3 py-1.5 rounded-[var(--r-md)] text-xs font-semibold hover:bg-[var(--color-accent-hover)] transition-colors"
    >
      {copied ? <><i className="iconoir-check" aria-hidden /> Copiado</> : <><i className="iconoir-copy" aria-hidden /> {label}</>}
    </button>
  )
}

// ── Uploader: paste/file → validate → editable staging → import ──────────────

function Uploader({ shopSlug, pagosConfigured }: { shopSlug: string | null; pagosConfigured: boolean }) {
  const fmt = useSellerFormat()
  const publicShopUrl = shopSlug ? shopUrlFor(SITE_ORIGIN, shopSlug) : ''
  const inputRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [result, setResult] = useState<CatalogParseResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [existingIds, setExistingIds] = useState<Set<string> | null>(null)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [report, setReport] = useState<RowResult[] | null>(null)
  const [pasteText, setPasteText] = useState('')
  const [extracting, setExtracting] = useState(false)
  // Editable working copy of the rows (Story B: inline-fix before importing).
  const [editRows, setEditRows] = useState<CatalogImportRow[]>([])

  // Shared by both inputs (file + paste): show staging and fetch existing ids.
  async function applyResult(parsed: CatalogParseResult) {
    setReport(null)
    setProgress({ done: 0, total: 0 })
    setExistingIds(null)
    setResult(parsed)
    setEditRows(parsed.staged.map((s) => ({ ...s.row })))
    if (parsed.staged.some((s) => s.valid)) {
      try {
        const res = await fetch('/api/sell/import/existing')
        if (res.ok) {
          const data = (await res.json()) as { external_ids?: string[] }
          setExistingIds(new Set(data.external_ids ?? []))
        }
      } catch {
        // Non-fatal: without the set, every row simply previews as "Nuevo".
      }
    }
  }

  async function handleFile(file: File) {
    setError(null)
    setResult(null)
    setEditRows([])
    setFileName(null)
    if (file.size > 5 * 1024 * 1024) {
      setError('El archivo es muy grande (máx. 5 MB).')
      return
    }
    try {
      const text = await file.text()
      setFileName(file.name)
      await applyResult(parseCatalogFile(text, file.name))
    } catch {
      setError('No se pudo leer el archivo. Intenta de nuevo.')
    }
  }

  // ── «Crear con IA» (one-front-door-both-markets S4.1, D20) ── the builder's own intakes, signed in: one photo, a
  // spreadsheet or PDF, or the shop's old store link. The routes know the session, so no Turnstile; every row they
  // return is screened for prohibited goods, then lands in THIS staging grid, reviewed before anything is created.
  const [aiBusy, setAiBusy] = useState<'photo' | 'file' | 'link' | null>(null)
  const [aiLink, setAiLink] = useState('')
  const aiPhotoRef = useRef<HTMLInputElement>(null)
  const aiFileRef = useRef<HTMLInputElement>(null)

  async function handleIntake(kind: 'photo' | 'file' | 'link', payload: { file?: File; url?: string }) {
    setError(null)
    setResult(null)
    setEditRows([])
    setFileName(payload.file?.name ?? null)
    setAiBusy(kind)
    // A CSV or JSON list is read HERE by the same parser as the upload below — every column kept, no 60-row cap
    // (fresh review, PR #501). Only a spreadsheet, a PDF, a photo or a link needs the server.
    if (kind === 'file' && payload.file && /\.(csv|tsv|txt|json)$/i.test(payload.file.name)) {
      setAiBusy(null)
      await handleFile(payload.file)
      return
    }
    // The shop's own market: a US shop's rows are priced in dollars (the backend refuses a currency mismatch).
    const answer = await runIntake(kind, { ...payload, turnstileToken: '', locale: 'es', marketHint: fmt.currency === 'USD' ? 'us' : 'mx' }, 'No pudimos leerlo. Inténtalo de nuevo en un momento.')
    setAiBusy(null)
    if (!answer.ok) {
      setError(answer.message)
      return
    }
    if (!answer.seedRows.length) {
      setError('No encontramos productos ahí. Prueba con tu lista en Excel o pega el texto abajo.')
      return
    }
    await applyResult({ format: 'json', staged: validateRows(answer.seedRows), fileErrors: [] })
  }

  async function handleExtract() {
    if (!pasteText.trim() || pasteText.length > EXTRACT_CHAR_LIMIT) return
    setError(null)
    setResult(null)
    setEditRows([])
    setFileName(null)
    setExtracting(true)
    try {
      const res = await fetch('/api/sell/import/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: pasteText }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        staged?: CatalogParseResult['staged']
        fileErrors?: CatalogParseResult['fileErrors']
        error?: string
      }
      if (!res.ok) {
        setError(data.error ?? 'No se pudo extraer el catálogo. Inténtalo de nuevo.')
        return
      }
      await applyResult({ format: 'json', staged: data.staged ?? [], fileErrors: data.fileErrors ?? [] })
    } catch {
      setError('No se pudo contactar al servicio de IA. Inténtalo de nuevo.')
    } finally {
      setExtracting(false)
    }
  }

  async function runImport(rows: CatalogImportRow[]) {
    setImporting(true)
    setError(null)
    const all: RowResult[] = []
    setProgress({ done: 0, total: rows.length })
    try {
      for (let i = 0; i < rows.length; i += IMPORT_CHUNK) {
        const chunk = rows.slice(i, i + IMPORT_CHUNK)
        const res = await fetch('/api/sell/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows: chunk }),
        })
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string }
          setError(err.error ?? 'No se pudo completar la importación.')
          break
        }
        const data = (await res.json()) as { results: RowResult[] }
        all.push(...data.results)
        setProgress({ done: Math.min(i + chunk.length, rows.length), total: rows.length })
        setReport([...all])
      }
    } catch {
      setError('Se interrumpió la importación. Revisa tu conexión e inténtalo de nuevo.')
    } finally {
      setImporting(false)
    }
  }

  // Re-validate the editable rows live so inline fixes flip a row to valid.
  const staged = editRows.length ? validateRows(editRows) : []
  const validRows = staged.filter((s) => s.valid)
  const validCount = validRows.length
  const errorRowCount = staged.filter((s) => !s.valid).length
  const isExisting = (extId?: string) => !!(extId && existingIds?.has(extId))
  const updateCount = validRows.filter((s) => isExisting(s.row.external_id)).length
  const createCount = validCount - updateCount
  const fileErrors = result?.fileErrors ?? []
  const warningIssues = staged.flatMap((s) => s.issues).filter((i) => i.level === 'warning')

  function updateField(i: number, field: keyof CatalogImportRow, raw: string) {
    setEditRows((prev) => prev.map((row, idx) => {
      if (idx !== i) return row
      const next = { ...row }
      if (field === 'price' || field === 'quantity') {
        const n = raw.trim() === '' ? undefined : Number(raw.replace(/[^\d.]/g, ''))
        next[field] = (n === undefined || Number.isNaN(n) ? undefined : n) as never
      } else {
        next[field] = (raw === '' ? undefined : raw) as never
      }
      return next
    }))
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept=".json,.csv,application/json,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleFile(f)
          e.target.value = '' // allow re-selecting the same file
        }}
      />

      {/* Paste & publish (Sprint 2) — the easy, native path */}
      <section id="crear-con-ia" data-testid="import-crear-con-ia" className="border border-[var(--color-border)] rounded-[var(--r-lg)] p-5 mb-4">
        <h2 className="font-semibold mb-1 flex items-center gap-2">
          <i className="iconoir-magic-wand text-xl" aria-hidden /> Crear con IA
        </h2>
        <p className="text-sm text-[var(--color-muted)] mb-3">
          Empieza con lo que ya tienes: una foto de un producto, tu lista en Excel o PDF, o el link de tu tienda anterior.
          Revisas todo aquí abajo antes de que se cree nada.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-secondary" disabled={!!aiBusy} onClick={() => aiPhotoRef.current?.click()} data-testid="import-ai-photo">
            <i className="iconoir-camera" aria-hidden /> {aiBusy === 'photo' ? 'Leyendo…' : 'Una foto'}
          </button>
          <button type="button" className="btn btn-secondary" disabled={!!aiBusy} onClick={() => aiFileRef.current?.click()} data-testid="import-ai-file">
            <i className="iconoir-page" aria-hidden /> {aiBusy === 'file' ? 'Leyendo…' : 'Tu lista en Excel o PDF'}
          </button>
        </div>
        <input ref={aiPhotoRef} type="file" accept={INTAKE_PHOTO_ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void handleIntake('photo', { file: f }) }} />
        <input ref={aiFileRef} type="file" accept={INTAKE_FILE_ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void handleIntake('file', { file: f }) }} />
        <div className="flex flex-wrap gap-2 mt-3">
          <label htmlFor="import-ai-link" className="sr-only">El link de tu tienda</label>
          <input
            id="import-ai-link"
            type="url"
            inputMode="url"
            value={aiLink}
            onChange={(e) => setAiLink(e.target.value)}
            placeholder="El link de tu tienda: tutienda.myshopify.com"
            className="flex-1 min-w-0 text-sm p-2 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--fg)]"
            data-testid="import-ai-link"
          />
          <button type="button" className="btn btn-secondary" disabled={!!aiBusy || !aiLink.trim()} onClick={() => void handleIntake('link', { url: aiLink.trim() })}>
            {aiBusy === 'link' ? 'Leyendo…' : 'Traer productos'}
          </button>
        </div>
      </section>

      <section className="border border-[var(--color-border)] rounded-[var(--r-lg)] p-5 mb-4">
        <h2 className="font-semibold mb-1 flex items-center gap-2">
          <i className="iconoir-sparks text-xl" aria-hidden /> Pega y publica
        </h2>
        <p className="text-sm text-[var(--color-muted)] mb-3">
          Pega lo que sea —listas, descripciones, mensajes de proveedor o notas— y nuestra IA arma tu
          catálogo. Tú lo revisas antes de publicar.
        </p>
        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          rows={7}
          placeholder={'Ej.\nBicicleta de montaña Trek rodada 29, seminueva, $8,500, Guadalajara\nClases de guitarra a domicilio, $350 la hora, CDMX\n…'}
          className="w-full text-sm p-3 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--fg)] resize-y"
          maxLength={EXTRACT_CHAR_LIMIT + 5000}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 mt-2">
          <span className={`text-xs ${pasteText.length > EXTRACT_CHAR_LIMIT ? 'text-red-600 font-semibold' : 'text-[var(--color-muted)]'}`}>
            {fmt.number(pasteText.length)} / {fmt.number(EXTRACT_CHAR_LIMIT)} caracteres
          </span>
          <button
            type="button"
            onClick={handleExtract}
            disabled={extracting || !pasteText.trim() || pasteText.length > EXTRACT_CHAR_LIMIT}
            className="btn btn-primary"
          >
            {extracting ? 'Extrayendo…' : 'Extraer productos'}
          </button>
        </div>
        {pasteText.length > EXTRACT_CHAR_LIMIT && (
          <p className="text-xs text-red-600 mt-2">
            Te pasaste del límite. Para catálogos grandes, usa tu propia IA y sube el archivo (más abajo).
          </p>
        )}
      </section>

      {/* File upload — for files generated by the seller's own AI */}
      <div className="border-2 border-dashed border-[var(--border)] rounded-[var(--r-lg)] p-6 text-center">
        <h2 className="font-semibold mb-1 text-sm">o sube un archivo (CSV o JSON)</h2>
        <p className="text-xs text-[var(--color-muted)] mb-3">
          ¿Ya tienes un archivo de tu propia IA? Súbelo y lo revisamos al instante.
        </p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="inline-block border border-[var(--border)] text-[var(--fg)] px-5 py-2 rounded-[var(--r-md)] text-sm font-medium hover:bg-[var(--surface-muted)] transition-colors"
        >
          Elegir archivo
        </button>
        {fileName && (
          <p className="text-xs text-[var(--color-muted)] mt-3"><i className="iconoir-page" aria-hidden /> {fileName}</p>
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-[var(--r-md)] border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-4">
          {/* File-level errors (unparseable / over cap) */}
          {fileErrors.length > 0 && (
            <div className="space-y-2 mb-3">
              {fileErrors.map((issue, idx) => (
                <div key={idx} className="rounded-[var(--r-md)] border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                  {issue.message}
                </div>
              ))}
            </div>
          )}

          {/* Summary */}
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <span className="inline-flex items-center gap-1.5 rounded-[var(--r-pill)] bg-green-100 text-green-700 px-3 py-1 text-sm font-semibold">
              <i className="iconoir-check" aria-hidden /> {validCount} {validCount === 1 ? 'producto listo' : 'productos listos'}
            </span>
            {errorRowCount > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-[var(--r-pill)] bg-red-100 text-red-700 px-3 py-1 text-sm font-semibold">
                <i className="iconoir-xmark" aria-hidden /> {errorRowCount} por corregir
              </span>
            )}
          </div>

          {/* Editable staging grid (US-3 preview + Story B inline fix) */}
          {staged.length > 0 && (
            <div className="rounded-[var(--r-lg)] border border-[var(--border)] overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 bg-[var(--surface-muted)] border-b border-[var(--border)]">
                <p className="text-sm font-medium">
                  {createCount > 0 && <>Se crearán <strong>{createCount}</strong></>}
                  {createCount > 0 && updateCount > 0 && ' · '}
                  {updateCount > 0 && <>Se actualizarán <strong>{updateCount}</strong></>}
                  {errorRowCount > 0 && (
                    <span className="text-[var(--color-muted)] font-normal"> · {errorRowCount} con error</span>
                  )}
                </p>
                <button
                  type="button"
                  disabled={importing || !!report || validCount === 0}
                  onClick={() => runImport(validRows.map((s) => s.row))}
                  className="btn btn-primary"
                >
                  {importing
                    ? `Procesando ${progress.done}/${progress.total}…`
                    : report
                      ? 'Importado'
                      : `Confirmar e importar (${validCount})`}
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[var(--color-muted)] border-b border-[var(--color-border)]">
                      <th className="py-2 px-3 font-semibold">Título</th>
                      <th className="py-2 px-3 font-semibold">Categoría</th>
                      <th className="py-2 px-3 font-semibold">Precio</th>
                      <th className="py-2 px-3 font-semibold">SKU</th>
                      <th className="py-2 px-3 font-semibold">Inv.</th>
                      <th className="py-2 px-3 font-semibold">Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {staged.map((s, i) => {
                      const row = editRows[i] ?? s.row
                      const cellErr = (field: string) => s.issues.some((iss) => iss.level === 'error' && iss.field === field)
                      const inputBase = 'w-full bg-transparent rounded-[var(--r-sm)] px-1.5 py-1 border'
                      return (
                        <tr key={i} className={`border-b border-[var(--color-border)] last:border-0 ${s.valid ? '' : 'bg-red-50/40'}`}>
                          <td className="py-1.5 px-2 min-w-[14rem]">
                            <input
                              value={row.title ?? ''}
                              onChange={(e) => updateField(i, 'title', e.target.value)}
                              placeholder="Título del producto"
                              className={`${inputBase} ${cellErr('title') ? 'border-red-300' : 'border-transparent hover:border-[var(--color-border)] focus:border-[var(--color-accent)]'}`}
                            />
                          </td>
                          <td className="py-1.5 px-2">
                            <select
                              value={row.category ?? ''}
                              onChange={(e) => updateField(i, 'category', e.target.value)}
                              className={`${inputBase} ${cellErr('category') ? 'border-red-300' : 'border-transparent hover:border-[var(--color-border)] focus:border-[var(--color-accent)]'}`}
                            >
                              <option value="">—</option>
                              {CATALOG_CATEGORY_KEYS.map((k) => (
                                <option key={k} value={k}>{k}</option>
                              ))}
                            </select>
                          </td>
                          <td className="py-1.5 px-2 w-24">
                            <input
                              value={row.price ?? ''}
                              onChange={(e) => updateField(i, 'price', e.target.value)}
                              inputMode="decimal"
                              placeholder="—"
                              className={`${inputBase} ${cellErr('price') ? 'border-red-300' : 'border-transparent hover:border-[var(--color-border)] focus:border-[var(--color-accent)]'}`}
                            />
                          </td>
                          <td className="py-1.5 px-2 w-28">
                            <input
                              value={row.external_id ?? ''}
                              onChange={(e) => updateField(i, 'external_id', e.target.value)}
                              placeholder="—"
                              className={`${inputBase} font-mono border-transparent hover:border-[var(--color-border)] focus:border-[var(--color-accent)]`}
                            />
                          </td>
                          <td className="py-1.5 px-2 w-16">
                            <input
                              value={row.quantity ?? ''}
                              onChange={(e) => updateField(i, 'quantity', e.target.value)}
                              inputMode="numeric"
                              placeholder="1"
                              className={`${inputBase} border-transparent hover:border-[var(--color-border)] focus:border-[var(--color-accent)]`}
                            />
                          </td>
                          <td className="py-1.5 px-3 whitespace-nowrap">
                            {!s.valid ? (
                              <span className="inline-block rounded-[var(--r-pill)] bg-red-100 text-red-700 px-2 py-0.5 font-semibold" title={s.issues.find((iss) => iss.level === 'error')?.message}>Corregir</span>
                            ) : isExisting(row.external_id) ? (
                              <span className="inline-block rounded-[var(--r-pill)] bg-amber-100 text-amber-700 px-2 py-0.5 font-semibold">Actualizar</span>
                            ) : (
                              <span className="inline-block rounded-[var(--r-pill)] bg-green-100 text-green-700 px-2 py-0.5 font-semibold">Nuevo</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {errorRowCount > 0 && (
                <p className="px-4 py-2 text-xs text-[var(--color-muted)] border-t border-[var(--color-border)]">
                  <i className="iconoir-light-bulb" aria-hidden /> Corrige los campos marcados en rojo aquí mismo, o vuelve a generar el texto con tu IA.
                </p>
              )}
              {importing && (
                <div className="px-4 py-3 border-t border-[var(--color-border)]">
                  <div className="h-2 rounded-[var(--r-pill)] bg-[var(--color-border)] overflow-hidden">
                    <div
                      className="h-full bg-[var(--color-accent)] transition-all"
                      style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Warnings (e.g. image URL format) */}
          {warningIssues.length > 0 && (
            <div className="space-y-2 mt-3">
              {warningIssues.map((issue, idx) => (
                <div key={idx} className="rounded-[var(--r-md)] border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  {issue.message}
                </div>
              ))}
            </div>
          )}

          {/* Import report — shared <SuccessCard> (F12 convergence, Sprint 2 · Story 2.2) */}
          {report && (() => {
            const created = report.filter((r) => r.status === 'created').length
            const updated = report.filter((r) => r.status === 'updated').length
            const failed = report.filter((r) => r.status === 'failed')
            const imagesFailed = report.reduce((sum, r) => sum + (r.images_failed ?? 0), 0)
            return (
              <div className="mt-4">
                <SuccessCard
                  headline="Tu catálogo está listo"
                  subcopy={`Creamos ${created} producto${created === 1 ? '' : 's'} nuevo${created === 1 ? '' : 's'}${updated > 0 ? ` y actualizamos ${updated}` : ''}${failed.length > 0 ? ` · ${failed.length} fallaron` : ''}.`}
                  counts={{ created, updated, failed: failed.length, draft: 0 }}
                  liveUrl={publicShopUrl || '/shop/manage'}
                  liveLabel={shopSlug ? 'Ver mi tienda pública ↗' : 'Ver mis anuncios →'}
                  warningCallout={!pagosConfigured ? {
                    text: 'Lo único que falta para vender: activa cómo cobrar. Son ~4 minutos con Mercado Pago.',
                    primaryAction: { label: 'Activar cobros ahora', href: '/shop/manage/settings/pagos' },
                    ghostAction: { label: 'Ir a mi Resumen', href: '/shop/manage' },
                  } : undefined}
                  nextActions={[{ label: 'Ver mis anuncios', href: '/shop/manage' }]}
                  shareUrl={publicShopUrl}
                />
                {imagesFailed > 0 && (
                  <p className="text-xs text-amber-700 mt-3 text-center">
                    <i className="iconoir-warning-triangle" aria-hidden /> {imagesFailed} imagen(es) no se pudieron traer y se dejaron con su enlace original.
                  </p>
                )}
                {failed.length > 0 && (
                  <div className="space-y-2 mt-3">
                    {failed.map((r) => (
                      <div key={r.line} className="rounded-[var(--r-md)] border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                        <strong>{r.title}</strong>: {r.reason}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}

export default function ImportClient({
  shopifyMigrationEnabled = false,
  shopSlug = null,
  pagosConfigured = false,
}: {
  shopifyMigrationEnabled?: boolean
  shopSlug?: string | null
  pagosConfigured?: boolean
}) {
  const prompt = buildCopilotPrompt()
  const exampleJson = JSON.stringify(EXAMPLE_CATALOG, null, 2)

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="mb-6">
        <SellerBreadcrumb />
        <h1 className="text-xl sm:text-2xl font-bold leading-tight mt-2">Importar catálogo</h1>
        <p className="text-sm text-[var(--color-muted)] mt-1">
          Trae toda tu tienda en minutos. Pega tu texto y deja que la IA lo arme, o sube un archivo que
          generó tu propio asistente — sin formatos complicados ni mapeos manuales.
        </p>
      </div>

      {/* ── Migrate from Shopify (epic 03 · platform-migrations S1) ─────────── */}
      {shopifyMigrationEnabled && (
        <Link
          href="/shop/manage/shopify/import"
          className="mb-4 flex items-center justify-between gap-3 rounded-[var(--r-lg)] border border-[var(--color-border)] p-5 hover:bg-[var(--surface-muted)] transition-colors"
        >
          <div>
            <h2 className="font-semibold mb-1 flex items-center gap-2">
              <i className="iconoir-shopping-bag text-xl" aria-hidden /> Migrar desde Shopify
            </h2>
            <p className="text-sm text-[var(--color-muted)]">
              Trae tu catálogo directamente desde el dominio de tu tienda Shopify — sin archivos ni copiar y pegar.
            </p>
          </div>
          <span className="text-[var(--color-accent)] font-semibold whitespace-nowrap">Empezar →</span>
        </Link>
      )}

      {/* ── Upload / paste + staging + import ───────────────────────────────── */}
      <Uploader shopSlug={shopSlug} pagosConfigured={pagosConfigured} />

      {/* ── Advanced path: use your own AI for big catalogs ─────────────────── */}
      <div className="mt-10 mb-4 pt-6 border-t border-[var(--color-border)]">
        <h2 className="font-semibold">¿Catálogo grande? Usa tu propia IA</h2>
        <p className="text-sm text-[var(--color-muted)] mt-1">
          Para catálogos extensos, copia este prompt en tu IA (Claude, ChatGPT o Gemini), genera un
          archivo y súbelo arriba. Así no hay límite de tamaño.
        </p>
      </div>

      {/* ── Step 1: Copilot prompt ──────────────────────────────────────────── */}
      <section className="border border-[var(--color-border)] rounded-[var(--r-lg)] p-5 mb-5">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="font-semibold flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-[var(--r-pill)] bg-[var(--accent)] text-[color:var(--fg-inverse)] text-xs font-bold">1</span>
            Copilot de catálogo
          </h2>
          <CopyButton text={prompt} label="Copiar prompt" />
        </div>
        <p className="text-sm text-[var(--color-muted)] mb-3">
          Copia este prompt y pégalo en tu IA favorita (Claude, ChatGPT o Gemini). Luego dale tus datos
          crudos —listas, notas, mensajes de proveedor, capturas o URLs— y te devolverá un archivo
          listo para subir.
        </p>
        <textarea
          readOnly
          value={prompt}
          onFocus={(e) => e.currentTarget.select()}
          rows={12}
          className="w-full font-mono text-xs leading-relaxed p-3 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--fg)] resize-y"
        />
        <p className="text-xs text-[var(--color-muted)] mt-2">
          <i className="iconoir-light-bulb" aria-hidden /> ¿Catálogo enorme? Si tus datos superan el límite de tu IA, súbelos primero a{' '}
          <a href="https://notebooklm.google.com" target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] hover:underline">NotebookLM</a>{' '}
          para condensarlos, y procésalos por partes. Máximo {MAX_IMPORT_ROWS} productos por archivo.
        </p>
      </section>

      {/* ── Step 2: Schema reference ────────────────────────────────────────── */}
      <section className="border border-[var(--border)] rounded-[var(--r-lg)] p-5 mb-5">
        <h2 className="font-semibold flex items-center gap-2 mb-1">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-[var(--r-pill)] bg-[var(--accent)] text-[color:var(--fg-inverse)] text-xs font-bold">2</span>
          Qué campos lleva cada producto
        </h2>
        <p className="text-sm text-[var(--color-muted)] mb-3">
          El prompt ya incluye este esquema. Esta tabla es solo para referencia.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-left text-[var(--color-muted)] border-b border-[var(--border)]">
                <th className="py-2 pr-3 font-semibold">Campo</th>
                <th className="py-2 pr-3 font-semibold">Tipo</th>
                <th className="py-2 pr-3 font-semibold">Req.</th>
                <th className="py-2 font-semibold">Notas</th>
              </tr>
            </thead>
            <tbody>
              {CATALOG_IMPORT_FIELDS.map((f) => (
                <tr key={f.name} className="border-b border-[var(--border)] align-top">
                  <td className="py-2 pr-3 font-mono">{f.name}</td>
                  <td className="py-2 pr-3 text-[var(--color-muted)]">{f.type}</td>
                  <td className="py-2 pr-3">
                    {f.required
                      ? <span className="text-red-600 font-semibold">sí</span>
                      : <span className="text-[var(--color-muted)]">no</span>}
                  </td>
                  <td className="py-2 text-[var(--color-muted)]">{f.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Step 3: Example ─────────────────────────────────────────────────── */}
      <section className="border border-[var(--border)] rounded-[var(--r-lg)] p-5 mb-5">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="font-semibold flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-[var(--r-pill)] bg-[var(--accent)] text-[color:var(--fg-inverse)] text-xs font-bold">3</span>
            Ejemplo de archivo
          </h2>
          <CopyButton text={exampleJson} label="Copiar ejemplo" />
        </div>
        <p className="text-sm text-[var(--color-muted)] mb-3">
          Así se ve un archivo válido. Tu IA debe devolver un arreglo JSON con esta forma.
        </p>
        <pre className="w-full font-mono text-xs leading-relaxed p-3 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--fg)] overflow-x-auto">
          {exampleJson}
        </pre>
      </section>
    </div>
  )
}
