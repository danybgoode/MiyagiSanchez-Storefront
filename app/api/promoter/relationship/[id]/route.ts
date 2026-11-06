/**
 * GET /api/promoter/relationship/[id] — resume a saved merchant relationship
 * record (founding-merchant-activation-ops S1.2). Powers the "resume by id
 * from localStorage" requirement in `NegocioStep`.
 *
 * Scope: the caller's own `promoter_id`, the assigned steward (S2 C1, floored
 * to `viewer` by an explicit `partner_grants` `viewer` grant — S2 D1), an
 * active `partner_grants` row for the linked `shop_id`, or admin
 * (`resolveRelationshipAccess` — the ONE shared helper every relationship
 * route calls, whose own doc comment has the full precedence). Anything else
 * is 403 with NO record fields — not a 404 (which would distinguish "doesn't
 * exist" from "not yours" differently than an absent id) and not a partial
 * record.
 *
 * Also returns a lightweight `shop` summary when the relationship already has
 * one linked (S1 cross-review B2) — `NegocioStep` hands this up to
 * `PromoterCloseClient` so switching to (or resuming) a relationship that
 * already has a shop REHYDRATES that shop instead of leaving the promoter
 * looking at a stale/blank one that invites creating a duplicate.
 *
 * Gated by `promoter.activation_crm_enabled` FIRST (404 when OFF).
 */
import { NextRequest, NextResponse } from 'next/server'
import {
  authorizeRelationshipRequest,
  resolveRelationshipAccess,
  resolveLinkedShopSummary,
  toRelationshipDTO,
} from '@/lib/relationship-access'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeRelationshipRequest(req)
  if (auth.error) return auth.error

  const { id } = await params
  const access = await resolveRelationshipAccess(id, auth.actor)
  if (!access.ok) return NextResponse.json({ ok: false }, { status: access.status })

  const shop = access.relationship.shop_id ? await resolveLinkedShopSummary(access.relationship.shop_id) : null

  return NextResponse.json({ ok: true, relationship: toRelationshipDTO(access.relationship), shop })
}
