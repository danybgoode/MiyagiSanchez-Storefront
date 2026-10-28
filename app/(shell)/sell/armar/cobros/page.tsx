import type { Metadata } from 'next'
import Link from 'next/link'
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import CobrosChooser from '@/app/(shell)/p2s/_components/CobrosChooser'
import { Banner } from '@/components/feedback/Banner'
import { isEnabled } from '@/lib/flags'
import { getMySeller } from '@/lib/get-my-seller'
import { findKeptDraft } from '@/lib/prompt-to-shop/claim-server'
import { readChooserState, type CobrosSettings } from '@/lib/prompt-to-shop/cobros'
import { COBROS_COPY } from '@/lib/prompt-to-shop/copy'
import { fetchGuideShop } from '@/lib/setup-guide-server'

/**
 * `/sell/armar/cobros` — the cobros / entregas chooser on its own page (epic prompt-to-shop S5.1), the same component
 * the kept-shop checklist opens as a sheet. The smoke walkthrough starts here.
 *
 * The switches start from the shop row the settings pages read (`marketplace_shops.metadata.settings`, via the
 * guide's own read); the buyer preview asks checkout (the Medusa seller). No copy lives in this file.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: COBROS_COPY.pageTitle,
  robots: { index: false, follow: false },
}

export default async function CobrosPage() {
  const { userId } = await auth()
  if (!userId) redirect('/sign-in?redirect_url=%2Fsell%2Farmar%2Fcobros')

  const [seller, guideShop, kept, correosAvailable] = await Promise.all([
    getMySeller(),
    fetchGuideShop(userId),
    findKeptDraft(userId, null),
    isEnabled('shipping.correos_enabled'),
  ])
  const settings = ((guideShop?.metadata as { settings?: CobrosSettings } | null)?.settings ?? null)
  const draftId = kept && kept !== 'unavailable' ? kept.id : null

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 grid gap-4" data-testid="p2s-cobros-page">
      <div className="grid gap-1">
        <h1 className="t-h3" style={{ margin: 0, letterSpacing: 0 }}>{COBROS_COPY.pageTitle}</h1>
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{COBROS_COPY.pageLead}</p>
      </div>
      {seller?.slug && guideShop ? (
        <CobrosChooser
          shopSlug={seller.slug}
          market={seller.market}
          initial={readChooserState(settings)}
          correosAvailable={correosAvailable}
          draftId={draftId}
        />
      ) : (
        <Banner variant="neutral">{COBROS_COPY.previewNoShop}</Banner>
      )}
      <div>
        <Link href="/sell/armar" prefetch={false} className="btn btn-secondary">{COBROS_COPY.back}</Link>
      </div>
    </div>
  )
}
