-- Follow-up to 20261028120000 (review on PR 438). HOW THIS GETS APPLIED: orchestrator, Supabase MCP
-- `apply_migration`, `schema_migrations` realigned to this filename, then the live probe below re-run.
--
-- 1. New functions must not arrive callable by the browser roles. The earlier per-schema
--    `ALTER DEFAULT PRIVILEGES … IN SCHEMA public REVOKE … ON FUNCTIONS FROM PUBLIC` was a no-op: PUBLIC's EXECUTE
--    is the built-in GLOBAL default, and a per-schema REVOKE only undoes a per-schema GRANT (PostgreSQL docs).
--    Measured live 2026-10-28: a throwaway function created after that migration was still EXECUTE-able by anon and
--    authenticated. This global form (no IN SCHEMA) is the one that works for functions the `postgres` role creates.
--    CONSEQUENCE, on purpose: a helper a policy calls as `authenticated` needs an explicit
--    `GRANT EXECUTE … TO authenticated` in its own migration. Today's policies call only `auth.jwt()`.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- 2. Belt and braces over every relation kind, not only tables: ALL TABLES includes views, materialized views and
--    foreign tables (none exist in public today, measured; the project is shared, so tomorrow is not promised).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- 3. The two realtime tables, made reproducible from migrations alone. Their RLS and participant policies were
--    applied by hand from db/messaging-realtime.sql and lived in no migration, so a replay would have left
--    `authenticated` with SELECT and RLS off: every signed-in user could read every conversation. Idempotent; the
--    policies are copied verbatim from that file.
ALTER TABLE public.marketplace_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_conversation_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "participant reads conversation" ON public.marketplace_conversations;
CREATE POLICY "participant reads conversation"
  ON public.marketplace_conversations FOR SELECT TO authenticated
  USING ( auth.jwt()->>'sub' IN (buyer_clerk_user_id, seller_clerk_user_id) );

DROP POLICY IF EXISTS "participant reads events" ON public.marketplace_conversation_events;
CREATE POLICY "participant reads events"
  ON public.marketplace_conversation_events FOR SELECT TO authenticated
  USING ( EXISTS (
    SELECT 1 FROM public.marketplace_conversations c
    WHERE c.id = marketplace_conversation_events.conversation_id
      AND auth.jwt()->>'sub' IN (c.buyer_clerk_user_id, c.seller_clerk_user_id)
  ) );

GRANT SELECT ON public.marketplace_conversations, public.marketplace_conversation_events TO authenticated;
