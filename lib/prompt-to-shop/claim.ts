/**
 * Prompt-to-shop — keep a draft: claim it, then turn it into ONE shop (epic S3.2, D16).
 *
 * The order is the contract: validate (pure) → look up the seller (read) → claim (one conditional write) → apply.
 * Nothing reaches Medusa before the claim has landed, and the claim is the only thing that decides who owns the
 * draft: `UPDATE … WHERE id AND device_id AND claimed_by IS NULL AND expires_at > now() AND identity IS NOT NULL`,
 * read back with `.select()` (supabase-js reports no error for an UPDATE that matched nothing).
 *
 * Apply is `ensureShop` + `applyStoreConfig` IN-PROCESS (never `fetch()` to our own authed route: the cookie does
 * not travel server-side, team memory / PR 244), with ONLY the `profile` block built from the draft's identity and
 * words. The catalog examples never leave the draft: there is no import, no product and no support block here, and
 * `e2e/p2s-claim.spec.ts` asserts that on the effect trace and on the source.
 *
 * Decisions this module encodes (each one spec-covered):
 *
 *   • A draft is poured ONLY into a seller that THIS keep created. Proof of that is `ensureShop` answering 201 in
 *     this very call — nothing weaker. A present seller at the lookup means no claim at all; a 200 from
 *     `ensureShop` (a shop made between the lookup and the create: another tab, the manual wizard, an agent) means
 *     «Ya tienes una tienda», no config applied, and the claim RELEASED (one conditional write, read back) so the
 *     draft is not stranded. An existing shop is never overwritten by a draft, however it came to exist.
 *   • `claimed_seller_id` is written IMMEDIATELY after the 201, before the config. It means "this draft made this
 *     seller", and it is final: a reload returns that shop and applies nothing again, so a merchant's later edits
 *     in /shop/manage are never clobbered. If the config apply then fails, the keep is still done — the shop already
 *     carries the draft's name, description and location from the create — and the outcome says
 *     `configApplied: false` instead of pretending, or retrying onto a shop the merchant may already be editing.
 *   • A draft claimed by THIS user with no `claimed_seller_id` is a keep that stopped before a seller existed (the
 *     create failed, or the tab closed). Re-entering resumes it only while the lookup says the user has no shop,
 *     and again applies only on a 201. A present seller there is `has_shop` + release, as above — whether the user
 *     built that shop by hand after a failed keep, or it came from ANOTHER draft they kept since (revisiting draft X
 *     after draft Y became the shop). Only this call's 201 ever proves a seller came from this draft.
 *   • Anything else that cannot claim — another phone, another account, expired, missing, malformed — gets the SAME
 *     «Esta tienda se armó en otro teléfono» answer, so a stranger learns nothing about the id. That includes the
 *     right phone holding a draft another account already kept: the device proves it made the draft, not that it
 *     owns the account that kept it.
 *   • The welcome email is not this module's business: `ensureShop` sends it on a 201 through the existing
 *     reserve-once path (`reserve_shop_created_welcome`). A resumed or second-tab keep gets a 200, which only
 *     retries a delivery that already exists.
 *   • The address (slug) is not chosen here. `POST /store/sellers/me` derives it from the name and appends `-1`,
 *     `-2`… until it is free, so a taken name never fails the keep; the merchant can change it later in Ajustes.
 *
 * Pure: every effect is an injected dependency, so the spec drives each branch with fakes and reads the trace.
 */

import type { EnsureShopResult, ShopCreateInput } from '../ensure-shop'
import type { StoreConfigManifest } from '../settings-import'
import { coerceBlocks } from './access'
import { profileOf, type IdentityBlock, type WordsBlock } from './blocks'
import { CLAIM_RETRY } from './copy'
import { readDeviceId } from './handler'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A draft row as the claim and the re-read return it. */
export interface ClaimRow {
  id: string
  device_id: string
  identity: unknown
  words: unknown
  claimed_by: string | null
  claimed_seller_id: string | null
  expires_at: string
}

export type SellerLookup =
  | { state: 'present'; seller: { id: string; slug: string } }
  | { state: 'absent' }
  /** Medusa unreachable or an unexpected status. NOT "absent": a confident "no shop" here would create a second. */
  | { state: 'unavailable' }

export interface ClaimDeps {
  /** The signed-in user's seller, three states. */
  findSeller: () => Promise<SellerLookup>
  /** The ONE conditional write. The row when it landed, null when it matched nothing; throws on a database error. */
  claim: (draftId: string, deviceId: string, userId: string) => Promise<ClaimRow | null>
  /** The row by id alone, whatever its state — the decision about what it means is made here, not in SQL. */
  reread: (draftId: string) => Promise<ClaimRow | null>
  ensureShop: (input: ShopCreateInput) => Promise<EnsureShopResult>
  applyConfig: (manifest: StoreConfigManifest) => Promise<{ ok: boolean; error?: string }>
  /**
   * "This draft made this seller". Conditional on id, an unset `claimed_seller_id`, and the draft being this user's
   * or released (a racing tab may have released it a moment ago — the 201 is the stronger fact), read back.
   */
  markSeller: (draftId: string, userId: string, sellerId: string) => Promise<boolean>
  /** Give the draft back: `claimed_by = null` WHERE id AND claimed_by = user AND claimed_seller_id IS NULL, read back. */
  release: (draftId: string, userId: string) => Promise<boolean>
  log: (line: Record<string, unknown>) => void
  revalidate: () => void
  now: () => Date
}

export type ClaimOutcome =
  /** `configApplied: false` — the shop exists from this draft, but its colours and words did not land. */
  | { kind: 'kept'; draftId: string; shopSlug: string; resumed: boolean; configApplied: boolean }
  | { kind: 'other_phone' }
  | { kind: 'has_shop'; shopSlug: string }
  /** The draft is this phone's and unclaimed, but its name and colours have not landed yet. */
  | { kind: 'incomplete'; draftId: string }
  | { kind: 'signed_out' }
  /** Something transient failed. Nothing is lost: the same user re-entering resumes from wherever it stopped. */
  | { kind: 'retry'; message: string }

/** What the draft becomes in the shop create. The name is required (the claim refuses a draft without identity). */
export function shopInputFrom(identity: IdentityBlock): ShopCreateInput {
  return {
    name: identity.name,
    description: identity.description,
    ...(identity.state ? { state: identity.state } : {}),
    ...(identity.city ? { city: identity.city } : {}),
    // No slug: the backend derives a free one from the name (see the module header). No market: a draft is an
    // es-MX shop (AGENTS rule 5), which is the documented default when it is omitted.
  }
}

/**
 * The manifest a keep applies: `profile` and nothing else. Not `catalog` (the examples stay in the draft), not
 * `support` (enabling it provisions a Medusa product), not `presentation` or `policies` (nothing generated them).
 */
export function manifestFrom(identity: IdentityBlock, words: WordsBlock | null): StoreConfigManifest {
  return { profile: profileOf(identity, words ?? undefined) }
}

export interface ClaimInput {
  draftId: string
  deviceCookie: string | null | undefined
  userId: string | null | undefined
}

/** Who is asking about this row, decided purely. */
export function classifyRow(
  row: ClaimRow | null,
  who: { userId: string; deviceId: string | null; now: Date },
): 'mine' | 'claimable' | 'not_ready' | 'other_phone' {
  if (!row) return 'other_phone'
  if (row.claimed_by) return row.claimed_by === who.userId ? 'mine' : 'other_phone'
  if (!who.deviceId || row.device_id !== who.deviceId) return 'other_phone'
  if (!(new Date(row.expires_at).getTime() > who.now.getTime())) return 'other_phone'
  return row.identity ? 'claimable' : 'not_ready'
}

export async function claimAndApply(input: ClaimInput, deps: ClaimDeps): Promise<ClaimOutcome> {
  // ── validate (pure) ───────────────────────────────────────────────────────────────────────────────────────────
  const userId = input.userId
  if (!userId) return { kind: 'signed_out' }
  if (typeof input.draftId !== 'string' || !UUID.test(input.draftId)) return { kind: 'other_phone' }
  const draftId = input.draftId.toLowerCase()
  const deviceId = readDeviceId(input.deviceCookie)

  // ── look up the seller BEFORE any write: an existing shop is never handed a draft ──────────────────────────────
  const seller = await deps.findSeller()
  if (seller.state === 'unavailable') return { kind: 'retry', message: CLAIM_RETRY.lookup }

  let row: ClaimRow | null = null
  let resumed = false
  try {
    // ── claim: only for a user with no shop, on the phone that made the draft ────────────────────────────────────
    if (seller.state === 'absent' && deviceId) row = await deps.claim(draftId, deviceId, userId)
    if (!row) {
      // Zero rows (or no claim attempted): re-read and decide what the row means for THIS user.
      const current = await deps.reread(draftId)
      const verdict = classifyRow(current, { userId, deviceId, now: deps.now() })
      if (verdict === 'other_phone') return { kind: 'other_phone' }
      if (verdict === 'not_ready') return seller.state === 'present' ? { kind: 'has_shop', shopSlug: seller.seller.slug } : { kind: 'incomplete', draftId }
      if (verdict === 'mine' && !current!.claimed_seller_id && seller.state === 'present') {
        // A keep that stopped before its seller existed, and the user has a shop now that this draft did not make.
        await release(deps, draftId, userId)
        return { kind: 'has_shop', shopSlug: seller.seller.slug }
      }
      if (verdict === 'claimable') {
        // Only reachable with a shop already present (an absent seller would have claimed it above, or lost a race
        // that the re-read then shows as claimed). The draft stays unclaimed and the existing shop untouched.
        if (seller.state === 'present') return { kind: 'has_shop', shopSlug: seller.seller.slug }
        // The claim matched nothing, yet the row reads claimable: a row that changed under us. Do not guess.
        return { kind: 'retry', message: CLAIM_RETRY.draft }
      }
      // verdict === 'mine' — this user kept it before (a reload, a second tab, or a keep that stopped half way).
      row = current!
      resumed = true
      if (row.claimed_seller_id) {
        // Finished earlier. Nothing is applied again.
        if (seller.state === 'present') return { kind: 'kept', draftId, shopSlug: seller.seller.slug, resumed, configApplied: true }
        // The seller it became is gone (paused and removed, or deleted). There is no shop to return to.
        return { kind: 'other_phone' }
      }
    }
  } catch {
    return { kind: 'retry', message: CLAIM_RETRY.draft }
  }

  // ── apply: the draft is this user's and not yet a finished shop ───────────────────────────────────────────────
  const { identity, words } = coerceBlocks({ identity: row.identity, words: row.words, catalog: null, block_status: {} })
  // The claim's WHERE requires an identity, so this is a row damaged after the fact. Refuse rather than invent one.
  if (!identity) return { kind: 'incomplete', draftId }

  const shop = await deps.ensureShop(shopInputFrom(identity))
  if (!shop.ok) return { kind: 'retry', message: CLAIM_RETRY.shop }
  if (shop.status !== 201) {
    // The seller already existed: this keep did not make it, so the draft is not poured into it.
    await release(deps, draftId, userId)
    return { kind: 'has_shop', shopSlug: shop.shopSlug }
  }

  // 201: this call created the seller from this draft. Record that first; it is what makes a reload harmless.
  const marked = await deps.markSeller(draftId, userId, shop.sellerId).catch(() => false)
  if (!marked) deps.log({ event: 'claim_mark_failed', draft: draftId, seller: shop.sellerId })

  const applied = await deps.applyConfig(manifestFrom(identity, words)).catch(() => ({ ok: false }))
  if (!applied.ok) deps.log({ event: 'claim_config_failed', draft: draftId, seller: shop.sellerId })

  deps.revalidate()
  return { kind: 'kept', draftId, shopSlug: shop.shopSlug, resumed, configApplied: applied.ok }
}

async function release(deps: ClaimDeps, draftId: string, userId: string): Promise<void> {
  const released = await deps.release(draftId, userId).catch(() => false)
  if (!released) deps.log({ event: 'claim_release_failed', draft: draftId })
}
