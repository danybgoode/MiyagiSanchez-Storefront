/**
 * lib/relationship-access.ts
 *
 * Founding merchant activation operations · Sprint 1 — the ONE shared scope
 * check every `/api/promoter/relationship*` route calls (build contract,
 * sprint-1.md: "Put the scope check in ONE shared helper that every route
 * calls"), plus the append-only field-audit writer (Story 1.3).
 *
 * Access to a relationship is granted to FOUR actors (precedence in
 * `lib/relationship-role.ts#decideRelationshipRole` — read that doc comment
 * for the full D1 reasoning, this is only the summary):
 *   1. the caller's own `promoter_id` (their own field-captured record) — role `owner`,
 *   2. admin (`lib/admin/guard.ts#currentUserIsAdmin`) — role `admin`,
 *   3. the assigned STEWARD (`row.steward_clerk_user_id === actor.clerkUserId`,
 *      S2 C1) — role `manager`, UNLESS an explicit `partner_grants` `viewer`
 *      grant exists for them, which FLOORS them at `viewer` (S2 D1 — a
 *      deliberate write-denial outranks an implicit stewardship upgrade),
 *   4. a promoter holding an ACTIVE `partner_grants` row for the relationship's
 *      linked `shop_id` — role mirrors the grant's OWN `manager`/`viewer` role,
 *      the same grant model `lib/partner-auth.ts` already uses, reused rather
 *      than re-invented (README "what already exists").
 * Anything else is a 403 carrying NO record fields — not a 404 (which would
 * distinguish "doesn't exist" from "not yours" differently than an absent id)
 * and not a partial record. An unresolvable id (bad UUID, genuinely absent)
 * gets the exact same 403 shape as a real id the caller doesn't own, so the
 * response never confirms which case it was.
 *
 * READ access via `resolveRelationshipAccess` is NOT write access — a
 * `viewer` grant passes the scope check but every write route must also call
 * `canWriteRelationship(access.role)` (S1 cross-review A5: `lib/partner-auth.ts`
 * already denies a viewer write at the MCP layer; this closes the same hole
 * here).
 *
 * Also holds `resolveLinkableShop` (may THIS actor bind a relationship to a
 * given shop — reuses `canAnchorPreview`'s ownership rule, S1 review A3/A4)
 * and `scopedRelationshipCandidates` (the actor-scoped pool the fuzzy
 * duplicate-name scan reads from, S1 review A11/A12).
 *
 * Runtime: Node only (Supabase service-role client + Clerk admin check).
 */
import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { isEnabled } from '@/lib/flags'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { currentUserIsAdmin } from '@/lib/admin/guard'
import { getPartnerIdentityByClerkId } from '@/lib/promoter'
import { resolveTargetShop } from '@/lib/promoter-server'
import { canAnchorPreview } from '@/lib/promoter-close'
import { decideRelationshipRole } from '@/lib/relationship-role'
import { recruitingV3Enabled } from '@/lib/recruiting-v3'

export interface RelationshipRow {
  id: string
  business_name: string
  contact_name: string | null
  phone_e164: string | null
  email_normalized: string | null
  whatsapp_e164: string | null
  instagram_handle: string | null
  estado: string | null
  municipio: string | null
  location_note: string | null
  category: string | null
  current_channels: string[] | null
  preferred_channel: string | null
  qualification: string
  fit_note: string | null
  objections: string | null
  promoter_id: string | null
  cohort: string | null
  source: string | null
  steward_clerk_user_id: string | null
  shop_id: string | null
  preview_id: string | null
  stage: string
  stage_entered_at: string
  intake_complete: boolean
  created_by: string
  created_at: string
  updated_at: string
}

export interface RelationshipActor {
  clerkUserId: string
  promoterId: string | null
  /** The bound promoter's PRM- code — needed to check shop OWNERSHIP
   *  (`canAnchorPreview`/`isPromoterShopOwner` key off the code embedded in a
   *  promoter-created shop's `source_url`, not the promoter row id). */
  promoterCode: string | null
  programTrack?: 'promoter' | 'founding_operator' | null
  isAdmin: boolean
}

/** Resolve the calling Clerk identity to its promoter binding + admin status. */
export async function resolveActor(clerkUserId: string): Promise<RelationshipActor> {
  const [promoter, isAdmin] = await Promise.all([
    getPartnerIdentityByClerkId(clerkUserId),
    currentUserIsAdmin(),
  ])
  return {
    clerkUserId,
    promoterId: promoter?.id ?? null,
    promoterCode: promoter?.code ?? null,
    programTrack: promoter?.program_track ?? null,
    isAdmin,
  }
}

export type RelationshipAuthResult =
  | { error: NextResponse; user?: undefined; actor?: undefined }
  | { error?: undefined; user: { id: string }; actor: RelationshipActor }

/**
 * The gate every `/api/promoter/relationship*` route runs FIRST: the
 * `promoter.activation_crm_enabled` flag (OFF ⇒ 404, indistinguishable from
 * absent — the build contract's dark-launch requirement), then a real Clerk
 * session (401), then the actor's track-specific recruiting gate, then a rate
 * limit. The actor's promoter/admin binding is returned to the route.
 * Deliberately does NOT require a promoter binding here — an admin with no
 * promoter code must still be able to reach a route; `resolveRelationshipAccess`
 * (or the create-path's own explicit check) is where binding is enforced.
 */
export async function authorizeRelationshipRequest(req: NextRequest): Promise<RelationshipAuthResult> {
  if (!(await isEnabled('promoter.activation_crm_enabled'))) {
    return { error: NextResponse.json({ ok: false }, { status: 404 }) }
  }
  const user = await currentUser().catch(() => null)
  if (!user) return { error: NextResponse.json({ ok: false, error: 'No autorizado' }, { status: 401 }) }

  const actor = await resolveActor(user.id)
  if (actor.programTrack === 'founding_operator' && !(await recruitingV3Enabled())) {
    return { error: NextResponse.json({ ok: false }, { status: 404 }) }
  }

  const rl = await checkRateLimit('relationship', getClientIp(req))
  if (!rl.allowed) {
    return {
      error: NextResponse.json(
        { ok: false, error: 'Demasiados intentos. Espera un momento.' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
      ),
    }
  }

  return { user: { id: user.id }, actor }
}

/** The scope an access grant was resolved through. `owner`/`admin` can always
 *  write; a `partner_grants` grant carries its OWN role — `viewer` must never
 *  write (mirrors `lib/partner-auth.ts`'s viewer-write denial exactly). */
export type RelationshipRole = 'owner' | 'admin' | 'manager' | 'viewer'

export type RelationshipAccess =
  | { ok: true; relationship: RelationshipRow; role: RelationshipRole }
  | { ok: false; status: 403 }

const FORBIDDEN: RelationshipAccess = { ok: false, status: 403 }

/** True for every role allowed to WRITE a relationship — everything except a
 *  read-only `partner_grants` `viewer` grant. Every write route (the update
 *  arm of `POST /api/promoter/relationship`, and the `consent` route) must
 *  check this after `resolveRelationshipAccess` — read access alone is NOT
 *  write access. */
export function canWriteRelationship(role: RelationshipRole): boolean {
  return role !== 'viewer'
}

/**
 * The shared scope check. Reads the row once and decides access from it —
 * every route (`GET`, the update arm of `POST`, and the `consent` route)
 * calls this instead of re-deriving the rule. Callers that WRITE must
 * additionally check `canWriteRelationship(access.role)` — this only decides
 * whether the caller may see the record at all.
 */
export async function resolveRelationshipAccess(
  relationshipId: string,
  actor: RelationshipActor,
): Promise<RelationshipAccess> {
  if (!relationshipId) return FORBIDDEN

  const { data, error } = await db
    .from('merchant_relationships')
    .select(
      'id, business_name, contact_name, phone_e164, email_normalized, whatsapp_e164, ' +
        'instagram_handle, estado, municipio, location_note, category, current_channels, ' +
        'preferred_channel, qualification, fit_note, objections, promoter_id, cohort, source, ' +
        'steward_clerk_user_id, shop_id, preview_id, stage, stage_entered_at, intake_complete, ' +
        'created_by, created_at, updated_at',
    )
    .eq('id', relationshipId)
    .maybeSingle()
  // A read error (including a malformed-UUID 22P02) is indistinguishable from
  // "not found" here — fail closed, never leak which one it was.
  if (error || !data) return FORBIDDEN

  const row = data as unknown as RelationshipRow

  // S2 fix (C1, PR 304 review): the assigned STEWARD now gets `manager`
  // access — otherwise reassigning `steward_clerk_user_id` (S2.2's
  // owner-reassign route) changes who a list SHOWS as responsible without
  // changing who can actually SEE or ACT on the record, directly defeating
  // S2.2's acceptance ("no active merchant disappears between contacts"):
  // the OLD promoter keeps write access via `promoter_id`/grants, and the
  // NEW steward — who may not be the `promoter_id` owner and may hold no
  // `partner_grants` row at all — is 403'd out of the record they were just
  // handed.
  //
  // Fixed on the READ side, deliberately NOT by auto-inserting a
  // `partner_grants` row on reassignment. Roadmap/LEARNINGS.md
  // (miyagi-partners S2.1, 2026-07-17): "when a funnel/automation writes
  // into an authorization table, enumerate every OTHER writer of that table
  // and decide whose intent wins" — a promoter-close auto-grant's
  // duplicate-handling once grew an upgrade path that would have silently
  // escalated an admin's deliberate `viewer` grant and let a re-close undo a
  // seller's revoke. A read-side rule adds NO rows to `partner_grants` at
  // all, so it can never race, escalate, or resurrect a grant an
  // admin/seller deliberately set or revoked — it only ever widens access
  // for the CURRENT steward, and only for as long as they stay the steward.
  // `listScopedRelationships` (`lib/relationship-list.ts`) mirrors this exact
  // rule so a steward's records also appear in their own pipeline.
  //
  // The DECISION itself (precedence: admin > owner > steward-unless-floored
  // > grant role, D1) is `lib/relationship-role.ts#decideRelationshipRole` —
  // pure, zero-import, spec-tested directly. This function's job is only to
  // resolve the FACTS and hand them over.
  const isAdmin = actor.isAdmin
  const isPromoterOwner = !!actor.promoterId && row.promoter_id === actor.promoterId
  const isSteward = !!row.steward_clerk_user_id && row.steward_clerk_user_id === actor.clerkUserId

  // The grant lookup is a DB call — LAZY, but D1 changed WHEN it can be
  // skipped: it must still run whenever `isSteward` is true, because
  // `decideRelationshipRole` needs to know whether an explicit `viewer`
  // grant FLOORS that stewardship. Only admin/owner (which unconditionally
  // outrank any grant) skip it.
  let grantRole: 'manager' | 'viewer' | null = null
  if (!isAdmin && !isPromoterOwner && row.shop_id && actor.promoterId) {
    const { data: grant } = await db
      .from('partner_grants')
      .select('role')
      .eq('shop_id', row.shop_id)
      .eq('promoter_id', actor.promoterId)
      .is('revoked_at', null)
      .maybeSingle()
    // `partner_grants.role` is `manager|viewer` (CHECK'd at the DB) — trust the
    // stored value literally rather than defaulting an unrecognized value to a
    // WRITE role (fail closed, same posture as `lib/partner-auth.ts`).
    if (grant?.role === 'manager') grantRole = 'manager'
    else if (grant?.role === 'viewer') grantRole = 'viewer'
  }

  const role = decideRelationshipRole({ isAdmin, isPromoterOwner, isSteward, grantRole })

  return role ? { ok: true, relationship: row, role } : FORBIDDEN
}

// ── Shop linking (A3/A4 — a relationship may only bind to a shop the calling
// promoter is allowed to ANCHOR, the exact rule `canAnchorPreview` already
// enforces for preview anchoring: unclaimed AND provably created by this
// promoter's own `promoter://<CODE>/` provenance) ──────────────────────────

export type ShopLinkResult =
  | { ok: true; shopId: string }
  | { ok: false; reason: 'not_found' | 'not_owned' }

/**
 * May this actor link a relationship to `shopId`? Admin bypasses the
 * ownership check (only existence matters); everyone else must pass the same
 * `canAnchorPreview` rule the preview-anchoring routes already enforce, so a
 * bound promoter can never squat a relationship onto a shop they didn't
 * create (build contract A4) — including the 29 backfilled shops, which have
 * no `promoter://` provenance and so are never linkable this way, and any
 * OTHER promoter's shop.
 */
export async function resolveLinkableShop(
  shopId: string,
  actor: RelationshipActor,
): Promise<ShopLinkResult> {
  if (!shopId) return { ok: false, reason: 'not_found' }
  const shop = await resolveTargetShop({ shopId })
  if (!shop) return { ok: false, reason: 'not_found' }
  if (actor.isAdmin) return { ok: true, shopId: shop.id }
  if (!actor.promoterCode) return { ok: false, reason: 'not_owned' }
  if (!canAnchorPreview({ sourceUrl: shop.sourceUrl, clerkUserId: shop.clerkUserId }, actor.promoterCode)) {
    return { ok: false, reason: 'not_owned' }
  }
  return { ok: true, shopId: shop.id }
}

// ── Shop rehydration (S1 cross-review B2) ───────────────────────────────────

export interface LinkedShopSummary {
  shopId: string
  slug: string
  name: string
  estado: string | null
  municipio: string | null
}

/**
 * A lightweight shop summary for the UI to REHYDRATE its `shop` state from a
 * relationship's own `shop_id` on GET/resume. Without this, switching to a
 * relationship that already has a linked shop leaves the promoter's `shop`
 * state at whatever it was (null, or a DIFFERENT merchant's shop) — inviting
 * either a confusing dead "create a shop" prompt or, worse, a duplicate
 * replacement shop for a merchant who already has one (B2). `estado`/
 * `municipio` come from the same `metadata.location_detail` shape
 * `/api/promoter/shop/setup` writes.
 */
export async function resolveLinkedShopSummary(shopId: string): Promise<LinkedShopSummary | null> {
  const { data, error } = await db
    .from('marketplace_shops')
    .select('id, slug, name, metadata')
    .eq('id', shopId)
    .maybeSingle()
  if (error || !data) return null
  const meta = (data.metadata ?? {}) as Record<string, unknown>
  const loc = (meta.location_detail ?? null) as Record<string, unknown> | null
  return {
    shopId: data.id as string,
    slug: data.slug as string,
    name: (data.name as string) ?? '',
    estado: typeof loc?.estado === 'string' ? loc.estado : null,
    municipio: typeof loc?.municipio === 'string' ? loc.municipio : null,
  }
}

// ── Field audit (Story 1.3 — "attribution and consent fields are audited on
// every edit") ───────────────────────────────────────────────────────────

/** The columns whose edits get an immutable audit row. `shop_id` (S1
 *  cross-review B6) is the single field binding a relationship to a REAL
 *  merchant — exactly the attribution class Story 1.3 promises is audited,
 *  and it became mutable the moment A3 let a save carry a `shopId`. */
export const AUDITED_FIELDS = [
  'promoter_id',
  'cohort',
  'source',
  'preferred_channel',
  'preview_id',
  'shop_id',
] as const
export type AuditedField = (typeof AUDITED_FIELDS)[number]

/**
 * Diff `before` against `after` over `AUDITED_FIELDS` and write one append-only
 * row per field that actually changed. A no-op diff writes nothing (and
 * reports `true` — there was nothing to fail at). The PRIMARY write already
 * committed by the time this runs (it can't be rolled back), so a failure
 * here can't fail the request — but it must not be swallowed silently either
 * (review A10: "the API reports success while the promised audit trail
 * silently didn't record"). Logs loudly AND returns `false` so every caller
 * can surface `auditRecorded: false` in its response instead of a bare
 * `{ ok: true }` that quietly lies about what got recorded.
 *
 * `opts.force` (S1 cross-review B4): a RETRY of a save whose audit write
 * failed can't reconstruct the failure by re-diffing — the primary write
 * already committed, so `before` now equals `after` and the diff is empty,
 * meaning a naive retry silently "succeeds" without ever writing the row it
 * was retrying. `force` writes every field present in `after` regardless of
 * whether it differs from `before`, so the caller's explicit retry can
 * actually re-emit the missed audit row.
 */
export async function auditFieldChanges(
  relationshipId: string,
  actorClerkUserId: string,
  before: Partial<Record<AuditedField, unknown>>,
  after: Partial<Record<AuditedField, unknown>>,
  opts?: { force?: boolean },
): Promise<boolean> {
  const force = opts?.force ?? false
  const rows = AUDITED_FIELDS.filter((field) => field in after && (force || after[field] !== before[field])).map(
    (field) => ({
      relationship_id: relationshipId,
      field,
      old_value: before[field] == null ? null : String(before[field]),
      new_value: after[field] == null ? null : String(after[field]),
      actor_clerk_user_id: actorClerkUserId,
    }),
  )
  if (rows.length === 0) return true
  const { error } = await db.from('merchant_relationship_field_audit').insert(rows)
  if (error) {
    console.error('[relationship-access] field audit insert failed:', error.message)
    return false
  }
  return true
}

/**
 * Write ONE free-form audit row for an event that isn't a plain column diff —
 * used by the consent route to leave a permanent trail of every successful
 * evidence check, even when it left `preview_id` unchanged (a re-confirmation).
 * Same "never swallow the failure" discipline as `auditFieldChanges` (A10).
 */
export async function auditEvent(
  relationshipId: string,
  actorClerkUserId: string,
  field: string,
  newValue: string,
): Promise<boolean> {
  const { error } = await db.from('merchant_relationship_field_audit').insert({
    relationship_id: relationshipId,
    field,
    old_value: null,
    new_value: newValue,
    actor_clerk_user_id: actorClerkUserId,
  })
  if (error) {
    console.error('[relationship-access] audit event insert failed:', error.message)
    return false
  }
  return true
}

// ── Scoped candidate pool (fuzzy-suggestion scan, A11/A12) ─────────────────

export interface CandidateRow {
  id: string
  business_name: string
}

/**
 * The relationships this ACTOR is allowed to see suggested as possible
 * duplicates — the caller's own records plus anything reachable through an
 * active `partner_grants` shop grant; admin sees everything. (A12: the fuzzy
 * scan must never leak another promoter's merchant names.)
 *
 * Bounded to the most-recent 300 per pool rather than filtered by a SQL
 * `ILIKE` pre-filter — `unaccent` is not installed on this database, so an
 * `ILIKE` against the RAW `business_name` column against a diacritic-stripped
 * search term systematically misses exactly the accented names es-MX is full
 * of (verified live: `'Café Don Memo' ILIKE '%cafe%'` → false). The caller
 * does the real (normalized-key) comparison in application code via
 * `isFuzzyNameMatch` — this is a bounded APPLICATION-side scan, not a
 * database-side text search (A11: the removed comment overclaimed that
 * `.limit()` bounded rows SCANNED; it only bounds rows RETURNED, and a
 * leading-wildcard `ILIKE` can't use the `lower(business_name)` btree index
 * regardless).
 */
export async function scopedRelationshipCandidates(actor: RelationshipActor): Promise<CandidateRow[]> {
  if (actor.isAdmin) {
    const { data } = await db
      .from('merchant_relationships')
      .select('id, business_name')
      .order('created_at', { ascending: false })
      .limit(300)
    return (data as CandidateRow[] | null) ?? []
  }

  const own = actor.promoterId
    ? await db
        .from('merchant_relationships')
        .select('id, business_name')
        .eq('promoter_id', actor.promoterId)
        .order('created_at', { ascending: false })
        .limit(300)
    : { data: [] as CandidateRow[] }

  let granted: CandidateRow[] = []
  if (actor.promoterId) {
    const { data: grants } = await db
      .from('partner_grants')
      .select('shop_id')
      .eq('promoter_id', actor.promoterId)
      .is('revoked_at', null)
    const shopIds = ((grants ?? []) as Array<{ shop_id: string }>).map((g) => g.shop_id).filter(Boolean)
    if (shopIds.length > 0) {
      const { data } = await db.from('merchant_relationships').select('id, business_name').in('shop_id', shopIds)
      granted = (data as CandidateRow[] | null) ?? []
    }
  }

  const seen = new Set<string>()
  const merged: CandidateRow[] = []
  for (const row of [...((own.data as CandidateRow[] | null) ?? []), ...granted]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    merged.push(row)
  }
  return merged
}

// ── Client DTO ──────────────────────────────────────────────────────────────

/** The camelCase shape every route hands back to the panel's «El negocio» step (`NegocioStep`). */
export interface RelationshipDTO {
  id: string
  businessName: string
  contactName: string | null
  phone: string | null
  email: string | null
  whatsapp: string | null
  instagramHandle: string | null
  estado: string | null
  municipio: string | null
  locationNote: string | null
  category: string | null
  currentChannels: string[]
  preferredChannel: string | null
  qualification: string
  fitNote: string | null
  objections: string | null
  promoterId: string | null
  cohort: string | null
  source: string | null
  stewardClerkUserId: string | null
  shopId: string | null
  previewId: string | null
  stage: string
  stageEnteredAt: string
  intakeComplete: boolean
  createdAt: string
  updatedAt: string
}

export function toRelationshipDTO(row: RelationshipRow): RelationshipDTO {
  return {
    id: row.id,
    businessName: row.business_name,
    contactName: row.contact_name,
    phone: row.phone_e164,
    email: row.email_normalized,
    whatsapp: row.whatsapp_e164,
    instagramHandle: row.instagram_handle,
    estado: row.estado,
    municipio: row.municipio,
    locationNote: row.location_note,
    category: row.category,
    currentChannels: row.current_channels ?? [],
    preferredChannel: row.preferred_channel,
    qualification: row.qualification,
    fitNote: row.fit_note,
    objections: row.objections,
    promoterId: row.promoter_id,
    cohort: row.cohort,
    source: row.source,
    stewardClerkUserId: row.steward_clerk_user_id,
    shopId: row.shop_id,
    previewId: row.preview_id,
    stage: row.stage,
    stageEnteredAt: row.stage_entered_at,
    intakeComplete: row.intake_complete,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
