/**
 * Prompt-to-shop — «Publicar» (epic S5.2). Pure: every effect is injected.
 *
 * WHAT IS PUBLISHED. The shop's own products in Medusa that are still unpublished (`status: 'draft'` in the seller
 * projection — the state photo → product creates them in). Nothing else:
 *
 *   • examples are never touched — they live only in the draft's `catalog` and are not Medusa products, so they are
 *     not in the list this reads;
 *   • a product the merchant PAUSED (`status: 'paused'`) stays paused: pausing is a decision, «Publicar» is not a
 *     way to undo it;
 *   • a product the mirror already marks deleted is skipped (Resumen's deploy-lag guard, `filterOutDeleted`).
 *
 * HOW. Each product goes through `setListingStatus(id, 'active')` — the in-process function behind the catalog's own
 * activate (`PATCH /api/sell/listing/[id]`), with its checkout-viability gate, Supabase mirror and launchpad notify.
 * Never a `fetch()` to that route: a server-side request carries no session cookie.
 *
 * ORDER: owner → product list → plan → one activation at a time. The viability gate is about the SHOP (a way to pay
 * and a way to deliver), so the first refusal stops the run: every later product would be refused for the same
 * reason, and the merchant needs that reason, once.
 */

import { filterOutDeleted } from '../listing-lifecycle'
import { PUBLISH_COPY } from './copy'
import type { OwnerLookup } from './photo'

export interface PublishListing {
  id: string
  status: string
}

/** The products «Publicar» turns public: unpublished, not paused, not deleted, in the order Medusa listed them. */
export function planPublish(listings: PublishListing[], deletedIds: Set<string>): string[] {
  return filterOutDeleted(listings, deletedIds)
    .filter((l) => l.status === 'draft')
    .map((l) => l.id)
}

/** Live products after a run: the ones that already were, plus the ones this run published. */
function liveCount(listings: PublishListing[], deletedIds: Set<string>, published: number): number {
  return filterOutDeleted(listings, deletedIds).filter((l) => l.status === 'active').length + published
}

export type ActivateResult = { ok: true } | { ok: false; status: number; error: string }

export interface PublishDeps {
  resolveOwner: () => Promise<OwnerLookup>
  /** The seller's own Medusa products. `null` = could not read (never "none"). */
  listProducts: () => Promise<PublishListing[] | null>
  deletedIds: () => Promise<Set<string>>
  activate: (productId: string) => Promise<ActivateResult>
  log: (line: Record<string, unknown>) => void
}

export type PublishBody =
  | { ok: true; published: number; live: number; message: string }
  | { ok: false; error: 'no_shop' | 'unavailable' | 'needs_product' | 'blocked' | 'failed'; message: string; published?: number }

export interface PublishResult {
  status: number
  body: PublishBody
}

export async function handlePublish(deps: PublishDeps): Promise<PublishResult> {
  const owner = await deps.resolveOwner()
  if (owner.kind === 'unavailable') return { status: 503, body: { ok: false, error: 'unavailable', message: PUBLISH_COPY.unavailable } }
  if (owner.kind === 'none') return { status: 404, body: { ok: false, error: 'no_shop', message: PUBLISH_COPY.noShop } }

  const listings = await deps.listProducts()
  if (!listings) return { status: 503, body: { ok: false, error: 'unavailable', message: PUBLISH_COPY.unavailable } }
  const deleted = await deps.deletedIds()
  const plan = planPublish(listings, deleted)

  if (plan.length === 0) {
    const live = liveCount(listings, deleted, 0)
    // Nothing left to publish and something is live: «Publicar» already happened (a second tap, another tab).
    if (live > 0) return { status: 200, body: { ok: true, published: 0, live, message: PUBLISH_COPY.done(live) } }
    return { status: 409, body: { ok: false, error: 'needs_product', message: PUBLISH_COPY.needsProduct } }
  }

  let published = 0
  const failed: string[] = []
  for (const id of plan) {
    const result = await deps.activate(id)
    if (result.ok) {
      published++
      continue
    }
    if (result.status === 422) {
      deps.log({ step: 'publish_blocked', draft_id: owner.draftId, published, product_id: id })
      return { status: 422, body: { ok: false, error: 'blocked', message: result.error, published } }
    }
    failed.push(id)
  }

  deps.log({ step: 'publish', draft_id: owner.draftId, published, failed: failed.length })
  if (published === 0) return { status: 502, body: { ok: false, error: 'failed', message: PUBLISH_COPY.failed, published: 0 } }
  const live = liveCount(listings, deleted, published)
  return {
    status: 200,
    body: { ok: true, published, live, message: failed.length ? PUBLISH_COPY.partial(published, failed.length) : PUBLISH_COPY.done(live) },
  }
}
