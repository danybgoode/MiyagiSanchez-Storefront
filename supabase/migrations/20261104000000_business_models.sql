-- business-infrastructure S2 (epic lock D5, D6, D18) — the «Tus números» draft block and one business model per shop.
--
-- HOW THIS GETS APPLIED: by the orchestrator through the Supabase MCP `apply_migration`, BEFORE the S2 pull request
-- merges (the S2 code saves a `numbers` block through `save_p2s_block` and reads the column; deployed against an
-- unmigrated database, every new draft would fail its fourth save). Then `supabase_migrations.schema_migrations` is
-- realigned to this filename's version by hand. NEVER `supabase db push` (local files are unrecorded remotely).
--
-- Premise, verified live 2026-11-03: `shop_drafts` holds 1 row and has no `numbers` column; `business_models` does
-- not exist; `save_p2s_block` accepts keys identity/words/catalog. Everything here is ADDITIVE (a nullable column, a
-- widened key list, a new table), so it is safe at any row count.

-- ── 1. The draft's fourth block ──────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.shop_drafts ADD COLUMN IF NOT EXISTS numbers jsonb;

-- Same signature, same guards, one more key. CREATE OR REPLACE keeps the existing grants; they are restated below.
CREATE OR REPLACE FUNCTION public.save_p2s_block(
  p_draft uuid, p_device uuid, p_version integer, p_key text, p_data jsonb, p_status text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE hit uuid;
BEGIN
  IF p_key NOT IN ('identity', 'words', 'catalog', 'numbers') OR p_status NOT IN ('ok', 'fallback') THEN
    RAISE EXCEPTION 'save_p2s_block: bad key/status (%, %)', p_key, p_status;
  END IF;
  UPDATE public.shop_drafts SET
      identity = CASE WHEN p_key = 'identity' THEN p_data ELSE identity END,
      words    = CASE WHEN p_key = 'words'    THEN p_data ELSE words END,
      catalog  = CASE WHEN p_key = 'catalog'  THEN p_data ELSE catalog END,
      numbers  = CASE WHEN p_key = 'numbers'  THEN p_data ELSE numbers END,
      block_status = block_status || jsonb_build_object(p_key, p_status),
      updated_at = now()
    WHERE id = p_draft AND device_id = p_device AND versions_used = p_version
      AND claimed_by IS NULL AND expires_at > now()
    RETURNING id INTO hit;
  RETURN hit IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION public.save_p2s_block(uuid, uuid, integer, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_p2s_block(uuid, uuid, integer, text, jsonb, text) TO service_role;

-- ── 2. One business model per shop ───────────────────────────────────────────────────────────────────────────────
-- Keyed by the MEDUSA SELLER id, not the slug: a merchant can change their shop URL (`set_shop_slug`), and a model
-- keyed by slug would be orphaned by it. `shop_slug` is kept only as a readable label. Non-commerce state (a plan's
-- inputs and its explanation), so it lives here and not in Medusa (AGENTS rule 2): prices and costs it MEASURES are
-- read from Medusa at plan time, never mirrored as the source of truth.
CREATE TABLE IF NOT EXISTS public.business_models (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id           text        NOT NULL UNIQUE,
  clerk_user_id       text        NOT NULL,
  shop_slug           text,
  -- The kept draft the first model was seeded from, when there was one.
  draft_id            uuid        REFERENCES public.shop_drafts(id) ON DELETE SET NULL,
  -- `lib/business-plan/model.ts` → BusinessInputs; every value carries {value, source, at}. Read defensively.
  inputs              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- The model-written explanation, cached by a hash of the inputs it explains (S3, D10).
  explanation         jsonb,
  -- The last month a check-in was SENT, e.g. '2026-12' (S3, D12): the claim-before-send marker.
  last_checkin_period text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_models_inputs_is_object CHECK (jsonb_typeof(inputs) = 'object'),
  CONSTRAINT business_models_checkin_period CHECK (last_checkin_period IS NULL OR last_checkin_period ~ '^\d{4}-\d{2}$')
);
CREATE INDEX IF NOT EXISTS business_models_clerk_user_idx ON public.business_models (clerk_user_id);

-- Supabase grants anon and authenticated EVERYTHING on a new public table by default (team memory, 2026-10-28: 60
-- tables were browser-writable). A merchant's costs are private: service role only, RLS on with no policies.
ALTER TABLE public.business_models ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.business_models FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_models TO service_role;
