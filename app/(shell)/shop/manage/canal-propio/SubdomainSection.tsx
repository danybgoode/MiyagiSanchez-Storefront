'use client'

/**
 * SubdomainSection — the subdomain is FREE on every plan (epic 08 · plans-gratis-negocio S2.4, README D11; Daniel,
 * 2026-11-04). This used to be the subdomain paywall's buy upsell and monthly↔yearly switch; nothing sells it now.
 *
 * Every shop sees one plain note. A merchant who still has a paid subdomain subscription is told it ends at the close
 * of the current period with no further charge (decision b — `scripts/cancel-subdomain-subscriptions.ts` cancels it
 * at period end and emails them). A shop whose old subscription lapsed simply has its subdomain back.
 *
 * The props are kept so the caller (`CanalPropioClient`) is unchanged; only `active` still matters.
 */
export default function SubdomainSection({
  subdomainUrl,
  active,
}: {
  subdomainUrl: string
  shopSlug?: string
  entitled?: boolean
  /** True ⇒ the merchant still holds a paid subdomain subscription (it ends at period end). */
  active: boolean
  hasMonthly?: boolean
  lapsed?: boolean
}) {
  return (
    <div className="mt-3 text-xs text-[var(--color-muted)] leading-relaxed">
      <p className="m-0">
        <i className="iconoir-check" aria-hidden /> Tu subdominio (<span className="font-mono">{subdomainUrl}</span>) está
        activo y es gratis en todos los planes.
      </p>
      {active && (
        <p className="m-0 mt-1">
          Ya no tienes que pagarlo: tu suscripción termina al final del periodo que ya pagaste, sin ningún otro cargo.
        </p>
      )}
    </div>
  )
}
