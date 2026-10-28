import { NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { auth } from '@clerk/nextjs/server'
import { setListingStatus } from '@/lib/listing-status'
import { PUBLISH_COPY } from '@/lib/prompt-to-shop/copy'
import { listOwnProducts, resolvePhotoOwner } from '@/lib/prompt-to-shop/photo-server'
import { handlePublish } from '@/lib/prompt-to-shop/publish'
import { fetchDeletedListingIds, fetchGuideShop } from '@/lib/setup-guide-server'

/**
 * POST /api/p2s/publish — «Publicar» on the kept shop (epic prompt-to-shop S5.2).
 *
 * Signed in, and only for the merchant whose kept draft became THIS Medusa seller (`resolvePhotoOwner`, the same
 * ownership proof photo → product uses). The decision and its order live in `handlePublish`; each product is
 * activated in-process through `setListingStatus` — the catalog's own activate — never by `fetch()`-ing
 * `/api/sell/listing/[id]` from here (a server-side request has no session cookie).
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function POST() {
  const { userId, getToken } = await auth()
  if (!userId) return NextResponse.json({ ok: false, error: 'signed_out', message: PUBLISH_COPY.signedOut }, { status: 401, headers: NO_STORE })
  const clerkJwt = await getToken()
  if (!clerkJwt) return NextResponse.json({ ok: false, error: 'signed_out', message: PUBLISH_COPY.signedOut }, { status: 401, headers: NO_STORE })

  const result = await handlePublish({
    resolveOwner: () => resolvePhotoOwner(userId, clerkJwt),
    listProducts: () => listOwnProducts(clerkJwt),
    deletedIds: async () => {
      const shop = await fetchGuideShop(userId)
      return shop?.id ? fetchDeletedListingIds(shop.id) : new Set<string>()
    },
    activate: (productId) => setListingStatus(productId, 'active', { userId, clerkJwt }),
    log: (line) => console.info('[p2s]', JSON.stringify(line)),
  })
  // The catalog's single-row activate does not bust the cache; a whole shop going public should show on the next view
  // of the marketplace and the shop page — the same tags the keep busts.
  if (result.body.published) {
    revalidateTag('listings', 'default')
    revalidateTag('shops', 'default')
  }
  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE })
}
