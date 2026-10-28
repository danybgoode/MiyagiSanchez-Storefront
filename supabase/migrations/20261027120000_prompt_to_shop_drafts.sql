-- Prompt-to-shop S1.1 — the anonymous shop draft and the AI allowance ledger.
--
-- HOW THIS GETS APPLIED: by the orchestrator, through Supabase MCP `apply_migration`, BEFORE the PR merges
-- (merging deploys code that reads these tables). Never `supabase db push`: local files are unrecorded remotely,
-- so a push would replay all of them. MCP records its own timestamp as the version, so realign
-- `supabase_migrations.schema_migrations` to this filename afterwards, then verify live: both tables, both
-- functions, RLS on, and anon/authenticated holding no grants.
--
-- Non-commerce staging (AGENTS rule 2, like supply_batches). Nothing here is a product, a seller or an order: the
-- examples in `catalog` never reach Medusa, and a draft becomes a shop only through the S3.2 claim.

CREATE TABLE IF NOT EXISTS public.shop_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The httpOnly `p2s_device` cookie. Proves ownership of an unclaimed draft; never shown to anyone.
  device_id uuid NOT NULL,
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500),
  identity jsonb,
  words jsonb,
  catalog jsonb,
  -- {identity|words|catalog: 'ok'|'fallback'} — a fallback block is real data, so it is recorded, not hidden.
  block_status jsonb NOT NULL DEFAULT '{}'::jsonb,
  versions_used integer NOT NULL DEFAULT 0 CHECK (versions_used >= 0),
  -- A SEPARATE secret from device_id (D15): the share link can read, and nothing a mutating route accepts can be
  -- derived from it.
  view_token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  claimed_by text,
  claimed_seller_id text,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
CREATE INDEX IF NOT EXISTS shop_drafts_device_id_idx ON public.shop_drafts (device_id);
ALTER TABLE public.shop_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shop_drafts FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.ai_allowance (
  -- device:<uuid> · user:<clerk id> · global
  subject text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('version', 'photo', 'daily_budget')),
  -- all · YYYY-MM · YYYY-MM-DD (America/Mexico_City). Computed by lib/prompt-to-shop/allowance.ts, never here.
  period text NOT NULL,
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject, kind, period)
);
ALTER TABLE public.ai_allowance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_allowance FROM anon, authenticated;

-- Spend one unit under a cap, as ONE statement (D4). Returns the new count, or NULL when the cap is already
-- reached. Two concurrent calls at 2 of 3 cannot both succeed: ON CONFLICT DO UPDATE takes the row lock, and the
-- second caller re-evaluates `count < p_cap` against the first caller's committed value. A read-then-write here
-- would be the double-spend this function exists to prevent.
CREATE OR REPLACE FUNCTION public.spend_ai_allowance(p_subject text, p_kind text, p_period text, p_cap integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE new_count integer;
BEGIN
  IF p_cap IS NULL OR p_cap < 1 THEN
    RAISE EXCEPTION 'spend_ai_allowance: cap must be >= 1 (got %)', p_cap;
  END IF;
  INSERT INTO public.ai_allowance AS a (subject, kind, period, count, updated_at)
    VALUES (p_subject, p_kind, p_period, 1, now())
  ON CONFLICT (subject, kind, period) DO UPDATE
    SET count = a.count + 1, updated_at = now()
    WHERE a.count < p_cap
  RETURNING a.count INTO new_count;
  RETURN new_count;
END $$;
REVOKE ALL ON FUNCTION public.spend_ai_allowance(text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.spend_ai_allowance(text, text, text, integer) TO service_role;

-- One generation spends a device version AND a unit of the global daily budget, or neither (D4). The function body
-- is one transaction, and the version row stays locked until it returns, so giving the version back when the
-- budget refuses cannot race another call from the same device. A merchant never loses a version to a closed budget.
-- reason: 'allowance' (the device is out of versions) · 'budget' (the platform is out for today) · null (spent).
CREATE OR REPLACE FUNCTION public.spend_p2s_generation(
  p_device text, p_version_cap integer, p_budget_period text, p_budget_cap integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE versions integer; budget integer;
BEGIN
  versions := public.spend_ai_allowance(p_device, 'version', 'all', p_version_cap);
  IF versions IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'allowance', 'versions_used', p_version_cap);
  END IF;
  budget := public.spend_ai_allowance('global', 'daily_budget', p_budget_period, p_budget_cap);
  IF budget IS NULL THEN
    UPDATE public.ai_allowance SET count = count - 1, updated_at = now()
      WHERE subject = p_device AND kind = 'version' AND period = 'all' AND count > 0;
    RETURN jsonb_build_object('ok', false, 'reason', 'budget', 'versions_used', versions - 1);
  END IF;
  RETURN jsonb_build_object('ok', true, 'reason', null, 'versions_used', versions);
END $$;
REVOKE ALL ON FUNCTION public.spend_p2s_generation(text, integer, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.spend_p2s_generation(text, integer, text, integer) TO service_role;
