/**
 * lib/promoter-upgrade-share.ts — the 20% upgrade share (plan-tienda D14) as validate → claim → apply, with the I/O
 * injected (plan-tienda S4 review, Codex security on PR 486).
 *
 * THE RACE IT CLOSES: "superseded by a Negocio package sold after the tienda_anual" was a read, and the share's insert
 * came after it. A package attribution landing between the two still paid the earlier promoter 20% of a move up that
 * the package sale had already made.
 *
 *   1. validate — the latest tienda_anual, the 12-month window, and no later Negocio package (`decideUpgradeShare`).
 *   2. claim    — insert the share row in a state that does NOT accrue (`claimed`: the accrual pays only `paid` rows),
 *                 under the anchor-keyed `payment_ref`, whose unique index admits one row per tienda_anual. A
 *                 collision returns the existing row: `paid` (already applied: re-run the idempotent accrual),
 *                 `void` (already found superseded: nothing), or `claimed` (an earlier delivery stopped here:
 *                 continue from step 3).
 *   3. re-check — supersession again, AFTER the claim is visible. A package that landed before this read is seen,
 *                 and the claim is voided (conditionally, only while still `claimed`).
 *   4. apply    — `claimed → paid`, conditionally, then accrue.
 * Interleavings: a package attribution committed before step 1 or anywhere up to step 3's read is seen (skip, or
 * void). One committed AFTER step 3's read was sold after this merchant payment was already the first Negocio payment
 * — the share is then correct, and the serialisation point is step 3. Two deliveries of the same payment, or two
 * payments under one tienda_anual, share one row: the conditional void and confirm let exactly one transition win, and
 * the loser reads the row's final state.
 */
import type { AccrualOutcome } from './promoter-commission'
import { accrualSettles } from './promoter-commission'
import { decideUpgradeShare } from './promoter-packages'

export type UpgradeShareRow = { id: string; status: string }

export type UpgradeShareDeps = {
  /** The shop's latest paid tienda_anual attribution, or null. Throws when it could not be read. */
  readAnchor: () => Promise<{ attributionId: string; promoterId: string; paidAt: Date } | null>
  /** Is there a paid Negocio package attribution for this shop created after `after`? Throws when unreadable. */
  negocioPackageAfter: (after: Date) => Promise<boolean>
  /** Insert the share row as `claimed` under `paymentRef`, or return the row already under it. Throws on failure. */
  claim: (row: { promoterId: string; paymentRef: string; grossCents: number }) => Promise<UpgradeShareRow>
  /** `claimed → void`, only while still claimed. */
  voidClaim: (id: string) => Promise<void>
  /** `claimed → paid`, only while still claimed; returns the row's status afterwards (`paid` or `void`). */
  confirmClaim: (id: string) => Promise<string>
  accrue: (id: string) => Promise<AccrualOutcome>
}

export type UpgradeShareOutcome = 'recorded' | 'replay' | 'no_anchor' | 'outside_window' | 'superseded'

/** Never pays a superseded share. Throws on a read or write failure (the caller alerts and the webhook retries). */
export async function runUpgradeShare(input: { paidAt: Date; grossCents: number }, deps: UpgradeShareDeps): Promise<UpgradeShareOutcome> {
  const anchor = await deps.readAnchor()
  const superseded = anchor ? await deps.negocioPackageAfter(anchor.paidAt) : false
  const decision = decideUpgradeShare({
    anchor: anchor ? { attributionId: anchor.attributionId, paidAt: anchor.paidAt } : null,
    paidAt: input.paidAt,
    negocioPackageAfterAnchor: superseded,
  })
  if (decision.action === 'skip' || !anchor) return decision.action === 'skip' ? decision.reason : 'no_anchor'

  const row = await deps.claim({ promoterId: anchor.promoterId, paymentRef: decision.paymentRef, grossCents: input.grossCents })
  if (row.status === 'void') return 'superseded'
  const existed = row.status === 'paid'
  if (row.status === 'claimed') {
    if (await deps.negocioPackageAfter(anchor.paidAt)) {
      await deps.voidClaim(row.id)
      return 'superseded'
    }
    const after = await deps.confirmClaim(row.id)
    if (after === 'void') return 'superseded'
    if (after !== 'paid') throw new Error(`upgrade share ended ${after}, not paid`)
  } else if (!existed) {
    throw new Error(`upgrade share row in an unknown state: ${row.status}`)
  }
  const accrual = await deps.accrue(row.id)
  if (!accrualSettles(accrual)) throw new Error(`negocio_upgrade commission could not be recorded: ${accrual.kind === 'failed' ? accrual.error : ''}`)
  return existed ? 'replay' : 'recorded'
}
