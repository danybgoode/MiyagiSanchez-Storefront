import { expect, test } from '@playwright/test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The public schema is server-only (lock-down migration 20261028120000). Supabase's anon key ships to every browser,
// and Supabase grants anon/authenticated EXECUTE on new functions DIRECTLY — so a SECURITY DEFINER function that
// revokes only PUBLIC is callable by anyone. Three welcome functions shipped exactly that way and sat open for weeks.
//
// Scoped to migrations from the lock-down on: older files are history (the lock-down revoked them live), and
// rewriting them would only make the guard look clean.

const DIR = join(process.cwd(), 'supabase', 'migrations')
const FROM = '20261027120000'

function newMigrations() {
  return readdirSync(DIR).filter((f) => f.endsWith('.sql') && f.slice(0, 14) >= FROM).sort()
}

test('the guard actually sees migrations (an empty population would pass anything)', () => {
  expect(newMigrations()).toContain('20261027120000_prompt_to_shop_drafts.sql')
  expect(newMigrations()).toContain('20261028120000_lock_down_anon_authenticated.sql')
})

test('every new SECURITY DEFINER function revokes anon and authenticated, not only PUBLIC', () => {
  const offenders: string[] = []
  for (const file of newMigrations()) {
    const sql = readFileSync(join(DIR, file), 'utf8')
    for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(([\s\S]*?)\)\s*RETURNS[\s\S]*?(?:\$\$|AS)/gi)) {
      const header = sql.slice(m.index, m.index! + 600)
      if (!/SECURITY\s+DEFINER/i.test(header)) continue
      const revoke = new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+public\\.${m[1]}\\s*\\([^)]*\\)\\s+FROM\\s+PUBLIC,\\s*anon,\\s*authenticated`, 'i')
      if (!revoke.test(sql)) offenders.push(`${file}: ${m[1]}`)
    }
  }
  expect(offenders).toEqual([])
})

test('new tables are created with RLS on and no anon/authenticated grant', () => {
  const offenders: string[] = []
  for (const file of newMigrations()) {
    const sql = readFileSync(join(DIR, file), 'utf8')
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.(\w+)/gi)) {
      const t = m[1]
      if (!new RegExp(`ALTER\\s+TABLE\\s+public\\.${t}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i').test(sql)) offenders.push(`${file}: ${t} (RLS)`)
      if (new RegExp(`GRANT[^;]*ON\\s+(?:TABLE\\s+)?public\\.${t}\\b[^;]*TO[^;]*\\b(anon|authenticated)\\b`, 'i').test(sql)) offenders.push(`${file}: ${t} (grant)`)
    }
  }
  expect(offenders).toEqual([])
})

test('the lock-down covers every table, the welcome functions and the default privileges', () => {
  const sql = readFileSync(join(DIR, '20261028120000_lock_down_anon_authenticated.sql'), 'utf8')
  expect(sql).toMatch(/WHERE n\.nspname = 'public' AND c\.relkind IN \('r', 'p'\)/)
  for (const fn of ['claim_account_welcome', 'reserve_account_welcome', 'reserve_shop_created_welcome']) {
    expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn}(text, text) FROM PUBLIC, anon, authenticated;`)
  }
  for (const kind of ['TABLES', 'SEQUENCES']) {
    expect(sql).toContain(`ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON ${kind} FROM anon, authenticated;`)
  }
  expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;')
})
