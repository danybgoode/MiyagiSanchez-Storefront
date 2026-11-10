-- A metadata merge guarded on SEVERAL keys at once (epic 08 · plan-tienda-three-free-months S1.1, PR #484 review).
--
-- HOW THIS GETS APPLIED: by the orchestrator through the Supabase MCP `apply_migration`, BEFORE the code that calls
-- it deploys; `supabase_migrations.schema_migrations` is realigned afterwards. Never `supabase db push`, and never
-- from a builder role.
--
-- ADDITIVE ONLY. `public.merge_shop_metadata(uuid, jsonb, text, text, jsonb)` is not changed, replaced or dropped:
-- every existing caller (the trial stamp, the trial notices, the paywall backfill, the legacy marker) keeps calling
-- it exactly as before. This file only adds a second function beside it.
--
-- WHY: `merge_shop_metadata` takes ONE guard key. A plan payment now decides from THREE keys of the same shop:
--   · a dated Plan Negocio payment reads `negocio_grant`, `negocio_trial` (the paid months start after a live trial)
--     and `tienda_grant` (a live Plan Tienda grant is moved forward by the Negocio months, in the same write);
--   · a dated Plan Tienda payment reads `tienda_grant`, `negocio_trial` and `negocio_grant` (its months start after
--     whatever outranks it).
-- Guarding only the key being paid for leaves the other two as a stale snapshot. Two payments on one shop a moment
-- apart (a merchant buying Tienda while a promoter's Negocio package is approved) could then: write a Tienda grant
-- computed from an old read over a newer one, erasing months somebody PAID for; or start Tienda months underneath
-- Negocio months that landed in between, so they run out unused. With every key the decision read guarded in the one
-- UPDATE, the second writer matches zero rows, re-reads and decides again from the truth.
--
-- CONTRACT
--   p_guards is a non-empty JSON array of objects:
--     { "key": "<metadata key>", "mode": "absent" }
--     { "key": "<metadata key>", "mode": "json_null" }
--     { "key": "<metadata key>", "mode": "equals", "expected": <any json> }
--   The merge lands only if EVERY guard holds, in the same statement that writes (one UPDATE: no window between
--   the check and the write). The modes mean exactly what they mean in `merge_shop_metadata`:
--     'absent'     → the key is absent                  (not (metadata ? key))
--     'json_null'  → the key holds JSON null            (metadata -> key = 'null')
--     'equals'     → the key equals `expected`          (metadata -> key is not distinct from expected)
--   The absent / JSON-null distinction is kept for the same reason as there: `'null'::jsonb` is not SQL NULL, and a
--   caller that cannot say which one it read jams the write forever.
--
-- EVERYTHING ELSE REFUSES (zero rows, nothing written). A guard nobody understands must never fall through to an
-- unconditional write:
--   · p_guards NULL, not an array, or EMPTY — there is deliberately no 'none' mode here. An unguarded merge has to
--     be asked for by name through `merge_shop_metadata`; it cannot be reached by passing an empty list by mistake.
--   · an element that is not an object, or whose `key` is not a string;
--   · an unknown or missing `mode`;
--   · 'equals' WITHOUT an `expected` member. In the single-guard function a SQL NULL `p_expected` under 'equals'
--     matches an ABSENT key; here a forgotten `expected` would silently turn "must equal what I read" into "must be
--     absent", so it is refused. (`"expected": null` is JSON null and matches a key holding JSON null — say
--     'json_null' instead; both are accepted and mean the same.)
--
-- Like the original, there is NO plan logic here: which keys to guard and what to write is decided in TypeScript
-- (`lib/plan.ts`). A second copy of that rule in SQL is the paraphrased contract that drifts permissive. This
-- compares values; it does not judge them.
--
-- Returns the updated row, or no rows when a guard refused (or the shop does not exist). A caller that gets no row
-- knows nothing was written; it must not read that as success.
--
-- Same settings as `merge_shop_metadata`: SECURITY DEFINER, `search_path = public`, `language sql`, the same
-- `(id, metadata)` return shape.
create or replace function public.merge_shop_metadata_guards(
  p_shop_id uuid,
  p_patch jsonb,
  p_guards jsonb
)
returns table (id uuid, metadata jsonb)
language sql
security definer
set search_path = public
as $$
  update marketplace_shops s
  set metadata = coalesce(s.metadata, '{}'::jsonb) || p_patch
  where s.id = p_shop_id
    -- CASE, not AND: its branches are tried in order, so `jsonb_array_length` / `jsonb_array_elements` are never
    -- reached with something that is not an array (they would raise instead of refusing).
    and case
      when p_guards is null then false
      when jsonb_typeof(p_guards) <> 'array' then false
      when jsonb_array_length(p_guards) = 0 then false
      else not exists (
        -- A guard that does NOT hold. `coalesce(..., false)`: a comparison that comes out NULL (a missing key name,
        -- a JSON-null test against an absent key) is "does not hold", never "skip this guard".
        select 1
        from jsonb_array_elements(p_guards) as g(guard)
        where not coalesce(
          case
            when jsonb_typeof(g.guard) <> 'object' then false
            when jsonb_typeof(g.guard -> 'key') is distinct from 'string' then false
            when g.guard ->> 'mode' = 'absent'
              then not (coalesce(s.metadata, '{}'::jsonb) ? (g.guard ->> 'key'))
            when g.guard ->> 'mode' = 'json_null'
              then (coalesce(s.metadata, '{}'::jsonb) -> (g.guard ->> 'key')) = 'null'::jsonb
            when g.guard ->> 'mode' = 'equals'
              then (g.guard ? 'expected')
                and (coalesce(s.metadata, '{}'::jsonb) -> (g.guard ->> 'key')) is not distinct from (g.guard -> 'expected')
            else false
          end,
          false
        )
      )
    end
  returning s.id, s.metadata;
$$;

-- service_role only. This merges arbitrary keys into a shop's metadata, so no request-bearing role may reach it.
-- Supabase's default privileges grant EXECUTE on a new public function to anon and authenticated DIRECTLY, so
-- revoking PUBLIC alone would leave it callable with the browser's anon key: name all three.
revoke all on function public.merge_shop_metadata_guards(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.merge_shop_metadata_guards(uuid, jsonb, jsonb) to service_role;
