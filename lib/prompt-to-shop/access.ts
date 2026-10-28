/**
 * Prompt-to-shop — who may see and change a draft (epic D12, D15).
 *
 * Two ways in, and they are NOT the same power:
 *
 *   • the OWNER route resolves a draft by its `id` AND the `p2s_device` cookie — and may edit, re-run and share;
 *   • the VIEW-ONLY link resolves a draft by its `view_token` alone — and may do nothing but look.
 *
 * The view token is a separate column from the device id on purpose (D2), and no mutating path in this app reads
 * it (`e2e/p2s-view-token.spec.ts` sweeps the source for exactly that). The rule is held by construction here: a
 * viewer resolution carries NO draft id and NO device id, so there is nothing for an edit, a version or a claim to
 * be built from, and `controlsFor` gives a viewer an empty list.
 *
 * Pure: the reads are injected (`ReadDeps`), so the spec drives every case with fakes and no database.
 */

import { readDeviceId } from './handler'
import type { ExampleRow, IdentityBlock, WordsBlock } from './blocks'
import type { DraftBlocks } from './view'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CanvasControl = 'rename' | 'accent' | 'version' | 'share' | 'keep'

export type DraftAccess = { kind: 'owner'; draftId: string } | { kind: 'viewer' }

/**
 * What each way in may do. A viewer's list is empty, and the canvas renders exactly this list and nothing else.
 * `keep` (S3.1) is «Quedármela» and «Mándame el enlace»: a viewer can neither claim a draft nor mail its links.
 */
export function controlsFor(access: DraftAccess): CanvasControl[] {
  return access.kind === 'owner' ? ['rename', 'accent', 'version', 'share', 'keep'] : []
}

/** A row as the owner route reads it. The share token rides along ONLY so the owner can copy the link. */
export interface OwnedDraftRow {
  id: string
  identity: unknown
  words: unknown
  catalog: unknown
  block_status: unknown
  versions_used: number
  updated_at: string
  view_token: string
}

/** A row as the view-only route reads it: content only. No id, no device, no token echoed back, no description. */
export interface SharedDraftRow {
  identity: unknown
  words: unknown
  catalog: unknown
  block_status: unknown
}

export interface ReadDeps {
  /** Unclaimed, unexpired, owned by this device — or null. One conditional read. */
  findOwned: (draftId: string, deviceId: string) => Promise<OwnedDraftRow | null>
  /** Unexpired and matching this token — or null. Never consults a device. */
  findByViewToken: (token: string) => Promise<SharedDraftRow | null>
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown) => typeof v === 'string'

/**
 * Stored jsonb → typed blocks. A block that is not the shape we wrote reads as "not landed" instead of crashing the
 * page: a corrupt row must show a placeholder, never a 500.
 */
export function coerceBlocks(row: Pick<SharedDraftRow, 'identity' | 'words' | 'catalog' | 'block_status'>): DraftBlocks {
  const i = row.identity
  const w = row.words
  const c = row.catalog
  const identity =
    isObj(i) && str(i.name) && str(i.tagline) && str(i.description) && str(i.accent_color) && str(i.theme_preset) &&
    Array.isArray(i.accent_alternates) && i.accent_alternates.length === 3 && i.accent_alternates.every(str)
      ? (i as unknown as IdentityBlock)
      : null
  const words = isObj(w) && str(w.announcement) && str(w.headline) && str(w.about) ? (w as unknown as WordsBlock) : null
  // An EMPTY array is a landed catalog with no examples left: on a kept shop the merchant replaced every one of them
  // (S4.3). Generation never writes one (validateCatalog needs 4), so `[]` cannot hide a block still shaping.
  const catalog =
    Array.isArray(c) && c.every((r) => isObj(r) && str(r.title) && typeof r.price === 'number' && str(r.illustration))
      ? (c as unknown as ExampleRow[])
      : null
  const status = isObj(row.block_status) ? row.block_status : {}
  const pick = (k: string) => (status[k] === 'ok' || status[k] === 'fallback' ? status[k] : undefined)
  return {
    identity,
    words,
    catalog,
    block_status: { identity: pick('identity'), words: pick('words'), catalog: pick('catalog') },
  }
}

export type OwnerResolution =
  | { kind: 'ok'; access: Extract<DraftAccess, { kind: 'owner' }>; blocks: DraftBlocks; versionsUsed: number; updatedAt: string; viewToken: string }
  | { kind: 'gone' }

export type ViewerResolution = { kind: 'ok'; access: Extract<DraftAccess, { kind: 'viewer' }>; blocks: DraftBlocks } | { kind: 'gone' }

/**
 * Not found, not yours, expired and malformed all answer the SAME `gone`: the page must not tell a stranger
 * whether an id exists.
 */
export async function resolveOwnerPage(
  input: { id: string; deviceCookie: string | null | undefined },
  deps: Pick<ReadDeps, 'findOwned'>,
): Promise<OwnerResolution> {
  const deviceId = readDeviceId(input.deviceCookie)
  if (!deviceId || !UUID.test(input.id)) return { kind: 'gone' }
  const row = await deps.findOwned(input.id.toLowerCase(), deviceId)
  if (!row) return { kind: 'gone' }
  return {
    kind: 'ok',
    access: { kind: 'owner', draftId: row.id },
    blocks: coerceBlocks(row),
    versionsUsed: row.versions_used,
    updatedAt: row.updated_at,
    viewToken: row.view_token,
  }
}

export async function resolveViewerPage(input: { token: string }, deps: Pick<ReadDeps, 'findByViewToken'>): Promise<ViewerResolution> {
  if (!UUID.test(input.token)) return { kind: 'gone' }
  const row = await deps.findByViewToken(input.token.toLowerCase())
  if (!row) return { kind: 'gone' }
  return { kind: 'ok', access: { kind: 'viewer' }, blocks: coerceBlocks(row) }
}

/** The link «Compartir vista previa» copies. */
export function viewHref(viewToken: string): string {
  return `/p2s/v/${viewToken}`
}

/**
 * The same link for an owner resolution, so a caller that mails it to the owner (S3.1 «Mándame el enlace») never
 * handles the token itself and stays outside the view-token allow-list (`e2e/p2s-view-token.spec.ts`).
 */
export function shareHrefFor(resolution: Extract<OwnerResolution, { kind: 'ok' }>): string {
  return viewHref(resolution.viewToken)
}
