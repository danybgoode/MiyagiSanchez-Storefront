-- one-front-door-both-markets D10.
--
-- A draft now knows the language it was started in (every builder screen and nudge email follows it), the market
-- the visitor was most likely in (a HINT that sets the example prices' currency — the claim still asks, D13), and
-- the merchant's own products when they started from a photo, a file or a store link (imported after the claim
-- through the existing /api/sell/import, D9).
--
-- Free to add on 2026-11-12: shop_drafts held 3 rows, all claimed. Existing rows read as Spanish with no hint.

alter table public.shop_drafts
  add column if not exists locale text not null default 'es',
  add column if not exists market text,
  add column if not exists seed_rows jsonb;

alter table public.shop_drafts
  drop constraint if exists shop_drafts_locale_check,
  add constraint shop_drafts_locale_check check (locale in ('es', 'en')),
  drop constraint if exists shop_drafts_market_check,
  add constraint shop_drafts_market_check check (market is null or market in ('mx', 'us')),
  drop constraint if exists shop_drafts_seed_rows_check,
  add constraint shop_drafts_seed_rows_check check (
    seed_rows is null or (jsonb_typeof(seed_rows) = 'array' and jsonb_array_length(seed_rows) <= 60)
  );
