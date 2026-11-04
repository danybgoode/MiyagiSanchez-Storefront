-- plans-gratis-negocio M2 (epic 08 · README D13). Applied by the orchestrator through MCP before the PR that uses it
-- merges; never `supabase db push`.
--
-- The year-2 renewal share is recorded as ONE attribution per merchant payment (sku `negocio_renewal`, keyed by the
-- Stripe payment id in `payment_ref`, which M1 made unique). The existing one-row-per (promoter, shop, sku) index would
-- refuse the second monthly renewal, so it now covers only rows WITHOUT a payment_ref — every existing row has none, so
-- the set it protects is unchanged. Rows with a payment_ref are unique by that ref instead.

drop index if exists public.marketplace_promoter_attributions_uniq;
create unique index marketplace_promoter_attributions_uniq
  on public.marketplace_promoter_attributions (promoter_id, seller_id, sku)
  where seller_id is not null and sku is not null and payment_ref is null;
