'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/feedback/Banner'
import { validateSetup, buildSetupPrompt, SETUP_SPEC_VERSION, type MiyagiSetupFile } from '@/lib/setup-spec'
import { parseCatalogFile } from '@/lib/catalog-import'
import { stashSetupFile } from '@/lib/onboarding-handoff'

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
          /* clipboard blocked — nothing else to do here */
        }
      }}
    >
      {copied ? <><i className="iconoir-check" aria-hidden /> Copiado</> : <><i className="iconoir-copy" aria-hidden /> {label}</>}
    </Button>
  )
}

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|heic)$/i

export default function AgenteIntakeClient({ mlConnected }: { mlConnected: boolean }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')

  function proceedWithSetupFile(rawText: string) {
    stashSetupFile(rawText)
    router.push('/sell/setup')
  }

  function processFileText(text: string, fileName: string) {
    setError(null)

    // Sniff: a full MiyagiSetupFile declares its version explicitly. Anything
    // else (CSV, or a bare JSON array/object of products) is catalog-only.
    let fullSetupCandidate: unknown = null
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'miyagi_setup_version' in parsed) {
        fullSetupCandidate = parsed
      }
    } catch {
      // not JSON at all — falls through to the catalog-only path (CSV)
    }

    if (fullSetupCandidate !== null) {
      const v = validateSetup(fullSetupCandidate)
      if (!v.ok) {
        setError(v.version_error ?? 'El archivo no es válido.')
        return
      }
      proceedWithSetupFile(text)
      return
    }

    const parsed = parseCatalogFile(text, fileName)
    if (parsed.fileErrors.length > 0) {
      setError(parsed.fileErrors[0].message)
      return
    }
    if (parsed.staged.length === 0) {
      setError('No encontramos productos en el archivo.')
      return
    }
    const setupFile: MiyagiSetupFile = {
      miyagi_setup_version: SETUP_SPEC_VERSION,
      catalog: parsed.staged.map((s) => s.row),
    }
    proceedWithSetupFile(JSON.stringify(setupFile))
  }

  async function handleFile(f: File) {
    setError(null)
    if (f.size > 5 * 1024 * 1024) { setError('El archivo es muy grande (máx. 5 MB).'); return }
    if (IMAGE_EXT_RE.test(f.name)) {
      setError('Por ahora solo aceptamos CSV o JSON — fotos y capturas llegan pronto.')
      return
    }
    setBusy(true)
    try {
      const text = await f.text()
      processFileText(text, f.name)
    } catch {
      setError('No se pudo leer el archivo. Intenta de nuevo.')
    } finally {
      setBusy(false)
    }
  }

  function handleReviewPaste() {
    setError(null)
    let parsed: unknown
    try {
      parsed = JSON.parse(pasteText)
    } catch {
      setError('El texto no es un JSON válido.')
      return
    }
    const v = validateSetup(parsed)
    if (!v.ok) {
      setError(v.version_error ?? 'El archivo de configuración no es válido.')
      return
    }
    proceedWithSetupFile(pasteText)
  }

  const prompt = buildSetupPrompt()

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '24px 0 48px' }}>
      {/* Back to the first run: the three-doors chooser this used to return to left the main path (prompt-to-shop S3.3). */}
      <Link href="/sell" className="text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)] no-underline">
        ← Volver
      </Link>
      <h1 className="text-2xl font-bold leading-tight mt-2">Trae tu catálogo como lo tengas</h1>
      <p className="text-sm text-[var(--color-muted)] mt-1">
        Nada se crea todavía — primero te mostramos el borrador completo.
      </p>

      {error && <Banner variant="danger" className="mt-4">{error}</Banner>}

      <input
        ref={inputRef}
        type="file"
        accept=".csv,.json,text/csv,application/json"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = '' }}
      />

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const f = e.dataTransfer.files?.[0]
          if (f) handleFile(f)
        }}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click() }
        }}
        role="button"
        tabIndex={0}
        className="mt-5 rounded-[var(--r-lg)] border-2 border-dashed p-10 text-center cursor-pointer transition-colors"
        style={{
          borderColor: dragOver ? 'var(--accent)' : 'var(--color-border)',
          background: dragOver ? 'var(--accent-soft)' : 'var(--bg-elevated)',
        }}
      >
        <i className="iconoir-cloud-upload" style={{ fontSize: 32, color: 'var(--accent)' }} />
        <p className="font-semibold mt-2">{busy ? 'Revisando…' : 'Arrastra tu CSV o JSON aquí'}</p>
        <p className="text-xs text-[var(--color-muted)] mt-1">
          o haz clic para elegir un archivo · fotos y capturas, próximamente
        </p>
      </div>

      {mlConnected && (
        <Card variant="tile" className="mt-3 p-4 flex items-center justify-between gap-3">
          <div>
            <p className="font-semibold text-sm">Traer de Mercado Libre</p>
            <p className="text-xs text-[var(--color-muted)]">Sincroniza tu catálogo desde tu cuenta conectada.</p>
          </div>
          <Link href="/shop/manage/mercadolibre" className="btn btn-secondary btn-sm no-underline">Abrir →</Link>
        </Card>
      )}

      <Card variant="tile" className="mt-3 p-4 flex items-center justify-between gap-3">
        <div>
          <p className="font-semibold text-sm">¿Ya tienes tu IA lista?</p>
          <p className="text-xs text-[var(--color-muted)]">Copia el prompt y dáselo a tu agente.</p>
        </div>
        <CopyButton text={prompt} label="Copiar prompt" />
      </Card>

      <div className="mt-5">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)] underline"
        >
          {advancedOpen ? 'Ocultar opción avanzada' : 'Opción avanzada: pegar JSON'}
        </button>
        {advancedOpen && (
          <div className="mt-3">
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={8}
              placeholder='Pega aquí el objeto JSON completo: { "miyagi_setup_version": "1", "profile": {…}, "config": {…}, "catalog": [...] }'
              className="w-full font-mono text-xs leading-relaxed p-3 rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--fg)] resize-y"
            />
            <div className="flex justify-end mt-2">
              <Button type="button" variant="secondary" onClick={handleReviewPaste} disabled={!pasteText.trim()}>
                Revisar
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
