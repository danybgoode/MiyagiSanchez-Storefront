import { redirect } from 'next/navigation'
import { auth } from '@clerk/nextjs/server'
import { getMySeller } from '@/lib/get-my-seller'
import { loadModel } from '@/lib/business-plan/store-server'
import { gapsOf } from '@/lib/business-plan/model'
import { Banner } from '@/components/feedback/Banner'
import { PLAN_COPY } from '@/lib/business-plan/copy'
import PlanClient from './PlanClient'

export const metadata = { title: 'Tu plan — Mi tienda' }
export const dynamic = 'force-dynamic'

/**
 * «Tu plan» (business-infrastructure S2.3, then S3). The shop's business model — every number with where it came
 * from — seeded on first visit from the kept prompt-to-shop draft, merged on every visit with what the shop's own
 * catalog and sales ledger say (`loadModel`). What could not be read is named on the page, never shown as zero.
 */
export default async function PlanPage() {
  const { userId, getToken } = await auth()
  if (!userId) redirect('/sign-in?redirect_url=%2Fshop%2Fmanage%2Fplan')
  const seller = await getMySeller()
  if (!seller) redirect('/sell')
  const clerkJwt = await getToken()
  const loaded = clerkJwt
    ? await loadModel({ sellerId: seller.id, clerkUserId: userId, slug: seller.slug }, clerkJwt)
    : 'unavailable'

  if (loaded === 'unavailable') {
    return (
      <div className="max-w-3xl mx-auto px-4 py-6 grid gap-3" data-testid="plan-page">
        <h1 className="t-h2" style={{ margin: 0, letterSpacing: 0 }}>{PLAN_COPY.title}</h1>
        <Banner variant="warning">{PLAN_COPY.unavailable}</Banner>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 grid gap-4" data-testid="plan-page">
      <div className="grid gap-1">
        <h1 className="t-h2" style={{ margin: 0, letterSpacing: 0 }}>{PLAN_COPY.title}</h1>
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{PLAN_COPY.lead}</p>
      </div>
      {loaded.unavailable.length ? (
        <Banner variant="warning">{PLAN_COPY.couldNotRead(loaded.unavailable)}</Banner>
      ) : null}
      <PlanClient inputs={loaded.row.inputs} updatedAt={loaded.row.updated_at} gaps={gapsOf(loaded.row.inputs)} />
    </div>
  )
}
