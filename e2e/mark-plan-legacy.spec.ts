/**
 * Every existing shop is marked legacy (epic 08 · plan-tienda-three-free-months S1.2, README D2).
 *
 * The marker is what keeps a shop that already existed on Plan Gratis; a shop without it and without a live plan is
 * `unpaid`, which the pause job acts on. So the planner is asserted from both sides: it must mark EVERY shop from
 * before the cutoff (a missed one gets paused), and it must mark NO shop from after it (a rerun weeks later must not
 * hand Plan Gratis to a new shop). Everything here is pure — the live run is a thin write around exactly this.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import {
  PLAN_LEGACY_KEY,
  NEGOCIO_TRIAL_KEY,
  buildPlanLegacy,
  derivePlanFromMetadata,
  planLegacyMarking,
  readPlanLegacyState,
  type ShopForLegacyMarking,
} from '../lib/plan'
import { LEGACY_PAGE_SIZE, formatLegacyMarkingReport, parseArgs, summarizeLegacyMarking } from '../scripts/mark-plan-legacy'
import { readAllPages } from '../lib/paged-read'

const CUTOFF = '2026-11-10T00:00:00.000Z'
const BEFORE = '2026-08-01T12:00:00.123456+00:00' // the shape PostgREST returns a timestamptz in
const AFTER = '2026-11-12T09:00:00+00:00'
const marker = { marked_at: '2026-11-10T03:00:00.000Z' }
const shop = (id: string, created_at: string | null, metadata: unknown = {}): ShopForLegacyMarking => ({ id, slug: id, created_at, metadata })

test.describe('planLegacyMarking — who gets the marker', () => {
  test('every unmarked shop from before the cutoff is marked, owned or not, whatever else its metadata holds', () => {
    const decisions = planLegacyMarking([
      shop('plain', BEFORE),
      shop('null-metadata', BEFORE, null),
      shop('with-settings', BEFORE, { settings: { theme: 'x' }, [NEGOCIO_TRIAL_KEY]: { started_at: BEFORE, expires_at: AFTER } }),
    ], CUTOFF)
    expect(decisions.map((d) => [d.slug, d.action, d.why, d.guard])).toEqual([
      ['plain', 'mark', 'unmarked_before_cutoff', { mode: 'absent' }],
      ['null-metadata', 'mark', 'unmarked_before_cutoff', { mode: 'absent' }],
      ['with-settings', 'mark', 'unmarked_before_cutoff', { mode: 'absent' }],
    ])
  })

  test('a key holding JSON null is marked with the json_null guard — `absent` would never land', () => {
    const [d] = planLegacyMarking([shop('nulled', BEFORE, { [PLAN_LEGACY_KEY]: null })], CUTOFF)
    expect(d).toMatchObject({ action: 'mark', why: 'unmarked_before_cutoff', guard: { mode: 'json_null' } })
  })

  test('a marked shop is never marked again: a rerun is a no-op', () => {
    const [d] = planLegacyMarking([shop('done', BEFORE, { [PLAN_LEGACY_KEY]: marker })], CUTOFF)
    expect(d).toEqual({ shopId: 'done', slug: 'done', action: 'skip', why: 'already_marked' })
  })

  test('a shop created at or after the cutoff is never marked — that is what makes a late rerun safe', () => {
    const decisions = planLegacyMarking([shop('new', AFTER), shop('on-the-dot', CUTOFF), shop('one-ms-before', '2026-11-09T23:59:59.999Z')], CUTOFF)
    expect(decisions.map((d) => [d.slug, d.action, d.why])).toEqual([
      ['new', 'skip', 'created_after_cutoff'],
      ['on-the-dot', 'skip', 'created_after_cutoff'],
      ['one-ms-before', 'mark', 'unmarked_before_cutoff'],
    ])
  })

  test('a marker or a creation date we cannot parse is UNREADABLE: reported, never marked, never overwritten, never "skipped, fine"', () => {
    const decisions = planLegacyMarking([
      shop('bad-marker', BEFORE, { [PLAN_LEGACY_KEY]: { marked_at: 'soon' } }),
      shop('true-marker', BEFORE, { [PLAN_LEGACY_KEY]: true }),
      shop('bad-marker-new-shop', AFTER, { [PLAN_LEGACY_KEY]: 'x' }),
      shop('no-date', null),
      shop('bad-date', 'last tuesday'),
      shop('string-metadata', BEFORE, '{}'),
    ], CUTOFF)
    for (const d of decisions) expect(d).toEqual({ shopId: d.shopId, slug: d.slug, action: 'skip', why: 'unreadable' })
  })

  test('the cutoff is the caller\'s and nothing else: no constant in the code, no default, and a non-date refuses to plan', () => {
    const plan = readFileSync('lib/plan.ts', 'utf8')
    expect(plan).not.toContain('PLAN_LEGACY_CUTOFF')
    expect(plan).toContain('export function planLegacyMarking(shops: readonly ShopForLegacyMarking[], cutoff: string): LegacyMarkingDecision[] {')
    // The same shop, two cutoffs: only the argument decides.
    const s = [shop('a', '2026-11-11T15:00:00Z')]
    expect(planLegacyMarking(s, '2026-11-10T00:00:00.000Z')[0].why).toBe('created_after_cutoff')
    expect(planLegacyMarking(s, '2026-11-12T00:00:00.000Z')[0].why).toBe('unmarked_before_cutoff')
    expect(() => planLegacyMarking([shop('a', BEFORE)], 'soon')).toThrow()
    expect(() => planLegacyMarking([shop('a', BEFORE)], undefined as unknown as string)).toThrow()
  })

  test('derivePlan depends on the marker only, never on a date: the same shop, marked or not, at any creation date', () => {
    const src = readFileSync('lib/plan.ts', 'utf8')
    const derive = src.slice(src.indexOf('export function derivePlan('), src.indexOf('/** The two subscription answers'))
    expect(derive).not.toMatch(/created_at|cutoff/i)
    const facts = { hasActiveSubscription: false, hasActiveTiendaSubscription: false }
    expect(derivePlanFromMetadata({ created_at: '2020-01-01T00:00:00Z' }, facts, new Date('2027-01-01T00:00:00Z')).plan).toBe('unpaid')
    expect(derivePlanFromMetadata({ [PLAN_LEGACY_KEY]: marker }, facts, new Date('2040-01-01T00:00:00Z')).plan).toBe('gratis')
  })

  test('what the plan promises: once marked, an ended trial is Plan Gratis; unmarked, it is unpaid', () => {
    const NOW = new Date('2026-12-10T12:00:00Z')
    const ended = { started_at: '2026-11-05T02:18:22.000Z', expires_at: '2026-12-05T02:18:22.000Z' }
    const facts = { hasActiveSubscription: false, hasActiveTiendaSubscription: false }
    const before = { [NEGOCIO_TRIAL_KEY]: ended }
    expect(derivePlanFromMetadata(before, facts, NOW).plan).toBe('unpaid')
    // The write is a MERGE of the one key: the trial is neither moved nor extended.
    const after = { ...before, [PLAN_LEGACY_KEY]: buildPlanLegacy(new Date(CUTOFF)) }
    expect(readPlanLegacyState(after)).toBe('marked')
    expect(derivePlanFromMetadata(after, facts, NOW)).toEqual({ plan: 'gratis', reason: 'trial_ended', endsAt: null })
    expect(after[NEGOCIO_TRIAL_KEY]).toEqual(ended)
  })
})

test.describe('the report — five counts that add up', () => {
  const decisions = planLegacyMarking([
    shop('a', BEFORE), shop('b', BEFORE), shop('c', BEFORE, { [PLAN_LEGACY_KEY]: marker }),
    shop('d', AFTER), shop('e', BEFORE, { [PLAN_LEGACY_KEY]: 7 }),
  ], CUTOFF)

  test('total, to mark, already marked, skipped after the cutoff, unreadable — and no row left out', () => {
    const s = summarizeLegacyMarking(decisions)
    expect(s).toEqual({ total: 5, toMark: 2, alreadyMarked: 1, afterCutoff: 1, unreadable: 1 })
    expect(s.toMark + s.alreadyMarked + s.afterCutoff + s.unreadable).toBe(s.total)
  })

  test('the dry run prints all five and names each unreadable row', () => {
    const lines = formatLegacyMarkingReport('DRY RUN', CUTOFF, decisions)
    expect(lines[0]).toBe(`[plan:mark-legacy] DRY RUN — cutoff ${CUTOFF}`)
    expect(lines[1]).toBe('  rows read 5   to mark 2   already marked 1   skipped (created after the cutoff) 1   unreadable 1')
    expect(lines).toContain('  ? unreadable, left alone: e')
    expect(lines.join('\n')).toContain('NOT marked and NOT overwritten')
  })

  test('with nothing unreadable the warning is not printed', () => {
    const lines = formatLegacyMarkingReport('APPLY', CUTOFF, planLegacyMarking([shop('a', BEFORE)], CUTOFF))
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('to mark 1')
  })
})

test.describe('reading the table — paged, and never a partial list', () => {
  const table = (n: number) => Array.from({ length: n }, (_, i) => i)
  const pager = (rows: number[], calls: Array<[number, number]> = []) => async (from: number, to: number) => {
    calls.push([from, to])
    return { data: rows.slice(from, to + 1), error: null }
  }

  test('more rows than one page are all read: 1,000 is not assumed', () => {
    const calls: Array<[number, number]> = []
    return readAllPages(pager(table(2345), calls), 1000).then((rows) => {
      expect(rows).toEqual(table(2345))
      expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
    })
  })

  test('a table that is an exact multiple of the page asks once more and stops on the empty page', async () => {
    const calls: Array<[number, number]> = []
    expect(await readAllPages(pager(table(20), calls), 10)).toHaveLength(20)
    expect(calls).toEqual([[0, 9], [10, 19], [20, 29]])
    expect(await readAllPages(pager([]), 10)).toEqual([])
  })

  test('an error on ANY page throws — a partial list is never returned as the table', async () => {
    let n = 0
    const failing = async (from: number, to: number) => (n++ === 1 ? { data: null, error: { message: 'timeout' } } : { data: table(30).slice(from, to + 1), error: null })
    await expect(readAllPages(failing, 10, 'marketplace_shops')).rejects.toThrow('could not read marketplace_shops (rows 10–19): timeout')
    await expect(readAllPages(async () => ({ data: null, error: null }), 10)).rejects.toThrow('no rows array')
  })

  test('the page is below PostgREST\'s 1,000-row ceiling', () => {
    expect(LEGACY_PAGE_SIZE).toBeGreaterThan(0)
    expect(LEGACY_PAGE_SIZE).toBeLessThan(1000)
  })
})

test.describe('the script shell', () => {
  const src = readFileSync('scripts/mark-plan-legacy.ts', 'utf8')

  const NOW = new Date('2026-11-12T20:00:00.000Z')
  const C = '2026-11-12T18:30:00Z'

  test('--cutoff is required; with it the run defaults to a dry run; unknown flags are refused', () => {
    expect(parseArgs(['--cutoff', C], NOW)).toEqual({ ok: true, apply: false, cutoff: '2026-11-12T18:30:00.000Z' })
    expect(parseArgs(['--cutoff', C, '--dry-run'], NOW)).toEqual({ ok: true, apply: false, cutoff: '2026-11-12T18:30:00.000Z' })
    expect(parseArgs(['--apply', `--cutoff=${C}`], NOW)).toEqual({ ok: true, apply: true, cutoff: '2026-11-12T18:30:00.000Z' })
    expect(parseArgs(['--cutoff', C, '--aply'], NOW).ok).toBe(false)
    for (const missing of [[], ['--apply'], ['--dry-run']]) {
      const r = parseArgs(missing, NOW)
      expect(r).toMatchObject({ ok: false })
      if (!r.ok) expect(r.error).toContain('missing --cutoff')
    }
  })

  test('the cutoff must be an instant with an explicit zone — a bare date or a local time is a different moment on each machine', () => {
    // A zone offset is honoured and printed in UTC.
    expect(parseArgs(['--cutoff', '2026-11-12T12:30:00-06:00'], NOW)).toMatchObject({ ok: true, cutoff: '2026-11-12T18:30:00.000Z' })
    expect(parseArgs(['--cutoff', '2026-11-12T18:30Z'], NOW)).toMatchObject({ ok: true, cutoff: '2026-11-12T18:30:00.000Z' })
    for (const bad of ['', 'soon', '2026-11-12', '2026-11-12T18:30:00', '2026-11-12 18:30:00Z', '12/11/2026', '1762972200000', '2026-13-40T00:00:00Z', '--apply']) {
      const r = parseArgs(['--cutoff', bad], NOW)
      expect({ bad, ok: r.ok }).toEqual({ bad, ok: false })
      if (!r.ok) expect(r.error).toContain('--cutoff must be an ISO instant')
    }
    expect(parseArgs(['--cutoff'], NOW).ok).toBe(false)
  })

  test('a cutoff in the future is refused: nothing created after the run can ever be covered by it', () => {
    const future = parseArgs(['--cutoff', '2026-11-12T20:00:00.001Z'], NOW)
    expect(future.ok).toBe(false)
    if (!future.ok) expect(future.error).toContain('is in the future')
    expect(parseArgs(['--cutoff', '2026-11-13T00:00:00Z', '--apply'], NOW).ok).toBe(false)
    // Exactly now, and one millisecond ago, are fine.
    expect(parseArgs(['--cutoff', '2026-11-12T20:00:00.000Z'], NOW).ok).toBe(true)
    expect(parseArgs(['--cutoff', '2026-11-12T19:59:59.999Z'], NOW).ok).toBe(true)
  })

  test('the boundary, end to end: the parsed cutoff marks a shop created one millisecond before it and not one created at it', () => {
    const parsed = parseArgs(['--cutoff', '2026-11-12T12:30:00-06:00'], NOW)
    if (!parsed.ok) throw new Error('expected a cutoff')
    const decisions = planLegacyMarking([shop('before', '2026-11-12T18:29:59.999Z'), shop('at', '2026-11-12T18:30:00.000Z'), shop('later-that-day', '2026-11-12T19:00:00Z')], parsed.cutoff)
    expect(decisions.map((d) => [d.slug, d.action])).toEqual([['before', 'mark'], ['at', 'skip'], ['later-that-day', 'skip']])
    expect(formatLegacyMarkingReport('DRY RUN', parsed.cutoff, decisions)[0]).toBe('[plan:mark-legacy] DRY RUN — cutoff 2026-11-12T18:30:00.000Z')
  })

  test('the dry run returns before the first write', () => {
    const dryReturn = src.indexOf('console.log(`[plan:mark-legacy] dry run — nothing written. Re-run with --cutoff ${parsed.cutoff} --apply.`)\n    return')
    expect(dryReturn).toBeGreaterThan(0)
    expect(src.indexOf("db.rpc('merge_shop_metadata'")).toBeGreaterThan(dryReturn)
    // The only write in the file is that one guarded merge: no update, upsert, insert or delete.
    expect(src.match(/\.rpc\(/g)).toHaveLength(1)
    expect(src).not.toMatch(/\.(update|upsert|insert|delete)\(/)
  })

  test('the write is guarded by the planner\'s guard on the marker key, and main is gated on the filename', () => {
    expect(src).toContain('p_guard_key: PLAN_LEGACY_KEY')
    expect(src).toContain('p_guard_mode: d.guard.mode')
    expect(src).toContain("process.argv[1]?.endsWith('mark-plan-legacy.ts')")
    // The plan, the report and the recount all use the cutoff that was passed — there is no other.
    expect(src.match(/planLegacyMarking\(await readShops\(db\), parsed\.cutoff\)/g)).toHaveLength(2)
    expect(src).toContain("formatLegacyMarkingReport(parsed.apply ? 'APPLY' : 'DRY RUN', parsed.cutoff, decisions)")
    expect(src).not.toContain('PLAN_LEGACY_CUTOFF')
    // The table is read through the paged reader, never one unpaged select.
    expect(src).toContain("}, LEGACY_PAGE_SIZE, 'marketplace_shops')")
    expect(src).toContain('.range(from, to)')
  })
})
