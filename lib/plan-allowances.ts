/**
 * lib/plan-allowances.ts — how much of the AI that costs money each plan gets (epic 08 · plans-gratis-negocio D8).
 *
 * The ONE home of these numbers: the shop chat, the photo step and every page that says "te quedan N" import them.
 * AI is limited by AMOUNT, never switched off (Daniel, 2026-11-04): Gratis gets some of every AI feature, Negocio and
 * its trial get more. The AI that BUILDS a shop (prompt-to-shop's drafts) is not here: it stays free, because it is
 * what brings merchants in.
 *
 * Starting values (2026-11-04). AI cost per shop is not measured yet; change them here after a month of real use.
 *
 * Scope note (README D8, disproved at build): prompt-to-shop's `ownerVersionsPerMonth` is declared but enforced
 * nowhere (the version spend is per anonymous device), so no per-plan version allowance exists to set.
 */
import type { PlanName } from './plan'

export type PlanAllowance = {
  /** Shop chat answers a month (widget and agents together). Past it, the chat offers «Déjale tu pregunta». */
  chatAnswersPerMonth: number
  /** Photos a month the owner can turn into products. */
  photosPerMonth: number
}

export const PLAN_ALLOWANCES: Readonly<Record<PlanName, PlanAllowance>> = Object.freeze({
  gratis: Object.freeze({ chatAnswersPerMonth: 50, photosPerMonth: 20 }),
  trial: Object.freeze({ chatAnswersPerMonth: 1000, photosPerMonth: 60 }),
  negocio: Object.freeze({ chatAnswersPerMonth: 1000, photosPerMonth: 60 }),
})

/** The allowance for a plan; an unknown plan (it could not be read) gets Gratis's — the lower, fail-closed amount. */
export function allowanceFor(plan: PlanName | null | undefined): PlanAllowance {
  return plan && plan in PLAN_ALLOWANCES ? PLAN_ALLOWANCES[plan] : PLAN_ALLOWANCES.gratis
}
