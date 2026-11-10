-- plan-tienda-three-free-months M1 (epic 08 · README D11, D12, D13, D14). Applied by the orchestrator through MCP
-- before the PR that first uses it merges, then `schema_migrations` realigned; never `supabase db push`.
--
-- Additive only: one CHECK constraint is WIDENED (every value it allowed before is still allowed, so every existing
-- row stays valid) and four commission-rate rows are inserted if absent (an admin-edited rate is never overwritten).
-- No column, no index, no rate row changes.
--
-- The other promoter `sku` columns were read in every migration that touches them and need nothing:
--   marketplace_promoter_attributions.sku    — no CHECK (20260629120000); renewals and the upgrade write new skus there.
--   marketplace_promoter_commissions.sku     — no CHECK (20260630120000).
--   marketplace_promoter_commission_rates.sku — no CHECK, on purpose (20260630120000: "the app validates it").
--   marketplace_promoter_sku_prices.sku      — no CHECK (20260703120000).
-- The orchestrator re-reads `pg_constraint` live at apply time (D13): a CHECK that exists live but not in these files
-- would refuse the new skus and must be widened the same way.

-- D11, D13 — a promoter can settle the two new packages by transfer (SPEI / DiMo / CoDi). Every earlier value stays:
-- the retired `negocio_arranque` and `setup_gratis` keep their old rows readable, and a pending one can be approved.
-- `migration` is ADDED as well: lib/promoter-transfer.ts has offered it for transfer since platform-migrations S2, but
-- no migration file ever put it in this CHECK (20260703140000 allowed three skus, 20261105000000 six, neither
-- `migration`), so a migration transfer would be refused at insert. Widening for it is additive; if the live CHECK
-- already allows it, nothing changes.
alter table public.marketplace_promoter_transfers drop constraint marketplace_promoter_transfers_sku_check;
alter table public.marketplace_promoter_transfers add constraint marketplace_promoter_transfers_sku_check
  check (sku = any (array[
    'custom_domain'::text, 'subdomain'::text, 'ml_sync'::text, 'migration'::text,
    'negocio_anual'::text, 'negocio_arranque'::text, 'setup_gratis'::text,
    'tienda_anual'::text, 'negocio_semestral'::text
  ]));

-- D12, D14 — the new packages' splits and the two shares after the sale (Daniel, 2026-11-09 and 2026-11-10). The
-- column is an integer, so `negocio_semestral` is 55: charge 1,100, pass 495, keep 605. `negocio_anual` keeps its row
-- (55, unchanged). `on conflict do nothing`: a rate already set in /admin/promoter is never overwritten.
insert into public.marketplace_promoter_commission_rates (sku, rate_pct, updated_at) values
  ('tienda_anual', 60, now()),
  ('negocio_semestral', 55, now()),
  ('tienda_renewal', 10, now()),
  ('negocio_upgrade', 20, now())
on conflict (sku) do nothing;
