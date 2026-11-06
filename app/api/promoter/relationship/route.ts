/**
 * POST /api/promoter/relationship — create or resume-and-save a founding
 * merchant relationship record (founding-merchant-activation-ops S1.2/S1.3).
 *
 * Two arms, selected by whether the body carries `relationshipId`:
 *   - CREATE (no `relationshipId`): the caller must be a BOUND promoter (the
 *     field-intake story — mirrors `/api/promoter/preview`'s exact 403 shape).
 *     Runs the dedupe precedence (shop_id → phone_e164 → email_normalized,
 *     `lib/merchant-identity.ts#decideDedupeMatch`) BEFORE inserting; a hit
 *     returns 409 with the existing id + `matchReason` unless the caller
 *     passes `confirmNew: true`. A dedupe LOOKUP that itself fails to read
 *     (a DB error) refuses the create rather than assuming "no duplicate" —
 *     these columns are deliberately unindexed-unique, so a fail-open read
 *     error is the only thing standing between a blip and a silent duplicate
 *     (S1 cross-review A9). A fuzzy business-name hit never blocks — it comes
 *     back as a `suggestions` array on the same 200, scoped to records this
 *     promoter can already see (epic Decision 3: never auto-merge on fuzzy
 *     name similarity; S1 cross-review A12: never leak another promoter's names).
 *   - UPDATE (`relationshipId` present): scope-checked through the ONE shared
 *     helper (`resolveRelationshipAccess`) — an id the caller doesn't own is a
 *     403 with no record fields, not a 404, not a partial write. A `viewer`
 *     partner-grant may READ but not WRITE (S1 cross-review A5).
 *
 * BOTH arms validate `shopId` the same way `canAnchorPreview` gates preview
 * anchoring — a bound promoter may only link a shop THEY created (S1
 * cross-review A3/A4); admin bypasses the ownership check.
 *
 * Malformed phone/email/whatsapp input is REJECTED (400), never silently
 * normalized to null and written over a good stored value (S1 cross-review
 * A8) — an explicit empty string is still a deliberate clear. Every field's
 * TYPE is validated too (S1 review B8) — `{phone: 123}` or
 * `{confirmNew: "false"}` (truthy as a string!) or `{intakeComplete: "false"}`
 * (also truthy) now 400 instead of throwing a 500 or silently coercing to
 * the WRONG value.
 *
 * Relinking `shop_id` clears `preview_id` when the shop actually changes (S1
 * review B5) — a `preview_id` left pointing at the OLD shop after a mis-link
 * correction would misread as consent for the NEW one. `shop_id` is itself
 * audited (B6): it is the field binding a relationship to a real merchant.
 *
 * `forceAudit: true` on the UPDATE arm re-emits the field-audit rows even
 * when the diff against the stored row is empty (S1 review B4) — the retry
 * path for a save whose FIRST attempt reported `auditRecorded: false`; a
 * plain retry can't reconstruct that failure by re-diffing, because the
 * primary write already committed and now equals what's being "changed".
 *
 * Gated by `promoter.activation_crm_enabled` FIRST (404 when OFF).
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/supabase'
import {
  normalizePhoneE164,
  normalizeEmail,
  isFuzzyNameMatch,
  decideDedupeMatch,
  type DedupeCandidateRows,
} from '@/lib/merchant-identity'
import { isPreferredChannel } from '@/lib/preferred-channels'
import {
  authorizeRelationshipRequest,
  resolveRelationshipAccess,
  resolveLinkableShop,
  canWriteRelationship,
  scopedRelationshipCandidates,
  auditFieldChanges,
  toRelationshipDTO,
  type RelationshipRow,
} from '@/lib/relationship-access'

export const dynamic = 'force-dynamic'

const QUALIFICATIONS = ['unknown', 'strong', 'medium', 'weak', 'disqualified'] as const

interface RelationshipBody {
  relationshipId?: string
  confirmNew?: boolean
  businessName?: string
  contactName?: string
  phone?: string
  email?: string
  whatsapp?: string
  instagramHandle?: string
  estado?: string
  municipio?: string
  locationNote?: string
  category?: string
  currentChannels?: string[]
  preferredChannel?: string
  qualification?: string
  fitNote?: string
  objections?: string
  cohort?: string
  source?: string
  shopId?: string
  intakeComplete?: boolean
  forceAudit?: boolean
}

// B8: the TYPE of every field, not just its presence, must be validated —
// JSON.parse hands back `any`, so the `RelationshipBody` interface above is
// a compile-time hint only. Every field a bare-string check or a truthy
// coercion would mishandle gets an explicit runtime guard below.
const STRING_FIELDS = [
  'relationshipId', 'businessName', 'contactName', 'phone', 'email', 'whatsapp',
  'instagramHandle', 'estado', 'municipio', 'locationNote', 'category',
  'preferredChannel', 'qualification', 'fitNote', 'objections', 'cohort',
  'source', 'shopId',
] as const satisfies ReadonlyArray<keyof RelationshipBody>
const BOOLEAN_FIELDS = ['confirmNew', 'intakeComplete', 'forceAudit'] as const satisfies ReadonlyArray<keyof RelationshipBody>

function validateBodyTypes(body: RelationshipBody): string | null {
  for (const field of STRING_FIELDS) {
    const v = body[field]
    if (v !== undefined && typeof v !== 'string') return `Campo inválido: ${field}.`
  }
  for (const field of BOOLEAN_FIELDS) {
    const v = body[field]
    if (v !== undefined && typeof v !== 'boolean') return `Campo inválido: ${field}.`
  }
  if (body.currentChannels !== undefined && !Array.isArray(body.currentChannels)) {
    return 'Campo inválido: currentChannels.'
  }
  return null
}

function clean(v: string | undefined): string | null {
  const t = (v ?? '').trim()
  return t.length > 0 ? t : null
}

type FieldResult = { ok: true; value: string | null } | { ok: false; error: string }

/**
 * Normalize an optional contact field, distinguishing three cases (A8):
 *  - `undefined` never reaches here (the caller only calls this when the
 *    field WAS present in the body — "not touched" is handled by the caller).
 *  - an explicit empty/blank string is a deliberate CLEAR → `{ value: null }`.
 *  - a non-blank string that fails to normalize is MALFORMED → refused, so a
 *    typo can never silently erase a good stored value.
 */
function normalizeOrReject(
  raw: string,
  normalizer: (s: string) => string | null,
  label: string,
): FieldResult {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: null }
  const normalized = normalizer(trimmed)
  if (!normalized) return { ok: false, error: `${label} no es válido.` }
  return { ok: true, value: normalized }
}

/** A9: a dedupe LOOKUP that fails to read must refuse the create, never
 *  silently proceed as "no duplicate found" — these columns have no unique
 *  constraint to catch it at insert time. */
type DedupeLookup = { ok: true; row: { id: string } | null } | { ok: false }

async function lookupDedupe(column: 'shop_id' | 'phone_e164' | 'whatsapp_e164' | 'email_normalized', value: string): Promise<DedupeLookup> {
  const { data, error } = await db.from('merchant_relationships').select('id').eq(column, value).limit(1).maybeSingle()
  if (error) return { ok: false }
  return { ok: true, row: (data as { id: string } | null) ?? null }
}

/** A11/A12: bounded, actor-scoped, ACTUALLY-normalized fuzzy business-name
 *  scan — see `scopedRelationshipCandidates` for why this can't be a SQL
 *  `ILIKE` pre-filter. Best-effort; a failure here never fails the create. */
async function fuzzySuggestions(
  businessName: string,
  excludeId: string,
  actor: Parameters<typeof scopedRelationshipCandidates>[0],
): Promise<Array<{ id: string; businessName: string }>> {
  try {
    const pool = await scopedRelationshipCandidates(actor)
    return pool
      .filter((row) => row.id !== excludeId && isFuzzyNameMatch(businessName, row.business_name))
      .slice(0, 5)
      .map((row) => ({ id: row.id, businessName: row.business_name }))
  } catch {
    return []
  }
}

export async function POST(req: NextRequest) {
  const auth = await authorizeRelationshipRequest(req)
  if (auth.error) return auth.error

  let body: RelationshipBody = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 })
  }

  const typeError = validateBodyTypes(body)
  if (typeError) return NextResponse.json({ ok: false, error: typeError }, { status: 400 })

  // The channel vocabulary is imported, never restated — it mirrors the DB
  // CHECK and lives in lib/preferred-channels.ts (PR 308 finding 2).
  if (body.preferredChannel && !isPreferredChannel(body.preferredChannel)) {
    return NextResponse.json({ ok: false, error: 'Canal preferido inválido.' }, { status: 400 })
  }
  if (body.qualification && !QUALIFICATIONS.includes(body.qualification as (typeof QUALIFICATIONS)[number])) {
    return NextResponse.json({ ok: false, error: 'Calificación inválida.' }, { status: 400 })
  }
  // A15: a non-array (or non-string-array) currentChannels would otherwise
  // reach PostgREST unvalidated and 500 instead of a clean 400.
  if (body.currentChannels !== undefined) {
    if (!Array.isArray(body.currentChannels) || !body.currentChannels.every((c) => typeof c === 'string')) {
      return NextResponse.json({ ok: false, error: 'Canales actuales inválidos.' }, { status: 400 })
    }
  }

  // A8: reject malformed contact fields instead of silently normalizing to
  // null and overwriting a good stored value.
  let phoneE164: string | null | undefined
  if (body.phone !== undefined) {
    const r = normalizeOrReject(body.phone, normalizePhoneE164, 'El teléfono')
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 400 })
    phoneE164 = r.value
  }
  let emailNormalized: string | null | undefined
  if (body.email !== undefined) {
    const r = normalizeOrReject(body.email, normalizeEmail, 'El correo')
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 400 })
    emailNormalized = r.value
  }
  let whatsappE164: string | null | undefined
  if (body.whatsapp !== undefined) {
    const r = normalizeOrReject(body.whatsapp, normalizePhoneE164, 'El WhatsApp')
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 400 })
    whatsappE164 = r.value
  }

  // A3/A4: a non-empty shopId must be a shop THIS actor may link — same rule
  // `canAnchorPreview` enforces for preview anchoring. An empty string clears
  // the link (never validated — clearing needs no ownership proof).
  let linkedShopId: string | null | undefined
  if (body.shopId !== undefined) {
    const trimmed = (body.shopId ?? '').trim()
    if (trimmed === '') {
      linkedShopId = null
    } else {
      const link = await resolveLinkableShop(trimmed, auth.actor)
      if (!link.ok) {
        // Never confirm a shop's existence to an actor who can't link it —
        // same posture as the preview-anchoring routes.
        return NextResponse.json({ ok: false, error: 'Tienda no encontrada.' }, { status: 404 })
      }
      linkedShopId = link.shopId
    }
  }

  // ── UPDATE arm ─────────────────────────────────────────────────────────
  if (body.relationshipId) {
    const access = await resolveRelationshipAccess(body.relationshipId, auth.actor)
    if (!access.ok) return NextResponse.json({ ok: false }, { status: 403 })
    if (!canWriteRelationship(access.role)) {
      return NextResponse.json(
        { ok: false, error: 'Tu acceso a este registro es de solo lectura (viewer) — esta acción requiere el rol manager.' },
        { status: 403 },
      )
    }

    const before = access.relationship
    const patch: Partial<Record<keyof RelationshipRow, unknown>> = { updated_at: new Date().toISOString() }
    if (body.businessName !== undefined) {
      const name = clean(body.businessName)
      if (!name) return NextResponse.json({ ok: false, error: 'El nombre del negocio no puede estar vacío.' }, { status: 400 })
      patch.business_name = name
    }
    // A14: send the field's CURRENT value explicitly (even blank) rather than
    // relying on the caller to omit it — `clean()` still turns a blank into a
    // stored null, but only because the caller EXPLICITLY sent it this time.
    if (body.contactName !== undefined) patch.contact_name = clean(body.contactName)
    if (phoneE164 !== undefined) patch.phone_e164 = phoneE164
    if (emailNormalized !== undefined) patch.email_normalized = emailNormalized
    if (whatsappE164 !== undefined) patch.whatsapp_e164 = whatsappE164
    if (body.instagramHandle !== undefined) patch.instagram_handle = clean(body.instagramHandle)
    if (body.estado !== undefined) patch.estado = clean(body.estado)
    if (body.municipio !== undefined) patch.municipio = clean(body.municipio)
    if (body.locationNote !== undefined) patch.location_note = clean(body.locationNote)
    if (body.category !== undefined) patch.category = clean(body.category)
    if (body.currentChannels !== undefined) patch.current_channels = body.currentChannels
    if (body.preferredChannel !== undefined) patch.preferred_channel = body.preferredChannel || null
    if (body.qualification !== undefined) patch.qualification = body.qualification || 'unknown'
    if (body.fitNote !== undefined) patch.fit_note = clean(body.fitNote)
    if (body.objections !== undefined) patch.objections = clean(body.objections)
    if (body.cohort !== undefined) patch.cohort = clean(body.cohort)
    if (body.source !== undefined) patch.source = clean(body.source)
    if (body.intakeComplete !== undefined) patch.intake_complete = !!body.intakeComplete
    // A3: actually apply the shop link the caller validated above.
    if (linkedShopId !== undefined) {
      patch.shop_id = linkedShopId
      // B5: a stored `preview_id` belongs to whatever shop it was captured
      // against. If the link is actually CHANGING (a mis-link correction, or
      // an unlink) — not just re-sent as the same value on every save (A3's
      // "always resend shopId" behavior) — any existing preview_id refers to
      // the OLD shop and must not silently keep pointing at it: a later S2+
      // reader treating a non-null preview_id as "permission granted" would
      // be wrong. The consent route itself re-verifies on every call
      // (`previewBelongsToRelationship`) and is safe regardless; this is
      // about not leaving the STORED field lying.
      if (linkedShopId !== before.shop_id) {
        patch.preview_id = null
      }
    }

    const { data, error } = await db
      .from('merchant_relationships')
      .update(patch)
      .eq('id', body.relationshipId)
      .select(
        'id, business_name, contact_name, phone_e164, email_normalized, whatsapp_e164, instagram_handle, ' +
          'estado, municipio, location_note, category, current_channels, preferred_channel, qualification, ' +
          'fit_note, objections, promoter_id, cohort, source, steward_clerk_user_id, shop_id, preview_id, ' +
          'stage, stage_entered_at, intake_complete, created_by, created_at, updated_at',
      )
      .maybeSingle()
    if (error || !data) {
      // 23505 on the shop_id unique index = someone else linked this shop
      // between our validation and this write — a genuine conflict, not a 500.
      if (error?.code === '23505') {
        return NextResponse.json({ ok: false, error: 'Ya existe un registro para esta tienda.' }, { status: 409 })
      }
      return NextResponse.json({ ok: false, error: 'No se pudo guardar el registro.' }, { status: 500 })
    }

    const auditRecorded = await auditFieldChanges(body.relationshipId, auth.user.id, before, patch, {
      force: body.forceAudit === true,
    })

    return NextResponse.json({ ok: true, relationship: toRelationshipDTO(data as unknown as RelationshipRow), auditRecorded })
  }

  // ── CREATE arm ─────────────────────────────────────────────────────────
  if (!auth.actor.promoterId) {
    return NextResponse.json({ ok: false, error: 'Vincula tu código de promotor primero.' }, { status: 403 })
  }

  const businessName = clean(body.businessName)
  if (!businessName) {
    return NextResponse.json({ ok: false, error: 'El nombre del negocio es obligatorio.' }, { status: 400 })
  }

  if (!body.confirmNew) {
    const candidates: DedupeCandidateRows = { byShopId: null, byPhone: null, byEmail: null }
    if (linkedShopId) {
      const r = await lookupDedupe('shop_id', linkedShopId)
      if (!r.ok) {
        return NextResponse.json({ ok: false, error: 'No se pudo verificar duplicados. Inténtalo de nuevo.' }, { status: 500 })
      }
      candidates.byShopId = r.row
    }
    if (phoneE164) {
      const r = await lookupDedupe('phone_e164', phoneE164)
      if (!r.ok) {
        return NextResponse.json({ ok: false, error: 'No se pudo verificar duplicados. Inténtalo de nuevo.' }, { status: 500 })
      }
      candidates.byPhone = r.row
    }
    if (whatsappE164) {
      const r = await lookupDedupe('whatsapp_e164', whatsappE164)
      if (!r.ok) {
        return NextResponse.json({ ok: false, error: 'No se pudo verificar duplicados. Inténtalo de nuevo.' }, { status: 500 })
      }
      candidates.byWhatsapp = r.row
    }
    if (emailNormalized) {
      const r = await lookupDedupe('email_normalized', emailNormalized)
      if (!r.ok) {
        return NextResponse.json({ ok: false, error: 'No se pudo verificar duplicados. Inténtalo de nuevo.' }, { status: 500 })
      }
      candidates.byEmail = r.row
    }
    const decision = decideDedupeMatch(candidates)
    if (decision.matched) {
      return NextResponse.json(
        { ok: false, error: 'Ya existe un registro con estos datos.', relationshipId: decision.relationshipId, matchReason: decision.matchReason },
        { status: 409 },
      )
    }
  }

  const { data: inserted, error: insertError } = await db
    .from('merchant_relationships')
    .insert({
      business_name: businessName,
      contact_name: clean(body.contactName),
      phone_e164: phoneE164 ?? null,
      email_normalized: emailNormalized ?? null,
      whatsapp_e164: whatsappE164 ?? null,
      instagram_handle: clean(body.instagramHandle),
      estado: clean(body.estado),
      municipio: clean(body.municipio),
      location_note: clean(body.locationNote),
      category: clean(body.category),
      current_channels: body.currentChannels ?? null,
      preferred_channel: body.preferredChannel || null,
      qualification: body.qualification || 'unknown',
      fit_note: clean(body.fitNote),
      objections: clean(body.objections),
      promoter_id: auth.actor.promoterId,
      cohort: clean(body.cohort),
      source: clean(body.source),
      shop_id: linkedShopId ?? null,
      intake_complete: !!body.intakeComplete,
      created_by: auth.user.id,
    })
    .select(
      'id, business_name, contact_name, phone_e164, email_normalized, whatsapp_e164, instagram_handle, ' +
        'estado, municipio, location_note, category, current_channels, preferred_channel, qualification, ' +
        'fit_note, objections, promoter_id, cohort, source, steward_clerk_user_id, shop_id, preview_id, ' +
        'stage, stage_entered_at, intake_complete, created_by, created_at, updated_at',
    )
    .maybeSingle()

  if (insertError || !inserted) {
    // 23505 on the shop_id unique index = a concurrent create raced us — surface
    // as a dedupe conflict rather than a bare 500, since that's what it is.
    if (insertError?.code === '23505') {
      return NextResponse.json({ ok: false, error: 'Ya existe un registro para esta tienda.' }, { status: 409 })
    }
    return NextResponse.json({ ok: false, error: 'No se pudo crear el registro.' }, { status: 500 })
  }

  const row = inserted as unknown as RelationshipRow

  const auditRecorded = await auditFieldChanges(
    row.id,
    auth.user.id,
    {},
    {
      promoter_id: row.promoter_id,
      cohort: row.cohort,
      source: row.source,
      preferred_channel: row.preferred_channel,
      // B6: shop_id is audited too — a create that already carries a shopId
      // (B3a's "shop created before the relationship was ever saved" order)
      // is the FIRST attribution event for that binding.
      shop_id: row.shop_id,
    },
  )

  const suggestions = await fuzzySuggestions(businessName, row.id, auth.actor)

  return NextResponse.json({ ok: true, relationship: toRelationshipDTO(row), suggestions, auditRecorded })
}
