import type { Metadata } from 'next'
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import ClaimRunner from '@/app/(shell)/p2s/_components/ClaimRunner'
import KeptShop from '@/app/(shell)/p2s/_components/KeptShop'
import { getMySeller } from '@/lib/get-my-seller'
import { filterOutDeleted } from '@/lib/listing-lifecycle'
import { photosLeft } from '@/lib/prompt-to-shop/allowance'
import { findKeptDraft } from '@/lib/prompt-to-shop/claim-server'
import { ARMAR_COPY } from '@/lib/prompt-to-shop/copy'
import { publishState } from '@/lib/prompt-to-shop/photo'
import { listOwnProducts, photosUsedThisMonth } from '@/lib/prompt-to-shop/photo-server'
import { draftView, ownProductCards } from '@/lib/prompt-to-shop/view'
import { guideProductCount, guideProgress, guideStepsFor } from '@/lib/setup-guide-source'
import { fetchDeletedListingIds, fetchGuideShop } from '@/lib/setup-guide-server'

/**
 * `/sell/armar` — where «Quedármela» lands (epic prompt-to-shop S3.1/S3.2).
 *
 *   • signed out → back to the draft (`/p2s/<id>`), or the describe box when there is none;
 *   • a draft this user already finished keeping → the kept shop, read by the CLAIMANT (no write, no apply — a
 *     reload is free and changes nothing);
 *   • otherwise → `ClaimRunner`, which runs the claim through `POST /api/p2s/claim/[id]` and shows the
 *     answer. That includes a keep this user started and that stopped half way: the claim resumes it.
 *   • no `?draft=` and nothing kept → `/sell`.
 *
 * The kept shop (S4) carries the checklist — `guideStepsFor` + `guideProductCount` over `fetchGuideShop`, the SAME
 * calls Resumen makes, so the % is Resumen's (D17) — the merchant's own products, the photos left this month and
 * «Publicar»'s state. A product list that could not be read is `null`, never "no products".
 *
 * No copy lives in this file (it is inside the seller-copy population scan); it comes from `copy.ts`.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: ARMAR_COPY.metaTitle,
  robots: { index: false, follow: false },
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function ArmarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const raw = Array.isArray(params.draft) ? params.draft[0] : params.draft
  const draftId = raw && UUID.test(raw) ? raw.toLowerCase() : null

  const { userId } = await auth()
  if (!userId) redirect(draftId ? `/p2s/${draftId}` : '/mx/vende')

  // A `draft` that is not a draft id at all is a link that leads nowhere: say so the same way as any other.
  if (raw && !draftId) return <ClaimRunner draftId={null} initial={{ kind: 'other_phone' }} />

  const kept = await findKeptDraft(userId, draftId)
  if (kept === 'unavailable') {
    if (!draftId) redirect('/sell')
    return <ClaimRunner draftId={draftId} />
  }
  if (kept?.sellerId) {
    const { getToken } = await auth()
    const clerkJwt = await getToken()
    const [seller, guideShop, listings, used] = await Promise.all([
      getMySeller(),
      fetchGuideShop(userId),
      clerkJwt ? listOwnProducts(clerkJwt) : Promise.resolve(null),
      photosUsedThisMonth(userId),
    ])
    const deletedIds = guideShop?.id ? await fetchDeletedListingIds(guideShop.id) : new Set<string>()
    // Resumen counts an unreadable product list as none for the checklist; so does this, for the same %. «Publicar»
    // does not: it says it could not check.
    const steps = guideStepsFor(guideShop, guideProductCount(listings ?? [], deletedIds))
    const own = listings ? filterOutDeleted(listings, deletedIds) : null
    return (
      <KeptShop
        view={draftView(kept.id, kept.blocks)}
        shopSlug={seller?.slug ?? null}
        steps={steps}
        progress={guideProgress(steps)}
        ownCards={own ? ownProductCards(own) : null}
        publish={publishState(own ? own.length : null)}
        photosLeft={photosLeft(used)}
        profile={{ name: guideShop?.name ?? kept.blocks.identity?.name ?? '', description: guideShop?.description ?? '' }}
      />
    )
  }
  if (kept) return <ClaimRunner draftId={kept.id} />
  if (!draftId) redirect('/sell')
  return <ClaimRunner draftId={draftId} />
}
