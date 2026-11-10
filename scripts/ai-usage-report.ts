/**
 * scripts/ai-usage-report.ts
 *
 * A month of AI use per shop (epic 08 · plan-tienda-three-free-months S1.4, README D15): how many shop-chat answers
 * and how many photos each shop used, and in total — so the allowances in `lib/plan-allowances.ts` are set on a
 * measured number instead of a guess.
 *
 *   npm run ai:usage-report -- --month 2026-10
 *
 * ALWAYS read-only: two selects, no write, no RPC. `--dry-run` is accepted and changes nothing (every agent tests
 * with it; it must never be an error).
 *
 * Where the numbers come from — the ledger `ai_allowance`, one row per (subject, kind, period), incremented by
 * `spend_ai_allowance` when an answer or a photo is spent:
 *   - chat answers: kind `chat_month`, subject `shop_chat:month:shop:<slug>` (lib/shop-chat/handler.ts). Per SHOP.
 *   - photos:       kind `photo`,      subject `user:<clerk id>` (lib/prompt-to-shop/photo-server.ts). Per OWNER,
 *                   not per shop: the report shows them on the owner's oldest shop (the shop `resolveMyPlan` reads
 *                   the plan from) and says so when the owner has more than one.
 *   - the period is `YYYY-MM` in America/Mexico_City (`monthPeriod`), so a month here is a Mexico City month.
 *   A photo is counted when the merchant CONFIRMS a product from it; the vision calls behind discarded suggestions
 *   are capped per day under another kind and are not in this report.
 *
 * COST IS NOT LOGGED ANYWHERE (found at build, 2026-11-09). The model's answer carries token counts
 * (`callModelBody` returns `promptTokens` / `outputTokens`), but the shop chat discards them and the photo analysis
 * only prints them to the container's stdout, without the shop or the owner; nothing is stored, and no price per
 * token exists in the code. So the cost column says «no registrado». It is never 0: a zero would read as "this
 * cost nothing", which is the one thing we know is false.
 *
 * A read that fails exits non-zero with the reason. A month with no rows is said in words («sin uso registrado»),
 * after a read that succeeded — never an empty table that could be mistaken for a failed one.
 */
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { userSubject } from '../lib/prompt-to-shop/allowance'
import { DEFAULT_PAGE_SIZE, readAllPages } from '../lib/paged-read'

/** The ledger kinds this report reads (README D15). */
export const USAGE_KINDS = ['chat_month', 'photo'] as const

/** The shop chat's monthly subject is `shop_chat:month:shop:<slug>` — built in `lib/shop-chat/handler.ts`; the spec
 *  pins that file to this prefix, so the two cannot drift apart unnoticed. */
export const CHAT_MONTH_SUBJECT_PREFIX = 'shop_chat:month:shop:'
/** `user:` — derived from the one function that builds the photo subject, never retyped. */
export const PHOTO_SUBJECT_PREFIX = userSubject('')

export const COST_NOT_LOGGED = 'no registrado'

export type UsageArgs = { ok: true; month: string } | { ok: false; error: string }

/** `--month YYYY-MM` (or `--month=YYYY-MM`) is required; `--dry-run` is accepted; anything else is fatal. */
export function parseArgs(argv: readonly string[]): UsageArgs {
  let month: string | null = null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') continue
    if (arg === '--month') { month = argv[i + 1] ?? ''; i += 1; continue }
    if (arg.startsWith('--month=')) { month = arg.slice('--month='.length); continue }
    return { ok: false, error: `unknown argument: ${arg}` }
  }
  if (month === null) return { ok: false, error: 'missing --month YYYY-MM (for example --month 2026-10)' }
  // No default month: "last month" computed here would silently depend on the machine's clock and timezone, while
  // the ledger's months are Mexico City months.
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { ok: false, error: `--month must be YYYY-MM (got "${month}")` }
  return { ok: true, month }
}

export type UsageRow = { subject: string; kind: string; period: string; used: unknown }
export type ShopRow = { id: string; slug: string | null; name: string | null; clerk_user_id: string | null; created_at: string | null }

export type UsageLine = {
  /** What the row is called in the table: the shop's slug, or the raw subject when no shop matches. */
  label: string
  chat: number
  photos: number
  /** Always null today: cost is not logged (see the file header). A number only once it is really measured. */
  costMxn: number | null
  notes: string[]
}

export type UsageReport = {
  month: string
  lines: UsageLine[]
  totals: { chat: number; photos: number; costMxn: number | null }
  /** Ledger rows of the right kind and month whose subject is not one this report knows how to read. They are
   *  counted in the totals and listed — never dropped. */
  unrecognised: Array<{ subject: string; kind: string; used: number }>
  shopsRead: number
  shopsWithoutUse: number
}

function countOf(row: UsageRow): number {
  // The ledger column is `integer NOT NULL CHECK (count >= 0)`. Anything else means the read is not what we think
  // it is (a wrong alias, an aggregate): refuse, rather than add up garbage.
  if (typeof row.used !== 'number' || !Number.isInteger(row.used) || row.used < 0) {
    throw new Error(`ai_allowance row ${row.subject} / ${row.kind} has no usable count (got ${JSON.stringify(row.used)})`)
  }
  return row.used
}

/** Oldest first, then by id: the same order `readOwnedShop` uses, so the report agrees with the app on which shop
 *  is "the owner's shop". */
function oldestFirst(a: ShopRow, b: ShopRow): number {
  const byDate = (a.created_at ?? '').localeCompare(b.created_at ?? '')
  return byDate !== 0 ? byDate : a.id.localeCompare(b.id)
}

/**
 * The report for one month. PURE: ledger rows and shop rows in, lines and totals out.
 * Rows of another month or another kind are ignored (the query already filters them; this keeps the function right
 * on its own).
 */
export function buildUsageReport(month: string, usage: readonly UsageRow[], shops: readonly ShopRow[]): UsageReport {
  const bySlug = new Map<string, ShopRow>()
  const byOwner = new Map<string, ShopRow[]>()
  for (const s of shops) {
    if (s.slug) bySlug.set(s.slug.toLowerCase(), s)
    if (s.clerk_user_id) byOwner.set(s.clerk_user_id, [...(byOwner.get(s.clerk_user_id) ?? []), s])
  }

  const lines = new Map<string, UsageLine>()
  const line = (label: string): UsageLine => {
    let l = lines.get(label)
    if (!l) { l = { label, chat: 0, photos: 0, costMxn: null, notes: [] }; lines.set(label, l) }
    return l
  }
  const note = (l: UsageLine, text: string) => { if (!l.notes.includes(text)) l.notes.push(text) }
  const unrecognised: UsageReport['unrecognised'] = []
  const totals = { chat: 0, photos: 0, costMxn: null as number | null }

  for (const row of usage) {
    if (row.period !== month) continue
    if (row.kind === 'chat_month') {
      const used = countOf(row)
      totals.chat += used
      if (!row.subject.startsWith(CHAT_MONTH_SUBJECT_PREFIX)) { unrecognised.push({ subject: row.subject, kind: row.kind, used }); continue }
      const slug = row.subject.slice(CHAT_MONTH_SUBJECT_PREFIX.length)
      const shop = bySlug.get(slug.toLowerCase())
      const l = line(shop?.slug ?? slug)
      l.chat += used
      if (!shop) note(l, 'no hay una tienda con ese slug (¿se renombró o se borró?)')
    } else if (row.kind === 'photo') {
      const used = countOf(row)
      totals.photos += used
      if (!row.subject.startsWith(PHOTO_SUBJECT_PREFIX)) { unrecognised.push({ subject: row.subject, kind: row.kind, used }); continue }
      const owner = row.subject.slice(PHOTO_SUBJECT_PREFIX.length)
      const owned = [...(byOwner.get(owner) ?? [])].sort(oldestFirst)
      if (owned.length === 0) {
        const l = line(row.subject)
        l.photos += used
        note(l, 'el dueño no tiene tienda')
        continue
      }
      const l = line(owned[0].slug ?? owned[0].id)
      l.photos += used
      if (owned.length > 1) note(l, `las fotos se cuentan por dueño: incluye las de sus ${owned.length} tiendas`)
    }
  }

  const sorted = [...lines.values()].sort((a, b) => (b.chat + b.photos) - (a.chat + a.photos) || a.label.localeCompare(b.label))
  const used = new Set(sorted.map((l) => l.label))
  const shopsWithoutUse = shops.filter((s) => !used.has(s.slug ?? s.id)).length
  return { month, lines: sorted, totals, unrecognised, shopsRead: shops.length, shopsWithoutUse }
}

/** A cost, or «no registrado» when it was not measured. NEVER "0" for an unmeasured cost. */
export function formatCost(costMxn: number | null): string {
  return costMxn === null ? COST_NOT_LOGGED : `$${costMxn.toFixed(2)}`
}

/** The printed report (pure, so the wording — and the absence of a made-up zero — is tested). */
export function formatUsageReport(report: UsageReport): string[] {
  const head = `[ai:usage-report] ${report.month} (mes de Ciudad de México) — solo lectura`
  if (report.lines.length === 0 && report.unrecognised.length === 0) {
    return [
      head,
      `  Sin uso registrado en ${report.month}: la lectura funcionó y no hay ninguna fila de chat ni de fotos para ese mes (${report.shopsRead} tiendas leídas).`,
      `  Costo: ${COST_NOT_LOGGED}.`,
    ]
  }
  const rows: Array<[string, string, string, string]> = [
    ['Tienda', 'Respuestas del chat', 'Fotos', 'Costo'],
    ...report.lines.map((l): [string, string, string, string] => [l.label, String(l.chat), String(l.photos), formatCost(l.costMxn)]),
    ...report.unrecognised.map((u): [string, string, string, string] => [
      `(sin clasificar) ${u.subject}`, u.kind === 'chat_month' ? String(u.used) : '', u.kind === 'photo' ? String(u.used) : '', COST_NOT_LOGGED,
    ]),
    ['TOTAL', String(report.totals.chat), String(report.totals.photos), formatCost(report.totals.costMxn)],
  ]
  const width = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i].length)))
  const out = [head]
  for (const r of rows) {
    out.push(`  ${r[0].padEnd(width[0])}  ${r[1].padStart(width[1])}  ${r[2].padStart(width[2])}  ${r[3].padStart(width[3])}`)
  }
  for (const l of report.lines) for (const n of l.notes) out.push(`  * ${l.label}: ${n}`)
  if (report.unrecognised.length) out.push(`  * ${report.unrecognised.length} fila(s) sin clasificar: su sujeto no es de chat por tienda ni de fotos por dueño. Están sumadas en el total.`)
  out.push(`  ${report.shopsWithoutUse} de ${report.shopsRead} tiendas no usaron chat ni fotos en ${report.month}.`)
  out.push('  Las fotos se cuentan por dueño (no por tienda) y solo las confirmadas como producto.')
  out.push(`  Costo «${COST_NOT_LOGGED}»: hoy no se guarda ni el costo ni los tokens de cada llamada, así que no hay de dónde calcularlo.`)
  return out
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

  const usage = await readAllPages<UsageRow>(async (from, to) => {
    const { data, error } = await db
      .from('ai_allowance')
      // Aliased: a bare `count` in a PostgREST select can be read as the aggregate rather than the column.
      .select('subject, kind, period, used:count')
      .eq('period', parsed.month)
      .in('kind', [...USAGE_KINDS])
      .order('subject', { ascending: true })
      .order('kind', { ascending: true }) // (subject, kind, period) is the primary key: a stable page order
      .range(from, to)
    return { data: data as UsageRow[] | null, error }
  }, DEFAULT_PAGE_SIZE, 'ai_allowance')

  const shops = await readAllPages<ShopRow>(async (from, to) => {
    const { data, error } = await db
      .from('marketplace_shops')
      .select('id, slug, name, clerk_user_id, created_at')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
    return { data: data as ShopRow[] | null, error }
  }, DEFAULT_PAGE_SIZE, 'marketplace_shops')
  // Zero shops is not "nobody used AI": it is a read of the wrong database, or of nothing.
  if (shops.length === 0) throw new Error('marketplace_shops is empty — refusing to report against no shops')

  for (const line of formatUsageReport(buildUsageReport(parsed.month, usage, shops))) console.log(line)
}

// Run only when executed directly (the spec imports the pure parts).
if (process.argv[1]?.endsWith('ai-usage-report.ts')) {
  main().catch((e) => {
    console.error('[ai:usage-report] FAILED:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
