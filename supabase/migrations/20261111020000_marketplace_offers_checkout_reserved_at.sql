-- checkout-trust-hardening S1.3: one accepted offer opens one checkout at a time. A reservation is a timestamp claimed by
-- a conditional UPDATE in backend start-checkout; it goes stale after 30 minutes so an abandoned checkout never locks
-- the offer. Additive and nullable: no existing row or reader changes.
-- Applied by the orchestrator (Supabase MCP apply_migration) on 2026-11-11 and verified live; schema_migrations realigned.
ALTER TABLE marketplace_offers ADD COLUMN IF NOT EXISTS checkout_reserved_at timestamptz NULL;
