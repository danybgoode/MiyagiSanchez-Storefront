import { redirect } from 'next/navigation'
import { auth } from '@clerk/nextjs/server'
import { resolveMyPlan } from '@/lib/plan-server'
import { negocioPageView } from '@/lib/negocio-page'
import { getPricingCatalog } from '@/lib/pricing-catalog-server'
import { Banner } from '@/components/feedback/Banner'
import NegocioBuyButtons from './NegocioBuyButtons'
import NegocioManageButton from './NegocioManageButton'

export const metadata = { title: 'Tu suscripción — Mi tienda' }
export const dynamic = 'force-dynamic'

/**
 * «Tu suscripción» (epic 08 · plans-gratis-negocio S3.2, README D15; copy rewritten 2026-11-05): which plan the shop is
 * on, what happens when the free days end, what the Plan Gratis keeps and pauses, and what each way of paying does.
 * «Tu plan» (/shop/manage/plan) is the business plan and is a different page.
 * Everything shown per plan is decided by the pure `negocioPageView`.
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
  const gratis = catalog.plans.find((p) => p.id === 'gratis')

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 grid gap-4" data-testid="negocio-page">
      <div className="grid gap-1">
        <h1 className="t-h2" style={{ margin: 0, letterSpacing: 0 }}>Tu suscripción</h1>
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>
          Tu plan en Miyagi Sánchez y cómo pagar el Plan Negocio. Tu plan de negocio, con tus números, está en «Tu plan».
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
        {view.manage ? <NegocioManageButton /> : null}
      </section>

      {view.afterTrial ? (
        <section className="card-panel" data-testid="negocio-after-trial" style={{ padding: 'var(--s-5)', display: 'grid', gap: 'var(--s-2)' }}>
          <h2 className="t-h4" style={{ margin: 0, letterSpacing: 0 }}>{view.afterTrial.title}</h2>
          <p className="t-small" style={{ margin: 0 }}>{view.afterTrial.body}</p>
          {gratis ? (
            <>
              <p className="t-small" style={{ margin: 'var(--s-2) 0 0', fontWeight: 600 }}>Te quedas con el Plan Gratis, para siempre:</p>
              <ul style={{ margin: 0, paddingLeft: 'var(--s-4)', display: 'grid', gap: 'var(--s-1)' }}>
                {gratis.includes.map((line) => <li key={line.es} className="t-small">{line.es}</li>)}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}

      {view.pauses ? (
        <section className="card-panel" data-testid="negocio-pauses" style={{ padding: 'var(--s-5)', display: 'grid', gap: 'var(--s-2)' }}>
          <p className="t-small" style={{ margin: 0, fontWeight: 600 }}>{view.pauses.title}</p>
          <ul style={{ margin: 0, paddingLeft: 'var(--s-4)', display: 'grid', gap: 'var(--s-1)' }}>
            {view.pauses.items.map((line) => <li key={line} className="t-small">{line}</li>)}
          </ul>
        </section>
      ) : null}

      {view.buttons.length ? (
        <section data-testid="negocio-options" style={{ display: 'grid', gap: 'var(--s-3)' }}>
          <h2 className="t-h4" style={{ margin: 0, letterSpacing: 0 }}>Contrata el Plan Negocio</h2>
          <NegocioBuyButtons buttons={view.buttons} />
        </section>
      ) : null}
    </div>
  )
}
