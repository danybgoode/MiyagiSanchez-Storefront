-- business-infrastructure S5 (epic lock D17, D18) — the handoff: a buyer's question the shop's chat could not answer.
--
-- HOW THIS GETS APPLIED: by the orchestrator through the Supabase MCP `apply_migration`, BEFORE the S5 pull request
-- merges; then `supabase_migrations.schema_migrations` is realigned to this filename's version by hand. NEVER
-- `supabase db push`.
--
-- Premise, verified live 2026-11-04: `shop_chat_threads` does not exist. Everything here is ADDITIVE (a new table).
--
-- Only questions a buyer chose to LEAVE are stored (the chat itself stores nothing). The buyer's email is personal
-- data: service role only, and nulled 90 days after the answer (the daily check-in cron, `checkin-server.ts`).

CREATE TABLE IF NOT EXISTS public.shop_chat_threads (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The Medusa seller the question was asked of (resolved server-side from the chat's URL slug, never the body).
  seller_id     text        NOT NULL,
  -- The shop owner's Clerk id at the time: the ONLY person who may read or answer this thread.
  owner_clerk_user_id text  NOT NULL,
  shop_slug     text        NOT NULL,
  question      text        NOT NULL CHECK (char_length(question) BETWEEN 1 AND 600),
  -- The conversation that led here (≤ 12 turns of {role, text}), so the owner sees the context.
  transcript    jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(transcript) = 'array'),
  buyer_email   text        CHECK (buyer_email IS NULL OR char_length(buyer_email) <= 254),
  status        text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered')),
  reply         text        CHECK (reply IS NULL OR char_length(reply) BETWEEN 1 AND 600),
  answered_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- An answered thread has its reply and its time; an open one has neither.
  CONSTRAINT shop_chat_threads_answer_shape CHECK (
    (status = 'open' AND reply IS NULL AND answered_at IS NULL) OR
    (status = 'answered' AND reply IS NOT NULL AND answered_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS shop_chat_threads_owner_idx ON public.shop_chat_threads (owner_clerk_user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS shop_chat_threads_purge_idx ON public.shop_chat_threads (answered_at) WHERE buyer_email IS NOT NULL;

-- Supabase grants anon and authenticated EVERYTHING on a new public table by default (team memory, 2026-10-28).
-- A buyer's email and question are private: service role only, RLS on with no policies.
ALTER TABLE public.shop_chat_threads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shop_chat_threads FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shop_chat_threads TO service_role;
