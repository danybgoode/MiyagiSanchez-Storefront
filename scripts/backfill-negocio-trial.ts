/**
 * scripts/backfill-negocio-trial.ts
 *
 * Gives every EXISTING owned shop its 30-day Negocio trial on launch day (epic 08 · plans-gratis-negocio, decision a,
 * README D4). New shops get theirs when the owner first opens the panel; this covers the ones that already exist.
 *
 *   npm run negocio:trial-backfill                 # DRY RUN — reads, plans, writes nothing
 *   npm run negocio:trial-backfill -- --apply      # writes
 *
 * `--dry-run` is the default and stays FULLY read-only. The decision lives in `lib/plan.ts`
 * (`planNegocioTrialBackfill`, unit-tested); this file only reads shops, asks the planner and writes what it says.
 * Each write is `merge_shop_metadata` guarded on the trial key being ABSENT, so a re-run, or a trial the owner
 * started concurrently by opening their panel, is never overwritten.
 *
 * A read failure, an empty table or any failed write exits non-zero: a backfill that "succeeds" at nothing reads as
 * a passing gate.
 */
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import {
  NEGOCIO_TRIAL_KEY,
  buildNegocioTrial,
  guardFor,
  planNegocioTrialBackfill,
  readNegocioTrial,
  type ShopForTrialBackfill,
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

function client() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — refusing to run blind')
  return createClient(url, key, { auth: { persistSession: false } })
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed.ok) throw new Error(parsed.error)
  const db = client()

  const { data, error } = await db
    .from('marketplace_shops')
    .select('id, slug, clerk_user_id, metadata')
    .order('created_at', { ascending: true })
  if (error) throw new Error(`could not read marketplace_shops: ${error.message}`)
  if (!data || data.length === 0) throw new Error('marketplace_shops is empty — refusing to report success against no shops')

  const shops = data as ShopForTrialBackfill[]
  const decisions = planNegocioTrialBackfill(shops)
  const owed = decisions.filter((d) => d.action === 'stamp')
  const count = (why: string) => decisions.filter((d) => d.why === why).length
  console.log(`[negocio:trial-backfill] ${parsed.apply ? 'APPLY' : 'DRY RUN'} — ${shops.length} shop(s)`)
  console.log(`  stamp ${owed.length}   unowned ${count('unowned')}   already trialed/Negocio ${count('already_trialed_or_negocio')}`)
  for (const d of owed) console.log(`  + ${d.slug ?? d.shopId}`)

  if (!parsed.apply) {
    console.log('[negocio:trial-backfill] dry run — nothing written. Re-run with --apply.')
    return
  }

  const trial = buildNegocioTrial()
  let written = 0
  let raced = 0
  const failures: string[] = []
  for (const d of owed) {
    // The guard matches what was read: a JSON-null trial is "never trialed" for the planner, so it must be written with
    // `json_null`, not `absent`, or the write never lands (Codex, #471).
    const shop = shops.find((x) => x.id === d.shopId)
    const guard = guardFor(shop?.metadata, NEGOCIO_TRIAL_KEY)
    if (guard.mode === 'equals') { raced += 1; continue }
    const { data: merged, error: writeError } = await db.rpc('merge_shop_metadata', {
      p_shop_id: d.shopId,
      p_patch: { [NEGOCIO_TRIAL_KEY]: trial },
      p_guard_key: NEGOCIO_TRIAL_KEY,
      p_guard_mode: guard.mode,
      p_expected: null,
    })
    if (writeError) { failures.push(`${d.slug ?? d.shopId}: ${writeError.message}`); continue }
    if (Array.isArray(merged) && merged.length > 0) { written += 1; continue }
    // The guard fired: a trial appeared since the read (the owner opened the panel). Verify it is a real trial.
    const { data: after } = await db.from('marketplace_shops').select('metadata').eq('id', d.shopId).maybeSingle()
    if (after && readNegocioTrial((after as { metadata: unknown }).metadata)) raced += 1
    else failures.push(`${d.slug ?? d.shopId}: trial key present but not a valid trial`)
  }
  console.log(`[negocio:trial-backfill] stamped ${written}; ${raced} already started concurrently; ${failures.length} failed`)
  for (const f of failures) console.error(`  ! ${f}`)
  if (failures.length) throw new Error(`${failures.length} write(s) failed — re-run to retry (the backfill is idempotent)`)
}

// Run only when executed directly (the spec imports parseArgs).
if (process.argv[1]?.endsWith('backfill-negocio-trial.ts')) {
  main().catch((e) => {
    console.error('[negocio:trial-backfill] FAILED:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
