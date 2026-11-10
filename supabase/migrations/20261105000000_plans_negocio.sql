-- plans-gratis-negocio M1 (epic 08 · README D8, D12, D13, D18). Applied by the orchestrator through MCP before the
-- PR that first uses it merges; never `supabase db push`.
--
-- Additive only: two CHECK constraints are WIDENED (every existing row stays valid), one nullable column and a
-- partial unique index are added, and four commission-rate rows are inserted if absent (an admin-edited rate is never
-- overwritten).

-- D8 — the shop chat's monthly allowance per plan is counted under its own kind.
alter table public.ai_allowance drop constraint ai_allowance_kind_check;
alter table public.ai_allowance add constraint ai_allowance_kind_check
  check (kind = any (array['version'::text, 'photo'::text, 'daily_budget'::text, 'chat_month'::text]));

-- D12 — a promoter can settle the three packages by transfer (SPEI / DiMo / CoDi), like the paid items before them.
alter table public.marketplace_promoter_transfers drop constraint marketplace_promoter_transfers_sku_check;
alter table public.marketplace_promoter_transfers add constraint marketplace_promoter_transfers_sku_check
  check (sku = any (array[
    'custom_domain'::text, 'subdomain'::text, 'ml_sync'::text,
    'negocio_anual'::text, 'negocio_arranque'::text, 'setup_gratis'::text
  ]));

-- D13 — a payment can be attributed to a promoter at most once (the year-2 renewal is recorded per Stripe payment, so
-- a replayed webhook finds its row and adds nothing). Existing rows keep NULL, which the partial index ignores.
alter table public.marketplace_promoter_attributions add column if not exists payment_ref text;
create unique index if not exists marketplace_promoter_attributions_payment_ref_key
  on public.marketplace_promoter_attributions (payment_ref)
  where payment_ref is not null;

-- D12, D13 — the packages' splits and the renewal share (Daniel, 2026-11-04), editable later in /admin/promoter.
insert into public.marketplace_promoter_commission_rates (sku, rate_pct, updated_at) values
  ('negocio_anual', 55, now()),
  ('negocio_arranque', 50, now()),
  ('setup_gratis', 80, now()),
  ('negocio_renewal', 10, now())
on conflict (sku) do nothing;
