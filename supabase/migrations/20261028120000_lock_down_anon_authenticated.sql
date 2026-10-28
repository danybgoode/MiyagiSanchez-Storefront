-- Lock the public schema down to the server (prompt-to-shop wave 2, folded-in hardening, 2026-10-28).
--
-- HOW THIS GETS APPLIED: by the orchestrator, through Supabase MCP `apply_migration` (never `supabase db push`), then
-- `schema_migrations` realigned to this filename and verified live: Supabase's security advisors must show no
-- `rls_disabled_in_public` and no `*_security_definer_function_executable`, and every app path still answers.
--
-- WHAT WAS WRONG (measured live 2026-10-28): 60 public tables had RLS off AND full anon/authenticated grants, and
-- three SECURITY DEFINER functions were anon-executable. The anon key ships to every browser, so anyone could read
-- and write those tables through /rest/v1 — orders, connections, audit log, tenants. The cause is the `postgres`
-- role's DEFAULT PRIVILEGES, which grant anon/authenticated everything on each new table, function and sequence.
--
-- WHY THIS IS SAFE: over 24 h of edge logs, all 7,763 PostgREST requests (56 IPs, every app on this shared project)
-- used the service_role key; service_role bypasses RLS and keeps its grants. The only browser use of the public key
-- is Clerk-authenticated realtime on the two conversation tables, which keep SELECT for `authenticated` under their
-- existing participant policies. Code sweep agrees: the storefront's one anon client (`lib/supabase-browser.ts`)
-- reads only those two; despachobonsai uses the service-role key server-side.
--
-- ROLLBACK: `GRANT … TO anon, authenticated` on the specific object that needs it — never a blanket re-grant.
-- Supabase's `supabase_admin`-owned default ACLs cannot be changed from the `postgres` role and are left as they are.

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.oid::regclass AS rel, c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    IF t.relname IN ('marketplace_conversations', 'marketplace_conversation_events') THEN
      -- Realtime: participants read their own rows under the existing policies. Writes go through the server.
      EXECUTE format('REVOKE ALL ON %s FROM anon', t.rel);
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %s FROM authenticated', t.rel);
    ELSE
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t.rel);
      EXECUTE format('REVOKE ALL ON %s FROM anon, authenticated', t.rel);
    END IF;
  END LOOP;
END $$;

REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- The three welcome-delivery functions revoked only PUBLIC; Supabase's default privileges had already granted anon and
-- authenticated EXECUTE directly, so anyone could reserve or suppress a welcome email.
REVOKE ALL ON FUNCTION public.claim_account_welcome(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_account_welcome(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_shop_created_welcome(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_account_welcome(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_account_welcome(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_shop_created_welcome(text, text) TO service_role;

-- Stop the next table, function or sequence from arriving open. A new object that the browser genuinely needs gets
-- an explicit, reviewed GRANT in its own migration.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;
