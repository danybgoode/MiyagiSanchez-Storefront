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
  const g = planAgentView(st('gratis', 'none'), NOW).json
  expect(g.includes).toMatchObject({ custom_domain: false, mercadolibre_sync: false, badge_shown: true, chat_answers_per_month: PLAN_ALLOWANCES.gratis.chatAnswersPerMonth })
  expect(g.negocio_price).toMatchObject({ monthly: NEGOCIO_PRICE_MONTHLY_MXN, yearly: NEGOCIO_PRICE_YEARLY_MXN })
  const t = planAgentView(st('trial', 'trial', '2026-11-20T12:00:00Z'), NOW).json
  expect(t).toMatchObject({ days_left: 10, includes: { custom_domain: false, mercadolibre_sync: true, badge_shown: false } })
})

test('which checkout can start mirrors the checkout rules (never a double charge)', () => {
  expect(planAgentView(st('gratis', 'none'), NOW).json.can_start).toEqual({ month: true, year: true })
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
