/**
 * scripts/mark-plan-legacy.ts
 *
 * Marks every shop that ALREADY EXISTS as legacy, so it keeps Plan Gratis for good (epic 08 ·
 * plan-tienda-three-free-months S1.2, README D2). Every row of `marketplace_shops` created before the
 * `--cutoff` instant gets `metadata.plan_legacy = { marked_at }`, owned or not: an imported shop claimed later was
 * promised the same page. Without the marker `lib/plan.ts` resolves a shop with no live plan to `unpaid`, which is
 * what the pause job (sprint 3) acts on — so this runs, and is verified, BEFORE that job is deployed.
 *
 *   npm run plan:mark-legacy -- --cutoff 2026-11-12T18:30:00Z             # DRY RUN — reads, plans, writes nothing
 *   npm run plan:mark-legacy -- --cutoff 2026-11-12T18:30:00Z --apply     # writes
 *
 * `--cutoff <ISO instant>` is REQUIRED (PR #484 review). It is the moment the promise «gratis para siempre» stopped
 * being made to new shops — in practice, the moment the new pricing went live. It is an argument and not a constant
 * in the code because it is only known on the day: a date typed into the code beforehand leaves every shop opened
 * between that date and the real one unmarked. Three refusals:
 *   - missing, or not an instant with an explicit zone (`Z` or `+hh:mm`): a bare date or a local time would mean a
 *     different moment on the VM (UTC) than on a laptop in Mexico City;
 *   - in the FUTURE: a shop that does not exist yet must never be covered by a run that already happened. With a
 *     future cutoff a rerun tomorrow would mark shops opened after the change;
 *   - anything this script does not recognise.
 * The cutoff used is printed on the first line of every report.
 *
 * `--dry-run` is the default and stays FULLY read-only. The decision lives in `lib/plan.ts` (`planLegacyMarking`,
 * unit-tested); this file only reads shops, asks the planner and writes what it says. Each write is
 * `merge_shop_metadata` guarded on the marker key being ABSENT (or `json_null` when the key holds JSON null — the
 * planner picks the guard that matches what was read), and only a row that the write RETURNED is counted. A marker
 * that appeared between the read and the write is left exactly as it is.
 *
 * The cutoff is what makes a rerun safe: a shop opened after it is never marked, however late this runs. A rerun
 * must pass the SAME cutoff as the first run.
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
  PLAN_LEGACY_KEY,
  buildPlanLegacy,
  planLegacyMarking,
  readPlanLegacy,
  type LegacyMarkingDecision,
  type ShopForLegacyMarking,
} from '../lib/plan'
import { DEFAULT_PAGE_SIZE, readAllPages } from '../lib/paged-read'

/** An instant with seconds optional and an EXPLICIT zone. A bare date, or a time with no zone, is refused: it
 *  would be read in the machine's own timezone and mean a different moment on each machine. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/

export type MarkLegacyArgs = { ok: true; apply: boolean; cutoff: string } | { ok: false; error: string }

/**
 * Parse argv. `--cutoff <ISO instant>` (or `--cutoff=<…>`) is required and must not be in the future; `--apply`
 * writes; `--dry-run` is the default; an unknown flag is fatal rather than silently ignored. The cutoff comes back
 * normalised to UTC (`toISOString`), which is the form the report prints.
 */
export function parseArgs(argv: readonly string[], now: Date = new Date()): MarkLegacyArgs {
  let apply = false
  let raw: string | null = null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') { apply = true; continue }
    if (arg === '--dry-run') { apply = false; continue }
    if (arg === '--cutoff') { raw = argv[i + 1] ?? ''; i += 1; continue }
    if (arg.startsWith('--cutoff=')) { raw = arg.slice('--cutoff='.length); continue }
    return { ok: false, error: `unknown argument: ${arg}` }
  }
  if (raw === null) return { ok: false, error: 'missing --cutoff <ISO instant> (for example --cutoff 2026-11-12T18:30:00Z): the moment new shops stopped being promised Plan Gratis' }
  const ms = ISO_INSTANT.test(raw) ? Date.parse(raw) : NaN
  if (!Number.isFinite(ms)) return { ok: false, error: `--cutoff must be an ISO instant with a zone, like 2026-11-12T18:30:00Z or 2026-11-12T12:30:00-06:00 (got "${raw}")` }
  if (ms > now.getTime()) {
    return { ok: false, error: `--cutoff ${new Date(ms).toISOString()} is in the future (now is ${now.toISOString()}): a shop that does not exist yet must never be covered by this run` }
  }
  return { ok: true, apply, cutoff: new Date(ms).toISOString() }
}

/** The page the table is read in (`lib/paged-read.ts` explains why it is paged, and why below 1,000). */
export const LEGACY_PAGE_SIZE = DEFAULT_PAGE_SIZE

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
  }, LEGACY_PAGE_SIZE, 'marketplace_shops')
  if (shops.length === 0) throw new Error('marketplace_shops is empty — refusing to report success against no shops')
  return shops
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed.ok) throw new Error(parsed.error)
  const db = client()

  const decisions = planLegacyMarking(await readShops(db), parsed.cutoff)
  for (const line of formatLegacyMarkingReport(parsed.apply ? 'APPLY' : 'DRY RUN', parsed.cutoff, decisions)) console.log(line)

  if (!parsed.apply) {
    console.log(`[plan:mark-legacy] dry run — nothing written. Re-run with --cutoff ${parsed.cutoff} --apply.`)
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
  const after = summarizeLegacyMarking(planLegacyMarking(await readShops(db), parsed.cutoff))
  console.log(`[plan:mark-legacy] recount (cutoff ${parsed.cutoff}) — rows ${after.total}   marked ${after.alreadyMarked}   still to mark ${after.toMark}   created after the cutoff ${after.afterCutoff}   unreadable ${after.unreadable}`)

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
