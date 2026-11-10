/**
 * scripts/set-trial-end.ts
 *
 * Moves ONE test shop's free-months end to a given instant, for the sprint-3 smoke test (epic 08 ·
 * plan-tienda-three-free-months, sprint-3 walkthrough step 2: "move that shop's trial end to yesterday and run the
 * plan job"). An operator's aid, not a product feature.
 *
 *   npm run plan:set-trial-end -- --shop <shop id> --trial-end 2026-11-09T12:00:00Z            # DRY RUN — prints, writes nothing
 *   npm run plan:set-trial-end -- --shop <shop id> --trial-end 2026-11-09T12:00:00Z --apply    # writes
 *
 * Refusals, all before anything is written:
 *   - `--shop` missing, or `--trial-end` not an instant with an explicit zone (`Z` or `+hh:mm`);
 *   - a shop whose name AND slug both lack the whole word «prueba» or «test» (any case) — so a real merchant's trial is never moved
 *     by a typo in an id — unless `--force` is passed;
 *   - a shop with no readable trial (its owner has not opened the panel yet, so there is nothing to move);
 *   - an unknown argument.
 *
 * The write is `merge_shop_metadata` with an `equals` guard on the trial exactly as read, and only a row the write
 * RETURNED with the new end counts. `notified_end_at` is cleared so the end notice can be seen in the smoke test;
 * the 15- and 5-day stamps are kept. If the new end is before the trial's start, the start moves to it too (a trial
 * that ends before it starts is not one `readNegocioTrial` would honestly describe).
 *
 * Dry run is the default and is FULLY read-only. Runs in production like `mark-plan-legacy.ts`: bundled with esbuild,
 * copied into the web container under THIS filename (main is gated on it), and run there with the container's env.
 */
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { NEGOCIO_TRIAL_KEY, readNegocioTrial, readPlanLegacyState, type NegocioTrial } from '../lib/plan'

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/

export type SetTrialEndArgs =
  | { ok: true; shopId: string; trialEnd: string; apply: boolean; force: boolean }
  | { ok: false; error: string }

export function parseArgs(argv: readonly string[]): SetTrialEndArgs {
  let shopId: string | null = null
  let raw: string | null = null
  let apply = false
  let force = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') { apply = true; continue }
    if (arg === '--dry-run') { apply = false; continue }
    if (arg === '--force') { force = true; continue }
    if (arg === '--shop') { shopId = argv[i + 1] ?? ''; i += 1; continue }
    if (arg.startsWith('--shop=')) { shopId = arg.slice('--shop='.length); continue }
    if (arg === '--trial-end') { raw = argv[i + 1] ?? ''; i += 1; continue }
    if (arg.startsWith('--trial-end=')) { raw = arg.slice('--trial-end='.length); continue }
    return { ok: false, error: `unknown argument: ${arg}` }
  }
  if (!shopId) return { ok: false, error: 'missing --shop <marketplace_shops id>' }
  if (raw === null) return { ok: false, error: 'missing --trial-end <ISO instant> (for example --trial-end 2026-11-09T12:00:00Z)' }
  const ms = ISO_INSTANT.test(raw) ? Date.parse(raw) : NaN
  if (!Number.isFinite(ms)) return { ok: false, error: `--trial-end must be an ISO instant with a zone, like 2026-11-09T12:00:00Z (got "${raw}")` }
  return { ok: true, shopId, trialEnd: new Date(ms).toISOString(), apply, force }
}

/**
 * «prueba» or «test» as a WHOLE WORD in the name or the slug, any case: «Tienda de prueba», `qa-test-1`. Not a
 * substring, so «contestar» or «protesta» never pass for a test shop (verifier nit). A word here is bounded by
 * anything that is not a letter or digit, accented letters included, so «pruebá» is not «prueba».
 */
export function looksLikeTestShop(shop: { name: string | null; slug: string | null }): boolean {
  return /(^|[^\p{L}\p{N}])(prueba|test)($|[^\p{L}\p{N}])/iu.test(`${shop.name ?? ''} ${shop.slug ?? ''}`)
}

export type TrialEndShop = { id: string; slug: string | null; name: string | null; metadata: unknown }

export type TrialEndPlan =
  | { ok: true; before: NegocioTrial; after: NegocioTrial; rawTrial: unknown; legacy: string }
  | { ok: false; error: string }

/** What the write would do, or why it must not happen. Pure. */
export function planTrialEnd(shop: TrialEndShop, trialEnd: string, force: boolean): TrialEndPlan {
  if (!force && !looksLikeTestShop(shop)) {
    return { ok: false, error: `"${shop.name ?? shop.slug ?? shop.id}" does not look like a test shop (no «prueba» or «test» in its name or slug). Pass --force only if you are sure.` }
  }
  const before = readNegocioTrial(shop.metadata)
  if (!before) return { ok: false, error: 'this shop has no readable trial: its owner must open /shop/manage once first' }
  const { notified_end_at: _cleared, ...kept } = before
  void _cleared
  const started = Date.parse(before.started_at) > Date.parse(trialEnd) ? trialEnd : before.started_at
  return {
    ok: true,
    before,
    after: { ...kept, started_at: started, expires_at: trialEnd },
    rawTrial: (shop.metadata as Record<string, unknown>)[NEGOCIO_TRIAL_KEY],
    legacy: readPlanLegacyState(shop.metadata),
  }
}

function client() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — refusing to run blind')
  return createClient(url, key, { auth: { persistSession: false } })
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.ok) throw new Error(args.error)
  const db = client()
  const { data, error } = await db.from('marketplace_shops').select('id, slug, name, metadata').eq('id', args.shopId).maybeSingle()
  if (error) throw new Error(`shop read failed: ${error.message}`)
  if (!data) throw new Error(`no shop with id ${args.shopId}`)
  const shop = data as TrialEndShop
  const plan = planTrialEnd(shop, args.trialEnd, args.force)
  if (!plan.ok) throw new Error(plan.error)

  console.log(`[plan:set-trial-end] ${args.apply ? 'APPLY' : 'DRY RUN'} — ${shop.name ?? shop.slug} (${shop.id})`)
  console.log(`  trial now   ${plan.before.started_at} → ${plan.before.expires_at}`)
  console.log(`  trial after ${plan.after.started_at} → ${plan.after.expires_at}`)
  if (plan.legacy !== 'absent') console.log(`  ! legacy marker is ${plan.legacy}: this shop falls to Plan Gratis and the plan job will NOT pause it`)
  if (!args.apply) {
    console.log('[plan:set-trial-end] dry run — nothing written. Re-run with --apply.')
    return
  }
  const { data: merged, error: writeError } = await db.rpc('merge_shop_metadata', {
    p_shop_id: shop.id,
    p_patch: { [NEGOCIO_TRIAL_KEY]: plan.after },
    p_guard_key: NEGOCIO_TRIAL_KEY,
    p_guard_mode: 'equals',
    p_expected: plan.rawTrial,
  })
  if (writeError) throw new Error(`write failed: ${writeError.message}`)
  const row = Array.isArray(merged) ? (merged[0] as { metadata: unknown } | undefined) : undefined
  if (!row) throw new Error('the trial changed between the read and the write — nothing written; re-run')
  if (readNegocioTrial(row.metadata)?.expires_at !== plan.after.expires_at) throw new Error('the write returned a row without the new end')
  console.log(`[plan:set-trial-end] written: the trial now ends ${plan.after.expires_at}`)
}

if (process.argv[1]?.endsWith('set-trial-end.ts')) {
  main().catch((e) => {
    console.error('[plan:set-trial-end] FAILED:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
