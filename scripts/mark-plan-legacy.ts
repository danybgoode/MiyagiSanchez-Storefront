/**
 * scripts/mark-plan-legacy.ts
 *
 * Marks every shop that ALREADY EXISTS as legacy, so it keeps Plan Gratis for good (epic 08 ·
 * plan-tienda-three-free-months S1.2, README D2). Every row of `marketplace_shops` created before
 * `PLAN_LEGACY_CUTOFF` gets `metadata.plan_legacy = { marked_at }`, owned or not: an imported shop claimed later was
 * promised the same page. Without the marker `lib/plan.ts` resolves a shop with no live plan to `unpaid`, which is
 * what the pause job (sprint 3) acts on — so this runs, and is verified, BEFORE that job is deployed.
 *
 *   npm run plan:mark-legacy                 # DRY RUN — reads, plans, writes nothing
 *   npm run plan:mark-legacy -- --apply      # writes
 *
 * `--dry-run` is the default and stays FULLY read-only. The decision lives in `lib/plan.ts` (`planLegacyMarking`,
 * unit-tested); this file only reads shops, asks the planner and writes what it says. Each write is
 * `merge_shop_metadata` guarded on the marker key being ABSENT (or `json_null` when the key holds JSON null — the
 * planner picks the guard that matches what was read), and only a row that the write RETURNED is counted. A marker
 * that appeared between the read and the write is left exactly as it is.
 *
 * The cutoff is what makes a rerun safe: a shop opened after the change is never marked, however late this runs.
 *
 * A read failure, an empty table, any failed write, a row that could not be decided, or a recount that still finds
 * shops to mark exits non-zero: a marking run that "succeeds" at nothing reads as a passing gate.
 *
 * Runs in production the same way as `backfill-negocio-trial.ts`: bundled with esbuild, copied into the web
 * container under THIS filename (main is gated on it), and run there with the container's own env.
 */
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import {
  PLAN_LEGACY_CUTOFF,
  PLAN_LEGACY_KEY,
  buildPlanLegacy,
  planLegacyMarking,
  readPlanLegacy,
  type LegacyMarkingDecision,
  type ShopForLegacyMarking,
} from '../lib/plan'

/** Parse argv; an unknown flag is fatal rather than silently ignored. */
export function parseArgs(argv: readonly string[]): { ok: true; apply: boolean } | { ok: false; error: string } {
  let apply = false
  for (const arg of argv) {
    if (arg === '--apply') { apply = true; continue }
    if (arg === '--dry-run') { apply = false; continue }
    return { ok: false, error: `unknown argument: ${arg}` }
  }
  return { ok: true, apply }
}

/**
 * PostgREST answers at most 1,000 rows per request by default, and says nothing when it cuts a result short. A
 * single unpaged read would therefore "succeed" on the first 1,000 shops and leave the rest unmarked — and unmarked
 * is the state that gets a shop paused. So the read is paged, and smaller than that ceiling on purpose.
 */
export const LEGACY_PAGE_SIZE = 500

export type PageResult<T> = { data: T[] | null; error: { message: string } | null }

/**
 * Read every row, `pageSize` at a time, until a page comes back short. Any page that errors, or answers without an
 * array, throws: a partial list must never be planned as if it were the table. The `fetchPage` it is given must
 * order by a stable, unique key (here `created_at, id`), or rows could repeat or be skipped between pages.
 */
export async function readAllPages<T>(
  fetchPage: (from: number, to: number) => Promise<PageResult<T>>,
  pageSize: number = LEGACY_PAGE_SIZE,
): Promise<T[]> {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error(`readAllPages: pageSize must be a positive integer (got ${pageSize})`)
  const rows: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1)
    if (error) throw new Error(`could not read marketplace_shops (rows ${from}–${from + pageSize - 1}): ${error.message}`)
    if (!Array.isArray(data)) throw new Error(`could not read marketplace_shops (rows ${from}–${from + pageSize - 1}): no rows array in the answer`)
    rows.push(...data)
    if (data.length < pageSize) return rows
  }
}

export type LegacyMarkingSummary = { total: number; toMark: number; alreadyMarked: number; afterCutoff: number; unreadable: number }

/** The five counts the run prints. They always add up to `total`: no row is left out of the report. */
export function summarizeLegacyMarking(decisions: readonly LegacyMarkingDecision[]): LegacyMarkingSummary {
  const count = (why: LegacyMarkingDecision['why']) => decisions.filter((d) => d.why === why).length
  return {
    total: decisions.length,
    toMark: count('unmarked_before_cutoff'),
    alreadyMarked: count('already_marked'),
    afterCutoff: count('created_after_cutoff'),
    unreadable: count('unreadable'),
  }
}

/** The report lines, the same for a dry run and an apply (pure, so the wording is tested). */
export function formatLegacyMarkingReport(mode: 'DRY RUN' | 'APPLY', cutoff: string, decisions: readonly LegacyMarkingDecision[]): string[] {
  const s = summarizeLegacyMarking(decisions)
  const lines = [
    `[plan:mark-legacy] ${mode} — cutoff ${cutoff}`,
    `  rows read ${s.total}   to mark ${s.toMark}   already marked ${s.alreadyMarked}   skipped (created after the cutoff) ${s.afterCutoff}   unreadable ${s.unreadable}`,
  ]
  for (const d of decisions) if (d.why === 'unreadable') lines.push(`  ? unreadable, left alone: ${d.slug ?? d.shopId}`)
  if (s.unreadable > 0) {
    lines.push(`  ! ${s.unreadable} row(s) could not be decided (a marker or a created_at we cannot parse). They are NOT marked and NOT overwritten — look at them by hand.`)
  }
  return lines
}

function client() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — refusing to run blind')
  return createClient(url, key, { auth: { persistSession: false } })
}

type Db = ReturnType<typeof client>

async function readShops(db: Db): Promise<ShopForLegacyMarking[]> {
  const shops = await readAllPages<ShopForLegacyMarking>(async (from, to) => {
    const { data, error } = await db
      .from('marketplace_shops')
      .select('id, slug, created_at, metadata')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }) // the tie-break that makes paging stable
      .range(from, to)
    return { data: data as ShopForLegacyMarking[] | null, error }
  })
  if (shops.length === 0) throw new Error('marketplace_shops is empty — refusing to report success against no shops')
  return shops
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed.ok) throw new Error(parsed.error)
  const db = client()

  const decisions = planLegacyMarking(await readShops(db), PLAN_LEGACY_CUTOFF)
  for (const line of formatLegacyMarkingReport(parsed.apply ? 'APPLY' : 'DRY RUN', PLAN_LEGACY_CUTOFF, decisions)) console.log(line)

  if (!parsed.apply) {
    console.log('[plan:mark-legacy] dry run — nothing written. Re-run with --apply.')
    return
  }

  const marker = buildPlanLegacy()
  let written = 0
  let raced = 0
  const failures: string[] = []
  for (const d of decisions) {
    if (d.action !== 'mark' || !d.guard) continue
    const name = d.slug ?? d.shopId
    const { data: merged, error: writeError } = await db.rpc('merge_shop_metadata', {
      p_shop_id: d.shopId,
      p_patch: { [PLAN_LEGACY_KEY]: marker },
      p_guard_key: PLAN_LEGACY_KEY,
      p_guard_mode: d.guard.mode,
      p_expected: null,
    })
    if (writeError) { failures.push(`${name}: ${writeError.message}`); continue }
    if (Array.isArray(merged) && merged.length > 0) {
      // Count only a row that came back AND carries a marker the seam can read: "the call did not error" is not
      // "the shop is marked".
      if (readPlanLegacy((merged[0] as { metadata: unknown }).metadata)) written += 1
      else failures.push(`${name}: the write returned a row without a readable marker`)
      continue
    }
    // The guard fired: something is under the key that was not there at the read. It is fine only if it is a marker.
    const { data: after, error: afterError } = await db.from('marketplace_shops').select('metadata').eq('id', d.shopId).maybeSingle()
    if (afterError) failures.push(`${name}: the guard fired and the re-read failed: ${afterError.message}`)
    else if (after && readPlanLegacy((after as { metadata: unknown }).metadata)) raced += 1
    else failures.push(`${name}: the guard fired but the shop holds no readable marker`)
  }
  console.log(`[plan:mark-legacy] marked ${written}; ${raced} already marked by someone else meanwhile; ${failures.length} failed`)
  for (const f of failures) console.error(`  ! ${f}`)

  // Take the count AGAIN from the table (the acceptance: "the count is taken again at apply time"). What matters is
  // the state of the shops now, not what this run believes it wrote.
  const after = summarizeLegacyMarking(planLegacyMarking(await readShops(db), PLAN_LEGACY_CUTOFF))
  console.log(`[plan:mark-legacy] recount — rows ${after.total}   marked ${after.alreadyMarked}   still to mark ${after.toMark}   created after the cutoff ${after.afterCutoff}   unreadable ${after.unreadable}`)

  if (failures.length) throw new Error(`${failures.length} write(s) failed — re-run to retry (the marking is idempotent)`)
  if (after.toMark > 0) throw new Error(`${after.toMark} shop(s) created before the cutoff are still unmarked — re-run`)
  if (after.unreadable > 0) throw new Error(`${after.unreadable} shop(s) could not be decided and were left alone — repair them by hand, then re-run`)
}

// Run only when executed directly (the spec imports the pure parts).
if (process.argv[1]?.endsWith('mark-plan-legacy.ts')) {
  main().catch((e) => {
    console.error('[plan:mark-legacy] FAILED:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
