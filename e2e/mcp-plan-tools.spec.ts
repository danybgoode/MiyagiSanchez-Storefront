/**
 * Agents read the plan and start Negocio (epic 08 · plans-gratis-negocio S3.3, README D17).
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { planAgentView } from '../lib/plan-agent'
import { MCP_SELLER_TOOLS } from '../lib/ucp/capabilities'
import { PARTNER_READ_TOOLS } from '../lib/partner-tools'
import { PLAN_ALLOWANCES } from '../lib/plan-allowances'
import { NEGOCIO_PRICE_MONTHLY_MXN, NEGOCIO_PRICE_YEARLY_MXN } from '../lib/negocio-pricing'
import type { PlanState } from '../lib/plan'

const NOW = new Date('2026-11-10T12:00:00Z')
const st = (plan: PlanState['plan'], reason: PlanState['reason'], endsAt: string | null = null): PlanState => ({ plan, reason, endsAt })

test('both tools are seller tools; a partner may READ the plan (viewer list), and start_negocio refuses partners in its handler', () => {
  expect(MCP_SELLER_TOOLS).toContain('get_plan')
  expect(MCP_SELLER_TOOLS).toContain('start_negocio')
  expect(PARTNER_READ_TOOLS.has('get_plan')).toBe(true)
  expect(PARTNER_READ_TOOLS.has('start_negocio')).toBe(false)
})

test('the plan view states what the plan includes, from the one allowance and price modules', () => {
  const g = planAgentView(st('gratis', 'legacy'), NOW).json
  expect(g.includes).toMatchObject({ custom_domain: false, mercadolibre_sync: false, badge_shown: true, chat_answers_per_month: PLAN_ALLOWANCES.gratis.chatAnswersPerMonth })
  expect(g.negocio_price).toMatchObject({ monthly: NEGOCIO_PRICE_MONTHLY_MXN, yearly: NEGOCIO_PRICE_YEARLY_MXN })
  const t = planAgentView(st('trial', 'trial', '2026-11-20T12:00:00Z'), NOW).json
  expect(t).toMatchObject({ days_left: 10, includes: { custom_domain: false, mercadolibre_sync: true, badge_shown: false } })
})

test('which checkout can start mirrors the checkout rules (never a double charge)', () => {
  expect(planAgentView(st('gratis', 'legacy'), NOW).json.can_start).toEqual({ month: true, year: true })
  expect(planAgentView(st('negocio', 'subscription'), NOW).json.can_start).toEqual({ month: false, year: false })
  expect(planAgentView(st('negocio', 'one_time', '2027-01-01T00:00:00Z'), NOW).json.can_start).toEqual({ month: false, year: true })
  expect(planAgentView(st('negocio', 'comp'), NOW).json.can_start).toEqual({ month: false, year: false })
  expect(planAgentView(st('gratis', 'unavailable'), NOW).json.can_start).toEqual({ month: false, year: false })
})

test('the tools are scoped to the token\'s exact shop, and an unclaimed shop cannot pay', () => {
  const src = readFileSync('app/api/ucp/mcp/route.ts', 'utf8')
  const getPlan = src.slice(src.indexOf('async function handleGetPlan('), src.indexOf('async function handleStartNegocio('))
  expect(getPlan).toContain('shopId: shop.id')
  const start = src.slice(src.indexOf('async function handleStartNegocio('), src.indexOf('async function handleGetDomainEntitlement('))
  expect(start).toContain('shopId: shop.id')
  expect(start).toContain('if (!shop.clerk_user_id)')
  // Every partner credential is refused BEFORE any checkout — the viewer-only PARTNER_READ_TOOLS gate would let a
  // manager partner through (pr-reviewer, #473).
  expect(start.indexOf('if (agentAuth.partner)')).toBeGreaterThan(-1)
  expect(start.indexOf('if (agentAuth.partner)')).toBeLessThan(start.indexOf('startNegocioCheckout('))
})

test('Plan Tienda and "no plan" are named truthfully to an agent (plan-tienda S1.1)', () => {
  const tienda = planAgentView(st('tienda', 'tienda_one_time', '2027-11-04T12:00:00Z'), NOW)
  expect(tienda.summary).toBe('La tienda tiene el Plan Tienda pagado hasta 2027-11-04.')
  expect(tienda.json).toMatchObject({
    plan: 'tienda', reason: 'tienda_one_time',
    includes: { custom_domain: false, mercadolibre_sync: false, badge_shown: true, monthly_checkin: false, chat_answers_per_month: PLAN_ALLOWANCES.tienda.chatAnswersPerMonth, photos_per_month: PLAN_ALLOWANCES.tienda.photosPerMonth },
  })
  expect(planAgentView(st('tienda', 'tienda_subscription'), NOW).summary).toBe('La tienda tiene el Plan Tienda activo.')
  const unpaid = planAgentView(st('unpaid', 'unpaid'), NOW)
  expect(unpaid.summary).toContain('no tiene un plan activo')
  expect(unpaid.summary).not.toContain('Plan Gratis')
  expect(unpaid.json).toMatchObject({ plan: 'unpaid', reason: 'unpaid', includes: { custom_domain: false, mercadolibre_sync: false, badge_shown: true, monthly_checkin: false } })
  for (const v of [tienda, unpaid]) expect(JSON.stringify(v)).not.toContain('undefined')
})

test('the get_plan description names the five plans and every reason the tool can return — and nothing it cannot (plan-tienda S1.1 review)', () => {
  const src = readFileSync('app/api/ucp/mcp/route.ts', 'utf8')
  const at = src.indexOf("name: 'get_plan'")
  const description = src.slice(at, src.indexOf('inputSchema', at))
  // Each PlanName and PlanReason is listed here by hand ON PURPOSE, typed against the unions: adding a plan or a
  // reason in lib/plan.ts is a type error on these two lines until the description is looked at again.
  const plans: Record<PlanState['plan'], true> = { negocio: true, trial: true, tienda: true, gratis: true, unpaid: true }
  const reasons: Record<PlanState['reason'], true> = {
    comp: true, one_time: true, subscription: true, trial: true, tienda_one_time: true, tienda_subscription: true,
    trial_ended: true, legacy: true, unpaid: true, unavailable: true,
  }
  for (const plan of Object.keys(plans)) expect(description).toContain('`' + plan + '`')
  const listed = description.slice(description.indexOf('`reason` says why:'), description.indexOf('Requires'))
  for (const reason of Object.keys(reasons)) expect({ reason, listed: new RegExp(`\\b${reason}\\b`).test(listed) }).toEqual({ reason, listed: true })
  // Stale or untrue: Gratis is no longer for every shop, the trial's length is not typed here, `none` is gone.
  expect(description).not.toContain('free forever')
  expect(description).not.toContain('30-day')
  expect(listed).not.toMatch(/\bnone\b/)
  // No price is typed, and nothing says Plan Tienda can be bought through an agent yet (that is sprint 2).
  expect(description).not.toMatch(/\$\s?\d|\d+\s?MXN/)
  expect(description).not.toMatch(/start_tienda|buy Plan Tienda|contrata(r)? (el )?Plan Tienda/i)
})

test('a plan that could not be read is never called Plan Gratis to an agent (PR #484 review)', () => {
  // `unavailable` travels under the plan name `gratis` (so every gate fails closed) — the SUMMARY must not repeat
  // that name as if it were known.
  const v = planAgentView(st('gratis', 'unavailable'), NOW)
  expect(v.summary).toBe('No se pudo confirmar la suscripción de la tienda en este momento; inténtalo de nuevo en unos minutos.')
  expect(v.summary).not.toMatch(/Plan (Gratis|Tienda|Negocio)/)
  expect(v.summary).not.toContain('no tiene un plan')
  // The machine-readable half says why, and offers no checkout on a guess.
  expect(v.json).toMatchObject({ reason: 'unavailable', ends_at: null, days_left: null, can_start: { month: false, year: false } })
  // Only `unavailable` gets that sentence: a legacy shop is still told it is on Plan Gratis.
  expect(planAgentView(st('gratis', 'legacy'), NOW).summary).toContain('Plan Gratis')
  expect(planAgentView(st('gratis', 'trial_ended'), NOW).summary).toContain('Plan Gratis')
})
