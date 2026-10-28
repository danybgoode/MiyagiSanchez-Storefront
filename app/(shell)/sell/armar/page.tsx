import type { Metadata } from 'next'
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import ClaimRunner from '@/app/(shell)/p2s/_components/ClaimRunner'
import KeptShop from '@/app/(shell)/p2s/_components/KeptShop'
import { getMySeller } from '@/lib/get-my-seller'
import { findKeptDraft } from '@/lib/prompt-to-shop/claim-server'
import { ARMAR_COPY } from '@/lib/prompt-to-shop/copy'
import { draftView } from '@/lib/prompt-to-shop/view'

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
    const seller = await getMySeller()
    return <KeptShop view={draftView(kept.id, kept.blocks)} shopSlug={seller?.slug ?? null} />
  }
  if (kept) return <ClaimRunner draftId={kept.id} />
  if (!draftId) redirect('/sell')
  return <ClaimRunner draftId={draftId} />
}
