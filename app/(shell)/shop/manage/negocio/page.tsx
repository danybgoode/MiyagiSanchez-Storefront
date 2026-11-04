import { redirect } from 'next/navigation'
import { auth } from '@clerk/nextjs/server'
import { resolveMyPlan } from '@/lib/plan-server'
import { negocioPageView } from '@/lib/negocio-page'
import { getPricingCatalog } from '@/lib/pricing-catalog-server'
import { Banner } from '@/components/feedback/Banner'
import NegocioBuyButtons from './NegocioBuyButtons'

export const metadata = { title: 'Tu suscripción — Mi tienda' }
export const dynamic = 'force-dynamic'

/**
 * «Tu suscripción» (epic 08 · plans-gratis-negocio S3.2, README D15): the plan the shop is on, what Negocio includes and
 * how to pay for it. «Tu plan» (/shop/manage/plan) is the business plan and is a different page.
 * What is shown per plan is decided by the pure `negocioPageView`.
 */
export default async function TuSuscripcionPage({ searchParams }: { searchParams: Promise<{ negocio?: string }> }) {
  const { userId } = await auth()
  if (!userId) redirect('/sign-in?redirect_url=%2Fshop%2Fmanage%2Fnegocio')
  const [mine, catalog, sp] = await Promise.all([
    // A failed read is NOT "no shop": it renders the unavailable state instead of sending the merchant to /sell.
    resolveMyPlan(userId).then((m) => m ?? ('none' as const)).catch(() => ('unavailable' as const)),
    getPricingCatalog(),
    searchParams,
  ])
  if (mine === 'none') redirect('/sell')

  const view = negocioPageView(mine === 'unavailable' ? { plan: 'gratis', reason: 'unavailable', endsAt: null } : mine.plan)
  const negocio = catalog.plans.find((p) => p.id === 'negocio')

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 grid gap-4" data-testid="negocio-page">
      <div className="grid gap-1">
        <h1 className="t-h2" style={{ margin: 0, letterSpacing: 0 }}>Tu suscripción</h1>
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>
          Tu plan en Miyagi Sánchez y cómo pagar Negocio. Tu plan de negocio, con tus números, está en «Tu plan».
        </p>
      </div>

      {sp.negocio === 'activated' ? (
        <Banner variant="success">¡Gracias! Recibimos tu pago. Tu plan se actualiza en unos momentos; si no lo ves, recarga la página.</Banner>
      ) : sp.negocio === 'cancelled' ? (
        <Banner variant="info">Cancelaste el pago y no se te cobró nada. Puedes intentarlo cuando quieras.</Banner>
      ) : null}

      <section className="card-panel" data-testid="negocio-status" style={{ padding: 'var(--s-5)', display: 'grid', gap: 'var(--s-3)' }}>
        {view.tone === 'unknown' ? (
          <Banner variant="warning">{view.headline}</Banner>
        ) : (
          <p className="t-h4" data-testid="negocio-headline" style={{ margin: 0, letterSpacing: 0 }}>{view.headline}</p>
        )}
        {view.buttons.length ? <NegocioBuyButtons buttons={view.buttons} /> : null}
      </section>

      {negocio ? (
        <section className="card-panel" data-testid="negocio-includes" style={{ padding: 'var(--s-5)', display: 'grid', gap: 'var(--s-2)' }}>
          <h2 className="t-h4" style={{ margin: 0, letterSpacing: 0 }}>Qué incluye Negocio</h2>
          <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>
            {negocio.priceLabel.es} · {negocio.yearlyLabel?.es}
          </p>
          <ul style={{ margin: 0, paddingLeft: 'var(--s-4)', display: 'grid', gap: 'var(--s-1)' }}>
            {negocio.includes.map((line) => (
              <li key={line.es} className="t-small">{line.es}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
