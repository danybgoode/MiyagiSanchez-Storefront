'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { sellerLandingPath } from '@/lib/seller-acquisition'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/feedback/Banner'
import type { ClaimOutcome } from '@/lib/prompt-to-shop/claim'
import { claimDraft } from '@/lib/prompt-to-shop/client'
import { trackFunnel } from '@/lib/prompt-to-shop/funnel'
import { ARMAR_COPY } from '@/lib/prompt-to-shop/copy'

/**
 * Runs the keep from the browser (epic S3.2): `POST /api/p2s/claim/[id]`, then shows what happened.
 *
 * A route handler and not the server page, because the apply busts the shop cache and `revalidateTag` may not run
 * during a render. The claim is idempotent, so a reload, a second tab or React running this effect twice all land
 * on the same shop. On `kept` the server page is re-read, and it renders the kept shop itself.
 */

function Panel({ title, lead, children }: { title: string; lead: string; children?: React.ReactNode }) {
  return (
    <main className="app-shell" style={{ paddingTop: 'var(--s-10)', paddingBottom: 'var(--s-10)' }}>
      <section className="card-panel" style={{ maxWidth: 520, margin: '0 auto', padding: 'var(--s-6)', display: 'grid', gap: 'var(--s-3)' }}>
        <h1 className="t-h3" style={{ letterSpacing: 0, margin: 0 }}>{title}</h1>
        <p className="t-lead" style={{ margin: 0, color: 'var(--fg-muted)' }}>{lead}</p>
        {children}
      </section>
    </main>
  )
}

export default function ClaimRunner({ draftId, initial }: { draftId: string | null; initial?: ClaimOutcome }) {
  const router = useRouter()
  const [outcome, setOutcome] = useState<ClaimOutcome | null>(initial ?? null)
  const [attempt, setAttempt] = useState(0)
  const started = useRef(-1)

  useEffect(() => {
    if (initial || !draftId || started.current === attempt) return
    // One request per attempt. No cancel-on-cleanup: React's dev double-run would cancel the only request it sent.
    started.current = attempt
    claimDraft(draftId).then((result) => {
      setOutcome(result)
      // Funnel step 4 (S5.3): counted on the keep itself — the claim's answer — never on a later visit to the shop.
      if (result.kind === 'kept') trackFunnel('p2s_kept', result.draftId, { resumed: result.resumed })
      // A keep whose colours and words did not save stays on this panel: the kept view draws them from the draft,
      // so it would show the merchant a shop the live one is not.
      if (result.kind === 'kept' && result.configApplied) router.refresh()
    })
  }, [draftId, attempt, initial, router])

  if (outcome?.kind === 'kept' && !outcome.configApplied) {
    return (
      <Panel title={ARMAR_COPY.configFailedTitle(null)} lead={ARMAR_COPY.configFailedLead}>
        <div className="flex flex-wrap gap-2">
          <Link href="/shop/manage/settings" prefetch={false} className="btn btn-primary">{ARMAR_COPY.settings}</Link>
          <Link href="/shop/manage" prefetch={false} className="btn btn-secondary">{ARMAR_COPY.manage}</Link>
        </div>
      </Panel>
    )
  }
  if (!outcome || outcome.kind === 'kept') {
    return (
      <Panel title={ARMAR_COPY.working} lead={ARMAR_COPY.keptLead}>
        {outcome?.kind === 'kept' ? (
          <div><Link href="/shop/manage" prefetch={false} className="btn btn-primary">{ARMAR_COPY.manage}</Link></div>
        ) : null}
      </Panel>
    )
  }
  if (outcome.kind === 'has_shop') {
    return (
      <Panel title={ARMAR_COPY.hasShopTitle} lead={ARMAR_COPY.hasShopLead}>
        <div><Link href="/shop/manage" prefetch={false} className="btn btn-primary">{ARMAR_COPY.manage}</Link></div>
      </Panel>
    )
  }
  if (outcome.kind === 'incomplete') {
    return (
      <Panel title={ARMAR_COPY.incompleteTitle} lead={ARMAR_COPY.incompleteLead}>
        <div><Link href={`/p2s/${outcome.draftId}`} prefetch={false} className="btn btn-primary">{ARMAR_COPY.backToShop}</Link></div>
      </Panel>
    )
  }
  if (outcome.kind === 'retry') {
    return (
      <Panel title={ARMAR_COPY.working} lead={ARMAR_COPY.keptLead}>
        <Banner variant="warning">{outcome.message}</Banner>
        <div>
          <Button type="button" variant="primary" onClick={() => { setOutcome(null); setAttempt((n) => n + 1) }}>
            {ARMAR_COPY.retry}
          </Button>
        </div>
      </Panel>
    )
  }
  // other_phone, and signed_out (a session that ended between the page and the request): the same way forward.
  return (
    <Panel title={ARMAR_COPY.otherPhoneTitle} lead={ARMAR_COPY.otherPhoneLead}>
      <div><Link href={sellerLandingPath('mx')} prefetch={false} className="btn btn-primary">{ARMAR_COPY.startNew}</Link></div>
    </Panel>
  )
}
