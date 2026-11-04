'use client'

/**
 * DomainPaywallUpsell — shown when a shop may not connect a custom domain. The custom domain is part of NEGOCIO now
 * (epic 08 · plans-gratis-negocio, D5; Daniel, 2026-11-04) and is not sold on its own, so this is a pointer to
 * «Tu suscripción», not a checkout. A merchant whose own domain lapsed is told how to get it back the same way.
 *
 * Props are kept so the caller (`CanalPropioClient`) is unchanged.
 */
export default function DomainPaywallUpsell({
  domainLapsed,
}: {
  /** True when a previously-active custom-domain subscription lapsed. */
  domainLapsed: boolean
  promoterEnabled?: boolean
}) {
  return (
    <div className="mt-3 border border-[var(--color-border)] rounded-[var(--r-lg)] p-4 bg-[var(--color-surface-alt)]" data-testid="domain-negocio-upsell">
      <p className="text-sm font-semibold mb-1">Dominio propio</p>
      <p className="text-xs text-[var(--color-muted)] leading-relaxed mb-3">
        {domainLapsed
          ? 'Tu dominio propio se desconectó. Para volver a conectarlo, activa Negocio: el dominio propio viene incluido.'
          : 'Conecta tu propio dominio (tutienda.com). Viene incluido en Negocio, junto con Mercado Libre y más ayuda de la IA.'}
      </p>
      <a href="/shop/manage/negocio" className="btn btn-primary btn-sm">Ver Negocio →</a>
    </div>
  )
}
