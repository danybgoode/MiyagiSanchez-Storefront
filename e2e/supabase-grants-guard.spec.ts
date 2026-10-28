import { expect, test } from '@playwright/test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The public schema is server-only (lock-down migrations 20261028120000 + 20261028130000). Supabase's anon key ships
// to every browser, and new functions are EXECUTE-able by PUBLIC unless revoked — so a SECURITY DEFINER function that
// does not revoke anon/authenticated is callable by anyone. Three welcome functions shipped exactly that way.
//
// Scoped to migrations from the lock-down on: older files are history (the lock-down revoked them live), and
// rewriting them would only make the guard look clean.
//
// The checker is tested against fixtures first. Its first version required a `public.` prefix and a 600-character
// window, and so passed on the repo's own dominant style (unqualified names) — a guard blind to the house style is
// a guard that passes the very shape it exists to catch (review of PR 438).

const DIR = join(process.cwd(), 'supabase', 'migrations')
const FROM = '20261027120000'

/** Realtime: participants read their own rows under RLS policies (20261028130000). The only allowed browser grant. */
const ALLOWED_BROWSER_GRANTS = new Set(['marketplace_conversations', 'marketplace_conversation_events'])

/** Line comments out, so prose ABOUT a grant is never read as one. (Dollar-quoted bodies keep their `--` text; a
 *  body never holds a top-level GRANT, so that is the safe side to err on.) */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

const NAME = String.raw`(?:"?public"?\s*\.\s*)?"?(\w+)"?`

/** Each CREATE FUNCTION statement, from CREATE to the `;` after its dollar-quoted body. */
function functionStatements(sql: string): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = []
  const re = new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+${NAME}\s*\(`, 'gi')
  for (const m of sql.matchAll(re)) {
    const rest = sql.slice(m.index!)
    const tag = /\$(\w*)\$/.exec(rest)
    let end = rest.length
    if (tag) {
      const close = rest.indexOf(tag[0], tag.index + tag[0].length)
      const semi = close === -1 ? -1 : rest.indexOf(';', close + tag[0].length)
      if (semi !== -1) end = semi + 1
    }
    out.push({ name: m[1].toLowerCase(), text: rest.slice(0, end) })
  }
  return out
}

/** Roles a file revokes EXECUTE (or ALL) from for one function, across every REVOKE statement for it. */
function revokedRoles(sql: string, fn: string): Set<string> {
  const roles = new Set<string>()
  const re = new RegExp(String.raw`REVOKE\s+(?:ALL(?:\s+PRIVILEGES)?|EXECUTE)\s+ON\s+FUNCTION\s+${NAME}\s*(?:\([^)]*\))?\s+FROM\s+([^;]+);`, 'gi')
  for (const m of sql.matchAll(re)) {
    if (m[1].toLowerCase() !== fn) continue
    for (const r of m[2].split(',')) roles.add(r.trim().replace(/"/g, '').toLowerCase())
  }
  return roles
}

function definerOffenders(raw: string): string[] {
  const sql = stripComments(raw)
  const offenders: string[] = []
  for (const f of functionStatements(sql)) {
    if (!/SECURITY\s+DEFINER/i.test(f.text)) continue
    const roles = revokedRoles(sql, f.name)
    const missing = ['public', 'anon', 'authenticated'].filter((r) => !roles.has(r))
    if (missing.length) offenders.push(`${f.name} (not revoked from ${missing.join(', ')})`)
  }
  return offenders
}

function tableOffenders(raw: string): string[] {
  const sql = stripComments(raw)
  const offenders: string[] = []
  for (const m of sql.matchAll(new RegExp(String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}`, 'gi'))) {
    const t = m[1].toLowerCase()
    const rls = new RegExp(String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:"?public"?\s*\.\s*)?"?${t}"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY`, 'i')
    if (!rls.test(sql)) offenders.push(`${t} (RLS not enabled)`)
  }
  for (const m of sql.matchAll(/GRANT\s+([^;]*?)\s+ON\s+([^;]*?)\s+TO\s+([^;]+);/gi)) {
    const grantees = m[3].toLowerCase()
    if (!/\b(anon|authenticated)\b/.test(grantees)) continue
    const target = m[2].trim()
    if (/^FUNCTION\b/i.test(target)) continue // function grants are the definer check's business
    if (/ALL\s+TABLES\s+IN\s+SCHEMA/i.test(target)) { offenders.push(`GRANT ON ALL TABLES to ${grantees.trim()}`); continue }
    const tables = target.replace(/^TABLE\s+/i, '').split(',').map((x) => x.trim().replace(/"/g, '').replace(/^public\./i, '').toLowerCase())
    const onlySelect = /^select$/i.test(m[1].trim())
    for (const t of tables) {
      if (ALLOWED_BROWSER_GRANTS.has(t) && onlySelect && !/\banon\b/.test(grantees)) continue
      offenders.push(`${t} (granted ${m[1].trim()} to ${grantees.trim()})`)
    }
  }
  return offenders
}

// ── The checker, against fixtures: what it must catch, and what it must ALLOW ─────────────────────────────────────

const OPEN_DEFINER_UNQUALIFIED = `CREATE FUNCTION evil(p text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN END $$;
REVOKE ALL ON FUNCTION evil(text) FROM PUBLIC;`
const OPEN_DEFINER_AFTER_LONG_BODY = `CREATE OR REPLACE FUNCTION public.long_one() RETURNS void AS $$
BEGIN ${'PERFORM 1; '.repeat(200)} END $$ LANGUAGE plpgsql SECURITY DEFINER;`
const OPEN_DEFINER_QUOTED = `CREATE FUNCTION "public"."quoted"() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ select 1 $$;`
const CLOSED_DEFINER_ANY_ORDER = `CREATE FUNCTION ok_fn(a int) RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ select a $$;
REVOKE EXECUTE ON FUNCTION ok_fn(int) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.ok_fn(int) FROM PUBLIC;`
const INVOKER_FN = `CREATE FUNCTION plain() RETURNS int LANGUAGE sql AS $$ select 1 $$;`

test('the definer checker catches unqualified, long-bodied and quoted functions, and allows correct SQL', () => {
  expect(definerOffenders(OPEN_DEFINER_UNQUALIFIED)).toEqual(['evil (not revoked from anon, authenticated)'])
  expect(definerOffenders(OPEN_DEFINER_AFTER_LONG_BODY)).toEqual(['long_one (not revoked from public, anon, authenticated)'])
  expect(definerOffenders(OPEN_DEFINER_QUOTED)).toEqual(['quoted (not revoked from public, anon, authenticated)'])
  expect(definerOffenders(CLOSED_DEFINER_ANY_ORDER)).toEqual([])
  expect(definerOffenders(INVOKER_FN)).toEqual([])
})

test('the table checker catches unqualified tables without RLS and browser grants, and allows the realtime read', () => {
  expect(tableOffenders('CREATE TABLE t2 (id int);')).toEqual(['t2 (RLS not enabled)'])
  expect(tableOffenders('CREATE TABLE "public"."t3" (id int); ALTER TABLE t3 ENABLE ROW LEVEL SECURITY;')).toEqual([])
  expect(tableOffenders('GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;')).toEqual(['GRANT ON ALL TABLES to anon'])
  expect(tableOffenders('GRANT INSERT ON public.orders TO authenticated;')).toEqual(['orders (granted INSERT to authenticated)'])
  expect(tableOffenders('GRANT SELECT ON public.marketplace_conversations, public.marketplace_conversation_events TO authenticated;')).toEqual([])
  expect(tableOffenders('GRANT SELECT ON public.marketplace_conversations TO anon;')).toEqual(['marketplace_conversations (granted SELECT to anon)'])
  // Prose about grants is not a grant: a guard that rejects correct files trains people to bypass it.
  expect(tableOffenders('-- Supabase grants EXECUTE on new functions to anon and authenticated directly;\nSELECT 1;')).toEqual([])
})

// ── The real migrations ───────────────────────────────────────────────────────────────────────────────────────────

function newMigrations() {
  return readdirSync(DIR).filter((f) => f.endsWith('.sql') && f.slice(0, 14) >= FROM).sort()
}

test('the guard actually sees migrations (an empty population would pass anything)', () => {
  const files = newMigrations()
  expect(files).toContain('20261027120000_prompt_to_shop_drafts.sql')
  expect(files).toContain('20261028130000_lock_down_followup.sql')
  const fns = files.flatMap((f) => functionStatements(readFileSync(join(DIR, f), 'utf8')))
  expect(fns.filter((f) => /SECURITY\s+DEFINER/i.test(f.text)).length).toBeGreaterThanOrEqual(4)
})

test('every new SECURITY DEFINER function is revoked from PUBLIC, anon and authenticated', () => {
  const offenders = newMigrations().flatMap((f) => definerOffenders(readFileSync(join(DIR, f), 'utf8')).map((o) => `${f}: ${o}`))
  expect(offenders).toEqual([])
})

test('new tables have RLS on, and nothing is granted to the browser roles beyond the realtime read', () => {
  const offenders = newMigrations().flatMap((f) => tableOffenders(readFileSync(join(DIR, f), 'utf8')).map((o) => `${f}: ${o}`))
  expect(offenders).toEqual([])
})

test('the follow-up closes the function default globally and covers every relation kind', () => {
  const sql = readFileSync(join(DIR, '20261028130000_lock_down_followup.sql'), 'utf8')
  // Global (no IN SCHEMA): PUBLIC's EXECUTE is a global default, which a per-schema REVOKE cannot remove.
  expect(sql).toMatch(/^ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;$/m)
  expect(sql).toMatch(/^REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;$/m)
  for (const t of ALLOWED_BROWSER_GRANTS) expect(sql).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`)
})
