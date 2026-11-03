# Database

## Two databases — know which one to use

**Medusa Postgres** (`apps/backend`) — commerce data: products, vendors, carts, orders, payments, fulfillment, returns, subscriptions. Access via Medusa Store API or Admin API. Never query this directly from the frontend.

**Supabase** (`apps/storefront`) — non-commerce marketplace data that Medusa has no concept of. The tables below are ALL that should be in Supabase.

---

## Supabase clients

**Server (API routes, Server Components):**
```ts
import { db } from '@/lib/supabase'
// db = service-role client — bypasses RLS, safe for server-only code
// NEVER expose in client components or return to browser
// NEVER use for products, orders, payments, or fulfillment — those go through Medusa
```

**Browser (realtime only):**
```ts
import { useSupabaseBrowser } from '@/lib/supabase-browser'
// anon key + Clerk session token (native third-party auth)
// RLS-scoped: each user only receives their own rows via postgres_changes
// Use ONLY inside client components for realtime subscriptions — all writes go through server API routes
```

The browser client uses Clerk's native Supabase integration (GA Apr 2025). Requires two dashboard toggles to activate:
1. Clerk → Integrations → "Connect with Supabase" (injects `role: authenticated` into session token)
2. Supabase → Authentication → Third-Party Auth → Add Clerk (issuer `https://clerk.miyagisanchez.com`)

Until those are done the app falls back to a 30s poll — not broken, just not instant.

---

## Supabase tables (non-commerce only)

### `marketplace_conversations`

One conversation per (buyer, vendor) pair. The persistent thread for offers, order tracking, and agent access.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `buyer_clerk_user_id` | TEXT | Clerk user ID |
| `vendor_id` | TEXT | Medusa vendor ID |
| `product_id` | TEXT | Medusa product ID |
| `offer_id` | UUID | FK → marketplace_offers (active offer) |
| `created_at` | TIMESTAMPTZ | |

### `marketplace_conversation_events`

Immutable event log for a conversation. `event_type` mirrors offer state machine + lifecycle.

| Column | Type | Notes |
|---|---|---|
| `conversation_id` | UUID | FK |
| `actor` | TEXT | `'buyer'|'seller'|'system'` |
| `event_type` | TEXT | `'message'|'offer'|'counter'|'accept'|'decline'|'order_placed'|'shipped'|...` |
| `metadata` | JSONB | Type-specific payload (amounts, tracking numbers, etc.) |

### `marketplace_offers`

Offer/negotiation state machine.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `product_id` | TEXT | Medusa product ID |
| `vendor_id` | TEXT | Medusa vendor ID |
| `buyer_clerk_user_id` | TEXT | |
| `amount_cents` | INT | Offered amount |
| `currency` | TEXT | Default 'MXN' |
| `status` | TEXT | `'pending'|'accepted'|'declined'|'countered'|'expired'` |
| `counter_amount_cents` | INT | If seller countered |
| `expires_at` | TIMESTAMPTZ | 72h default |

### `marketplace_favorites`

Buyer saved items. `price_cents_at_save` enables price-drop alerts.

| Column | Type | Notes |
|---|---|---|
| `buyer_clerk_user_id` | TEXT | |
| `product_id` | TEXT | Medusa product ID |
| `price_cents_at_save` | INT | |

### `supply_batches` + `supply_items`

Bulk import staging. Keeps scraped/CSV data isolated until admin review + Medusa publish.

| Table | Purpose |
|---|---|
| `supply_batches` | One batch per import run |
| `supply_items` | Individual rows, normalized and validated |

After review, supply items are published as Medusa products via `POST /api/supply/import` → calls Medusa Admin API to create products.

### `marketplace_scrape_runs` + `marketplace_scrape_run_items`

Admin scraper job tracking. Raw scraper output stored here before supply review.

### `push_subscriptions`

Web push (VAPID) subscriptions. One row per device per user. Used by `lib/notify.ts` to fan out push notifications when a new stamp or offer arrives. Dead subscriptions (410/404) are pruned automatically on delivery.

| Column | Type | Notes |
|---|---|---|
| `clerk_user_id` | TEXT | |
| `endpoint` | TEXT | Push service URL |
| `p256dh` | TEXT | ECDH public key |
| `auth` | TEXT | Auth secret |
| `ua` | TEXT | User-agent (for debugging) |
| `created_at` | TIMESTAMPTZ | |

RLS: server-only (no read/write policies for `authenticated`). Only the service-role client touches this table.

### `ucp_buyer_identities`

OmniReputation trust scores. Keyed by buyer identifier (email, Clerk ID, or phone hash).

---

## Query patterns (Supabase only)

```ts
// Basic fetch
const { data } = await db
  .from('marketplace_conversations')
  .select('*, events:marketplace_conversation_events(*)')
  .eq('buyer_clerk_user_id', userId)
  .order('created_at', { ascending: false })

// Prefer .maybeSingle() over .single() to avoid throwing on not-found
const { data } = await db
  .from('marketplace_offers')
  .select('*')
  .eq('id', offerId)
  .maybeSingle()
```

---

## Migrations

Supabase migrations live in `supabase/migrations/`. Only add migrations for tables in the non-commerce list above. Never add migrations for products, orders, payments, or any concern Medusa handles.

Naming: `YYYYMMDDHHMMSS_description.sql`  
Never modify existing migration files — add new ones.
