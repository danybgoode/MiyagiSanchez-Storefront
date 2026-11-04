'use client'

import { useSellerFormat } from '@/app/components/SellerFormatProvider'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { MlHealth, MlHealthState } from '@/lib/ml-health'
import type { SanitizedMlConnection } from '@/lib/ml-connection'
import type { MlEventView } from '@/lib/ml-events-view'

/**
 * Mercado Libre connection status + actions (US-3; extended in S5 · US-13/14).
 * Presentational client island: the health badge + nickname, Conectar/Reconectar/
 * Desconectar, plus (S5) a re-auth prompt on `needs_reauth`, the two-way stock-sync
 * enable toggle (entitlement-gated → upsell when not entitled), and the per-seller
 * activity log. No token is ever present here.
 */

const STATE_STYLE: Record<MlHealthState, { color: string; bg: string; dot: string }> = {
  connected: { color: 'var(--success)', bg: 'var(--success-soft)', dot: 'var(--success)' },
  stale: { color: 'var(--warning)', bg: 'var(--warning-soft)', dot: 'var(--warning)' },
  expired: { color: 'var(--danger)', bg: 'var(--danger-soft)', dot: 'var(--danger)' },
  // A failed refresh: same urgency tone as expired — the seller must reconnect.
  needs_reauth: { color: 'var(--danger)', bg: 'var(--danger-soft)', dot: 'var(--danger)' },
  disconnected: { color: 'var(--fg-muted)', bg: 'var(--bg-sunk)', dot: 'var(--fg-subtle)' },
}

const ERROR_COPY: Record<string, string> = {
  oauth_state: 'No pudimos validar la sesión de conexión. Vuelve a intentarlo.',
  oauth_failed: 'Mercado Libre rechazó la conexión. Vuelve a intentarlo.',
  ml_no_config: 'La integración con Mercado Libre aún no está configurada. Contacta a soporte.',
}

export default function MercadoLibreStatus({
  connection,
  health,
  error,
  justConnected,
  importEnabled = false,
  syncEnabledFlag = false,
  syncEntitled = false,
  sellerSyncEnabled = false,
  events = [],
}: {
  connection: SanitizedMlConnection | null
  health: MlHealth
  error: string | null
  justConnected: boolean
  importEnabled?: boolean
  syncEnabledFlag?: boolean
  syncEntitled?: boolean
  sellerSyncEnabled?: boolean
  events?: MlEventView[]
}) {
  const fmt = useSellerFormat()
  const fmtDate = (iso: string | null) => {
    if (!iso) return '—'
    try {
      return fmt.date(iso, { dateStyle: 'medium', timeStyle: 'short' })
    } catch {
      return '—'
    }
  }
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncOn, setSyncOn] = useState(sellerSyncEnabled)
  const [syncError, setSyncError] = useState<string | null>(null)

  const isConnected = !!connection && connection.status === 'connected'
  const needsReauth = health.state === 'needs_reauth'
  const style = STATE_STYLE[health.state] ?? STATE_STYLE.disconnected

  async function toggleSync(next: boolean) {
    if (syncBusy) return
    setSyncBusy(true)
    setSyncError(null)
    try {
      const res = await fetch('/api/sell/ml/sync-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      if (res.status === 403) {
        setSyncError('La sincronización con Mercado Libre es una función de pago.')
        return
      }
      if (res.status === 409) {
        setSyncError('Conecta tu cuenta de Mercado Libre primero.')
        return
      }
      if (!res.ok) throw new Error('sync_toggle_failed')
      const d = (await res.json()) as { sync_enabled?: boolean }
      setSyncOn(d.sync_enabled === true)
      router.refresh()
    } catch {
      setSyncError('No se pudo actualizar la sincronización. Vuelve a intentarlo.')
    } finally {
      setSyncBusy(false)
    }
  }


  async function disconnect() {
    if (busy) return
    if (!confirm('¿Desconectar tu cuenta de Mercado Libre? Tendrás que volver a autorizarla para sincronizar.')) return
    setBusy(true)
    setActionError(null)
    try {
      const res = await fetch('/api/sell/ml/disconnect', { method: 'DELETE' })
      if (!res.ok) throw new Error('disconnect_failed')
      router.refresh()
    } catch {
      setActionError('No se pudo desconectar. Vuelve a intentarlo.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error && (
        <div style={{ padding: '12px 14px', borderRadius: 'var(--r-md)', background: 'var(--danger-soft)', color: 'var(--danger)', fontSize: 14 }}>
          {ERROR_COPY[error] ?? 'Ocurrió un error al conectar con Mercado Libre.'}
        </div>
      )}
      {justConnected && isConnected && !needsReauth && (
        <div style={{ padding: '12px 14px', borderRadius: 'var(--r-md)', background: 'var(--success-soft)', color: 'var(--success)', fontSize: 14 }}>
          ¡Listo! Tu cuenta de Mercado Libre quedó conectada.
        </div>
      )}
      {needsReauth && (
        <div style={{ padding: '12px 14px', borderRadius: 'var(--r-md)', background: 'var(--danger-soft)', color: 'var(--danger)', fontSize: 14 }}>
          <strong>Reconecta tu cuenta de Mercado Libre.</strong> Tu autorización dejó de ser válida
          (la revocaste o expiró), así que la sincronización está en pausa. Vuelve a conectar para reanudarla.
        </div>
      )}

      {/* Status card */}
      <div
        style={{
          padding: 18,
          borderRadius: 'var(--r-lg)',
          border: '1.5px solid var(--border)',
          background: 'var(--bg-elevated)',
          boxShadow: 'var(--shadow-1)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: isConnected ? 14 : 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: style.dot, flexShrink: 0 }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: style.color }}>{health.label_es}</span>
        </div>

        {isConnected ? (
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px', fontSize: 14, margin: 0 }}>
            <dt style={{ color: 'var(--fg-muted)' }}>Cuenta</dt>
            <dd style={{ margin: 0, fontWeight: 600 }}>{connection?.ml_nickname ?? connection?.ml_user_id}</dd>
            <dt style={{ color: 'var(--fg-muted)' }}>Última renovación</dt>
            <dd style={{ margin: 0 }}>{fmtDate(connection?.last_refreshed_at ?? null)}</dd>
            <dt style={{ color: 'var(--fg-muted)' }}>Vence</dt>
            <dd style={{ margin: 0 }}>{fmtDate(connection?.expires_at ?? null)}</dd>
          </dl>
        ) : (
          <p style={{ fontSize: 14, color: 'var(--fg-muted)', margin: '8px 0 0' }}>
            Aún no has conectado tu cuenta de Mercado Libre.
          </p>
        )}
      </div>

      {actionError && (
        <div style={{ color: 'var(--danger)', fontSize: 13 }}>{actionError}</div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {isConnected ? (
          <>
            {importEnabled && (
              <a
                href="/shop/manage/mercadolibre/import"
                style={{
                  padding: '10px 16px', borderRadius: 'var(--r-md)', fontSize: 14, fontWeight: 600,
                  background: 'var(--accent)', color: 'var(--fg-inverse)', textDecoration: 'none',
                }}
              >
                Importar mi catálogo
              </a>
            )}
            <a
              href="/api/sell/ml/connect"
              style={{
                padding: '10px 16px', borderRadius: 'var(--r-md)', fontSize: 14, fontWeight: 600,
                border: '1.5px solid var(--border)', color: 'var(--fg)', textDecoration: 'none',
              }}
            >
              Reconectar
            </a>
            <button
              type="button"
              onClick={disconnect}
              disabled={busy}
              style={{
                padding: '10px 16px', borderRadius: 'var(--r-md)', fontSize: 14, fontWeight: 600,
                border: '1.5px solid var(--danger)', color: 'var(--danger)', background: 'transparent',
                cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
              }}
            >
              {busy ? 'Desconectando…' : 'Desconectar'}
            </button>
          </>
        ) : (
          <a
            href="/api/sell/ml/connect"
            style={{
              padding: '10px 16px', borderRadius: 'var(--r-md)', fontSize: 14, fontWeight: 600,
              background: 'var(--accent)', color: 'var(--fg-inverse)', textDecoration: 'none',
            }}
          >
            Conectar Mercado Libre
          </a>
        )}
      </div>

      {/* Two-way stock sync — entitlement-gated toggle OR upsell (S5 · US-14).
          Same ml_sync grant also gates order materialization (ml-orders-native
          S2 · US-6) — a presentational note only, not a second paywall surface. */}
      {syncEnabledFlag && isConnected && (
        <div
          style={{
            padding: 18, borderRadius: 'var(--r-lg)', border: '1.5px solid var(--border)',
            background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-1)',
          }}
        >
          <h2 style={{ fontSize: 'var(--t-base)', fontWeight: 700, margin: '0 0 4px' }}>Sincronización de inventario y pedidos</h2>
          <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 14px' }}>
            Mantén tu existencia igual en Mercado Libre y en Miyagi — cada venta descuenta de ambos, sin vender de más.
            Tus pedidos de Mercado Libre también aparecen en tu bandeja de pedidos de Miyagi.
          </p>

          {syncEntitled ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button
                type="button"
                onClick={() => toggleSync(!syncOn)}
                disabled={syncBusy}
                aria-pressed={syncOn}
                style={{
                  padding: '10px 16px', borderRadius: 'var(--r-md)', fontSize: 14, fontWeight: 600,
                  border: syncOn ? '1.5px solid var(--danger)' : 'none',
                  background: syncOn ? 'transparent' : 'var(--accent)',
                  color: syncOn ? 'var(--danger)' : 'var(--fg-inverse)',
                  cursor: syncBusy ? 'default' : 'pointer', opacity: syncBusy ? 0.6 : 1,
                }}
              >
                {syncBusy ? 'Guardando…' : syncOn ? 'Desactivar sincronización' : 'Activar sincronización'}
              </button>
              <span style={{ fontSize: 13, fontWeight: 600, color: syncOn ? 'var(--success)' : 'var(--fg-muted)' }}>
                {syncOn ? 'Activada' : 'Desactivada'}
              </span>
            </div>
          ) : (
            <div style={{ padding: '12px 14px', borderRadius: 'var(--r-md)', background: 'var(--bg-sunk)', fontSize: 13 }}>
              <p style={{ margin: '0 0 10px', color: 'var(--fg)' }}>
                La sincronización automática de inventario viene incluida en Negocio (y en tu prueba de Negocio). Así no
                vendes de más en ninguno de los dos canales, y tus pedidos de Mercado Libre aparecen solos en tu
                bandeja de pedidos.
              </p>
              <a href="/shop/manage/negocio" className="btn btn-primary btn-sm">Ver Negocio →</a>
            </div>
          )}
          {syncError && <div style={{ color: 'var(--danger)', fontSize: 13, marginTop: 10 }}>{syncError}</div>}
        </div>
      )}

      {/* Per-seller sync activity log (S5 · US-13) */}
      {syncEnabledFlag && isConnected && events.length > 0 && (
        <div
          style={{
            padding: 18, borderRadius: 'var(--r-lg)', border: '1.5px solid var(--border)',
            background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-1)',
          }}
        >
          <h2 style={{ fontSize: 'var(--t-base)', fontWeight: 700, margin: '0 0 12px' }}>Actividad reciente</h2>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {events.map((e) => (
              <li key={e.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13 }}>
                <span
                  aria-hidden
                  style={{
                    width: 8, height: 8, borderRadius: '50%', marginTop: 5, flexShrink: 0,
                    background: e.tone === 'fail' ? 'var(--danger)' : 'var(--success)',
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <span style={{ fontWeight: 600, color: e.tone === 'fail' ? 'var(--danger)' : 'var(--fg)' }}>{e.label}</span>
                    <span style={{ color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>{e.when}</span>
                  </div>
                  {e.message && <div style={{ color: 'var(--fg-muted)', marginTop: 2 }}>{e.message}</div>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
