'use client'

import { useCallback, useEffect, useState } from 'react'
import { shopUrlFor } from '@/lib/market-url'
import { SITE_ORIGIN } from '@/lib/market-seo'

/**
 * Promoter workspace — private preview + activation step
 * (founding-merchant-consent-previews S2). Only rendered when
 * `promoter.private_preview_enabled` is ON. Three things the promoter does here:
 *   1. Generate the opaque private preview link and share it with the merchant.
 *   2. Watch the consent state (delivered → approved / changes-requested / stale).
 *   3. Once there is a CURRENT approval, activate the shop — the exact approved
 *      snapshot goes public, once. Every gate is enforced server-side; this UI only
 *      reflects the server's `canActivate` decision.
 * Thin screen over /api/promoter/preview (GET state, POST mint, DELETE revoke) and
 * /api/promoter/preview/activate.
 */
type Shop = { shopId: string; slug: string; name: string }

type ChecklistItem = { key: string; label: string; required: boolean; done: boolean; action: string }

type State = {
  exists: boolean
  status?: string
  stale?: boolean
  staleReasons?: string[]
  approved?: boolean
  canActivate?: boolean
  activateReason?: string | null
  productCount?: number
  checklist?: ChecklistItem[]
  nextAction?: string | null
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador — aún no se comparte',
  delivered: 'Enviada al comerciante — en revisión',
  changes_requested: 'El comerciante pidió cambios',
  approved: 'Aprobada por el comerciante',
  invalidated: 'La propuesta cambió — requiere nueva aprobación',
  activated: 'Tienda activa (pública)',
}

export default function PreviewStep({ shop, n, relationshipId = null }: { shop: Shop; n: number; relationshipId?: string | null }) {
  const [state, setState] = useState<State | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'mint' | 'revoke' | 'activate' | 'refresh'>(null)
  const [consentBusy, setConsentBusy] = useState(false)
  const [consentNote, setConsentNote] = useState<string | null>(null)

  const loadState = useCallback(async () => {
    try {
      const res = await fetch(`/api/promoter/preview?shopId=${encodeURIComponent(shop.shopId)}`)
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.ok) setState(data as State)
    } catch { /* best-effort — the buttons still work */ }
  }, [shop.shopId])

  useEffect(() => {
    // The preview row is an external system snapshot; loading it is the effect's
    // synchronization job even though the async helper owns the eventual setState.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadState()
  }, [loadState])

  async function mint() {
    setBusy('mint'); setError(null)
    try {
      const res = await fetch('/api/promoter/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopId: shop.shopId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) { setError(data.error ?? 'No se pudo generar el enlace.'); return }
      setLink(data.url); setCopied(false)
      await loadState()
    } catch { setError('Error de red. Intenta de nuevo.') }
    finally { setBusy(null) }
  }

  async function revoke() {
    setBusy('revoke'); setError(null)
    try {
      const res = await fetch('/api/promoter/preview', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopId: shop.shopId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) { setError(data.error ?? 'No se pudo revocar el enlace.'); return }
      setLink(null)
    } catch { setError('Error de red. Intenta de nuevo.') }
    finally { setBusy(null) }
  }

  async function activate() {
    setBusy('activate'); setError(null)
    try {
      const res = await fetch('/api/promoter/preview/activate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopId: shop.shopId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) { setError(data.error ?? 'No se pudo activar la tienda.'); return }
      setLink(null)
      await loadState()
    } catch { setError('Error de red. Intenta de nuevo.') }
    finally { setBusy(null) }
  }

  async function copy() {
    if (!link) return
    try { await navigator.clipboard.writeText(link); setCopied(true) } catch { /* manual copy */ }
  }

  const status = state?.status
  const activated = status === 'activated'

  // The owner approved in person: recorded on their relationship (moved here from the old «Datos del comercio» form,
  // promoter-panel S2), then the state is read again so «Publicar» unlocks.
  async function registerConsent() {
    if (!relationshipId) return
    setConsentBusy(true); setConsentNote(null)
    try {
      const res = await fetch(`/api/promoter/relationship/${encodeURIComponent(relationshipId)}/consent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) { setConsentNote(data.error ?? 'No se pudo guardar. Revisa tu conexión e intenta otra vez.'); return }
      setConsentNote('Aprobada: ya puede publicarse.')
      await loadState()
    } catch { setConsentNote('No se pudo guardar. Revisa tu conexión e intenta otra vez.') }
    finally { setConsentBusy(false) }
  }

  return (
    <section className="rounded-lg border border-[var(--color-border)] p-4 space-y-3">
      <h2 className="font-semibold">
        <span className="text-[var(--color-muted)] mr-2">{n}.</span>Vista previa privada y activación
      </h2>
      {relationshipId && status && status !== 'approved' && status !== 'activated' ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={registerConsent} disabled={consentBusy} data-testid="panel-consent">
            {consentBusy ? 'Guardando…' : 'El dueño vio su tienda y está de acuerdo'}
          </button>
        </div>
      ) : null}
      {consentNote ? <p className="text-sm" role="status">{consentNote}</p> : null}

      {status && (
        <p className="text-sm">
          <span className="text-[var(--color-muted)]">Estado:</span>{' '}
          <span className="font-medium">{STATUS_LABEL[status] ?? status}</span>
          {typeof state?.productCount === 'number' && !activated && (
            <span className="text-[var(--color-muted)]"> · {state.productCount} producto{state.productCount === 1 ? '' : 's'}</span>
          )}
        </p>
      )}

      {state?.stale && (state.staleReasons?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-medium">La propuesta cambió después de aprobarse. Pide una nueva aprobación:</p>
          <ul className="mt-1 list-disc pl-5">
            {state.staleReasons!.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}

      {activated ? (
        <p className="text-sm text-[color:var(--success)]">
          <i className="iconoir-check-circle" aria-hidden /> La tienda ya es pública —{' '}
          <a className="underline" href={shopUrlFor(SITE_ORIGIN, shop.slug)} target="_blank" rel="noreferrer">{shopUrlFor(SITE_ORIGIN, shop.slug)}</a>.
        </p>
      ) : (
        <>
          <p className="text-sm text-[var(--color-muted)]">
            Comparte este enlace privado con el comerciante para que revise y apruebe. Nada es público
            hasta que apruebe y actives la tienda.
          </p>

          {link ? (
            <div className="space-y-2">
              <div className="flex gap-2">
                <input readOnly value={link}
                  className="flex-1 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-mono" />
                <button type="button" onClick={copy}
                  className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium">
                  {copied ? 'Copiado ✓' : 'Copiar'}
                </button>
              </div>
              <button type="button" onClick={revoke} disabled={busy !== null}
                className="text-xs underline text-[var(--color-muted)] disabled:opacity-50">
                {busy === 'revoke' ? 'Revocando…' : 'Revocar este enlace'}
              </button>
            </div>
          ) : (
            <button onClick={mint} disabled={busy !== null}
              className="rounded-lg bg-[var(--color-accent)] text-[var(--fg-inverse)] px-4 py-2 font-medium disabled:opacity-50">
              {busy === 'mint' ? 'Generando…' : 'Generar enlace de vista previa'}
            </button>
          )}

          {error && <p className="text-sm text-[color:var(--danger)]">{error}</p>}

          {(state?.checklist?.length ?? 0) > 0 && (
            <div className="border-t border-[var(--color-border)] pt-3">
              <p className="text-sm font-medium">Lista de verificación</p>
              <ul className="mt-2 space-y-1 text-sm">
                {state!.checklist!.map((item) => (
                  <li key={item.key} className={item.done ? 'text-[color:var(--success)]' : 'text-[var(--color-muted)]'}>
                    <i className={item.done ? 'iconoir-check-circle' : 'iconoir-circle'} aria-hidden />{' '}
                    <span className={item.done ? '' : 'font-medium'}>{item.label}</span>
                    {!item.done && <span className="block pl-5 text-xs">{item.action}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex items-center gap-3 border-t border-[var(--color-border)] pt-3">
            <button onClick={activate} disabled={busy !== null || !state?.canActivate}
              className="rounded-lg bg-[var(--color-accent)] text-[var(--fg-inverse)] px-4 py-2 font-medium disabled:opacity-50">
              {busy === 'activate' ? 'Activando…' : 'Activar tienda'}
            </button>
            <button onClick={() => { setBusy('refresh'); loadState().finally(() => setBusy(null)) }}
              disabled={busy !== null}
              className="text-sm underline text-[var(--color-muted)] disabled:opacity-50">
              Actualizar estado
            </button>
          </div>
          {!state?.canActivate && state?.activateReason && (
            <p className="text-xs text-[var(--color-muted)]">{state.activateReason}</p>
          )}
        </>
      )}
    </section>
  )
}
