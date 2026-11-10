/**
 * lib/plan-pause.ts — the pause for lack of a plan, decided in ONE pure place (epic 08 · plan-tienda-three-free-months
 * S3.3 / S3.4, README D9 / D10).
 *
 * The seller's status (active, paused) is Medusa's, changed only through `POST /internal/sellers/:id/status`. That
 * route takes a `reason` but does not store it, so the Backend cannot say WHY a seller is paused. The record that a
 * pause is the PLAN's is ours: `marketplace_shops.metadata.plan_pause = { paused_at }`, claimed before the Backend is
 * asked to pause, and cleared only after the Backend set the seller active again. A payment restores a shop only
 * while that record is there, so an admin pause (which never writes it) is never lifted by a payment (D10).
 *
 * Validate, then claim, then apply — three positions, never two:
 *   validate — `decidePlanPause`, pure: owned, legacy marker ABSENT, KNOWN to be in Mexico (S3.3 review: no United
 *              States plans, so another market is `not_mx` and an unreadable one `unavailable`), plan read uncached as
 *              `unpaid`, a free or paid
 *              term that has ended, not already claimed. Anything it could not read is `unavailable`, never `pause`.
 *   claim    — `plan_pause` written with a guard matching what was read (absent, or JSON null after a release), read
 *              back from the row the write returned.
 *   apply    — the Backend status route. A failure releases the claim (guard `equals` on what was written) so a later
 *              run retries; an answer that the seller is already paused (by someone else) releases it too, so the
 *              payment path never lifts a pause that is not the plan's.
 *
 * PURE + next-free + no `server-only`: the cron shell, the webhook and the Playwright `api` runner import it.
 */
import {
  NEGOCIO_GRANT_KEY,
  NEGOCIO_TRIAL_KEY,
  TIENDA_GRANT_KEY,
  keyedGuardFor,
  readNegocioGrant,
  readNegocioTrial,
  readTiendaGrant,
  type KeyedMetadataGuard,
  type PlanLegacyState,
  type PlanState,
} from './plan'

export const PLAN_PAUSE_KEY = 'plan_pause'

/** The reason sent to the Backend status route when the plan job pauses a shop. */
export const PLAN_PAUSE_REASON = 'plan_unpaid'
/** The reason sent when a payment brings the shop back. */
export const PLAN_RESTORE_REASON = 'plan_paid'

/**
 * The claim. `market: 'mx'` records that the job KNEW the shop was in Mexico when it paused it: a paused seller is
 * hidden from the public seller read (`/store/sellers/:slug` answers 404 for it), so the market can no longer be read
 * afterwards, and the end notice relies on this field instead (lib/negocio-trial-notices.ts).
 */
export type PlanPause = { paused_at: string; market: 'mx' }

/**
 * The shop's market as far as the plan job can tell (plan-tienda S3.3 review). Only `mx` can ever be paused: Plan
 * Tienda and Plan Negocio are Mexico plans and "No United States plans" is a no-go, so a shop in any other market has
 * nothing it could pay. `unknown` — the read failed, the seller is hidden or its id does not match the mirror's, or
 * the projection contradicts the market registry — is never treated as Mexico.
 */
export type PlanPauseMarket = 'mx' | 'other' | 'unknown'

/** The market from a validated public seller projection's code (`readPublicSellerMarket`), or `unknown`. */
export function planPauseMarketOf(marketCode: string | null | undefined): PlanPauseMarket {
  if (marketCode === 'mx') return 'mx'
  if (typeof marketCode === 'string' && marketCode !== '') return 'other'
  return 'unknown'
}

/** The market the claim recorded: `mx` only when the claim says so (an older or malformed claim is `unknown`). */
export function claimMarket(metadata: unknown): PlanPauseMarket {
  const raw = rawPlanPause(metadata) as { market?: unknown } | null
  return raw && typeof raw === 'object' && raw.market === 'mx' ? 'mx' : 'unknown'
}

/**
 * Is there a plan-pause claim on this shop? ANY non-null value under the key counts: only service-role code writes
 * it, so a malformed value is still our claim, and treating it as "none" would let the job pause twice or the
 * payment path skip a restore. JSON null is what a release writes, so it means "no claim".
 */
export function hasPlanPause(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false
  const meta = metadata as Record<string, unknown>
  return PLAN_PAUSE_KEY in meta && meta[PLAN_PAUSE_KEY] !== null && meta[PLAN_PAUSE_KEY] !== undefined
}

/** The claim's value exactly as stored (for an `equals` guard), or null when there is none. */
export function rawPlanPause(metadata: unknown): unknown {
  return hasPlanPause(metadata) ? (metadata as Record<string, unknown>)[PLAN_PAUSE_KEY] : null
}

/** The claim the job writes. */
export function buildPlanPause(now: Date): PlanPause {
  return { paused_at: now.toISOString(), market: 'mx' }
}

/**
 * Did this shop have a plan that ENDED — a trial, or a dated Negocio or Tienda grant whose end has passed? A shop
 * that never had any (an owner who claimed a shop and never opened the panel, so the trial was never stamped) is
 * not "after its free months": it is left alone until its trial starts and ends. A decision the lock did not spell
 * out; it follows the sprint's acceptance ("whose three months ended").
 */
export function hadPlanThatEnded(metadata: unknown, now: Date): boolean {
  const ended = (iso: string | undefined) => !!iso && Date.parse(iso) <= now.getTime()
  const trial = readNegocioTrial(metadata)
  if (trial && ended(trial.expires_at)) return true
  const negocio = readNegocioGrant(metadata)
  if (negocio?.type === 'one_time' && ended(negocio.expires_at)) return true
  const tienda = readTiendaGrant(metadata)
  return !!tienda && ended(tienda.expires_at)
}

export type PausableShop = { clerk_user_id: string | null; metadata: unknown }

export type PlanPauseWhy =
  | 'unpaid' // pause
  | 'unowned'
  | 'legacy' // the marker is there: Plan Gratis for good
  | 'legacy_unreadable' // something is under the marker key that we cannot read: never paused (lib/plan.ts)
  | 'already_claimed'
  | 'not_mx' // a shop in another market: there is no plan it could pay (no United States plans)
  | 'has_plan' // a live plan, or legacy Gratis
  | 'never_started' // no trial or grant ever ended
  | 'plan_unreadable' // the plan could not be read (a failed lookup, or `unavailable`)
  | 'market_unknown' // the shop's market could not be read: never paused on a guess

export type PlanPauseDecision =
  | { action: 'pause'; why: 'unpaid' }
  | { action: 'leave'; why: Exclude<PlanPauseWhy, 'unpaid' | 'plan_unreadable' | 'market_unknown'> }
  | { action: 'unavailable'; why: 'plan_unreadable' | 'market_unknown' }

/**
 * The facts read from the shop row alone (owner, marker, claim). They settle most shops without a single network
 * read, so the runner asks them first; `decidePlanPause` starts with the same function, so the two never disagree.
 */
export function decidePlanPauseFromRow(shop: PausableShop, legacy: PlanLegacyState): PlanPauseDecision | null {
  if (!shop.clerk_user_id) return { action: 'leave', why: 'unowned' }
  if (legacy === 'marked') return { action: 'leave', why: 'legacy' }
  if (legacy === 'unreadable') return { action: 'leave', why: 'legacy_unreadable' }
  if (hasPlanPause(shop.metadata)) return { action: 'leave', why: 'already_claimed' }
  return null
}

/** The market step: a shop not KNOWN to be in Mexico is never paused. */
export function decidePlanPauseMarket(market: PlanPauseMarket): PlanPauseDecision | null {
  if (market === 'other') return { action: 'leave', why: 'not_mx' }
  if (market === 'unknown') return { action: 'unavailable', why: 'market_unknown' }
  return null
}

/**
 * Pause, leave, or "could not tell". `plan` is the plan resolved UNCACHED (`resolvePlan`), or null when the read
 * failed. Only ONE combination pauses; everything else leaves, and a plan we could not read is `unavailable`.
 *
 * Order matters only for the label: the facts that make a shop unpausable whatever its plan (unowned, legacy,
 * already claimed) are checked before the plan read's outcome, so a dry run names the real reason a shop is safe.
 */
export function decidePlanPause(shop: PausableShop, plan: PlanState | null, legacy: PlanLegacyState, now: Date, market: PlanPauseMarket): PlanPauseDecision {
  const fromRow = decidePlanPauseFromRow(shop, legacy)
  if (fromRow) return fromRow
  const fromMarket = decidePlanPauseMarket(market)
  if (fromMarket) return fromMarket
  if (!plan || plan.reason === 'unavailable') return { action: 'unavailable', why: 'plan_unreadable' }
  if (plan.plan !== 'unpaid' || plan.reason !== 'unpaid') return { action: 'leave', why: 'has_plan' }
  if (!hadPlanThatEnded(shop.metadata, now)) return { action: 'leave', why: 'never_started' }
  return { action: 'pause', why: 'unpaid' }
}

// ── The claim and its release (exact RPC arguments, pure so the guards are asserted without a database) ──

/**
 * The `merge_shop_metadata_guards` arguments for the claim. It guards `plan_pause` as read (absent, or JSON null after
 * an earlier release) AND the three keys the plan was decided from, as read: a grant or a trial written between the
 * plan read and this claim makes the claim match no row, so a shop that just paid is never claimed on a stale "unpaid".
 */
export function planPauseClaimArgs(shopId: string, metadata: unknown, claim: PlanPause): { p_shop_id: string; p_patch: Record<string, PlanPause>; p_guards: KeyedMetadataGuard[] } {
  return {
    p_shop_id: shopId,
    p_patch: { [PLAN_PAUSE_KEY]: claim },
    p_guards: [PLAN_PAUSE_KEY, NEGOCIO_GRANT_KEY, TIENDA_GRANT_KEY, NEGOCIO_TRIAL_KEY].map((k) => keyedGuardFor(metadata, k)),
  }
}

/**
 * The `merge_shop_metadata` arguments that clear a claim: JSON null, and only if the key still holds exactly
 * `expected` (what this run wrote, or what the restore read). A newer claim is never cleared by an older actor.
 */
export function planPauseClearArgs(shopId: string, expected: unknown) {
  return { p_shop_id: shopId, p_patch: { [PLAN_PAUSE_KEY]: null }, p_guard_key: PLAN_PAUSE_KEY, p_guard_mode: 'equals' as const, p_expected: expected }
}

/** Did the row a claim write returned carry exactly that claim? "The call did not error" is not "it is claimed". */
export function claimLanded(returnedMetadata: unknown, claim: PlanPause): boolean {
  const raw = rawPlanPause(returnedMetadata) as { paused_at?: unknown } | null
  return !!raw && typeof raw === 'object' && raw.paused_at === claim.paused_at
}

// ── The job's runner (the I/O is injected, so the claim → call → release order is tested without a database) ──

export type PauseCandidate = {
  id: string
  slug: string | null
  name: string | null
  clerk_user_id: string | null
  metadata: unknown
}

/** What the Backend said when asked to pause. */
export type PauseCallResult =
  | { outcome: 'paused'; complete: boolean } // the seller is paused now (complete: every market link was removed)
  | { outcome: 'already_paused' } // 409 no_change: paused before, by someone else
  | { outcome: 'failed'; detail: string } // definitely did not apply
  | { outcome: 'unknown'; detail: string } // we cannot tell (a timeout, a gateway error, an answer we cannot read)

/**
 * The shape `changeSellerStatus` (lib/admin/tenant-status.ts) answers with, restated structurally so this pure module
 * does not import a server-only file. Only the fields read below.
 */
export type StatusChangeAnswer =
  | { ok: 'unknown'; message: string }
  | { ok: true; to: string; complete: boolean }
  | { ok: false; status: number; message: string }

/** The Backend's answer to a pause request, as the runner's four outcomes. */
export function pauseOutcomeOf(result: StatusChangeAnswer): PauseCallResult {
  if (result.ok === 'unknown') return { outcome: 'unknown', detail: result.message }
  if (result.ok === false) {
    // The Backend answers 409 only for `no_change` (`planSellerStatusChange`): the seller was already paused.
    if (result.status === 409) return { outcome: 'already_paused' }
    // ANY 5xx is "we do not know", not "it did not happen" (verifier S3): a 500 Medusa authors after the unlinks ran
    // leaves a dark shop reading `active`. `changeSellerStatus` calls only 502/503/504 ambiguous; this caller is
    // stricter on purpose, because releasing the claim here is the one mistake a payment cannot repair.
    if (result.status >= 500) return { outcome: 'unknown', detail: `HTTP ${result.status}: ${result.message}` }
    return { outcome: 'failed', detail: `HTTP ${result.status}: ${result.message}` }
  }
  // `to` is the status the seller ACTUALLY holds: a pause whose every unlink failed leaves it active.
  // `complete: false` is a PARTIAL pause: the seller reads paused but some of its products are still linked to a
  // market channel (an unlink failed, or the ledger held entries it could not parse). The Backend cannot finish it on
  // a re-run: asking for `paused` again is refused as `no_change` (409) before any work. So it is never a clean pause.
  if (result.to === 'paused') return { outcome: 'paused', complete: result.complete }
  return { outcome: 'failed', detail: `the Backend left the seller ${result.to} (no product could be unlinked)` }
}

/** What the Backend said when the settle step asked to undo a pause. */
export type UnpauseCallResult =
  | { outcome: 'active'; complete: boolean }
  | { outcome: 'already_active' }
  | { outcome: 'failed'; detail: string }
  | { outcome: 'unknown'; detail: string }

/** The Backend's answer to the settle step's unpause (same mapping as the payment path's restore). */
export function unpauseOutcomeOf(result: StatusChangeAnswer): UnpauseCallResult {
  if (result.ok === 'unknown') return { outcome: 'unknown', detail: result.message }
  if (result.ok === false) {
    if (result.status === 409) return { outcome: 'already_active' }
    if (result.status >= 500) return { outcome: 'unknown', detail: `HTTP ${result.status}: ${result.message}` }
    return { outcome: 'failed', detail: `HTTP ${result.status}: ${result.message}` }
  }
  if (result.to === 'active') return { outcome: 'active', complete: result.complete }
  return { outcome: 'failed', detail: `the Backend left the seller ${result.to}` }
}

/** Is the claim read now exactly the one this run wrote? */
export function claimIsOurs(current: unknown, claim: PlanPause): boolean {
  return !!current && typeof current === 'object' && (current as { paused_at?: unknown }).paused_at === claim.paused_at
}

/** The seller's status before the claim: the validate step's last read. */
export type SellerStatusFact = 'active' | 'paused' | 'deleted' | 'unavailable' | 'no_seller'

export interface PlanPauseDeps {
  /** One page of owned shops, in a stable order; null = could not read (the run reports unavailable, never "nobody"). */
  readPage: (from: number, to: number) => Promise<PauseCandidate[] | null>
  pageSize: number
  /** The plan, resolved uncached; null = could not read. */
  readPlan: (shop: PauseCandidate) => Promise<PlanState | null>
  /** The legacy state, from the metadata read with the shop. Injected so the shell and the spec use one reader. */
  readLegacy: (metadata: unknown) => PlanLegacyState
  /** The shop's market, read fresh from its Medusa seller; `unknown` when it cannot be told (never a default). */
  readMarket: (shop: PauseCandidate) => Promise<PlanPauseMarket>
  /** The Medusa seller's current status. */
  readSellerStatus: (shop: PauseCandidate) => Promise<SellerStatusFact>
  /** Write `plan_pause = claim`, guarded on what was read; true only when the returned row carries exactly it. */
  claim: (shop: PauseCandidate, claim: PlanPause) => Promise<boolean>
  /** Ask the Backend to pause the seller with `PLAN_PAUSE_REASON`. */
  pause: (shop: PauseCandidate) => Promise<PauseCallResult>
  /** Clear the claim (guard `equals` on `claim`); true when it was cleared. */
  release: (shop: PauseCandidate, claim: PlanPause) => Promise<boolean>
  /** The `plan_pause` value now, read fresh; `'unavailable'` when the read failed. */
  readClaim: (shop: PauseCandidate) => Promise<unknown | 'unavailable'>
  /** Ask the Backend to set the seller active with `PLAN_RESTORE_REASON` (the settle step's undo). */
  unpause: (shop: PauseCandidate) => Promise<UnpauseCallResult>
  /** Put the claim back when it is gone (guard: `plan_pause` absent or JSON null); true when written. */
  restoreClaim: (shop: PauseCandidate, claim: PlanPause) => Promise<boolean>
  alert: (message: string) => void
  now: () => Date
}

export type PlanPauseEntry = {
  shopId: string
  slug: string | null
  name: string | null
  /** What happened to this shop on this run (a dry run stops at `would_pause`). */
  result:
    | 'would_pause'
    | 'paused'
    | 'already_paused'
    | 'not_active'
    | 'seller_unavailable'
    | 'no_seller'
    | 'claim_lost'
    | 'paid_meanwhile'
    | 'paused_partly'
    | 'unpaused_after_payment'
    | 'plan_unavailable'
    | 'failed'
    | 'unknown'
  detail?: string
}

export type PlanPauseRun =
  | {
      ok: true
      dryRun: boolean
      read: number
      /** Every shop the decision said to pause, with what became of it. */
      candidates: PlanPauseEntry[]
      paused: number
      left: Record<string, number>
      unavailable: number
      /** The `unavailable` shops by reason (`plan_unreadable`, `market_unknown`); after the claim, by their entry. */
      unavailableBy: Record<string, number>
      failed: number
    }
  | { ok: false; error: 'unavailable'; read: number }

/** Upper bound on pages: a paging bug must end the run loudly, never loop forever. */
const MAX_PAGES = 200

/**
 * The daily job. Reads every owned shop page by page, decides each, and for a `pause`: validate the seller is active
 * → claim → pause → (release on failure). `dryRun` reads and decides and writes NOTHING — no claim, no Backend write
 * — and returns the list. A page that cannot be read fails the whole run (`unavailable`): a half-read population
 * reported as complete would hide shops.
 */
export async function runPlanPause(deps: PlanPauseDeps, opts: { dryRun: boolean }): Promise<PlanPauseRun> {
  const shops: PauseCandidate[] = []
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) return { ok: false, error: 'unavailable', read: shops.length }
    const from = page * deps.pageSize
    const rows = await deps.readPage(from, from + deps.pageSize - 1)
    if (!rows) return { ok: false, error: 'unavailable', read: shops.length }
    shops.push(...rows)
    if (rows.length < deps.pageSize) break
  }

  const now = deps.now()
  const candidates: PlanPauseEntry[] = []
  const left: Record<string, number> = {}
  const unavailableBy: Record<string, number> = {}
  let unavailable = 0
  let paused = 0
  let failed = 0
  const entry = (shop: PauseCandidate, result: PlanPauseEntry['result'], detail?: string): PlanPauseEntry => ({
    shopId: shop.id,
    slug: shop.slug,
    name: shop.name,
    result,
    ...(detail ? { detail } : {}),
  })


  /**
   * SETTLE — after the Backend paused the seller, decide whether the pause may stand (Codex, PR 487).
   *
   * The race it closes: a payment can land at ANY point of this run, and its restore hook
   * (`restoreAfterPlanPaid`, lib/plan-restore.ts) reads the claim → asks the Backend for `active` → clears the claim.
   * If that hook runs entirely before our pause call, it finds the seller still active (409, `already_active`),
   * clears the claim, and our pause then lands on a PAID shop with no claim — and no later payment would restore it.
   *
   * So, after the pause call, the job reads the claim and the plan again (uncached) and lets the pause stand ONLY when
   * both say nothing happened: the claim is still exactly ours, and the plan is still `unpaid`. Otherwise it undoes
   * its own pause (`active`, reason `plan_paid`) and clears the claim. A read that fails counts as "something
   * happened": the cost of being wrong that way is one unpaid shop open until tomorrow's run; the cost of the other
   * way is a paying merchant left dark.
   *
   * Why this is enough: a payment is RECORDED (grant written, or subscription created) before its hook runs, and the
   * hook clears the claim only after its own Backend call. Every interleaving, by where the payment lands:
   *
   *   payment recorded …                          | what the job sees                 | outcome
   *   ------------------------------------------- | --------------------------------- | -----------------------------------
   *   before the job's claim (a grant)            | claim lost (grant key guarded)    | never claimed, never paused
   *   before the claim (a subscription), hook     | re-check: plan paid               | released, never paused
   *     found no claim                            |                                   |
   *   between claim and re-check                  | re-check: plan paid               | released, never paused; the hook,
   *                                               |                                   |   if it saw the claim, gets 409 and
   *                                               |                                   |   clears it
   *   between re-check and pause call; hook ran   | settle: claim gone                | job unpauses → active
   *     fully before the pause call (the bug)     |                                   |
   *   between re-check and pause call; hook       | settle: plan paid (it was         | job unpauses; the hook's clear (or
   *     mid-flight at the settle reads            |   recorded before the hook)       |   ours) removes the claim
   *   during the pause call; hook after it        | settle: plan paid, or claim gone  | job unpauses, or the hook already
   *                                               |                                   |   restored (job's unpause gets 409)
   *   after the settle reads                      | claim ours, plan unpaid           | pause stands; the hook then sees
   *                                               |                                   |   the claim and restores
   *
   * In no row does a recorded payment leave the shop paused without the claim that lets the hook restore it.
   */
  async function settle(shop: PauseCandidate, claim: PlanPause, complete: boolean, detail?: string): Promise<void> {
    const current = await deps.readClaim(shop).catch(() => 'unavailable' as const)
    const plan = await deps.readPlan(shop).catch(() => null)
    const ours = current !== 'unavailable' && claimIsOurs(current, claim)
    const stillUnpaid = !!plan && plan.plan === 'unpaid' && plan.reason === 'unpaid'
    if (ours && stillUnpaid) {
      paused += 1
      if (complete) { candidates.push(entry(shop, 'paused', detail)); return }
      // The seller reads paused but some products are still on sale. A re-run of the Backend route cannot finish it
      // (paused → paused is refused), so a person must; the claim stays, so a payment still restores the shop.
      candidates.push(entry(shop, 'paused_partly', detail))
      deps.alert(`🚨 Pausa por falta de plan INCOMPLETA: la tienda quedó en pausa pero algunos productos siguen publicados — revisar a mano en /admin/tenants.\nShop: ${shop.slug ?? shop.id}`)
      return
    }
    // Something happened while we paused: undo our own pause.
    const undo = await deps.unpause(shop).catch((e): UnpauseCallResult => ({ outcome: 'unknown', detail: e instanceof Error ? e.message : String(e) }))
    if (undo.outcome === 'active' || undo.outcome === 'already_active') {
      if (ours || current === 'unavailable') await deps.release(shop, claim).catch(() => false)
      candidates.push(entry(shop, 'unpaused_after_payment'))
      if (undo.outcome === 'active' && !undo.complete) {
        deps.alert(`⚠️ La tienda se reactivó tras un pago que llegó durante la pausa, pero no todos sus productos volvieron — revisar en /admin/tenants.\nShop: ${shop.slug ?? shop.id}`)
      }
      return
    }
    // The undo did not land: the shop may be paid AND paused. Keep (or put back) the claim so the next payment, or a
    // person, can still bring it back as the plan's pause, and say so loudly.
    if (!ours) await deps.restoreClaim(shop, claim).catch(() => false)
    failed += 1
    candidates.push(entry(shop, 'failed', `paid while pausing; unpause ${undo.outcome}: ${undo.detail}`))
    deps.alert(`🚨 Llegó un pago mientras la tienda se pausaba y NO se pudo reactivar — reactivarla a mano en /admin/tenants.\nShop: ${shop.slug ?? shop.id}\n${undo.detail}`)
  }

  for (const shop of shops) {
    const legacy = deps.readLegacy(shop.metadata)
    // In the order of `decidePlanPause`, cheapest first: the row (no read), then the market (one public read), then
    // the plan (the Backend's subscription reads). Each later read happens only when the earlier facts did not settle
    // the shop, and the final call re-decides from ALL the facts, so the shortcut can never decide differently.
    const decision = await (async (): Promise<PlanPauseDecision> => {
      const fromRow = decidePlanPauseFromRow(shop, legacy)
      if (fromRow) return fromRow
      const market = await deps.readMarket(shop).catch((): PlanPauseMarket => 'unknown')
      const fromMarket = decidePlanPauseMarket(market)
      if (fromMarket) return fromMarket
      const plan = await deps.readPlan(shop).catch(() => null)
      return decidePlanPause(shop, plan, legacy, now, market)
    })()
    if (decision.action === 'unavailable') { unavailable += 1; unavailableBy[decision.why] = (unavailableBy[decision.why] ?? 0) + 1; continue }
    if (decision.action === 'leave') { left[decision.why] = (left[decision.why] ?? 0) + 1; continue }

    // VALIDATE: the seller must be active now. Already paused (by an admin) or deleted: not ours to touch.
    const status = await deps.readSellerStatus(shop).catch((): SellerStatusFact => 'unavailable')
    if (status === 'no_seller') { candidates.push(entry(shop, 'no_seller')); failed += 1; continue }
    if (status === 'unavailable') { candidates.push(entry(shop, 'seller_unavailable')); unavailable += 1; continue }
    if (status !== 'active') { candidates.push(entry(shop, 'not_active', status)); continue }

    if (opts.dryRun) { candidates.push(entry(shop, 'would_pause')); continue }

    // CLAIM — the record that this pause is the plan's, written before the Backend is asked.
    const claim = buildPlanPause(now)
    const claimed = await deps.claim(shop, claim).catch(() => false)
    if (!claimed) { candidates.push(entry(shop, 'claim_lost')); continue }

    // Re-validate after the claim, before anything irreversible: a monthly subscription is not in the metadata the
    // claim guarded, so one activated in the last instant is caught here. If its payment hook ran before our claim it
    // found nothing to restore, so pausing now would leave a PAID shop dark.
    const recheck = await deps.readPlan(shop).catch(() => null)
    if (!recheck || recheck.plan !== 'unpaid' || recheck.reason !== 'unpaid') {
      await deps.release(shop, claim).catch(() => false)
      candidates.push(entry(shop, recheck ? 'paid_meanwhile' : 'plan_unavailable'))
      if (!recheck) unavailable += 1
      continue
    }

    // APPLY.
    const result = await deps.pause(shop).catch((e): PauseCallResult => ({ outcome: 'unknown', detail: e instanceof Error ? e.message : String(e) }))
    if (result.outcome === 'paused') { await settle(shop, claim, result.complete); continue }

    if (result.outcome === 'unknown') {
      // We do not know whether the Backend paused it, and a read-back cannot settle it: the Backend flips the status
      // LAST, after draining the catalog, writing the ledger and unlinking — all of which can still be running after
      // our client gave up. So the claim is NEVER released here (verifier B1): releasing over a pause that lands a
      // moment later would leave a plan pause with no claim, and a payment would then find nothing to restore. A claim
      // left on a shop that stays active is harmless: the next payment's restore gets 409 and clears it.
      const after = await deps.readSellerStatus(shop).catch((): SellerStatusFact => 'unavailable')
      // Already paused: the race with a payment still applies, so settle (the answer saying whether every link came
      // off was lost, so it is not a clean pause).
      if (after === 'paused') { await settle(shop, claim, false, 'confirmed by re-read'); continue }
      candidates.push(entry(shop, 'unknown', `${result.detail} · status read back: ${after}`)); failed += 1
      deps.alert(`🚨 Pausa por falta de plan: NO sabemos si la tienda quedó en pausa (el backend no respondió claro; puede seguir pausándola). La marca plan_pause se queda — revisar a mano en /admin/tenants.\nShop: ${shop.slug ?? shop.id}\n${result.detail}`)
      continue
    }

    // `already_paused` (someone else paused it after our read) or `failed`: the claim must not stay. For an admin
    // pause, a claim left behind would let a payment lift it; for a failure, it would stop a later run retrying.
    const released = await deps.release(shop, claim).catch(() => false)
    if (result.outcome === 'already_paused') {
      candidates.push(entry(shop, 'already_paused', released ? undefined : 'claim NOT released'))
      if (!released) deps.alert(`🚨 Pausa por falta de plan: la tienda ya estaba en pausa por otra razón y NO se pudo quitar nuestra marca plan_pause — quitarla a mano, o un pago la reactivaría.\nShop: ${shop.slug ?? shop.id}`)
      continue
    }
    candidates.push(entry(shop, 'failed', `${result.detail}${released ? '' : ' · claim NOT released'}`)); failed += 1
    deps.alert(`⚠️ Pausa por falta de plan FALLÓ${released ? ' (se reintenta mañana)' : ' y NO se pudo liberar la marca — quitar plan_pause a mano'}.\nShop: ${shop.slug ?? shop.id}\n${result.detail}`)
  }

  return { ok: true, dryRun: opts.dryRun, read: shops.length, candidates, paused, left, unavailable, unavailableBy, failed }
}
