import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHECKIN_WINDOW_DAYS, decideCheckin, reportedPeriod, runCheckinCron, unitsInPeriod, type CheckinDeps, type CheckinRow } from '../lib/business-plan/checkin'
import { CHECKIN_COPY } from '../lib/business-plan/copy'
import { COMMUNICATION_CATALOG } from '../lib/notifications/catalog'
import type { ProfitEvent, ProfitOrderInfo } from '../lib/profit'

// business-infrastructure S3.4 — the monthly check-in (D12).

const AT = '2026-10-01T00:00:00.000Z'
const told = (value: number) => ({ value, source: 'told', at: AT })
const INPUTS = {
  offers: [{ key: 'p:a', title: 'Comida corrida', price_cents: told(9500), unit_cost_cents: told(3800), minutes_per_unit: told(20), units_per_month: told(40) }],
  capacity: { resource: { value: 'la estufa', source: 'told', at: AT }, hours_per_month: told(200) },
  fixed_costs: [{ label: 'Renta', monthly_cents: told(300000) }],
  goal_cents: told(1500000),
}
const row = (over: Partial<CheckinRow> = {}): CheckinRow => ({ id: 'bm1', seller_id: 'sel_1', clerk_user_id: 'user_1', shop_slug: 'tamales', inputs: INPUTS, last_checkin_period: null, ...over })
const NOV_2 = new Date('2026-11-02T15:00:00Z')

const orders: ProfitOrderInfo[] = [
  { id: 'o1', display_id: 1, created_at: null, currency_code: 'mxn', source: 'native', items: [{ id: 'l1', product_id: 'a', variant_id: null, title: 'x', quantity: 3 }, { id: 'l2', product_id: 'a', variant_id: null, title: 'x', quantity: 2 }] },
]
const ev = (line: string, at: string, cur = 'mxn'): ProfitEvent => ({ id: `${line}${at}`, order_id: 'o1', order_line_id: line, source: 'native', event_type: 'revenue', amount_cents: 100, currency_code: cur, captured_at: at })

test('the check-in reports on the PREVIOUS calendar month, counting MXN revenue lines once', () => {
  expect(reportedPeriod(NOV_2)).toBe('2026-10')
  expect(reportedPeriod(new Date('2027-01-03T00:00:00Z'))).toBe('2026-12')
  expect(unitsInPeriod([ev('l1', '2026-10-05T00:00:00Z'), ev('l1', '2026-10-06T00:00:00Z'), ev('l2', '2026-11-01T00:00:00Z'), ev('l2', '2026-10-09T00:00:00Z', 'usd')], orders, '2026-10')).toBe(3)
})

test('decide: plan vs last month, the first move; skips outside the first week, once a month, without offers', () => {
  const d = decideCheckin(row(), 30, NOV_2)
  expect(d.kind).toBe('send')
  if (d.kind !== 'send') return
  expect(d.message).toMatchObject({ period: '2026-10', month: 'octubre', sold: 30, onTrack: false })
  expect(d.message.needed).toBe(Math.ceil((300000 + 1500000) / 5700))
  expect(d.message.next).not.toBeNull()
  expect(decideCheckin(row(), 30, new Date(Date.UTC(2026, 10, CHECKIN_WINDOW_DAYS + 1)))).toMatchObject({ kind: 'skip', reason: 'outside_window' })
  expect(decideCheckin(row({ last_checkin_period: '2026-10' }), 30, NOV_2)).toMatchObject({ kind: 'skip', reason: 'already_sent' })
  expect(decideCheckin(row({ inputs: { offers: [], fixed_costs: [] } }), 0, NOV_2)).toMatchObject({ kind: 'skip', reason: 'no_offers' })
  // the shortfall is needed − sold, never the needed figure again
  expect(CHECKIN_COPY.versus(316, 30)).toContain('te faltaron 286')
  expect(CHECKIN_COPY.versus(30, 31)).toContain('llegaste')
})

function fakes(over: Partial<CheckinDeps> = {}) {
  const trace: string[] = []
  const deps: CheckinDeps = {
    readRows: async () => { trace.push('read'); return [row(), row({ id: 'bm2', seller_id: 'sel_2', last_checkin_period: '2026-10' }), row({ id: 'bm3', seller_id: 'sel_3' })] },
    readLedger: async (id) => { trace.push(`ledger:${id}`); return id === 'sel_3' ? null : { events: [ev('l1', '2026-10-05T00:00:00Z')], orders } },
    claim: async (id) => { trace.push(`claim:${id}`); return true },
    send: async (r) => { trace.push(`send:${r.id}`) },
    now: () => NOV_2,
    ...over,
  }
  return { deps, trace }
}

test('the run: authorise → read → per merchant ledger → claim → send; a failed ledger read waits for tomorrow', async () => {
  const { deps, trace } = fakes()
  const r = await runCheckinCron({ authorised: true }, deps)
  expect(r).toEqual({ status: 200, body: { ok: true, period: '2026-10', sent: 1, skipped: 1, unavailable: 1, failed: 0 } })
  // bm2 already got October's (no ledger read, no claim); sel_3's ledger failed → not claimed, retried next run
  expect(trace).toEqual(['read', 'ledger:sel_1', 'claim:bm1', 'send:bm1', 'ledger:sel_3'])
})

test('nothing is read without the secret; a failed read is a 503; a lost claim sends nothing; outside the window, nothing', async () => {
  const unauth = fakes()
  expect(await runCheckinCron({ authorised: false }, unauth.deps)).toEqual({ status: 401, body: { ok: false, error: 'unauthorized' } })
  expect(unauth.trace).toEqual([])
  const down = fakes({ readRows: async () => null })
  expect((await runCheckinCron({ authorised: true }, down.deps)).status).toBe(503)
  const lost = fakes({ claim: async () => false })
  const r = await runCheckinCron({ authorised: true }, lost.deps)
  expect(r.body).toMatchObject({ sent: 0 })
  expect(lost.trace.some((t) => t.startsWith('send:'))).toBe(false)
  const late = fakes({ now: () => new Date('2026-11-20T15:00:00Z') })
  expect((await runCheckinCron({ authorised: true }, late.deps)).body).toMatchObject({ sent: 0 })
  expect(late.trace).toEqual([])
})

test('a send that throws is counted and the run carries on; the claim is kept (no duplicate tomorrow)', async () => {
  const { deps, trace } = fakes({
    readRows: async () => [row(), row({ id: 'bm4', seller_id: 'sel_4' })],
    send: async (r) => { trace.push(`send:${r.id}`); if (r.id === 'bm1') throw new Error('smtp') },
  })
  const r = await runCheckinCron({ authorised: true }, deps)
  expect(r.body).toMatchObject({ sent: 1, failed: 1 })
  expect(trace.filter((t) => t.startsWith('send:'))).toEqual(['send:bm1', 'send:bm4'])
})

test('wiring: a registered message, a header-only secret, a daily timer, the internal ledger read', () => {
  expect(COMMUNICATION_CATALOG.find((e) => e.key === 'shop.business_checkin')).toMatchObject({ sender: 'sendBusinessCheckin', group: 'onboarding' })
  const route = readFileSync(join(process.cwd(), 'app/api/cron/business-checkin/route.ts'), 'utf8')
  expect(route).toContain("cronSecretMatches(req.headers.get('x-cron-secret'), process.env.CRON_SECRET)")
  expect(route).not.toMatch(/searchParams/)
  const server = readFileSync(join(process.cwd(), 'lib/business-plan/checkin-server.ts'), 'utf8')
  expect(server).toContain('/internal/profit/ledger?seller_id=')
  expect(server).toContain(".or(`last_checkin_period.is.null,last_checkin_period.neq.${period}`)")
})
