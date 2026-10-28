'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  validateSetup,
  buildSetupPrompt,
  buildClerkPrompt,
  EXAMPLE_SETUP,
  SETUP_SPEC_VERSION,
  type MiyagiSetupFile,
} from '@/lib/setup-spec'
import ConnectAgentPanel from '@/components/ConnectAgentPanel'
import {
  planSetupApply,
  aggregateSetupReport,
  chunkFailureRows,
  type SetupApplyReport,
  type RowResult,
} from '@/lib/setup-apply'
import { CATALOG_CATEGORY_KEYS, validateRows, type CatalogImportRow } from '@/lib/catalog-import'
import { type BlockResult } from '@/lib/settings-import'
import { Button } from '@/components/ui/Button'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Card } from '@/components/ui/Card'
import { Banner } from '@/components/feedback/Banner'
import { consumeSetupFile } from '@/lib/onboarding-handoff'
import { slugify } from '@/lib/slug'
import { SuccessCard, SuccessCardProgress } from '@/components/SuccessCard'
import { pushAnalyticsEvent } from '@/lib/analytics-events'
import { getOnboardingElapsedMs } from '@/lib/onboarding-timing'
import { shopUrlFor } from '@/lib/market-url'
import { SITE_ORIGIN } from '@/lib/market-seo'

// ── Copy-to-clipboard (mirrors the import clients) ────────────────────────────
function CopyButton({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="primary"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1800)
        } catch {
          /* clipboard blocked — textarea is still selectable */
        }
      }}
    >
      {copied ? <><i className="iconoir-check" aria-hidden /> Copiado</> : <><i className="iconoir-copy" aria-hidden /> {label}</>}
    </Button>
  )
}

// ── Per-block result row (preview + report) — same shape as SettingsImportClient
function BlockRow({ b }: { b: BlockResult }) {
  const ok = b.status === 'applied'
  return (
    <Banner variant={ok ? 'success' : 'danger'}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{b.label}</span>
        <span className="text-xs font-semibold">
          {ok ? <><i className="iconoir-check" aria-hidden /> {b.appliedFields.length} campo(s)</> : <><i className="iconoir-xmark" aria-hidden /> omitido</>}
        </span>
      </div>
      {b.issues.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {b.issues.map((iss, i) => (
            <li key={i} className="text-xs">• {iss}</li>
          ))}
        </ul>
      )}
    </Banner>
  )
}

type ValidatedSetup = ReturnType<typeof validateSetup>
type SetupProfile = NonNullable<MiyagiSetupFile['profile']>

function FirstRunApply() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [pasteText, setPasteText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  // The parsed + validated setup file (staging preview source).
  const [file, setFile] = useState<MiyagiSetupFile | null>(null)
  const [validated, setValidated] = useState<ValidatedSetup | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Inline-fix working copies (S4) — edits patch these, never `file` itself;
  // `planSetupApply` is called unchanged, merged with these overrides right
  // before the call (same principle ImportClient.tsx already uses for its
  // own edit-then-submit flow — see updateField below).
  const [editCatalogRows, setEditCatalogRows] = useState<CatalogImportRow[]>([])
  const [profileOverrides, setProfileOverrides] = useState<Partial<SetupProfile>>({})
  const [editingProfile, setEditingProfile] = useState(false)
  // edits-per-approval (Sprint 3 · Story 3.3) — counts inline-fix ACTIONS (a
  // field touched), not a value-diff against the original; good enough for
  // "how much did the seller have to fix before approving."
  const [editCount, setEditCount] = useState(0)
  // Apply state
  const [applying, setApplying] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [report, setReport] = useState<SetupApplyReport | null>(null)

  // S4 approve rate (Story 3.3) — the "shown" half of the rate; fires once
  // per staging preview that actually renders (pairs with
  // `setup_staging_approved` in runApply()).
  useEffect(() => {
    if (validated && !report) pushAnalyticsEvent('setup_staging_shown')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!validated])

  function review(text: string, source: 'paste' | 'file', name?: string) {
    setError(null); setFile(null); setValidated(null); setReport(null)
    setEditCatalogRows([]); setProfileOverrides({}); setEditingProfile(false)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      setError('El texto no es un JSON válido. Pega el objeto completo que generó tu agente.')
      return
    }
    const v = validateSetup(parsed)
    if (!v.ok) {
      // Unknown/missing version or not an object — a clear error, no partial parse.
      setError(v.version_error ?? 'El archivo de configuración no es válido.')
      return
    }
    if (source === 'file' && name) setFileName(name)
    const parsedFile = parsed as MiyagiSetupFile
    setFile(parsedFile)
    setValidated(v)
    setEditCatalogRows((parsedFile.catalog ?? []).map((row) => ({ ...row })))
  }

  // Onboarding three-doors handoff (Sprint 1 · Story 1.3): a CSV/JSON dropped
  // on /sell/agente stashes its parsed MiyagiSetupFile text before routing
  // here. Consumed at most once (sessionStorage is cleared on read) — a
  // no-op for every other entry into this page (paste/upload unaffected).
  useEffect(() => {
    const stashed = consumeSetupFile()
    // sessionStorage is the external handoff source; consuming it once and
    // hydrating the review state is exactly the synchronization performed here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stashed) review(stashed, 'file', 'desde-tres-puertas.json')
  }, [])

  async function handleFile(f: File) {
    setFileName(null)
    if (f.size > 5 * 1024 * 1024) { setError('El archivo es muy grande (máx. 5 MB).'); return }
    try {
      review(await f.text(), 'file', f.name)
    } catch {
      setError('No se pudo leer el archivo. Intenta de nuevo.')
    }
  }

  // Re-validate the editable catalog rows live so an inline fix flips a row
  // to "Listo" — same shape as ImportClient.tsx's updateField.
  function updateField(i: number, field: keyof CatalogImportRow, raw: string) {
    setEditCount((c) => c + 1)
    setEditCatalogRows((prev) => prev.map((row, idx) => {
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

  function updateProfileField(field: 'name' | 'city' | 'state', raw: string) {
    setEditCount((c) => c + 1)
    setProfileOverrides((prev) => ({ ...prev, [field]: raw === '' ? undefined : raw }))
  }

  // Walk the plan over the EXISTING apply routes in order: shop → config → catalog.
  // Each step degrades gracefully; the combined report shows exactly what applied.
  async function runApply() {
    if (!file) return
    // S4 approve rate + edits-per-approval (Story 3.3) — fires on every
    // approve tap, whether or not the seller edited anything first.
    pushAnalyticsEvent('setup_staging_approved', { edits: editCount })
    setApplying(true); setError(null)
    // Merge the inline-fix overrides on top of the parsed file right before
    // building the plan — planSetupApply itself is unchanged.
    const effectiveFile: MiyagiSetupFile = {
      ...file,
      profile: { ...file.profile, ...profileOverrides },
      catalog: editCatalogRows.length ? editCatalogRows : file.catalog,
    }
    const plan = planSetupApply(effectiveFile)
    const totalRows = plan.catalogChunks.reduce((s, c) => s + c.length, 0)
    setProgress({ done: 0, total: totalRows })

    try {
      // 1 — create-shop-if-missing (idempotent: 201 created / 200 existed).
      const shopRes = await fetch('/api/sell/shop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(plan.shop),
      })
      const shopData = (await shopRes.json().catch(() => ({}))) as { shopSlug?: string; error?: string }
      const shopPart = { ok: shopRes.ok, status: shopRes.status, shopSlug: shopData.shopSlug ?? null }

      // The shop is the prerequisite for config + catalog — if it failed, stop here
      // (nothing else can apply) and report it.
      if (!shopRes.ok) {
        setError(shopData.error ?? 'No se pudo crear tu tienda. Inténtalo de nuevo.')
        setReport(aggregateSetupReport({ shop: shopPart, config: null, catalogChunks: [] }))
        return
      }

      // 2 — config (optional; a failed block never blocks the catalog).
      let configPart: { ok: boolean; blocks?: BlockResult[] } | null = null
      if (plan.configManifest) {
        const cRes = await fetch('/api/sell/settings-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ manifest: plan.configManifest }),
        })
        const cData = (await cRes.json().catch(() => ({}))) as { blocks?: BlockResult[] }
        configPart = { ok: cRes.ok, blocks: cData.blocks ?? [] }
      }

      // 3 — catalog in ≤25-row chunks; live progress; per-chunk graceful degrade.
      const chunkParts: Array<{ results?: RowResult[] }> = []
      let line = 1
      let done = 0
      for (const chunk of plan.catalogChunks) {
        try {
          const res = await fetch('/api/sell/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows: chunk }),
          })
          if (!res.ok) {
            const err = (await res.json().catch(() => ({}))) as { error?: string }
            chunkParts.push({ results: chunkFailureRows(chunk, line, err.error ?? `Error ${res.status}.`) })
          } else {
            const data = (await res.json()) as { results: RowResult[] }
            chunkParts.push({ results: data.results })
          }
        } catch {
          chunkParts.push({ results: chunkFailureRows(chunk, line, 'Se interrumpió la conexión.') })
        }
        line += chunk.length
        done += chunk.length
        setProgress({ done, total: totalRows })
        setReport(aggregateSetupReport({ shop: shopPart, config: configPart, catalogChunks: chunkParts }))
      }

      setReport(aggregateSetupReport({ shop: shopPart, config: configPart, catalogChunks: chunkParts }))
    } catch {
      setError('Algo falló al aplicar tu configuración. Revisa el reporte e inténtalo de nuevo.')
    } finally {
      setApplying(false)
    }
  }

  const catalogRows = editCatalogRows.length ? validateRows(editCatalogRows) : (validated?.catalog ?? [])
  const validRows = catalogRows.filter((s) => s.valid)
  const errorRows = catalogRows.filter((s) => !s.valid)
  const configBlocks = (validated?.config?.blocks ?? []).filter((b) => b.status === 'applied')
  const profileBlock = configBlocks.find((b) => b.key === 'profile')
  const shippingBlock = configBlocks.find((b) => b.key === 'shipping')
  const configIssueBlocks = (validated?.config?.blocks ?? []).filter((b) => b.issues.length > 0)
  const displayProfile: Partial<SetupProfile> = { ...file?.profile, ...profileOverrides }
  const shopNamePreview = displayProfile.name?.trim() || ''
  const slugPreview = shopNamePreview ? slugify(shopNamePreview) : null

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = '' }}
      />

      {/* ── Paste / upload the setup file ──────────────────────────────────── */}
      {!report && (
        <section className="border border-[var(--color-border)] rounded-[var(--r-lg)] p-5 mb-4">
          <h2 className="font-semibold mb-1 flex items-center gap-2">
            <i className="iconoir-sparks text-xl" aria-hidden /> Pega el archivo de tu agente
          </h2>
          <p className="text-sm text-[var(--color-muted)] mb-3">
            Tu agente ya armó tu tienda en un solo archivo. Pégalo aquí (o súbelo) y lo revisamos antes de
            crear tu tienda y tu catálogo de un jalón.
          </p>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={8}
            placeholder={'Pega aquí el objeto JSON completo: { "miyagi_setup_version": "1", "profile": {…}, "config": {…}, "catalog": [...] }'}
            className="w-full font-mono text-xs leading-relaxed p-3 rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--fg)] resize-y"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 mt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => inputRef.current?.click()}
            >
              o sube un archivo (.json)
            </Button>
            <button
              type="button"
              onClick={() => review(pasteText, 'paste')}
              disabled={!pasteText.trim()}
              className="btn btn-primary"
            >
              Revisar
            </button>
          </div>
          {fileName && <p className="text-xs text-[var(--color-muted)] mt-3"><i className="iconoir-page" aria-hidden /> {fileName}</p>}
        </section>
      )}

      {error && <Banner variant="danger" className="mt-2">{error}</Banner>}

      {/* ── Staging preview: Revisa y aprueba (S4) ─────────────────────────── */}
      {validated && !report && (
        <div className="mt-4">
          <h2 className="text-lg font-bold mb-1">Revisa tu tienda antes de crearla</h2>
          <p className="text-sm text-[var(--color-muted)] mb-4">Toca cualquier cosa para editarla.</p>

          {/* Tu tienda */}
          <Card variant="panel" className="p-4 mb-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                {displayProfile.logo_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={displayProfile.logo_url} alt="" className="w-12 h-12 rounded-[var(--r-pill)] object-cover shrink-0" />
                ) : (
                  <div className="w-12 h-12 rounded-[var(--r-pill)] bg-[var(--surface-muted)] flex items-center justify-center text-sm font-bold shrink-0">
                    {(shopNamePreview || 'MS').slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="font-semibold truncate">{shopNamePreview || '(se generará automáticamente)'}</p>
                  <p className="text-xs text-[var(--color-muted)] truncate">
                    {slugPreview ? shopUrlFor(SITE_ORIGIN, slugPreview) : 'tu enlace se genera al crear la tienda'}
                  </p>
                  {(displayProfile.city || displayProfile.state) && (
                    <p className="text-xs text-[var(--color-muted)]">
                      {[displayProfile.city, displayProfile.state].filter(Boolean).join(', ')}
                    </p>
                  )}
                </div>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditingProfile((v) => !v)}>
                {editingProfile ? 'Listo' : 'Editar'}
              </Button>
            </div>
            {editingProfile && (
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input
                  value={displayProfile.name ?? ''}
                  onChange={(e) => updateProfileField('name', e.target.value)}
                  placeholder="Nombre de tu tienda"
                  className="text-sm p-2 rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--fg)]"
                />
                <input
                  value={displayProfile.city ?? ''}
                  onChange={(e) => updateProfileField('city', e.target.value)}
                  placeholder="Ciudad"
                  className="text-sm p-2 rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--fg)]"
                />
                <input
                  value={displayProfile.state ?? ''}
                  onChange={(e) => updateProfileField('state', e.target.value)}
                  placeholder="Estado"
                  className="text-sm p-2 rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--fg)] sm:col-span-2"
                />
              </div>
            )}
          </Card>

          {/* Config chips */}
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <StatusBadge token={profileBlock ? 'success' : 'neutral'}>
              {profileBlock ? <><i className="iconoir-check" aria-hidden /> Diseño y colores</> : 'Diseño y colores'}
            </StatusBadge>
            <StatusBadge token={shippingBlock ? 'success' : 'neutral'}>
              {shippingBlock ? <><i className="iconoir-check" aria-hidden /> Políticas de envío</> : 'Políticas de envío'}
            </StatusBadge>
            <StatusBadge token="neutral">Cobros — después, ~4 min</StatusBadge>
          </div>

          {/* Config blocks that need attention (kept visible even though the
              chips above summarize the happy path — a block with issues still
              needs to surface its detail before the seller approves). */}
          {configIssueBlocks.length > 0 && (
            <div className="space-y-2 mb-3">
              {configIssueBlocks.map((b) => <BlockRow key={b.key} b={b} />)}
            </div>
          )}

          {/* Catálogo */}
          {catalogRows.length > 0 && (
            <div className="rounded-[var(--r-lg)] border border-[var(--border)] overflow-hidden mb-3">
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 bg-[var(--surface-muted)] border-b border-[var(--border)]">
                <p className="text-sm font-medium">
                  {validRows.length} {validRows.length === 1 ? 'listo' : 'listos'}
                  {errorRows.length > 0 && <span className="text-[var(--color-muted)] font-normal"> · {errorRows.length} por corregir</span>}
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[var(--color-muted)] border-b border-[var(--color-border)]">
                      <th className="py-2 px-3 font-semibold">Título</th>
                      <th className="py-2 px-3 font-semibold">Categoría</th>
                      <th className="py-2 px-3 font-semibold">Precio</th>
                      <th className="py-2 px-3 font-semibold">SKU</th>
                      <th className="py-2 px-3 font-semibold">Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {catalogRows.map((s, i) => {
                      const row = editCatalogRows[i] ?? s.row
                      const cellErr = (field: string) => s.issues.some((iss) => iss.level === 'error' && iss.field === field)
                      const inputBase = 'w-full bg-transparent rounded-[var(--r-sm)] px-1.5 py-1 border'
                      const reason = s.issues.find((iss) => iss.level === 'error')?.message
                      return (
                        <Fragment key={i}>
                          <tr className={`border-b border-[var(--color-border)] last:border-0 ${s.valid ? '' : 'bg-[var(--danger-soft)]'}`}>
                            <td className="py-1.5 px-2 min-w-[12rem]">
                              <input
                                value={row.title ?? ''}
                                onChange={(e) => updateField(i, 'title', e.target.value)}
                                placeholder="Título del producto"
                                className={`${inputBase} ${cellErr('title') ? 'border-[var(--danger)]' : 'border-transparent hover:border-[var(--color-border)] focus:border-[var(--color-accent)]'}`}
                              />
                            </td>
                            <td className="py-1.5 px-2">
                              <select
                                value={CATALOG_CATEGORY_KEYS.includes(row.category) ? row.category : ''}
                                onChange={(e) => updateField(i, 'category', e.target.value)}
                                className={`${inputBase} ${cellErr('category') ? 'border-[var(--danger)]' : 'border-transparent hover:border-[var(--color-border)] focus:border-[var(--color-accent)]'}`}
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
                                placeholder="a convenir"
                                className={`${inputBase} ${cellErr('price') ? 'border-[var(--danger)]' : 'border-transparent hover:border-[var(--color-border)] focus:border-[var(--color-accent)]'}`}
                              />
                            </td>
                            <td className="py-1.5 px-2 font-mono w-28">
                              <input
                                value={row.external_id ?? ''}
                                onChange={(e) => updateField(i, 'external_id', e.target.value)}
                                placeholder="—"
                                className={`${inputBase} font-mono border-transparent hover:border-[var(--color-border)] focus:border-[var(--color-accent)]`}
                              />
                            </td>
                            <td className="py-2 px-3 whitespace-nowrap">
                              {s.valid
                                ? <StatusBadge token="success">Listo</StatusBadge>
                                : <StatusBadge token="danger">Corregir</StatusBadge>}
                            </td>
                          </tr>
                          {!s.valid && reason && (
                            <tr className="border-b border-[var(--color-border)] last:border-0">
                              <td colSpan={5} className="px-3 pb-2 -mt-1">
                                <p className="text-xs" style={{ color: 'var(--warning)' }}><i className="iconoir-warning-triangle" aria-hidden /> {reason} — tócalo arriba para corregirlo.</p>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {applying && (
            <div className="mb-3">
              <SuccessCardProgress done={progress.done} total={progress.total} />
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={runApply}
              disabled={applying || (validRows.length === 0 && configBlocks.length === 0)}
              className="btn btn-primary"
            >
              {applying
                ? `Creando ${progress.done}/${progress.total}…`
                : validRows.length > 0
                  ? `Crear mi tienda con ${validRows.length} producto${validRows.length === 1 ? '' : 's'}`
                  : 'Crear mi tienda'}
            </button>
          </div>
          {errorRows.length > 0 && (
            <p className="text-xs text-[var(--color-muted)] mt-2 text-right">
              Lo que falta por corregir no se crea todavía — corrígelo arriba o vuelve a intentarlo cuando quieras.
            </p>
          )}
        </div>
      )}

      {/* ── Land-in-shop report ────────────────────────────────────────────── */}
      {report && <SetupReport report={report} />}
    </div>
  )
}

// ── The post-apply summary — shared <SuccessCard> (F12 convergence, Story 2.2) ──
function SetupReport({ report }: { report: SetupApplyReport }) {
  const { shop, shopSlug, config, catalog } = report
  const shopOk = shop !== 'failed'
  const publicShopUrl = shopSlug ? shopUrlFor(SITE_ORIGIN, shopSlug) : ''
  const failedRows = catalog.rows.filter((r) => r.status === 'failed')
  const configIssueBlocks = config.filter((b) => b.issues.length > 0)

  // time_to_first_product (Sprint 3 · Story 3.3) — fires once, only on a
  // genuine first successful apply (dedupeKey), diffed against the
  // Bienvenida-marked onboarding start (null for an existing seller who never
  // went through Bienvenida — no event fires, nothing to divide by zero).
  useEffect(() => {
    if (!shopOk || catalog.created <= 0) return
    const elapsedMs = getOnboardingElapsedMs()
    if (elapsedMs == null) return
    pushAnalyticsEvent('time_to_first_product', { elapsed_ms: elapsedMs }, { dedupeKey: 'time_to_first_product' })
  }, [shopOk, catalog.created])

  if (!shopOk) {
    return (
      <div className="mt-2 text-center">
        <div className="text-4xl mb-2"><i className="iconoir-warning-triangle" aria-hidden /></div>
        <h2 className="text-xl font-bold">No pudimos crear tu tienda</h2>
        {configIssueBlocks.length > 0 && (
          <div className="space-y-2 mt-4 text-left">
            {configIssueBlocks.map((b) => <BlockRow key={b.key} b={b} />)}
          </div>
        )}
        {failedRows.length > 0 && (
          <div className="space-y-2 mt-4 text-left">
            {failedRows.map((r, i) => (
              <Banner key={i} variant="danger">
                <strong>{r.title}</strong>: {r.reason}
              </Banner>
            ))}
          </div>
        )}
        <div className="flex justify-center mt-6">
          <Link href="/sell/setup" className="btn btn-secondary no-underline">Intentar de nuevo</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-2">
      <SuccessCard
        headline="Tu tienda está lista"
        subcopy={`Creamos tu tienda con ${catalog.created} producto${catalog.created === 1 ? '' : 's'} publicado${catalog.created === 1 ? '' : 's'}${catalog.failed > 0 ? ` · ${catalog.failed} no se pudo${catalog.failed === 1 ? '' : 'n'} crear (corrígelo abajo)` : ''}. Diseño y envíos quedaron configurados.`}
        counts={{ created: catalog.created, updated: catalog.updated, failed: catalog.failed, draft: 0 }}
        liveUrl={publicShopUrl || '/shop/manage'}
        warningCallout={{
          text: 'Lo único que falta para vender: activa cómo cobrar. Son ~4 minutos con Mercado Pago.',
          primaryAction: { label: 'Activar cobros ahora', href: '/shop/manage/settings/pagos/wizard' },
          ghostAction: { label: 'Ir a mi Resumen', href: '/shop/manage' },
        }}
        nextActions={[{ label: 'Ir a mi tienda', href: '/shop/manage' }]}
        shareUrl={publicShopUrl}
      />

      {/* Config blocks that need attention (kept below the card — the same
          "surface issues, don't bury them" treatment S4's staging chips use). */}
      {configIssueBlocks.length > 0 && (
        <div className="space-y-2 mt-4">
          {configIssueBlocks.map((b) => <BlockRow key={b.key} b={b} />)}
        </div>
      )}

      {/* Failed rows detail */}
      {failedRows.length > 0 && (
        <div className="space-y-2 mt-4">
          {failedRows.map((r, i) => (
            <Banner key={i} variant="danger">
              <strong>{r.title}</strong>: {r.reason}
            </Banner>
          ))}
        </div>
      )}

      {/* ── Close the loop: your agent as your shop clerk + what's next (Story 3) ── */}
      <LoopClose shopSlug={shopSlug} />
    </div>
  )
}

// ── Post-setup loop-close: clerk prompt + connect-agent + what's next ─────────────
function LoopClose({ shopSlug }: { shopSlug: string | null }) {
  const clerkPrompt = buildClerkPrompt()
  const publicShopUrl = shopSlug ? shopUrlFor(SITE_ORIGIN, shopSlug) : null
  return (
    <div className="mt-10 pt-6 border-t border-[var(--color-border)] space-y-6">
      <div className="text-center">
        <h3 className="text-lg font-bold">Deja que tu agente lleve tu tienda</h3>
        <p className="text-sm text-[var(--color-muted)] mt-1">
          Tu tienda ya está creada. Estos dos pasos hacen que tu propio agente la opere de aquí en adelante.
        </p>
      </div>

      {/* 1 — the copyable shop-clerk operate-prompt */}
      <section className="border border-[var(--color-border)] rounded-[var(--r-lg)] p-5">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h4 className="font-semibold flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-[var(--r-pill)] bg-[var(--color-accent)] text-white text-xs font-bold">1</span>
            Tu agente como tu dependiente
          </h4>
          <CopyButton text={clerkPrompt} label="Copiar prompt del dependiente" />
        </div>
        <p className="text-sm text-[var(--color-muted)] mb-3">
          Copia este prompt en tu IA (Claude u otro cliente MCP), junto con tu token de abajo, y tu agente
          podrá pulir, fijar precios, promover, resurtir y mantener tu tienda — en tu idioma.
        </p>
        <textarea
          readOnly
          value={clerkPrompt}
          onFocus={(e) => e.currentTarget.select()}
          rows={12}
          className="w-full font-mono text-xs leading-relaxed p-3 rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--fg)] resize-y"
        />
      </section>

      {/* 2 — the per-shop MCP token + config (reused ConnectAgentPanel) */}
      <section className="border border-[var(--color-border)] rounded-[var(--r-lg)] p-5">
        <h4 className="font-semibold flex items-center gap-2 mb-3">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-[var(--r-pill)] bg-[var(--color-accent)] text-white text-xs font-bold">2</span>
          Conecta tu agente
        </h4>
        <ConnectAgentPanel />
      </section>

      {/* 3 — what's next */}
      <section className="rounded-[var(--r-lg)] bg-[var(--surface-muted)] p-5">
        <h4 className="font-semibold mb-2">¿Qué sigue?</h4>
        <ul className="text-sm text-[var(--color-muted)] space-y-1.5">
          <li>
            <i className="iconoir-credit-card" aria-hidden /> <strong className="text-[var(--color-foreground)] font-medium">Agrega pagos</strong> — sigue
            siendo un paso manual. Configúralos en{' '}
            <Link href="/shop/manage/settings" className="text-[var(--color-accent)] hover:underline">ajustes de tu tienda</Link>.
          </li>
          <li>
            <i className="iconoir-link" aria-hidden /> <strong className="text-[var(--color-foreground)] font-medium">Comparte tu tienda</strong>
            {publicShopUrl
              ? <> — tu enlace público es <Link href={publicShopUrl} className="text-[var(--color-accent)] hover:underline">{publicShopUrl}</Link>.</>
              : <> desde el panel de tu tienda.</>}
          </li>
          <li>
            <i className="iconoir-cpu" aria-hidden /> <strong className="text-[var(--color-foreground)] font-medium">Deja que tu agente la lleve</strong> —
            con el prompt y el token de arriba, tu IA se encarga del día a día.
          </li>
        </ul>
      </section>
    </div>
  )
}

// ── Page wrapper: header + apply + the "how to get the file" reference ────────
export default function SetupClient() {
  const prompt = buildSetupPrompt()
  const exampleJson = JSON.stringify(EXAMPLE_SETUP, null, 2)

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="mb-6">
        <Link href="/sell" className="text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)] no-underline">
          ← Vender
        </Link>
        <h1 className="text-2xl font-bold leading-tight mt-2">Arma tu tienda con tu agente</h1>
        <p className="text-sm text-[var(--color-muted)] mt-1">
          Si tu agente de IA ya generó tu archivo de configuración, pégalo abajo y creamos tu tienda y tu
          catálogo en un solo paso. ¿Aún no lo tienes? Copia el prompt y dáselo a tu agente.
        </p>
        {/* The drop-anything intake lost its only way in when the three-doors chooser left (prompt-to-shop S3.3). */}
        <Link href="/sell/agente" className="inline-block text-xs text-[var(--color-accent)] hover:underline mt-2">
          ¿Tu catálogo está en un CSV o en Mercado Libre? Tráelo como lo tengas →
        </Link>
      </div>

      {/* Apply (paste/upload → staging → confirm → land-in-shop) */}
      <FirstRunApply />

      {/* How to produce the file — the S1 prompt + example, for sellers who don't have it yet */}
      <div className="mt-10 pt-6 border-t border-[var(--color-border)]">
        <section className="border border-[var(--color-border)] rounded-[var(--r-lg)] p-5 mb-5">
          <div className="flex items-start justify-between gap-3 mb-1">
            <h2 className="font-semibold flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-[var(--r-pill)] bg-[var(--color-accent)] text-white text-xs font-bold">1</span>
              Prompt para tu agente
            </h2>
            <CopyButton text={prompt} label="Copiar prompt" />
          </div>
          <p className="text-sm text-[var(--color-muted)] mb-3">
            Copia este prompt en tu IA (Claude, ChatGPT o Gemini), dale tus datos crudos (catálogo,
            capturas, notas) y te devolverá UN solo archivo. Pégalo arriba.
          </p>
          <textarea
            readOnly
            value={prompt}
            onFocus={(e) => e.currentTarget.select()}
            rows={12}
            className="w-full font-mono text-xs leading-relaxed p-3 rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--fg)] resize-y"
          />
        </section>

        <section className="border border-[var(--color-border)] rounded-[var(--r-lg)] p-5">
          <div className="flex items-start justify-between gap-3 mb-1">
            <h2 className="font-semibold flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-[var(--r-pill)] bg-[var(--color-accent)] text-white text-xs font-bold">2</span>
              Ejemplo de archivo (versión {SETUP_SPEC_VERSION})
            </h2>
            <CopyButton text={exampleJson} label="Copiar ejemplo" />
          </div>
          <pre className="w-full font-mono text-xs leading-relaxed p-3 rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--fg)] overflow-x-auto max-h-80">
            {exampleJson}
          </pre>
        </section>
      </div>
    </div>
  )
}
