-- merchant-features-surfaced-by-promoter-kit · S3.2 (D9) — a field promoter can file a report from their panel.
-- Applied BY THE ORCHESTRATOR (Supabase MCP apply_migration) BEFORE the S3.2 code deploys; never `db push`.
-- Live CHECK today: author_kind IN ('seller','partner','agent', 'promoter'). Re-verify at apply time:
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'platform_feedback_author_kind_check';
ALTER TABLE platform_feedback DROP CONSTRAINT IF EXISTS platform_feedback_author_kind_check;
ALTER TABLE platform_feedback
  ADD CONSTRAINT platform_feedback_author_kind_check
  CHECK (author_kind IN ('seller', 'partner', 'agent', 'promoter'));
