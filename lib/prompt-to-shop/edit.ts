/**
 * Prompt-to-shop — `PATCH /api/p2s/drafts/[id]`, the canvas's autosave (epic S2.4, D15).
 *
 *   parse body → device cookie → read (id AND device) → apply + validate → conditional write
 *
 * The merchant can change exactly two things: the shop's name, and the accent colour (one of the stored
 * alternates). Everything goes through the S1 validators — a new name must pass `validateIdentity`, the same gate
 * the generated one passed — so autosave cannot store a shape generation would have refused.
 *
 * The write is OPTIMISTIC: it lands only if the row's `updated_at` is still what this request read. A generation
 * saving a block (which bumps `updated_at`) between the read and the write turns the edit into a 409 instead of a
 * silent overwrite of the newer version. Ownership is `id` + device cookie ONLY — this module has no parameter that
 * could carry a view token, and an unknown body key (a smuggled `view_token`, say) is a 400 (D15).
 *
 * Pure: the read and the write are injected, so the spec drives every branch with fakes.
 */

import { accentIsReadable, validateIdentity, type IdentityBlock } from './blocks'
import { readDeviceId } from './handler'

export const EDIT_COPY = {
  invalid: 'No pudimos guardar ese cambio. Revisa el nombre (hasta 60 caracteres) y el color.',
  notFound: 'No encontramos esa tienda en este teléfono. Empieza una nueva.',
  busy: 'Tu tienda todavía se está armando. Espera a que termine para cambiarla.',
  conflict: 'Tu tienda cambió mientras guardábamos. Recarga la página para ver la última versión.',
  unavailable: 'No pudimos guardar ahora. Inténtalo de nuevo en un momento.',
} as const

export interface EditableRow {
  identity: IdentityBlock | null
  /** The `updated_at` this read saw — the write's precondition. */
  updatedAt: string
}

export interface EditDeps {
  /** Unclaimed, unexpired, owned by this device (id AND device) — or null. */
  read: (draftId: string, deviceId: string) => Promise<EditableRow | null>
  /** One conditional UPDATE (id, device, unclaimed, unexpired, updated_at = expected), `.select()`ed back. True = a row changed. */
  write: (draftId: string, deviceId: string, expectedUpdatedAt: string, identity: IdentityBlock) => Promise<boolean>
}

export interface EditBody {
  name?: string
  accent_color?: string
}

const EDIT_KEYS = ['name', 'accent_color'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Pure. One or both known keys, nothing else: an unknown key (a view token, a draft id) is not a hint, it is a no. */
export function parseEditBody(body: unknown): EditBody | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  if (Object.keys(b).some((k) => !(EDIT_KEYS as readonly string[]).includes(k))) return null
  const out: EditBody = {}
  if (b.name !== undefined) {
    if (typeof b.name !== 'string') return null
    out.name = b.name
  }
  if (b.accent_color !== undefined) {
    if (typeof b.accent_color !== 'string') return null
    out.accent_color = b.accent_color
  }
  return out.name === undefined && out.accent_color === undefined ? null : out
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * Apply an edit to the stored identity, or say why not. An accent must be the current one or one of the stored
 * alternates (a free-form colour would bypass the contrast guard), and picking one SWAPS it with the old accent so
 * the merchant can always go back.
 */
export function applyEdit(identity: IdentityBlock, edit: EditBody): IdentityBlock | null {
  let next: IdentityBlock = identity
  if (edit.accent_color !== undefined) {
    const chosen = edit.accent_color
    if (!accentIsReadable(chosen)) return null
    if (!same(chosen, identity.accent_color)) {
      const at = identity.accent_alternates.findIndex((a) => same(a, chosen))
      if (at === -1) return null
      const alternates = [...identity.accent_alternates] as [string, string, string]
      alternates[at] = identity.accent_color
      next = { ...next, accent_color: identity.accent_alternates[at], accent_alternates: alternates }
    }
  }
  if (edit.name !== undefined) {
    const checked = validateIdentity({ ...next, name: edit.name })
    if (!checked.ok) return null
    next = { ...next, name: checked.data.name }
  }
  return next
}

export type EditResult =
  | { status: 200; body: { ok: true; identity: IdentityBlock } }
  | { status: 400 | 404 | 409 | 503; body: { error: string; code: keyof typeof EDIT_COPY } }

const fail = (status: 400 | 404 | 409 | 503, code: keyof typeof EDIT_COPY): EditResult => ({ status, body: { error: EDIT_COPY[code], code } })

export async function handleEditDraft(
  input: { draftId: string; body: unknown; deviceCookie: string | null | undefined },
  deps: EditDeps,
): Promise<EditResult> {
  const edit = parseEditBody(input.body)
  if (!edit) return fail(400, 'invalid')
  const deviceId = readDeviceId(input.deviceCookie)
  if (!deviceId || !UUID.test(input.draftId)) return fail(404, 'notFound')
  const draftId = input.draftId.toLowerCase()

  const row = await deps.read(draftId, deviceId)
  if (!row) return fail(404, 'notFound')
  // A new version is being written: its identity is null until the first block lands. Editing a half-written draft
  // would race the generation, so the merchant waits.
  if (!row.identity) return fail(409, 'busy')

  const next = applyEdit(row.identity, edit)
  if (!next) return fail(400, 'invalid')

  let landed = false
  try {
    landed = await deps.write(draftId, deviceId, row.updatedAt, next)
  } catch {
    return fail(503, 'unavailable')
  }
  // Zero rows: the draft changed (or expired) since this request read it. Never report a save that did not happen.
  return landed ? { status: 200, body: { ok: true, identity: next } } : fail(409, 'conflict')
}
