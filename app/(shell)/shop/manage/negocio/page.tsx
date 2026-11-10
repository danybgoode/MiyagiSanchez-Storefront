import { redirect } from 'next/navigation'
import { auth } from '@clerk/nextjs/server'
import { resolveMyPlan } from '@/lib/plan-server'
import { readPlanLegacyState } from '@/lib/plan'
import { negocioPageView } from '@/lib/negocio-page'
import { Banner } from '@/components/feedback/Banner'
import NegocioBuyButtons from './NegocioBuyButtons'
import NegocioManageButton from './NegocioManageButton'

export const metadata = { title: 'Tu suscripción — Mi tienda' }
export const dynamic = 'force-dynamic'

/**
 * «Tu suscripción» (epic 08 · plans-gratis-negocio S3.2, README D15; copy rewritten 2026-11-05; both paid plans since
 * plan-tienda-three-free-months S2.3): which plan the shop is on, what happens when the free days end, and what each
 * way of paying Plan Tienda or Plan Negocio does. «Tu plan» (/shop/manage/plan) is the business plan and is a
 * different page. Everything shown per plan is decided by the pure `negocioPageView`.
 */
export default async function TuSuscripcionPage({ searchParams }: { searchParams: Promise<{ negocio?: string }> }) {
  const { userId } = await auth()
  if (!userId) redirect('/sign-in?redirect_url=%2Fshop%2Fmanage%2Fnegocio')
  const [mine, sp] = await Promise.all([
    // A failed read is NOT "no shop": it renders the unavailable state instead of sending the merchant to /sell.
    resolveMyPlan(userId).then((m) => m ?? ('none' as const)).catch(() => ('unavailable' as const)),
    searchParams,
  ])
  if (mine === 'none') redirect('/sell')

  // The legacy marker decides only what the trial view says happens at its end (Plan Gratis, or choose a plan). A
  // damaged marker counts as legacy, exactly as `derivePlan` reads it.
  const legacy = mine !== 'unavailable' && readPlanLegacyState(mine.shop.metadata) !== 'absent'
  const view = negocioPageView(mine === 'unavailable' ? { plan: 'gratis', reason: 'unavailable', endsAt: null } : mine.plan, new Date(), { legacy })

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 grid gap-4" data-testid="negocio-page">
      <div className="grid gap-1">
        <h1 className="t-h2" style={{ margin: 0, letterSpacing: 0 }}>Tu suscripción</h1>
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>
          Tu plan en Miyagi Sánchez y cómo pagarlo. Tu plan de negocio, con tus números, está en «Tu plan».
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
        {view.notice ? <p className="t-small" data-testid="negocio-notice" style={{ margin: 0 }}>{view.notice}</p> : null}
        {view.manage && view.managePlan ? <NegocioManageButton plan={view.managePlan} /> : null}
      </section>

      {view.afterTrial ? (
        <section className="card-panel" data-testid="negocio-after-trial" style={{ padding: 'var(--s-5)', display: 'grid', gap: 'var(--s-2)' }}>
          <h2 className="t-h4" style={{ margin: 0, letterSpacing: 0 }}>{view.afterTrial.title}</h2>
          <p className="t-small" style={{ margin: 0 }}>{view.afterTrial.body}</p>
          {view.afterTrial.keeps ? (
            <>
              <p className="t-small" style={{ margin: 'var(--s-2) 0 0', fontWeight: 600 }}>{view.afterTrial.keeps.title}</p>
              <ul style={{ margin: 0, paddingLeft: 'var(--s-4)', display: 'grid', gap: 'var(--s-1)' }}>
                {view.afterTrial.keeps.items.map((line) => <li key={line} className="t-small">{line}</li>)}
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

      {view.offers.map((offer) => (
        <section key={offer.plan} data-testid={`${offer.plan}-options`} style={{ display: 'grid', gap: 'var(--s-3)' }}>
          <div className="grid gap-1">
            <h2 className="t-h4" style={{ margin: 0, letterSpacing: 0 }}>{offer.title}</h2>
            <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{offer.intro}</p>
          </div>
          <NegocioBuyButtons buttons={offer.buttons} />
        </section>
      ))}
    </div>
  )
}
