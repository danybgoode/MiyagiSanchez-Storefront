/**
 * lib/plan-restore.ts — a payment brings a shop paused for lack of a plan back (epic 08 ·
 * plan-tienda-three-free-months S3.4, README D10). The pause record and its readers live in `lib/plan-pause.ts`.
 *
 * PURE runner with injected I/O (`lib/plan-restore-server.ts` is the shell), so "only with `plan_pause`", "a replay
 * restores nothing twice" and "a failure never throws into the payment" are tested without a database.
 */
import { hasPlanPause, rawPlanPause } from './plan-pause'

export type RestoreCallResult =
  | { outcome: 'active'; complete: boolean } // the seller is active now (complete: every recorded link came back)
  | { outcome: 'already_active' } // 409 no_change: active before this call
  | { outcome: 'failed'; detail: string }
  | { outcome: 'unknown'; detail: string }

export interface PlanRestoreDeps {
  /** The shop's metadata, or null when there is no such shop; throws when it cannot be read. */
  readMetadata: (shopId: string) => Promise<unknown | null>
  /** Ask the Backend to set the seller active with `PLAN_RESTORE_REASON`. */
  activate: (shopId: string, metadata: unknown) => Promise<RestoreCallResult>
  /** Clear the claim with an `equals` guard on `expected` (the value read). True when cleared. */
  clearClaim: (shopId: string, expected: unknown) => Promise<boolean>
  alert: (message: string) => void
}

export type PlanRestoreOutcome = 'not_paused' | 'restored' | 'restored_partly' | 'already_active' | 'failed' | 'no_shop'

/**
 * After a plan payment or subscription activation was RECORDED. Restores only a shop holding `plan_pause` (D10): no
 * claim, no call — an admin pause stays paused. Relink first (the Backend replays the ledger), clear the claim after.
 * A replay finds no claim and does nothing; one whose earlier clear failed gets `already_active` and clears it then.
 * NEVER throws: the payment already landed, and the caller must not lose it to a restore problem.
 */
export async function restoreAfterPlanPaid(shopId: string, deps: PlanRestoreDeps): Promise<PlanRestoreOutcome> {
  try {
    const metadata = await deps.readMetadata(shopId)
    if (metadata === null) return 'no_shop'
    if (!hasPlanPause(metadata)) return 'not_paused'
    const expected = rawPlanPause(metadata)
    const result = await deps.activate(shopId, metadata).catch((e): RestoreCallResult => ({ outcome: 'unknown', detail: e instanceof Error ? e.message : String(e) }))
    if (result.outcome === 'failed' || result.outcome === 'unknown') {
      // The claim stays: it is what lets the next attempt (by hand, or a replayed event) know the pause is the plan's.
      deps.alert(`🚨 Pago recibido pero la tienda NO se reactivó (sigue en pausa por falta de plan) — reactivarla a mano en /admin/tenants.\nShop: ${shopId}\n${result.detail}`)
      return 'failed'
    }
    const cleared = await deps.clearClaim(shopId, expected).catch(() => false)
    if (!cleared) deps.alert(`⚠️ La tienda se reactivó tras el pago, pero no se pudo quitar la marca plan_pause — quitarla a mano.\nShop: ${shopId}`)
    if (result.outcome === 'already_active') return 'already_active'
    if (!result.complete) {
      deps.alert(`⚠️ La tienda se reactivó tras el pago, pero no todos sus productos volvieron al catálogo — revisar en /admin/tenants.\nShop: ${shopId}`)
      return 'restored_partly'
    }
    return 'restored'
  } catch (e) {
    deps.alert(`🚨 Pago recibido pero no se pudo revisar si la tienda estaba en pausa — revisar a mano.\nShop: ${shopId}\n${e instanceof Error ? e.message : String(e)}`)
    return 'failed'
  }
}

/** The shape `changeSellerStatus` answers with (lib/admin/tenant-status.ts), restated structurally: only what is read. */
export type RestoreStatusAnswer =
  | { ok: 'unknown'; message: string }
  | { ok: true; to: string; complete: boolean }
  | { ok: false; status: number; message: string }

/** The Backend's answer to "set this seller active", as the runner's four outcomes. */
export function restoreOutcomeOf(result: RestoreStatusAnswer): RestoreCallResult {
  if (result.ok === 'unknown') return { outcome: 'unknown', detail: result.message }
  if (result.ok === false) {
    // 409 is only `no_change` (`planSellerStatusChange`): the seller is active already — an earlier restore whose
    // clear failed, or an admin who reactivated it by hand.
    if (result.status === 409) return { outcome: 'already_active' }
    return { outcome: 'failed', detail: `HTTP ${result.status}: ${result.message}` }
  }
  if (result.to === 'active') return { outcome: 'active', complete: result.complete }
  return { outcome: 'failed', detail: `the Backend left the seller ${result.to}` }
}
