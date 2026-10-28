'use client'

/**
 * Métodos de pago (slug `pagos`) — extracted out of the ShopSettings monolith.
 * Bundles the four internal sections the `pagos` route revealed, in order:
 *   proteccion (Compra Protegida) · stripe · mercadopago · spei (pago directo).
 *
 * Behavior-preserving: every <section> below is verbatim from the monolith, and
 * each external request fires identically — Stripe links are the same `<a href>`s
 * (`/api/stripe/connect*`), MercadoPago connect is the same `<a href="/api/mp/connect">`,
 * disconnect is the same `DELETE /api/mp/connect`. Persistence is the `checkout`
 * slice this page owns (escrow_mode · bank_transfer · dimo · cash_pickup) plus
 * the top-level `stripe_enabled`, through useSettingsSave() — the PATCH route
 * deep-merges, so the Envíos-owned checkout fields (show_phone/phone/whatsapp_cta/
 * show_email) are untouched. `mp_enabled` has no control on this page (it never
 * changed in the monolith either), so the slice omits it — the column is left as-is.
 *
 * No payment secret reaches this component: it receives only the public MP flags
 * ({connected, enabled, live_mode}) and the public Stripe status — never tokens.
 */

import { useState } from 'react'
import { useSettingsSave } from '../_components/useSettingsSave'
import { Toast } from '@/components/feedback/Toast'
import { Banner } from '@/components/feedback/Banner'
import { Button } from '@/components/ui/Button'
import { SectionTitle } from '../_components/SectionTitle'
import { ToggleSwitch } from '../_components/ToggleSwitch'
import { CopyPromptButton } from '../_components/CopyPromptButton'
import type { ShopStripe, CheckoutSettings } from '@/lib/shop-settings/types'

// The CLABE rule and the bank list live in `lib/clabe.ts`, shared with the prompt-to-shop cobros chooser.
import { CLABE_LENGTH, MX_BANKS, clabeComplete, normalizeClabeInput } from '@/lib/clabe'

const ESCROW_OPTIONS: { key: 'off' | 'optional' | 'required'; label: string; desc: string; color: string }[] = [
  { key: 'off',      label: 'Desactivado',  desc: 'Sin Compra Protegida. El comprador paga directo al vendedor.',    color: 'border-[var(--neutral)] bg-[var(--neutral-soft)]' },
  { key: 'optional', label: 'Opcional',     desc: 'El comprador puede elegir activar la protección de pago.',        color: 'border-[var(--warning)] bg-[var(--warning-soft)]' },
  { key: 'required', label: 'Obligatorio',  desc: 'Todos los pagos pasan por Compra Protegida sin excepción.',       color: 'border-[var(--success)] bg-[var(--success-soft)]' },
]

export interface PagosInitial {
  stripe?: ShopStripe
  mercadopago?: { connected?: boolean; enabled?: boolean; live_mode?: boolean }
  /** The checkout slice — escrow_mode, bank_transfer, dimo, cash_pickup. */
  checkout?: CheckoutSettings | null
  /** Read-only — drives the "activa recolección" warning under cash-pickup. */
  local_pickup?: boolean
}

export default function Pagos({
  initial,
  stripeError,
  mpError,
}: {
  initial: PagosInitial
  stripeError?: string | null
  mpError?: string | null
}) {
  const { save, saving, toast, dismissToast, isDirty, markDirty } = useSettingsSave()
  const mark = markDirty

  async function handleMpDisconnect() {
    if (!confirm('¿Desconectar Mercado Pago? Dejarás de aceptar pagos con Mercado Pago hasta que lo reconectes.')) return
    try {
      await fetch('/api/mp/connect', { method: 'DELETE' })
    } catch { /* ignore */ }
    window.location.reload()
  }

  // ── Compra Protegida (escrow) ──────────────────────────────────────────────
  const [escrowMode, setEscrowMode]   = useState<'off' | 'optional' | 'required'>(initial.checkout?.escrow_mode ?? 'off')
  const [showEscrowExplainer, setShowEscrowExplainer] = useState(false)

  // ── Stripe ─────────────────────────────────────────────────────────────────
  const [stripeEnabled, setStripeEnabled]   = useState(initial.stripe?.enabled !== false)

  // ── Pago directo — SPEI / DiMo / efectivo al recoger ─────────────────────────
  const bt = initial.checkout?.bank_transfer ?? ({} as NonNullable<CheckoutSettings['bank_transfer']> & {})
  const [bankTransferEnabled, setBankTransferEnabled] = useState(bt?.enabled ?? false)
  const [clabe, setClabe]               = useState(bt?.clabe ?? '')
  const [bankName, setBankName]         = useState(bt?.bank_name ?? '')
  const [accountHolder, setAccountHolder] = useState(bt?.account_holder ?? '')
  const [bankIsOther, setBankIsOther]   = useState(!!bt?.bank_name && !(MX_BANKS as readonly string[]).includes(bt.bank_name))
  // Both are on `CheckoutSettings` now, so this reads the real type — the
  // hand-written cast that used to stand in here is gone, and with it its
  // guess that `phone` was a plain `string` (it is nullable, and production
  // holds nulls).
  // Read straight off the typed tree. An `?? {}` fallback would widen the
  // whole thing back to `{}` and lose every field, which is how the cast this
  // replaces came to exist in the first place.
  const dimoCfg = initial.checkout?.dimo
  const [dimoEnabled, setDimoEnabled]   = useState<boolean>(dimoCfg?.enabled ?? false)
  const [dimoPhone, setDimoPhone]       = useState<string>(dimoCfg?.phone ?? '')
  const cashCfg = initial.checkout?.cash_pickup
  const [cashPickupEnabled, setCashPickupEnabled] = useState<boolean>(cashCfg?.enabled ?? true)
  const [cashPickupNote, setCashPickupNote]       = useState<string>(cashCfg?.note ?? '')
  const localPickup = initial.local_pickup ?? true

  async function handleSave() {
    await save({
      stripe_enabled: stripeEnabled,
      settings: {
        checkout: {
          escrow_mode:    escrowMode,
          bank_transfer: {
            enabled:        bankTransferEnabled,
            clabe:          clabe.trim() || null,
            bank_name:      bankName.trim() || null,
            account_holder: accountHolder.trim() || null,
          },
          dimo: {
            enabled: dimoEnabled,
            phone:   dimoPhone.trim().replace(/\D/g, '') || null,
          },
          cash_pickup: {
            enabled: cashPickupEnabled,
            note:    cashPickupNote.trim() || null,
          },
        },
      },
    })
  }

  return (
    <div>
      {/* ════════════════════════════════════════════════════════════════════
          Compra Protegida (escrow)
      ════════════════════════════════════════════════════════════════════ */}
      <section id="proteccion" className="border border-[var(--color-border)] rounded-[var(--r-lg)] p-5 mb-5">
        <div className="flex items-center justify-between mb-3">
          <SectionTitle>Compra Protegida</SectionTitle>
          <div className="flex items-center gap-2 -mt-3">
            <CopyPromptButton prompt="¿Cómo funciona realmente un sistema de pago en custodia (escrow) en un marketplace? Quiero validar si es confiable antes de activarlo en mi tienda. Busca información en la documentación oficial de Stripe Connect: https://stripe.com/docs/connect — ¿Tiene Stripe algún mecanismo de retención de fondos? ¿Qué pasa si el comprador no confirma la recepción en 3 días? ¿Qué riesgos existen para el vendedor?" />
            <button
              type="button"
              onClick={() => setShowEscrowExplainer(v => !v)}
              className="text-xs text-[var(--color-accent)] hover:underline flex-shrink-0"
            >
              {showEscrowExplainer ? 'Ocultar' : '¿Qué es? →'}
            </button>
          </div>
        </div>

        {showEscrowExplainer && (
          <div className="mb-4 bg-[var(--info-soft)] border border-[var(--info)] rounded-[var(--r-lg)] p-4">
            <p className="text-xs font-semibold text-[var(--info)] mb-3">¿Cómo funciona Compra Protegida?</p>
            <div className="flex items-start gap-1 flex-wrap sm:flex-nowrap">
              {[
                { icon: 'iconoir-credit-card', title: 'Comprador paga',    desc: 'El monto se cobra de forma segura' },
                { icon: 'iconoir-lock', title: 'Fondos retenidos',  desc: 'El dinero queda en custodia temporal' },
                { icon: 'iconoir-package', title: 'Recibes el pago',   desc: 'Entrega el producto al comprador' },
                { icon: 'iconoir-check-circle', title: 'Confirma recepción', desc: 'Los fondos se liberan al vendedor' },
              ].map((step, i, arr) => (
                <div key={step.title} className="flex items-center gap-1">
                  <div className="text-center min-w-[72px]">
                    <div className="text-xl mb-1"><i className={step.icon} aria-hidden /></div>
                    <div className="text-[11px] font-semibold text-[var(--info)] leading-tight">{step.title}</div>
                    <div className="text-[10px] text-[var(--info)] leading-tight mt-0.5">{step.desc}</div>
                  </div>
                  {i < arr.length - 1 && <span className="text-[var(--info)] font-bold hidden sm:block mx-1">→</span>}
                </div>
              ))}
            </div>
            <p className="text-xs text-[var(--info)] mt-3 pt-2 border-t border-[var(--info)]">
              <i className="iconoir-light-bulb" aria-hidden /> Si el comprador no confirma la recepción en <strong>3 días hábiles</strong>, los fondos se liberan automáticamente. Powered by Stripe.
            </p>
          </div>
        )}

        <div className="space-y-2">
          {ESCROW_OPTIONS.map(opt => (
            <label
              key={opt.key}
              className={`flex items-center gap-3 p-3 rounded-[var(--r-md)] border-2 cursor-pointer transition-all ${
                escrowMode === opt.key
                  ? `border-[var(--color-accent)] ${opt.color}`
                  : 'border-[var(--color-border)] hover:border-gray-400'
              }`}
            >
              <input
                type="radio"
                name="escrow_mode"
                value={opt.key}
                checked={escrowMode === opt.key}
                onChange={() => { setEscrowMode(opt.key); mark() }}
                className="accent-[var(--color-accent)]"
              />
              <div>
                <div className="text-sm font-semibold">{opt.label}</div>
                <div className="text-xs text-[var(--color-muted)]">{opt.desc}</div>
              </div>
            </label>
          ))}
        </div>

        {escrowMode === 'required' && (
          <Banner variant="warning" className="mt-3 text-xs">
            <strong>Impacto para el comprador:</strong> El pago quedará retenido hasta que confirme haber recibido el producto. Algunos compradores pueden preferir tiendas sin esta restricción.
          </Banner>
        )}
        {escrowMode === 'off' && (
          <Banner variant="success" className="mt-3 text-xs">
            <strong>Impacto para el comprador:</strong> El pago va directo al vendedor al momento de pagar. El proceso es más rápido para el comprador.
          </Banner>
        )}
      </section>

      {/* ════════════════════════════════════════════════════════════════════
          Pagos con tarjeta (Stripe)
      ════════════════════════════════════════════════════════════════════ */}
      <section id="stripe" className="border border-[var(--color-border)] rounded-[var(--r-lg)] p-5 mb-5">
        <div className="flex items-center justify-between mb-1">
          <SectionTitle>Pagos con tarjeta (Stripe)</SectionTitle>
          <div className="-mt-3">
            <CopyPromptButton prompt="¿Es seguro conectar mi cuenta bancaria a Stripe Express en un marketplace de terceros? Verifica revisando la documentación oficial de Stripe Connect: https://stripe.com/docs/connect/express-accounts — ¿Qué acceso le da al marketplace sobre mi cuenta? ¿Cómo funciona el modelo Express? ¿Puedo desconectarme en cualquier momento? ¿Stripe cobra comisiones adicionales?" />
          </div>
        </div>
        <p className="text-xs text-[var(--color-muted)] mb-4">
          Acepta pagos con tarjeta directamente en tu tienda. Sin comisiones de plataforma — solo la tarifa estándar de Stripe.
        </p>

        {stripeError && (
          <Banner variant="danger" className="mb-4 text-xs">
            <span className="font-semibold">Error al conectar Stripe:</span>{' '}{stripeError}
          </Banner>
        )}

        {initial.stripe?.charges_enabled ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3 bg-[var(--success-soft)] border border-[var(--success)] rounded-[var(--r-md)] px-4 py-3">
              <div className="w-8 h-8 rounded-[var(--r-pill)] bg-[var(--success-soft)] flex items-center justify-center flex-shrink-0">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--success)]">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-[var(--success)]">Cuenta Stripe conectada</div>
                <div className="text-xs text-[var(--success)] mt-0.5">Tu cuenta está activa y lista para recibir pagos con tarjeta.</div>
              </div>
              <a href="/api/stripe/connect/dashboard" className="text-xs text-[var(--success)] underline hover:opacity-80 flex-shrink-0">
                Gestionar →
              </a>
            </div>
            <div className="border border-[var(--color-border)] rounded-[var(--r-md)] divide-y divide-[var(--color-border)]">
              <ToggleSwitch
                checked={stripeEnabled}
                onChange={v => { setStripeEnabled(v); mark() }}
                label="Aceptar pagos con tarjeta (Stripe)"
                description="Muestra el botón de pago con tarjeta en tus anuncios."
              />
            </div>
            {stripeEnabled ? (
              <Banner variant="success" className="text-xs">
                <p className="font-semibold">Lo que verán los compradores:</p>
                <p><i className="iconoir-check" aria-hidden /> Botón &ldquo;Pagar con tarjeta&rdquo; visible en cada anuncio</p>
                <p><i className="iconoir-check" aria-hidden /> Checkout seguro de Stripe — Visa, Mastercard, AMEX</p>
                <p><i className="iconoir-check" aria-hidden /> El pago llega a tu cuenta Stripe directamente</p>
              </Banner>
            ) : (
              <Banner variant="warning" className="text-xs">
                El botón de pago con tarjeta estará <strong>oculto</strong> en tus anuncios mientras esté desactivado.
              </Banner>
            )}
          </div>
        ) : initial.stripe?.account_id && !initial.stripe.onboarding_complete ? (
          <div className="bg-[var(--warning-soft)] border border-[var(--warning)] rounded-[var(--r-md)] px-4 py-4">
            <div className="flex items-start gap-3 mb-3">
              <i className="iconoir-warning-triangle text-xl" aria-hidden />
              <div>
                <div className="text-sm font-semibold text-[var(--warning)]">Configuración pendiente</div>
                <div className="text-xs text-[var(--warning)] mt-0.5">
                  Completa la configuración de tu cuenta Stripe para empezar a cobrar.
                </div>
              </div>
            </div>
            <a href={`/api/stripe/connect/refresh?account_id=${initial.stripe.account_id}`}
              className="flex items-center justify-center gap-2 w-full bg-[var(--warning)] text-white font-semibold py-2.5 rounded-[var(--r-md)] text-sm no-underline hover:opacity-90 transition-colors">
              Completar configuración →
            </a>
          </div>
        ) : (
          <div className="bg-[var(--color-surface-alt)] border border-[var(--color-border)] rounded-[var(--r-md)] px-4 py-4">
            <div className="flex items-start gap-3 mb-4">
              <i className="iconoir-credit-card text-2xl" aria-hidden />
              <div>
                <div className="text-sm font-semibold">Acepta tarjetas en tu tienda</div>
                <ul className="text-xs text-[var(--color-muted)] mt-1.5 space-y-0.5">
                  <li><i className="iconoir-check" aria-hidden /> Visa, Mastercard, AMEX</li>
                  <li><i className="iconoir-check" aria-hidden /> 0% comisión de plataforma</li>
                  <li><i className="iconoir-check" aria-hidden /> Pagos directos a tu cuenta bancaria</li>
                  <li><i className="iconoir-check" aria-hidden /> Configuración en 2 minutos</li>
                </ul>
              </div>
            </div>
            <a href="/api/stripe/connect"
              className="btn btn-primary flex items-center justify-center gap-2 w-full">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/>
              </svg>
              Conectar Stripe
            </a>
            <p className="text-[10px] text-center text-[var(--color-muted)] mt-2">
              Serás redirigido a Stripe para crear o conectar tu cuenta.
            </p>
          </div>
        )}
      </section>

      {/* ════════════════════════════════════════════════════════════════════
          MercadoPago
      ════════════════════════════════════════════════════════════════════ */}
      <section id="mercadopago" className="border border-[var(--color-border)] rounded-[var(--r-lg)] p-5 mb-5">
        <div className="flex items-center justify-between mb-1">
          <SectionTitle>Mercado Pago</SectionTitle>
          <div className="-mt-3">
            <CopyPromptButton prompt="¿Cómo funciona Mercado Pago Checkout Pro para vendedores en México? Verifica con la documentación oficial: https://www.mercadopago.com.mx/developers/es/docs — ¿Qué métodos de pago incluye? ¿Hay comisiones para el vendedor? ¿Cuándo recibe el dinero el vendedor? ¿Es confiable para un marketplace?" />
          </div>
        </div>
        <p className="text-xs text-[var(--color-muted)] mb-4">
          Conecta tu cuenta de Mercado Pago para aceptar tarjeta, OXXO, wallet y meses sin intereses. El dinero llega directo a tu cuenta — sin comisiones de plataforma.
        </p>

        {mpError && (
          <Banner variant="danger" className="mb-4 text-xs">
            <span className="font-semibold">Error al conectar Mercado Pago:</span>{' '}{mpError}
          </Banner>
        )}

        {initial.mercadopago?.connected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3 bg-[var(--success-soft)] border border-[var(--success)] rounded-[var(--r-md)] px-4 py-3">
              <div className="w-8 h-8 rounded-[var(--r-pill)] bg-[var(--success-soft)] flex items-center justify-center flex-shrink-0">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--success)]">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-[var(--success)]">Mercado Pago conectado</div>
                <div className="text-xs text-[var(--success)] mt-0.5">Tu cuenta está lista. Los pagos llegan directo a tu cuenta de Mercado Pago.</div>
              </div>
              <div className="flex flex-col items-end gap-1 flex-shrink-0">
                <a href="https://www.mercadopago.com.mx/activities" target="_blank" rel="noreferrer" className="text-xs text-[var(--success)] underline hover:opacity-80">
                  Ver mi cuenta →
                </a>
                <button type="button" onClick={handleMpDisconnect} className="text-xs text-[var(--danger)] underline hover:opacity-80">
                  Desconectar
                </button>
              </div>
            </div>
            <Banner variant="info" className="text-xs">
              <p className="font-semibold">Lo que verán los compradores:</p>
              <p><i className="iconoir-check" aria-hidden /> Botón &ldquo;Pagar con Mercado Pago&rdquo; en tus anuncios</p>
              <p><i className="iconoir-check" aria-hidden /> Tarjeta, OXXO, saldo MP, meses sin intereses</p>
              <p><i className="iconoir-check" aria-hidden /> El pago llega directo a tu cuenta de Mercado Pago</p>
            </Banner>
            {initial.mercadopago?.live_mode === false && (
              <Banner variant="warning" className="text-xs">
                Conectado en modo de prueba (sandbox).
              </Banner>
            )}
          </div>
        ) : (
          <div className="bg-[var(--color-surface-alt)] border border-[var(--color-border)] rounded-[var(--r-md)] px-4 py-4">
            <div className="flex items-start gap-3 mb-4">
              <i className="iconoir-circle text-2xl" aria-hidden />
              <div>
                <div className="text-sm font-semibold">Conecta tu cuenta de Mercado Pago</div>
                <ul className="text-xs text-[var(--color-muted)] mt-1.5 space-y-0.5">
                  <li><i className="iconoir-check" aria-hidden /> Tarjeta, OXXO, saldo MP, meses sin intereses</li>
                  <li><i className="iconoir-check" aria-hidden /> 0% comisión de plataforma</li>
                  <li><i className="iconoir-check" aria-hidden /> El dinero llega directo a tu cuenta</li>
                  <li><i className="iconoir-check" aria-hidden /> Checkout familiar para compradores mexicanos</li>
                </ul>
              </div>
            </div>
            <a href="/api/mp/connect"
              className="flex items-center justify-center gap-2 w-full bg-[var(--provider-mercadopago)] text-[var(--fg-inverse)] font-semibold py-2.5 rounded-[var(--r-md)] text-sm no-underline hover:opacity-90 transition-opacity">
              Conectar Mercado Pago
            </a>
            <p className="text-[10px] text-center text-[var(--color-muted)] mt-2">
              Serás redirigido a Mercado Pago para autorizar la conexión.
            </p>
          </div>
        )}
      </section>

      {/* ════════════════════════════════════════════════════════════════════
          Transferencia bancaria (SPEI) — pago directo al vendedor
      ════════════════════════════════════════════════════════════════════ */}
      <section id="spei" className="border border-[var(--color-border)] rounded-[var(--r-lg)] p-5 mb-5">
        <div className="flex items-center justify-between mb-1">
          <SectionTitle>Pago directo al vendedor</SectionTitle>
          <div className="-mt-3">
            <CopyPromptButton prompt="¿Es seguro compartir mi CLABE interbancaria con compradores en línea en México? ¿Qué puede hacer alguien con mi CLABE? Verifica con información oficial del sistema SPEI del Banco de México: https://www.banxico.org.mx/sistemas-de-pago/spei.html — ¿Es reversible una transferencia SPEI? ¿Qué riesgos tiene este método de pago para el vendedor?" />
          </div>
        </div>
        <p className="text-xs text-[var(--color-muted)] mb-4">
          El comprador te paga directamente (sin protección de Miyagi). Tú confirmas el pago manualmente antes de entregar. Elige los métodos que aceptas.
        </p>
        <div className="divide-y divide-[var(--color-border)]">
          <ToggleSwitch
            checked={bankTransferEnabled}
            onChange={v => { setBankTransferEnabled(v); mark() }}
            label="Transferencia SPEI (CLABE)"
            description="Aparecerá como opción de pago en tus anuncios."
          />
        </div>

        {bankTransferEnabled && (
          <div className="mt-4 space-y-3">
            <div>
              <label className="block text-sm font-medium mb-1">
                CLABE interbancaria <span className="text-[var(--danger)]">*</span>
              </label>
              <input
                value={clabe}
                onChange={e => { setClabe(normalizeClabeInput(e.target.value)); mark() }}
                maxLength={CLABE_LENGTH}
                placeholder="18 dígitos"
                className="w-full border border-[var(--color-border)] rounded-[var(--r-sm)] px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              />
              {clabe && !clabeComplete(clabe) && (
                <p className="text-[var(--warning)] text-xs mt-1"><i className="iconoir-warning-triangle" aria-hidden /> La CLABE debe tener exactamente 18 dígitos ({clabe.length}/{CLABE_LENGTH})</p>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Banco</label>
                <select
                  value={bankIsOther ? 'Otro' : bankName}
                  onChange={e => {
                    const v = e.target.value
                    if (v === 'Otro') { setBankIsOther(true); setBankName('') }
                    else { setBankIsOther(false); setBankName(v) }
                    mark()
                  }}
                  className="w-full border border-[var(--color-border)] rounded-[var(--r-sm)] px-3 py-2 text-sm bg-[var(--color-surface)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                >
                  <option value="">Selecciona tu banco…</option>
                  {MX_BANKS.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
                {bankIsOther && (
                  <input
                    value={bankName}
                    onChange={e => { setBankName(e.target.value); mark() }}
                    placeholder="Nombre del banco"
                    className="w-full mt-2 border border-[var(--color-border)] rounded-[var(--r-sm)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                  />
                )}
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Titular de la cuenta</label>
                <input
                  value={accountHolder}
                  onChange={e => { setAccountHolder(e.target.value); mark() }}
                  placeholder="Nombre completo"
                  className="w-full border border-[var(--color-border)] rounded-[var(--r-sm)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                />
              </div>
            </div>
            {clabe && clabeComplete(clabe) ? (
              <div className="bg-[var(--info-soft)] border border-[var(--info)] rounded-[var(--r-md)] px-3 py-2.5 text-xs text-[var(--info)] space-y-1">
                <p className="font-semibold">Vista previa — lo que verá el comprador:</p>
                <div className="bg-[var(--bg-elevated)] border border-[var(--info)] rounded-[var(--r-sm)] px-3 py-2 space-y-0.5 font-mono">
                  <p>CLABE: <span className="font-semibold">{clabe}</span></p>
                  {bankName && <p>Banco: {bankName}</p>}
                  {accountHolder && <p>Titular: {accountHolder}</p>}
                </div>
                <p className="font-normal">Confirma el pago en tu banco antes de entregar el producto.</p>
              </div>
            ) : (
              <Banner variant="neutral" className="text-xs">
                <i className="iconoir-light-bulb" aria-hidden /> El comprador verá la CLABE al momento de pagar. Confirma el pago en tu cuenta antes de enviar o entregar.
              </Banner>
            )}
          </div>
        )}

        {/* DiMo — transfer by phone number */}
        <div className="divide-y divide-[var(--color-border)] mt-2">
          <ToggleSwitch
            checked={dimoEnabled}
            onChange={v => { setDimoEnabled(v); mark() }}
            label="DiMo (transferencia por teléfono)"
            description="El comprador transfiere a tu número de teléfono vía DiMo / CoDi."
          />
        </div>
        {dimoEnabled && (
          <div className="mt-3">
            <label className="block text-sm font-medium mb-1">
              Teléfono DiMo <span className="text-[var(--danger)]">*</span>
            </label>
            <input
              value={dimoPhone}
              onChange={e => { setDimoPhone(e.target.value.replace(/\D/g, '').slice(0, 10)); mark() }}
              inputMode="tel"
              maxLength={10}
              placeholder="10 dígitos"
              className="w-full border border-[var(--color-border)] rounded-[var(--r-sm)] px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            />
            {dimoPhone && dimoPhone.length !== 10 && (
              <p className="text-[var(--warning)] text-xs mt-1"><i className="iconoir-warning-triangle" aria-hidden /> El teléfono debe tener 10 dígitos ({dimoPhone.length}/10)</p>
            )}
          </div>
        )}

        {/* Efectivo al recoger — only meaningful with local pickup */}
        <div className="divide-y divide-[var(--color-border)] mt-2">
          <ToggleSwitch
            checked={cashPickupEnabled}
            onChange={v => { setCashPickupEnabled(v); mark() }}
            label="Efectivo al recoger"
            description="El comprador paga en efectivo al recoger su pedido."
          />
        </div>
        {cashPickupEnabled && !localPickup && (
          <p className="text-[var(--warning)] text-xs mt-2">
          <i className="iconoir-warning-triangle" aria-hidden /> Activa “Recolección en mano” en Envíos para que esta opción aparezca en el checkout.
          </p>
        )}
        {cashPickupEnabled && (
          <div className="mt-3">
            <label className="block text-sm font-medium mb-1">Instrucciones (opcional)</label>
            <input
              value={cashPickupNote}
              onChange={e => { setCashPickupNote(e.target.value); mark() }}
              placeholder="Ej. Trae el monto exacto"
              className="w-full border border-[var(--color-border)] rounded-[var(--r-sm)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            />
          </div>
        )}
      </section>

      {/* ── Save button ───────────────────────────────────────────────────── */}
      {/* Back affordance now lives in the top-of-page breadcrumb (<SellerBreadcrumb>). */}
      <div className="flex items-center justify-end mb-24">
        <Button type="button" variant="primary" onClick={handleSave} loading={saving}>
          {saving ? 'Guardando…' : 'Guardar cambios'}
        </Button>
      </div>

      {/* ── Sticky unsaved bar ────────────────────────────────────────────────── */}
      {isDirty && (
        <div className="fixed bottom-0 inset-x-0 z-40 bg-[var(--bg-elevated)] border-t border-[var(--color-border)] shadow-lg">
          <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
              <span className="w-2 h-2 rounded-[var(--r-pill)] bg-[var(--warning)] flex-shrink-0" />
              Tienes cambios sin guardar
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => window.location.reload()}>
                Descartar
              </Button>
              <Button type="button" variant="primary" size="sm" onClick={handleSave} loading={saving}>
                Guardar
              </Button>
            </div>
          </div>
        </div>
      )}

      {toast && <Toast toast={toast} onDismiss={dismissToast} />}
    </div>
  )
}
