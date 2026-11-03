/**
 * The plan's explanation, cached (business-infrastructure D10). The template is always there; the model's warmer
 * version replaces it only when it passes `guardExplanation`, and is regenerated only when the inputs change.
 *
 * Spend: one model call per change of inputs, capped per merchant per day through the existing
 * `spend_ai_allowance` RPC on its own subject (`plan_explain:user:<id>`, kind `daily_budget` — the table's CHECK allows
 * only version/photo/daily_budget, and the photo analysis uses the same pattern). Fails CLOSED to the template.
 */

import 'server-only'
import { db } from '@/lib/supabase'
import { callModelBody, MODEL_CONFIGURED } from '@/lib/prompt-to-shop/server'
import { budgetPeriod, userSubject } from '@/lib/prompt-to-shop/allowance'
import type { Plan } from './engine'
import type { BusinessInputs } from './model'
import { explainPrompt, explainTemplate, guardExplanation, inputsHash } from './explain'

/** A merchant who edits all afternoon gets a warm explanation for the first ten versions; the template after that. */
export const EXPLAIN_PER_DAY = 10

export interface Explanation { text: string; source: 'model' | 'template' }

export async function explanationFor(
  row: { id: string; explanation: unknown },
  inputs: BusinessInputs,
  plan: Plan,
  owner: { clerkUserId: string; shopName: string },
): Promise<Explanation> {
  const template: Explanation = { text: explainTemplate(plan), source: 'template' }
  const hash = inputsHash(inputs)
  const cached = row.explanation as { hash?: unknown; text?: unknown } | null
  if (cached && cached.hash === hash) {
    // Re-guard on read: a cached text must still match the plan these inputs produce today.
    const ok = guardExplanation(cached.text, plan)
    if (ok) return { text: ok, source: 'model' }
  }
  if (!MODEL_CONFIGURED) return template

  const { data, error } = await db.rpc('spend_ai_allowance', {
    p_subject: `plan_explain:${userSubject(owner.clerkUserId)}`,
    p_kind: 'daily_budget',
    p_period: budgetPeriod(new Date()),
    p_cap: EXPLAIN_PER_DAY,
  })
  if (error || typeof data !== 'number') return template

  const result = await callModelBody({
    contents: [{ role: 'user', parts: [{ text: explainPrompt(plan, owner.shopName) }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: 'minimal' } },
  })
  const text = result.ok ? guardExplanation(result.text, plan) : null
  if (!text) return template
  // Best effort: a lost cache write costs one more call next visit, never a wrong text.
  await db.from('business_models').update({ explanation: { hash, text } }).eq('id', row.id)
  return { text, source: 'model' }
}
